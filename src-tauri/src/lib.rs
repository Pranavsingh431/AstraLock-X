//! AstraLock-X desktop host.
//!
//! The simulation core is TypeScript (see
//! `docs/adr/0005-typescript-core-with-rust-later.md`), and Rust takes over
//! specific hot paths only when profiling shows it is warranted. None has yet.
//!
//! What the host does own is the things a webview cannot: the window, and — from
//! Phase 5 — persistent storage for experiment runs in the operating system's
//! application-data directory. Storage is a set of narrow commands rather than a
//! general filesystem plugin, so the frontend can reach the run directory and
//! nothing else.

mod experiments;

/// Builds and runs the application.
///
/// # Panics
///
/// Panics if the webview cannot be created, which is unrecoverable: without a
/// window there is no application to run.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            experiments::experiment_create_run,
            experiments::experiment_write_atomic,
            experiments::experiment_append,
            experiments::experiment_read_file,
            experiments::experiment_read_chunk,
            experiments::experiment_file_size,
            experiments::experiment_list_runs,
            experiments::experiment_delete_run,
            experiments::experiment_run_path,
            experiments::experiment_reveal_run,
            experiments::experiment_open_report,
            experiments::experiment_runs_root,
        ])
        .run(tauri::generate_context!())
        .expect("failed to start the AstraLock-X window");
}
