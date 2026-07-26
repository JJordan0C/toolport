//! Server-side tool orchestration ("code mode"): run ONE agent-submitted script that
//! calls multiple downstream tools, loops, and branches, and returns a single aggregated
//! value. This is the results-layer twin of lazy discovery: lazy discovery collapses N
//! tool *definitions* to a handful of meta-tools; code mode collapses N tool *calls +
//! results* to one `run_script` round-trip, so the intermediate results never land in the
//! model's context.
//!
//! The engine is [`boa_engine`], a pure-Rust JS interpreter, so this adds no C toolchain
//! or FFI to the build. Because Toolport is single-user and local, the agent is already
//! trusted and the servers already run on the host: the sandbox's job is round-trip and
//! token reduction, NOT a security boundary. It still fails closed on resource limits so a
//! runaway or buggy script can't wedge the gateway.
//!
//! Scripts get:
//! - `toolport.call(name, args)` — synchronous host call (v1)
//! - `toolport.callAsync(name, args)` — returns a Promise; independent calls fan out with
//!   bounded host-side parallelism (v2)
//! - `toolport.callAll([{name, args}, ...])` — `Promise.all` sugar over `callAsync`
//!
//! Each binding routes through the caller-supplied closure (the same path as
//! `toolport_call_tool`: per-client scope, human approval, result shaping), so a script
//! never widens what the client could already reach. Limits: call budget, wall-clock
//! deadline, max concurrent host calls, and boa's loop/recursion caps.

use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::rc::Rc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use boa_engine::builtins::promise::{PromiseState, ResolvingFunctions};
use boa_engine::object::builtins::JsPromise;
use boa_engine::property::Attribute;
use boa_engine::{
    js_string, Context, JsError, JsNativeError, JsValue, NativeFunction, Source,
};
use boa_gc::{Finalize, Trace};
use serde_json::{json, Value};

/// Host binding used for every downstream tool invocation from a script.
///
/// `Send + Sync` so independent `callAsync` work can run on a small thread pool without
/// serializing every host call on the JS thread.
pub type CallBinding = Arc<dyn Fn(&str, Value) -> Value + Send + Sync>;

/// Resource limits for one script run. All are fail-closed: exceeding any of them aborts
/// the script with an error result the agent can read and recover from.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    /// Max number of `toolport.call` / `callAsync` invocations. Bounds fan-out and load.
    pub max_calls: usize,
    /// Wall-clock budget for the whole run, checked at each host call.
    pub wall_clock: Duration,
    /// Max concurrent host tool calls when scripts fan out with `callAsync` / `Promise.all`.
    pub max_parallel: usize,
    /// Max total loop iterations across the script (boa runtime limit); bounds a pure-JS
    /// `while(true){}` that never calls a tool.
    pub loop_iteration_limit: u64,
    /// Max recursion depth (boa runtime limit).
    pub recursion_limit: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            max_calls: 64,
            wall_clock: Duration::from_secs(60),
            max_parallel: 8,
            loop_iteration_limit: 10_000_000,
            recursion_limit: 400,
        }
    }
}

/// The outcome of running a script.
#[derive(Debug, Clone)]
pub struct ScriptOutcome {
    /// The script's return value as JSON (`null` if it returned nothing). Meaningful only
    /// when `error` is `None`.
    pub value: Value,
    /// How many host tool invocations the script actually made — used to account
    /// round-trips saved (calls - 1) and to report fan-out.
    pub calls: usize,
    /// `Some(message)` if the script threw, hit a limit, or failed to compile. Fail-closed:
    /// the caller surfaces this to the agent as an error result.
    pub error: Option<String>,
}

/// One deferred `callAsync` waiting for host execution + promise settlement.
struct PendingCall {
    name: String,
    args: Value,
    resolvers: ResolvingFunctions,
}

impl Finalize for PendingCall {
    fn finalize(&self) {
        self.resolvers.finalize();
    }
}

// SAFETY: only `resolvers` points into the boa heap; name/args are ordinary Rust data.
unsafe impl Trace for PendingCall {
    unsafe fn trace(&self, tracer: &mut boa_gc::Tracer) {
        // SAFETY: resolvers is a live GC graph while the pending call exists.
        unsafe { self.resolvers.trace(tracer) };
    }
    unsafe fn trace_non_roots(&self) {
        // SAFETY: same as `trace`.
        unsafe { self.resolvers.trace_non_roots() };
    }
    fn run_finalizer(&self) {
        self.finalize();
    }
}

