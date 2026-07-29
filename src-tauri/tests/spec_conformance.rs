//! MCP specification conformance + backward-compatibility harness (SOU-443).
//!
//! Toolport is simultaneously an MCP *server* (to AI clients) and an MCP *client*
//! (to downstream servers), so every protocol revision change lands on it twice.
//! The gateway must stay **dual-era**: speaking `2026-07-28` upward while still
//! driving `initialize`-era servers downward.
//!
//! This file is the regression net for that work. It has three jobs:
//!
//! 1. **Validate the fixture.** `mock-mcp-server` can impersonate any revision;
//!    these tests prove it actually behaves era-correctly, so later tests can
//!    trust it as a reference implementation.
//! 2. **Pin today's wire format.** `downstream_transcript_pins_current_wire_format`
//!    records the exact JSON-RPC the gateway emits downstream. Any change to it
//!    is then a deliberate edit to this file, never an accident.
//! 3. **Prove the dual-era guarantees.** Both directions are covered: Toolport
//!    connecting to a modern server and serving a modern client, each paired with
//!    a test that the legacy path sees byte-identical traffic.
//!
//! Gaps were tracked here as `#[ignore]`d acceptance criteria while the work was
//! in flight, which is a good pattern to reuse. Every test in this file runs
//! today.

use std::sync::atomic::{AtomicU8, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use conduit_lib::downstream::{DownstreamServer, StdioTransport, Transport, TransportError};
use serde_json::{json, Value};

const MODERN: &str = "2026-07-28";
const LEGACY_REVISIONS: [&str; 4] = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];

/// Historical default the fixture must keep when no revision is requested, so
/// the pre-existing integration tests are unaffected by the multi-revision work.
const FIXTURE_DEFAULT: &str = "2025-06-18";

fn mock_bin() -> &'static str {
    env!("CARGO_BIN_EXE_mock-mcp-server")
}

/// A unique scratch path per call. Avoids a `tempfile` dev-dependency for what
/// is only ever a few lines of JSONL.
fn scratch_path(tag: &str) -> std::path::PathBuf {
    static N: AtomicUsize = AtomicUsize::new(0);
    let n = N.fetch_add(1, Ordering::SeqCst);
    std::env::temp_dir().join(format!(
        "toolport-conformance-{tag}-{}-{n}.jsonl",
        std::process::id()
    ))
}

fn env_for(revision: Option<&str>, strict: bool, transcript: Option<&str>) -> Vec<(String, String)> {
    let mut env = Vec::new();
    if let Some(rev) = revision {
        env.push(("MOCK_MCP_REVISION".to_string(), rev.to_string()));
    }
    if strict {
        env.push(("MOCK_MCP_STRICT".to_string(), "1".to_string()));
    }
    if let Some(path) = transcript {
        env.push(("MOCK_MCP_TRANSCRIPT".to_string(), path.to_string()));
    }
    env
}

/// A raw transport to the fixture, bypassing `DownstreamServer::connect` so a
/// test can drive the handshake itself and observe era behaviour directly.
fn raw_transport(env: &[(String, String)]) -> StdioTransport {
    let dirty = Arc::new(AtomicU8::new(0));
    StdioTransport::spawn_watched(mock_bin(), &[], env, None, dirty, None).expect("spawn fixture")
}

/// JSON-RPC error objects are carried structurally by `TransportError::Rpc`
/// since SOU-445, so a test can read the `code` directly. This used to re-parse
/// a flattened string, which is exactly the lossiness that made the
/// backward-compatibility ladder unimplementable.
fn error_json(err: &TransportError) -> Value {
    let TransportError::Rpc(obj) = err else {
        panic!("expected a JSON-RPC error response, got {err:?}");
    };
    obj.clone()
}

fn read_transcript(path: &std::path::Path) -> Vec<Value> {
    let raw = std::fs::read_to_string(path).unwrap_or_default();
    raw.lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}

fn methods_of(transcript: &[Value]) -> Vec<String> {
    transcript
        .iter()
        .filter_map(|r| r.get("method").and_then(|m| m.as_str()).map(String::from))
        .collect()
}

// ---------------------------------------------------------------------------
// 1. Fixture validation
// ---------------------------------------------------------------------------

