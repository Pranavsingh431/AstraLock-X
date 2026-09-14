//! AstraLock-X desktop host.
//!
//! At Phase 0 this crate does one job: create the window that hosts the
//! frontend. The simulation core is TypeScript for now (see
//! `docs/adr/0005-typescript-core-with-rust-later.md`), and Rust takes over
//! specific hot paths only when profiling shows it is warranted. Keeping the
//! host minimal until then avoids an IPC boundary that buys nothing.

/// Builds and runs the application.
///
/// # Panics
///
/// Panics if the webview cannot be created, which is unrecoverable: without a
/// window there is no application to run.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("failed to start the AstraLock-X window");
}