/// Host state shared with the `__toolport_call` / `__toolport_call_async` native functions.
struct HostState {
    call: CallBinding,
    /// Shared with the run so the count survives after the closure is moved into boa.
    calls_made: Rc<Cell<usize>>,
    max_calls: usize,
    max_parallel: usize,
    deadline: Instant,
    /// Queued `callAsync` work; drained with bounded host-side parallelism.
    pending: Rc<RefCell<VecDeque<PendingCall>>>,
}

impl Clone for HostState {
    fn clone(&self) -> Self {
        Self {
            call: Arc::clone(&self.call),
            calls_made: Rc::clone(&self.calls_made),
            max_calls: self.max_calls,
            max_parallel: self.max_parallel,
            deadline: self.deadline,
            pending: Rc::clone(&self.pending),
        }
    }
}

impl Finalize for HostState {
    fn finalize(&self) {
        if let Ok(pending) = self.pending.try_borrow() {
            for item in pending.iter() {
                item.finalize();
            }
        }
    }
}

// SAFETY: only the `ResolvingFunctions` inside `pending` point into the boa heap. The
// `call` Arc, counters, and deadline are ordinary Rust-owned data. While a native call
// holds `pending` mutably, GC is not expected to re-enter; `try_borrow` fails closed by
// skipping the queue for that mark pass (queue entries stay reachable via the promise
// resolvers already rooted as live JS objects).
unsafe impl Trace for HostState {
    unsafe fn trace(&self, tracer: &mut boa_gc::Tracer) {
        if let Ok(pending) = self.pending.try_borrow() {
            for item in pending.iter() {
                // SAFETY: each PendingCall only traces its resolvers.
                unsafe { item.trace(tracer) };
            }
        }
    }
    unsafe fn trace_non_roots(&self) {
        if let Ok(pending) = self.pending.try_borrow() {
            for item in pending.iter() {
                // SAFETY: same as `trace`.
                unsafe { item.trace_non_roots() };
            }
        }
    }
    fn run_finalizer(&self) {
        self.finalize();
    }
}

/// The JS prelude installed before the user script.
const PRELUDE: &str = r#"
globalThis.toolport = {
    call: function (name, args) {
        var payload = (args === undefined || args === null) ? {} : args;
        return JSON.parse(__toolport_call(String(name), JSON.stringify(payload)));
    },
    callAsync: function (name, args) {
        var payload = (args === undefined || args === null) ? {} : args;
        return __toolport_call_async(String(name), JSON.stringify(payload)).then(function (raw) {
            return JSON.parse(raw);
        });
    },
    callAll: function (items) {
        if (!Array.isArray(items)) {
            return Promise.reject(new TypeError("toolport.callAll expects an array of {name, args}"));
        }
        return Promise.all(items.map(function (item) {
            var name = item && item.name;
            var args = item && item.args;
            return toolport.callAsync(name, args);
        }));
    },
};
"#;

