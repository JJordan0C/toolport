//! Regression guard for append-mode log permissions (SBS-868).
//!
//! Ten log writers opened their file with a bare
//! `OpenOptions::new().create(true).append(true)`, which takes the process umask
//! and lands 0644 under the usual 022. They only became owner-only on their
//! FIRST size-triggered rotation, because rotation goes through
//! `registry::atomic_write`, which sets the mode before writing. So each one was
//! readable by a second OS user from creation until its first rotation.
//!
//! That mattered most for `gateway.log`: it carries the line
//! `[broker] bound 127.0.0.1:<port>; endpoint published at <path>`, which
//! publishes the HITL broker's port. The 0600 on `approval-endpoint.json` was
//! the control meant to keep another OS user out, and this log routed around it.
//!
//! Every production writer now goes through `registry::open_append_private`,
//! which applies the mode AT creation - setting it afterwards would leave a
//! window in which the file exists world-readable.

use std::path::{Path, PathBuf};

/// The only files allowed to spell the raw append-open themselves: the helper
/// that defines the safe pattern, and a test-only binary that writes a
/// transcript into a temp dir.
const EXEMPT: [&str; 2] = ["registry.rs", "mock-mcp-server.rs"];

fn rust_sources(dir: &Path, out: &mut Vec<PathBuf>) {
    let entries = std::fs::read_dir(dir).unwrap_or_else(|e| panic!("read {}: {e}", dir.display()));
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            rust_sources(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

#[test]
fn no_production_log_opens_append_mode_directly() {
    let src = PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/src"));
    let mut files = Vec::new();
    rust_sources(&src, &mut files);
    assert!(!files.is_empty(), "no sources found under {}", src.display());

    let mut offenders = Vec::new();
    for file in files {
        let name = file.file_name().unwrap().to_string_lossy().to_string();
        if EXEMPT.contains(&name.as_str()) {
            continue;
        }
        let text = std::fs::read_to_string(&file).unwrap_or_else(|e| panic!("read {file:?}: {e}"));
        if text.contains(".append(true)") {
            offenders.push(name);
        }
    }
    assert!(
        offenders.is_empty(),
        "these files open an append-mode log directly, so it is created \
         world-readable under the usual umask (SBS-868): {offenders:?}. Use \
         registry::open_append_private instead."
    );
}

/// The helper's actual effect, which the source scan above cannot check.
#[cfg(unix)]
#[test]
fn open_append_private_creates_an_owner_only_file() {
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;

    let dir = std::env::temp_dir().join(format!("toolport-sbs868-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let path = dir.join("gateway.log");
    let _ = std::fs::remove_file(&path);

    let mut file = conduit_lib::registry::open_append_private(&path).expect("create log");
    file.write_all(b"[broker] bound 127.0.0.1:54321\n").expect("write");

    let mode = std::fs::metadata(&path).expect("stat").permissions().mode() & 0o777;
    assert_eq!(
        mode, 0o600,
        "the log was created {mode:o}, so a second OS user can read the broker port"
    );

    // Appending again must not widen it either.
    let mut again = conduit_lib::registry::open_append_private(&path).expect("reopen log");
    again.write_all(b"second line\n").expect("write");
    let mode = std::fs::metadata(&path).expect("stat").permissions().mode() & 0o777;
    assert_eq!(mode, 0o600, "reopening widened the mode to {mode:o}");

    let _ = std::fs::remove_dir_all(&dir);
}