/// The multi-revision work must not change what an un-configured fixture does,
/// because `list_changed`, `circuit_breaker`, and `root_cwd` all depend on it.
#[test]
fn fixture_default_revision_is_unchanged() {
    let mut t = raw_transport(&env_for(None, false, None));
    let init = t
        .request("initialize", json!({ "protocolVersion": FIXTURE_DEFAULT, "capabilities": {} }))
        .expect("default fixture should answer initialize");
    assert_eq!(init["protocolVersion"], FIXTURE_DEFAULT);
}

#[test]
fn fixture_reports_each_legacy_revision() {
    for rev in LEGACY_REVISIONS {
        let mut t = raw_transport(&env_for(Some(rev), false, None));
        let init = t
            .request("initialize", json!({ "protocolVersion": rev, "capabilities": {} }))
            .unwrap_or_else(|e| panic!("{rev} fixture should answer initialize: {e}"));
        assert_eq!(init["protocolVersion"], rev, "fixture pinned to {rev}");

        // Legacy revisions must NOT answer server/discover: that is precisely the
        // signal the gateway's stdio fallback probe keys on (SOU-445).
        //
        // Note *how* it fails. Like many real stdio servers, the fixture simply
        // does not reply to a method it does not know, so the probe ends in a
        // read timeout rather than a JSON-RPC error. Silence is therefore a third
        // outcome the era probe must handle, alongside "recognized modern error"
        // (stay modern) and "some other error" (fall back). A probe without a
        // bounded timeout would hang on every legacy stdio server it meets.
        t.set_read_timeout(Duration::from_millis(500));
        assert!(
            t.request("server/discover", json!({})).is_err(),
            "{rev} is legacy and must not implement server/discover"
        );
    }
}

/// Icons landed in 2025-11-25 (SEP-973). They ride on the tool definition, so a
/// gateway that rebuilds tool objects field-by-field would silently drop them.
#[test]
fn fixture_advertises_icons_from_2025_11_25() {
    let mut t = raw_transport(&env_for(Some("2025-11-25"), false, None));
    t.request("initialize", json!({ "protocolVersion": "2025-11-25", "capabilities": {} }))
        .expect("initialize");
    let tools = t.request("tools/list", json!({})).expect("tools/list");
    let echo = tools["tools"]
        .as_array()
        .expect("tools array")
        .iter()
        .find(|t| t["name"] == "echo")
        .expect("echo tool");
    assert!(echo.get("icons").is_some(), "2025-11-25 fixture should carry icons");

    // ...and must not appear on older revisions, so a test can tell eras apart.
    let mut old = raw_transport(&env_for(Some("2025-06-18"), false, None));
    old.request("initialize", json!({ "protocolVersion": "2025-06-18", "capabilities": {} }))
        .expect("initialize");
    let old_tools = old.request("tools/list", json!({})).expect("tools/list");
    let old_echo = old_tools["tools"]
        .as_array()
        .expect("tools array")
        .iter()
        .find(|t| t["name"] == "echo")
        .expect("echo tool");
    assert!(old_echo.get("icons").is_none(), "2025-06-18 predates icons");
}

/// A modern server has no handshake. The spec asks it to name its supported
/// versions in the error, because legacy clients have no fall-forward mechanism
/// and this may be the only diagnostic a user ever sees.
#[test]
fn modern_fixture_rejects_initialize_and_names_supported_versions() {
    let mut t = raw_transport(&env_for(Some(MODERN), true, None));
    let err = t
        .request("initialize", json!({ "protocolVersion": "2025-06-18", "capabilities": {} }))
        .expect_err("a modern server must not implement initialize");
    let err = error_json(&err);
    assert_eq!(err["code"], -32601, "unknown method");
    assert_eq!(err["data"]["supported"][0], MODERN);
}

#[test]
fn modern_fixture_answers_server_discover() {
    let mut t = raw_transport(&env_for(Some(MODERN), true, None));
    let result = t
        .request(
            "server/discover",
            json!({ "_meta": { "io.modelcontextprotocol/protocolVersion": MODERN } }),
        )
        .expect("a modern server MUST implement server/discover");

    assert_eq!(result["supportedVersions"][0], MODERN);
    assert_eq!(result["resultType"], "complete", "every result carries resultType");
    assert_eq!(
        result["_meta"]["io.modelcontextprotocol/serverInfo"]["name"],
        "mock-mcp-server"
    );
    // server/discover is a cacheable operation.
    assert!(result.get("ttlMs").is_some(), "CacheableResult.ttlMs");
    assert_eq!(result["cacheScope"], "public");
}