/// Run `script` with `data` available as a global `data` object, giving it `toolport.call`
/// / `callAsync` / `callAll` bound to `call`. Returns one aggregated [`ScriptOutcome`];
/// intermediate call results never surface to the model.
///
/// Scripts are wrapped in an async IIFE so top-level `await` and returned Promises work.
/// Independent `callAsync` work is flushed with up to [`Limits::max_parallel`] host calls
/// in flight at once.
///
/// `call` must be `'static` (the gateway builds it from `Arc`-cloned handles). It is
/// invoked once per host tool call; whatever it returns becomes that call's JS result.
pub fn run_script(
    script: &str,
    data: Value,
    call: CallBinding,
    limits: Limits,
) -> ScriptOutcome {
    let calls_made = Rc::new(Cell::new(0usize));
    let pending = Rc::new(RefCell::new(VecDeque::new()));
    let mut context = Context::default();

    // Pure-JS runaway guards (a script that loops/recurses forever without calling a tool).
    context
        .runtime_limits_mut()
        .set_loop_iteration_limit(limits.loop_iteration_limit);
    context
        .runtime_limits_mut()
        .set_recursion_limit(limits.recursion_limit);

    let state = HostState {
        call,
        calls_made: calls_made.clone(),
        max_calls: limits.max_calls,
        max_parallel: limits.max_parallel.max(1),
        deadline: Instant::now() + limits.wall_clock,
        pending,
    };

    let sync_native = NativeFunction::from_copy_closure_with_captures(
        |_this: &JsValue, args: &[JsValue], state: &HostState, _ctx: &mut Context| {
            reserve_call_slot(state)?;
            let (name, parsed) = parse_call_args(args);
            state.calls_made.set(state.calls_made.get() + 1);
            let result = (state.call)(&name, parsed);
            let result_str = serde_json::to_string(&result).unwrap_or_else(|_| "null".to_string());
            Ok(JsValue::from(js_string!(result_str)))
        },
        state.clone(),
    );

    let async_native = NativeFunction::from_copy_closure_with_captures(
        |_this: &JsValue, args: &[JsValue], state: &HostState, ctx: &mut Context| {
            reserve_call_slot(state)?;
            let (name, parsed) = parse_call_args(args);
            state.calls_made.set(state.calls_made.get() + 1);
            let (promise, resolvers) = JsPromise::new_pending(ctx);
            state.pending.borrow_mut().push_back(PendingCall {
                name,
                args: parsed,
                resolvers,
            });
            Ok(promise.into())
        },
        state.clone(),
    );

    if let Err(e) = context.register_global_callable(js_string!("__toolport_call"), 2, sync_native)
    {
        return fail(calls_made.get(), e);
    }
    if let Err(e) =
        context.register_global_callable(js_string!("__toolport_call_async"), 2, async_native)
    {
        return fail(calls_made.get(), e);
    }

    // Inject `data` as a global before the prelude/script run.
    match JsValue::from_json(&data, &mut context) {
        Ok(v) => {
            if let Err(e) =
                context.register_global_property(js_string!("data"), v, Attribute::all())
            {
                return fail(calls_made.get(), e);
            }
        }
        Err(e) => return fail(calls_made.get(), e),
    }

    if let Err(e) = context.eval(Source::from_bytes(PRELUDE)) {
        return fail(calls_made.get(), e);
    }

    // Async IIFE: top-level `return` and `await` both work; the result is always a Promise.
    let wrapped = format!("(async function () {{\n{script}\n}})()");
    let top = match context.eval(Source::from_bytes(wrapped.as_bytes())) {
        Ok(v) => v,
        Err(e) => return fail(calls_made.get(), e),
    };

    match drive_to_completion(&mut context, &state, top) {
        Ok(value) => ScriptOutcome {
            value,
            calls: calls_made.get(),
            error: None,
        },
        Err(e) => fail(calls_made.get(), e),
    }
}

fn reserve_call_slot(state: &HostState) -> Result<(), JsError> {
    if state.calls_made.get() >= state.max_calls {
        return Err(JsError::from_native(JsNativeError::error().with_message(
            format!("toolport.call budget exceeded ({} calls)", state.max_calls),
        )));
    }
    if Instant::now() >= state.deadline {
        return Err(JsError::from_native(
            JsNativeError::error().with_message("toolport script wall-clock deadline exceeded"),
        ));
    }
    Ok(())
}

fn parse_call_args(args: &[JsValue]) -> (String, Value) {
    let name = args
        .first()
        .and_then(JsValue::as_string)
        .map(|s| s.to_std_string_escaped())
        .unwrap_or_default();
    let args_json = args
        .get(1)
        .and_then(JsValue::as_string)
        .map(|s| s.to_std_string_escaped())
        .unwrap_or_else(|| "{}".to_string());
    let parsed: Value = serde_json::from_str(&args_json).unwrap_or(Value::Null);
    (name, parsed)
}

/// Flush pending host work and promise jobs until the top-level async IIFE settles.
fn drive_to_completion(
    context: &mut Context,
    state: &HostState,
    top: JsValue,
) -> Result<Value, JsError> {
    // Bound the drive loop so a pure-JS pending Promise can't spin forever.
    const MAX_DRIVE_ITERS: usize = 1_000_000;

    for _ in 0..MAX_DRIVE_ITERS {
        flush_pending_host_calls(context, state)?;

        if let Err(e) = context.run_jobs() {
            return Err(e);
        }

        // Host work may have been enqueued from a microtask after run_jobs.
        if !state.pending.borrow().is_empty() {
            continue;
        }

        let Some(obj) = top.as_object() else {
            return Ok(top.to_json(context).ok().flatten().unwrap_or(Value::Null));
        };
        let promise = match JsPromise::from_object(obj.clone()) {
            Ok(p) => p,
            Err(_) => {
                return Ok(top.to_json(context).ok().flatten().unwrap_or(Value::Null));
            }
        };

        match promise.state() {
            PromiseState::Pending => {
                // No host work left and jobs drained: the script is stuck on a Promise
                // that nothing will settle.
                return Err(JsError::from_native(JsNativeError::error().with_message(
                    "toolport script hung on an unresolved Promise (no pending tool calls)",
                )));
            }
            PromiseState::Fulfilled(value) => {
                return Ok(value.to_json(context).ok().flatten().unwrap_or(Value::Null));
            }
            PromiseState::Rejected(reason) => {
                let msg = reason
                    .to_string(context)
                    .map(|s| s.to_std_string_escaped())
                    .unwrap_or_else(|_| reason.display().to_string());
                return Err(JsError::from_native(
                    JsNativeError::error().with_message(format!("Uncaught {msg}")),
                ));
            }
        }
    }

    Err(JsError::from_native(JsNativeError::error().with_message(
        "toolport script exceeded internal async drive budget",
    )))
}

/// Take queued `callAsync` work, run it with bounded host-side parallelism, resolve each
/// Promise with the JSON-stringified tool result (same wire shape as sync `call`).
fn flush_pending_host_calls(context: &mut Context, state: &HostState) -> Result<(), JsError> {
    loop {
        if Instant::now() >= state.deadline {
            return Err(JsError::from_native(
                JsNativeError::error().with_message("toolport script wall-clock deadline exceeded"),
            ));
        }

        let batch: Vec<PendingCall> = {
            let mut pending = state.pending.borrow_mut();
            if pending.is_empty() {
                return Ok(());
            }
            let take = pending.len().min(state.max_parallel);
            pending.drain(..take).collect()
        };

        let names_args: Vec<(String, Value)> = batch
            .iter()
            .map(|p| (p.name.clone(), p.args.clone()))
            .collect();
        let results = run_calls_parallel(&state.call, names_args);

        for (pending_call, result) in batch.into_iter().zip(results.into_iter()) {
            let result_str =
                serde_json::to_string(&result).unwrap_or_else(|_| "null".to_string());
            let js_result = JsValue::from(js_string!(result_str));
            pending_call.resolvers.resolve.call(
                &JsValue::undefined(),
                &[js_result],
                context,
            )?;
        }

        // More may still be queued; keep draining this wave before returning to the
        // outer drive loop (which also runs promise jobs).
        if state.pending.borrow().is_empty() {
            return Ok(());
        }
    }
}

/// Run independent host tool calls, using a short-lived thread scope when more than one
/// is ready so wall-clock tracks the slowest call in the batch rather than the sum.
fn run_calls_parallel(call: &CallBinding, items: Vec<(String, Value)>) -> Vec<Value> {
    if items.is_empty() {
        return Vec::new();
    }
    if items.len() == 1 {
        let (name, args) = &items[0];
        return vec![call(name, args.clone())];
    }

    let n = items.len();
    let mut results: Vec<Option<Value>> = (0..n).map(|_| None).collect();
    std::thread::scope(|scope| {
        let mut handles = Vec::with_capacity(n);
        for (i, (name, args)) in items.into_iter().enumerate() {
            let call = call;
            handles.push(scope.spawn(move || (i, call(&name, args))));
        }
        for handle in handles {
            match handle.join() {
                Ok((i, value)) => results[i] = Some(value),
                Err(_) => {
                    // Worker panicked; leave a slot error in place so order is preserved.
                    // Index is unknown if join payload was lost — fill first empty slot.
                    if let Some(slot) = results.iter_mut().find(|s| s.is_none()) {
                        *slot = Some(json!({
                            "content": [{ "type": "text", "text": "Toolport: callAsync worker panicked" }],
                            "isError": true
                        }));
                    }
                }
            }
        }
    });
    results
        .into_iter()
        .map(|v| {
            v.unwrap_or_else(|| {
                json!({
                    "content": [{ "type": "text", "text": "Toolport: callAsync worker missing result" }],
                    "isError": true
                })
            })
        })
        .collect()
}