/// Every modern request declares its version in `_meta`; a server that does not
/// implement it MUST reply `-32022` listing what it does support.
#[test]
fn modern_fixture_rejects_request_without_protocol_version() {
    let mut t = raw_transport(&env_for(Some(MODERN), true, None));

    let err = error_json(&t.request("tools/list", json!({})).expect_err("missing _meta version"));
    assert_eq!(err["code"], -32022);
    assert_eq!(err["data"]["supported"][0], MODERN);

    let err = error_json(
        &t.request(
            "tools/list",
            json!({ "_meta": { "io.modelcontextprotocol/protocolVersion": "1900-01-01" } }),
        )
        .expect_err("unknown version"),
    );
    assert_eq!(err["code"], -32022);
    assert_eq!(err["data"]["requested"], "1900-01-01");

    // The same request with the right version succeeds, proving the gate is the
    // version and not the method.
    let ok = t
        .request(
            "tools/list",
            json!({ "_meta": { "io.modelcontextprotocol/protocolVersion": MODERN } }),
        )
        .expect("correct version should pass");
    assert_eq!(ok["resultType"], "complete");
}

#[test]
fn strict_legacy_fixture_requires_initialize_first() {
    let mut t = raw_transport(&env_for(Some("2025-06-18"), true, None));
    let err = error_json(&t.request("tools/list", json!({})).expect_err("handshake not done"));
    assert_eq!(err["code"], -32600);

    t.request("initialize", json!({ "protocolVersion": "2025-06-18", "capabilities": {} }))
        .expect("initialize");
    t.notify("notifications/initialized", json!({})).expect("initialized");
    assert!(t.request("tools/list", json!({})).is_ok(), "handshake complete");
}

// ---------------------------------------------------------------------------
// 2. Pin today's downstream wire format
// ---------------------------------------------------------------------------

/// Records exactly what Toolport sends to a downstream server for a fixed
/// scenario. This is the regression net: SOU-444 and SOU-445 both rewrite this
/// path, and this test makes any change to the emitted bytes an explicit,
/// reviewed edit rather than a silent behavioural drift.
#[test]
fn downstream_transcript_pins_current_wire_format() {
    let path = scratch_path("wire");
    let _ = std::fs::remove_file(&path);
    let env = env_for(None, false, Some(&path.to_string_lossy()));

    let dirty = Arc::new(AtomicU8::new(0));
    let transport = StdioTransport::spawn_watched(mock_bin(), &[], &env, None, dirty, None)
        .expect("spawn fixture");
    let mut server =
        DownstreamServer::connect("mock".to_string(), Box::new(transport)).expect("connect");
    server.load_resources_prompts();
    server.call("echo", json!({ "text": "hi" })).expect("echo call");
    drop(server);

    let transcript = read_transcript(&path);
    let methods = methods_of(&transcript);

    // The handshake still opens the conversation, and it still declares a
    // version. When SOU-445 lands, a dual-era gateway will probe with
    // `server/discover` first and only fall back to `initialize` here.
    assert_eq!(methods.first().map(String::as_str), Some("initialize"));
    let init = &transcript[0];
    assert!(
        init["params"].get("protocolVersion").is_some(),
        "initialize must declare a protocol version"
    );

    for expected in ["tools/list", "resources/list", "prompts/list", "tools/call"] {
        assert!(methods.iter().any(|m| m == expected), "missing {expected} in {methods:?}");
    }

    // The `tools/call` envelope for a call carrying no client metadata. Since
    // SOU-444 the gateway attaches `_meta` only when there is something relayable
    // to attach, so this shape is byte-identical to what Toolport sent before
    // that work: an unchanged request for every server that never sees `_meta`.
    let call = transcript
        .iter()
        .find(|r| r["method"] == "tools/call")
        .expect("tools/call recorded");
    let mut keys: Vec<&str> = call["params"]
        .as_object()
        .expect("params object")
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        vec!["arguments", "name"],
        "tools/call params shape changed; if this is SOU-444, update this assertion on purpose"
    );

    // The downstream name is the ORIGINAL tool name, not the namespaced exposed
    // name. SOU-450 depends on this: the `Mcp-Name` header must carry the name
    // actually sent on the wire.
    assert_eq!(call["params"]["name"], "echo");

    let _ = std::fs::remove_file(&path);
}

// ---------------------------------------------------------------------------
// 3. Known gaps, encoded as acceptance criteria
// ---------------------------------------------------------------------------

/// Ask the fixture to reflect back whatever `_meta` reached it.
fn relayed_meta(client_meta: &Value) -> Value {
    let dirty = Arc::new(AtomicU8::new(0));
    let transport = StdioTransport::spawn_watched(mock_bin(), &[], &[], None, dirty, None)
        .expect("spawn fixture");
    let mut server =
        DownstreamServer::connect("mock".to_string(), Box::new(transport)).expect("connect");
    let result = server
        .call_with_cancel("echo_meta", json!({}), None, Some(client_meta))
        .expect("echo_meta call");
    result["structuredContent"]["receivedMeta"].clone()
}

/// SOU-444. `_meta` an upstream client sends must reach the downstream server,
/// including keys this build has never heard of. That "forward unknown by
/// default" property is what stops Toolport silently breaking future extensions
/// such as MCP Apps and Tasks.
#[test]
fn client_meta_reaches_downstream_server() {
    let received = relayed_meta(&json!({
        "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        "com.example/somethingWeHaveNeverSeen": { "nested": [1, 2, 3] },
        "io.modelcontextprotocol/tasks": { "taskId": "t-1" }
    }));

    assert_eq!(
        received["traceparent"],
        "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        "OTel trace context is explicitly meant to propagate across hops"
    );
    assert_eq!(
        received["com.example/somethingWeHaveNeverSeen"]["nested"][2], 3,
        "an unknown extension namespace must survive verbatim, got {received}"
    );
    assert_eq!(received["io.modelcontextprotocol/tasks"]["taskId"], "t-1");
}

/// The other half of relaying: keys that describe one hop must NOT be forwarded.
/// Toolport is the client on the downstream hop, so relaying the upstream
/// client's identity or capabilities would assert claims the gateway cannot
/// honour. SOU-445/SOU-446 replace these with Toolport's own values.
#[test]
fn per_hop_meta_keys_are_not_relayed() {
    let received = relayed_meta(&json!({
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { "name": "SomeOtherClient", "version": "9.9.9" },
        "io.modelcontextprotocol/clientCapabilities": { "sampling": {} },
        "keepMe": true
    }));

    for key in [
        "io.modelcontextprotocol/protocolVersion",
        "io.modelcontextprotocol/clientInfo",
        "io.modelcontextprotocol/clientCapabilities",
    ] {
        assert!(
            received.get(key).is_none(),
            "{key} is per-hop and must not be relayed, got {received}"
        );
    }
    assert_eq!(received["keepMe"], true, "non-per-hop keys still travel");
}

/// A request whose `_meta` is entirely per-hop must not gain an empty `_meta`
/// object. Downstream servers that never see client metadata keep receiving
/// byte-identical requests.
#[test]
fn fully_stripped_meta_leaves_no_empty_object() {
    let received = relayed_meta(&json!({
        "io.modelcontextprotocol/protocolVersion": "2026-07-28"
    }));
    assert!(
        received.is_null(),
        "no relayable keys should mean no _meta at all, got {received}"
    );
}

/// SOU-444 part 2. `progressToken` is relayed now that the gateway routes the
/// resulting `notifications/progress` back to the client that minted it.
#[test]
fn progress_token_reaches_downstream_server() {
    let received = relayed_meta(&json!({ "progressToken": "p-1" }));
    assert_eq!(received["progressToken"], "p-1");
}

/// The whole progress chain, not just its ends: a server emits
/// `notifications/progress` mid-call, the stdout drain recognises it, and the
/// bound sink receives it while the originating request is still in flight.
///
/// Before SOU-444 the drain dropped every notification it did not recognise, so
/// this traffic went nowhere.
#[test]
fn downstream_progress_notification_reaches_the_bound_sink() {
    let dirty = Arc::new(AtomicU8::new(0));
    let mut transport = StdioTransport::spawn_watched(mock_bin(), &[], &[], None, dirty, None)
        .expect("spawn fixture");

    let seen: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
    let sink_seen = Arc::clone(&seen);
    transport.set_progress_sink(Some(Arc::new(move |note: Value| {
        sink_seen
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(note);
    })));

    let mut server =
        DownstreamServer::connect("mock".to_string(), Box::new(transport)).expect("connect");

    let result = server
        .call_with_cancel(
            "progress_ping",
            json!({}),
            None,
            Some(&json!({ "progressToken": "tok-e2e" })),
        )
        .expect("progress_ping call");
    assert_eq!(result["isError"], false, "the call itself still succeeds");

    // The notification is emitted before the response, so by the time the call
    // returns the drain has already seen it.
    let got = seen.lock().unwrap_or_else(|e| e.into_inner()).clone();
    assert_eq!(got.len(), 1, "expected exactly one progress notification, got {got:?}");
    assert_eq!(got[0]["method"], "notifications/progress");
    assert_eq!(
        got[0]["params"]["progressToken"], "tok-e2e",
        "the token must round-trip so the gateway can route it back"
    );
    assert_eq!(got[0]["params"]["total"], 2);
}