/// Build a fail-closed outcome from a boa error, rendering it to a readable message.
/// Uses the error's `Display` rather than `to_opaque` on purpose: boa's uncatchable
/// runtime-limit errors (loop/recursion caps) panic when converted to an opaque JS value,
/// and `Display` yields a usable message (`Uncaught Error: ...`, `RuntimeLimit: ...`) for
/// every error kind.
fn fail(calls: usize, err: JsError) -> ScriptOutcome {
    ScriptOutcome {
        value: json!(null),
        calls,
        error: Some(err.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use std::thread;
    use std::time::Duration as StdDuration;

    /// A call binding that records the calls it saw and echoes a canned reply per tool.
    fn recording_call(
        log: Arc<Mutex<Vec<(String, Value)>>>,
    ) -> CallBinding {
        Arc::new(move |name: &str, args: Value| {
            log.lock().unwrap().push((name.to_string(), args.clone()));
            json!({ "echo": name, "args": args })
        })
    }

    #[test]
    fn runs_a_plain_script_and_returns_its_value() {
        let call = Arc::new(|_: &str, _: Value| Value::Null);
        let out = run_script("return 1 + 2;", json!({}), call, Limits::default());
        assert_eq!(out.error, None, "unexpected error: {:?}", out.error);
        assert_eq!(out.value, json!(3));
        assert_eq!(out.calls, 0);
    }

    #[test]
    fn toolport_call_reaches_the_binding_and_data_is_injected() {
        let log = Arc::new(Mutex::new(Vec::new()));
        let call = recording_call(log.clone());
        let script = r#"
            var out = [];
            for (var i = 0; i < data.ids.length; i++) {
                var r = toolport.call("lookup", { id: data.ids[i] });
                out.push(r.args.id);
            }
            return out;
        "#;
        let out = run_script(script, json!({ "ids": [10, 20, 30] }), call, Limits::default());
        assert_eq!(out.error, None, "unexpected error: {:?}", out.error);
        assert_eq!(out.value, json!([10, 20, 30]));
        assert_eq!(out.calls, 3);
        let log = log.lock().unwrap();
        assert_eq!(log.len(), 3);
        assert_eq!(log[0].0, "lookup");
        assert_eq!(log[1].1, json!({ "id": 20 }));
    }

    #[test]
    fn call_budget_is_enforced() {
        let call = Arc::new(|_: &str, _: Value| json!({}));
        let limits = Limits {
            max_calls: 2,
            ..Limits::default()
        };
        let out = run_script(
            "for (var i = 0; i < 10; i++) { toolport.call('t', {}); } return 'done';",
            json!({}),
            call,
            limits,
        );
        // Fail-closed: it made exactly the budgeted calls, then errored instead of finishing.
        assert_eq!(out.calls, 2);
        assert_ne!(out.error, None);
        assert!(out.error.unwrap().contains("budget"));
    }

    #[test]
    fn loop_limit_stops_pure_js_runaway() {
        let call = Arc::new(|_: &str, _: Value| Value::Null);
        let limits = Limits {
            loop_iteration_limit: 1000,
            ..Limits::default()
        };
        let out = run_script("while (true) {} return 1;", json!({}), call, limits);
        assert_ne!(out.error, None, "an infinite loop must be stopped");
        assert_eq!(out.calls, 0);
    }

    #[test]
    fn a_thrown_error_is_reported_not_panicked() {
        let call = Arc::new(|_: &str, _: Value| Value::Null);
        let out = run_script("throw new Error('boom');", json!({}), call, Limits::default());
        assert!(out.error.unwrap().contains("boom"));
    }

    #[test]
    fn syntax_error_fails_closed() {
        let call = Arc::new(|_: &str, _: Value| Value::Null);
        let out = run_script("this is not valid )(", json!({}), call, Limits::default());
        assert_ne!(out.error, None);
        assert_eq!(out.calls, 0);
    }

    #[test]
    fn call_async_with_await_returns_result() {
        let log = Arc::new(Mutex::new(Vec::new()));
        let call = recording_call(log.clone());
        let script = r#"
            const a = await toolport.callAsync("lookup", { id: 7 });
            return a.args.id;
        "#;
        let out = run_script(script, json!({}), call, Limits::default());
        assert_eq!(out.error, None, "unexpected error: {:?}", out.error);
        assert_eq!(out.value, json!(7));
        assert_eq!(out.calls, 1);
    }

    #[test]
    fn promise_all_fans_out_and_preserves_order() {
        let log = Arc::new(Mutex::new(Vec::new()));
        let call = recording_call(log.clone());
        let script = r#"
            const results = await Promise.all([
                toolport.callAsync("a", { n: 1 }),
                toolport.callAsync("b", { n: 2 }),
                toolport.callAsync("c", { n: 3 }),
            ]);
            return results.map(function (r) { return r.echo + ":" + r.args.n; });
        "#;
        let out = run_script(script, json!({}), call, Limits::default());
        assert_eq!(out.error, None, "unexpected error: {:?}", out.error);
        assert_eq!(out.value, json!(["a:1", "b:2", "c:3"]));
        assert_eq!(out.calls, 3);
        let names: Vec<String> = log.lock().unwrap().iter().map(|(n, _)| n.clone()).collect();
        assert_eq!(names.len(), 3);
        assert!(names.contains(&"a".to_string()));
        assert!(names.contains(&"b".to_string()));
        assert!(names.contains(&"c".to_string()));
    }

    #[test]
    fn call_all_sugar_matches_promise_all() {
        let call = Arc::new(|name: &str, args: Value| {
            json!({ "echo": name, "args": args })
        });
        let script = r#"
            const results = await toolport.callAll([
                { name: "x", args: { i: 1 } },
                { name: "y", args: { i: 2 } },
            ]);
            return results.map(function (r) { return r.echo + r.args.i; }).join(",");
        "#;
        let out = run_script(script, json!({}), call, Limits::default());
        assert_eq!(out.error, None, "unexpected error: {:?}", out.error);
        assert_eq!(out.value, json!("x1,y2"));
        assert_eq!(out.calls, 2);
    }

    #[test]
    fn call_async_budget_is_enforced() {
        let call = Arc::new(|_: &str, _: Value| json!({}));
        let limits = Limits {
            max_calls: 2,
            ..Limits::default()
        };
        let out = run_script(
            r#"
                await Promise.all([
                    toolport.callAsync("a", {}),
                    toolport.callAsync("b", {}),
                    toolport.callAsync("c", {}),
                ]);
                return "done";
            "#,
            json!({}),
            call,
            limits,
        );
        assert_eq!(out.calls, 2);
        assert_ne!(out.error, None);
        assert!(out.error.unwrap().contains("budget"));
    }

    #[test]
    fn parallel_host_calls_overlap_in_wall_clock() {
        // Each call sleeps ~80ms. Three sequential would be ~240ms; with max_parallel >= 3
        // the batch should finish near one sleep (+ overhead).
        let call: CallBinding = Arc::new(|name: &str, _: Value| {
            thread::sleep(StdDuration::from_millis(80));
            json!({ "echo": name })
        });
        let limits = Limits {
            max_parallel: 8,
            wall_clock: StdDuration::from_secs(10),
            ..Limits::default()
        };
        let started = Instant::now();
        let out = run_script(
            r#"
                return await Promise.all([
                    toolport.callAsync("a", {}),
                    toolport.callAsync("b", {}),
                    toolport.callAsync("c", {}),
                ]);
            "#,
            json!({}),
            call,
            limits,
        );
        let elapsed = started.elapsed();
        assert_eq!(out.error, None, "unexpected error: {:?}", out.error);
        assert_eq!(out.calls, 3);
        assert!(
            elapsed < StdDuration::from_millis(200),
            "expected overlapping host calls, took {elapsed:?}"
        );
    }

    #[test]
    fn max_parallel_caps_concurrent_host_work() {
        let in_flight = Arc::new(Mutex::new(0usize));
        let peak = Arc::new(Mutex::new(0usize));
        let in_flight2 = in_flight.clone();
        let peak2 = peak.clone();
        let call: CallBinding = Arc::new(move |_name: &str, _: Value| {
            {
                let mut n = in_flight2.lock().unwrap();
                *n += 1;
                let mut p = peak2.lock().unwrap();
                if *n > *p {
                    *p = *n;
                }
            }
            thread::sleep(StdDuration::from_millis(30));
            {
                let mut n = in_flight2.lock().unwrap();
                *n -= 1;
            }
            json!({ "ok": true })
        });
        let limits = Limits {
            max_parallel: 2,
            wall_clock: StdDuration::from_secs(10),
            ..Limits::default()
        };
        let out = run_script(
            r#"
                return await Promise.all([
                    toolport.callAsync("a", {}),
                    toolport.callAsync("b", {}),
                    toolport.callAsync("c", {}),
                    toolport.callAsync("d", {}),
                ]);
            "#,
            json!({}),
            call,
            limits,
        );
        assert_eq!(out.error, None, "unexpected error: {:?}", out.error);
        assert_eq!(out.calls, 4);
        let peak = *peak.lock().unwrap();
        assert!(peak <= 2, "peak concurrency {peak} exceeded max_parallel 2");
        assert!(peak >= 2, "expected to reach max_parallel, peak={peak}");
    }
}