/// SOU-445. A dual-era gateway must connect to a modern, stateless server: fall
/// forward from the rejected `initialize` to `server/discover`, then carry the
/// protocol `_meta` on every subsequent request.
#[test]
fn gateway_connects_to_a_modern_server() {
    let path = scratch_path("modern");
    let _ = std::fs::remove_file(&path);
    let env = env_for(Some(MODERN), true, Some(&path.to_string_lossy()));

    let dirty = Arc::new(AtomicU8::new(0));
    let transport = StdioTransport::spawn_watched(mock_bin(), &[], &env, None, dirty, None)
        .expect("spawn fixture");
    let mut server = DownstreamServer::connect("mock".to_string(), Box::new(transport))
        .expect("a dual-era gateway must connect to a modern server");

    assert!(server.era().is_modern(), "era should be detected as modern");
    assert_eq!(server.era().version(), MODERN);

    // The connection is not merely established: it is usable. The strict fixture
    // rejects any request lacking the protocol `_meta`, so a successful call
    // proves the transport is stamping every request, not just the handshake.
    let result = server.call("echo", json!({ "text": "hi" })).expect("call a modern server");
    assert_eq!(result["content"][0]["text"], "hi");
    assert_eq!(result["resultType"], "complete");
    drop(server);

    let transcript = read_transcript(&path);
    let methods = methods_of(&transcript);

    // `initialize` is attempted once and rejected; the fall-forward is what makes
    // the connection work. No `notifications/initialized` is ever sent.
    assert_eq!(methods.first().map(String::as_str), Some("initialize"));
    assert!(
        methods.iter().any(|m| m == "server/discover"),
        "must fall forward to server/discover, got {methods:?}"
    );
    assert!(
        !methods.iter().any(|m| m == "notifications/initialized"),
        "a modern server has no handshake to complete, got {methods:?}"
    );

    // Every post-handshake request carries its own protocol version and identity.
    for record in transcript.iter().filter(|r| r["method"] == "tools/list" || r["method"] == "tools/call")
    {
        let meta = &record["params"]["_meta"];
        assert_eq!(
            meta["io.modelcontextprotocol/protocolVersion"], MODERN,
            "every modern request declares its version, got {record}"
        );
        assert_eq!(
            meta["io.modelcontextprotocol/clientInfo"]["name"], "toolport-gateway",
            "Toolport identifies itself on the downstream hop, not the upstream client"
        );
    }

    let _ = std::fs::remove_file(&path);
}

/// The legacy path must be untouched by era detection: no extra probe, no
/// `server/discover`, and no protocol `_meta` on the wire. This is the
/// no-regression guarantee for the entire existing install base.
#[test]
fn legacy_servers_see_no_era_detection_traffic() {
    let path = scratch_path("legacy-era");
    let _ = std::fs::remove_file(&path);
    let env = env_for(Some("2025-06-18"), true, Some(&path.to_string_lossy()));

    let dirty = Arc::new(AtomicU8::new(0));
    let transport = StdioTransport::spawn_watched(mock_bin(), &[], &env, None, dirty, None)
        .expect("spawn fixture");
    let mut server =
        DownstreamServer::connect("mock".to_string(), Box::new(transport)).expect("connect");
    assert!(!server.era().is_modern());
    assert_eq!(server.era().version(), "2025-06-18");
    server.call("echo", json!({ "text": "hi" })).expect("call");
    drop(server);

    let transcript = read_transcript(&path);
    let methods = methods_of(&transcript);
    assert!(
        !methods.iter().any(|m| m == "server/discover"),
        "a legacy server must never be probed, got {methods:?}"
    );
    for record in &transcript {
        assert!(
            record["params"].get("_meta").is_none(),
            "legacy requests carry no protocol _meta, got {record}"
        );
    }

    let _ = std::fs::remove_file(&path);
}
