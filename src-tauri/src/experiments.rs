//! Persistent storage for experiment runs.
//!
//! Phase 5 needs runs to survive the application closing, on all three desktop
//! platforms, in a directory the operating system considers the right place for
//! application data. That is the whole job.
//!
//! It is implemented as a handful of narrow commands rather than by enabling a
//! general filesystem plugin. A plugin would grant the frontend the ability to
//! read and write wherever its scope allowed; these commands can only touch
//! files inside `<app data>/<store>/<id>/`, cannot traverse out of it, and
//! accept only the fixed set of file names an experiment or a benchmark
//! consists of. The smaller surface is worth the extra code.
//!
//! Phase 9 added the second store. AstraBench writes a benchmark's own
//! documents — the suite it ran, the aggregate it computed, the report it
//! rendered — and those are not an experiment. They live in `benchmarks/`
//! rather than being given experiment-shaped identifiers in `runs/`, so that
//! listing runs still returns runs and nothing has to guess from a name what
//! kind of directory it found. `store` is an allowlist of two, not a path.
//!
//! Writes that must not tear — the manifest and the summary — go through
//! `write_atomic`, which writes a temporary file and renames it. A run that is
//! interrupted halfway leaves a manifest that still says `running`, which is
//! exactly what the Reports view needs in order not to present it as a result.

use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use tauri::ipc::Response;
use tauri::{AppHandle, Manager};

/// Largest chunk a single streaming read may return.
const MAX_CHUNK_BYTES: u32 = 8 << 20;

/// The files an experiment run or a benchmark directory may contain.
///
/// A fixed list rather than a pattern: the frontend never needs to invent a
/// file name, so accepting an arbitrary one would be surface with no purpose.
const ALLOWED_FILES: &[&str] = &[
    "manifest.json",
    "scenario.json",
    "algorithm.json",
    "events.jsonl",
    "telemetry.csv",
    "evaluation.csv",
    "summary.json",
    "report.html",
    // Benchmark documents (Phase 9).
    "suite.json",
    "aggregate.json",
];

/// The directories under the application data directory that may be written.
///
/// Two, both fixed. The parameter exists so experiments and benchmarks keep
/// separate namespaces; it is not a path and cannot become one.
const ALLOWED_STORES: &[&str] = &["runs", "benchmarks"];

/// Rejects any store that is not one of the two.
fn validate_store(store: &str) -> Result<(), String> {
    if ALLOWED_STORES.contains(&store) {
        Ok(())
    } else {
        Err(format!("Unknown store: {store}"))
    }
}

/// The store a command addresses, defaulting to runs.
///
/// Defaulted so that a frontend built before Phase 9 — or any caller that only
/// deals in experiments — keeps working without passing it.
fn store_or_runs(store: Option<String>) -> Result<String, String> {
    let name = store.unwrap_or_else(|| "runs".to_owned());
    validate_store(&name)?;
    Ok(name)
}

/// Rejects anything that is not a plain generated run identifier.
fn validate_run_id(run_id: &str) -> Result<(), String> {
    let acceptable = !run_id.is_empty()
        && run_id.len() <= 128
        && run_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');

    if acceptable {
        Ok(())
    } else {
        Err(format!("Unsafe run identifier: {run_id}"))
    }
}

fn validate_file_name(file_name: &str) -> Result<(), String> {
    if ALLOWED_FILES.contains(&file_name) {
        Ok(())
    } else {
        Err(format!("Not an experiment file: {file_name}"))
    }
}

/// Root directory for a store, created on first use.
fn store_root(app: &AppHandle, store: &str) -> Result<PathBuf, String> {
    validate_store(store)?;
    let base = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("No application data directory: {error}"))?;
    let root = base.join(store);
    fs::create_dir_all(&root)
        .map_err(|error| format!("Cannot create {}: {error}", root.display()))?;
    Ok(root)
}

/// Directory for one run, verified to sit inside the run root.
///
/// The identifier is already validated, so this is defence in depth rather than
/// the only check — but a path traversal that reached the user's home directory
/// would be a serious bug and the verification costs nothing.
fn run_dir(app: &AppHandle, store: &str, run_id: &str) -> Result<PathBuf, String> {
    validate_run_id(run_id)?;
    let root = store_root(app, store)?;
    let directory = root.join(run_id);

    if !directory.starts_with(&root) {
        return Err(format!("Run directory escapes the store root: {run_id}"));
    }
    Ok(directory)
}

fn file_path(
    app: &AppHandle,
    store: &str,
    run_id: &str,
    file_name: &str,
) -> Result<PathBuf, String> {
    validate_file_name(file_name)?;
    Ok(run_dir(app, store, run_id)?.join(file_name))
}

#[tauri::command]
pub fn experiment_create_run(
    app: AppHandle,
    run_id: String,
    store: Option<String>,
) -> Result<String, String> {
    let store = store_or_runs(store)?;
    let directory = run_dir(&app, &store, &run_id)?;
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Cannot create {}: {error}", directory.display()))?;
    Ok(directory.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn experiment_runs_root(app: AppHandle, store: Option<String>) -> Result<String, String> {
    let store = store_or_runs(store)?;
    Ok(store_root(&app, &store)?.to_string_lossy().into_owned())
}

/// Replaces a file's contents: write a temporary file, flush it, rename it.
///
/// `rename` replaces the target atomically on all three platforms (on Windows
/// the standard library uses `MoveFileExW` with `MOVEFILE_REPLACE_EXISTING`).
/// The flush first matters as much: without it a power loss can leave the
/// renamed file present but empty.
#[tauri::command]
pub fn experiment_write_atomic(
    app: AppHandle,
    run_id: String,
    file_name: String,
    contents: String,
    store: Option<String>,
) -> Result<(), String> {
    let store = store_or_runs(store)?;
    let target = file_path(&app, &store, &run_id, &file_name)?;
    write_atomic_to(&target, contents.as_bytes())
}

/// The atomic write itself, independent of the application handle.
fn write_atomic_to(target: &Path, contents: &[u8]) -> Result<(), String> {
    let mut temporary_name = target.as_os_str().to_owned();
    temporary_name.push(".tmp");
    let temporary = PathBuf::from(temporary_name);

    let mut file = fs::File::create(&temporary)
        .map_err(|error| format!("Cannot write {}: {error}", temporary.display()))?;
    file.write_all(contents)
        .and_then(|()| file.sync_all())
        .map_err(|error| format!("Cannot write {}: {error}", temporary.display()))?;
    drop(file);

    fs::rename(&temporary, target)
        .map_err(|error| format!("Cannot finalise {}: {error}", target.display()))?;
    Ok(())
}

#[tauri::command]
pub fn experiment_append(
    app: AppHandle,
    run_id: String,
    file_name: String,
    contents: String,
    store: Option<String>,
) -> Result<(), String> {
    let store = store_or_runs(store)?;
    let target = file_path(&app, &store, &run_id, &file_name)?;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&target)
        .map_err(|error| format!("Cannot open {}: {error}", target.display()))?;
    file.write_all(contents.as_bytes())
        .map_err(|error| format!("Cannot append to {}: {error}", target.display()))?;
    Ok(())
}

#[tauri::command]
pub fn experiment_read_file(
    app: AppHandle,
    run_id: String,
    file_name: String,
    store: Option<String>,
) -> Result<String, String> {
    let store = store_or_runs(store)?;
    let target = file_path(&app, &store, &run_id, &file_name)?;
    fs::read_to_string(&target)
        .map_err(|error| format!("Cannot read {}: {error}", target.display()))
}

/// Reads up to `length` bytes of a file starting at `offset`, as raw bytes.
///
/// For streaming a long run's sample files without moving them across the IPC
/// boundary as one string. Bytes, not text, because a chunk boundary can fall
/// inside a multi-byte character; the frontend decodes with a streaming
/// decoder. A short read means the end of the file.
#[tauri::command]
pub fn experiment_read_chunk(
    app: AppHandle,
    run_id: String,
    file_name: String,
    offset: u64,
    length: u32,
    store: Option<String>,
) -> Result<Response, String> {
    let store = store_or_runs(store)?;
    let target = file_path(&app, &store, &run_id, &file_name)?;
    Ok(Response::new(read_chunk_from(&target, offset, length)?))
}

/// The ranged read itself, independent of the application handle.
fn read_chunk_from(target: &Path, offset: u64, length: u32) -> Result<Vec<u8>, String> {
    let mut file = fs::File::open(target)
        .map_err(|error| format!("Cannot read {}: {error}", target.display()))?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| format!("Cannot seek {}: {error}", target.display()))?;

    let limit = length.min(MAX_CHUNK_BYTES);
    let mut buffer = Vec::with_capacity(limit as usize);
    file.take(u64::from(limit))
        .read_to_end(&mut buffer)
        .map_err(|error| format!("Cannot read {}: {error}", target.display()))?;
    Ok(buffer)
}

#[tauri::command]
pub fn experiment_file_size(
    app: AppHandle,
    run_id: String,
    file_name: String,
    store: Option<String>,
) -> Result<u64, String> {
    let store = store_or_runs(store)?;
    let target = file_path(&app, &store, &run_id, &file_name)?;
    Ok(fs::metadata(&target).map(|meta| meta.len()).unwrap_or(0))
}

#[tauri::command]
pub fn experiment_list_runs(app: AppHandle, store: Option<String>) -> Result<Vec<String>, String> {
    let store = store_or_runs(store)?;
    let root = store_root(&app, &store)?;
    let mut ids: Vec<String> = fs::read_dir(&root)
        .map_err(|error| format!("Cannot list {}: {error}", root.display()))?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| validate_run_id(name).is_ok())
        .collect();

    // Run identifiers begin with a sortable timestamp, so this is newest first.
    ids.sort();
    ids.reverse();
    Ok(ids)
}

#[tauri::command]
pub fn experiment_delete_run(
    app: AppHandle,
    run_id: String,
    store: Option<String>,
) -> Result<(), String> {
    let store = store_or_runs(store)?;
    let directory = run_dir(&app, &store, &run_id)?;
    if directory.exists() {
        fs::remove_dir_all(&directory)
            .map_err(|error| format!("Cannot delete {}: {error}", directory.display()))?;
    }
    Ok(())
}

#[tauri::command]
pub fn experiment_run_path(
    app: AppHandle,
    run_id: String,
    store: Option<String>,
) -> Result<String, String> {
    let store = store_or_runs(store)?;
    Ok(run_dir(&app, &store, &run_id)?
        .to_string_lossy()
        .into_owned())
}

/// Opens a path with the platform's default handler: a directory in the file
/// manager, an HTML file in the default browser.
fn reveal(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    #[cfg(target_os = "windows")]
    let mut command = std::process::Command::new("explorer");
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = std::process::Command::new("xdg-open");

    command
        .arg(path)
        .spawn()
        .map_err(|error| format!("Cannot open {}: {error}", path.display()))?;
    Ok(())
}

#[tauri::command]
pub fn experiment_reveal_run(
    app: AppHandle,
    run_id: String,
    store: Option<String>,
) -> Result<(), String> {
    let store = store_or_runs(store)?;
    let directory = run_dir(&app, &store, &run_id)?;
    if !directory.exists() {
        return Err(format!("No such run: {run_id}"));
    }
    reveal(&directory)
}

/// Opens a completed run's `report.html` in the default browser.
///
/// The file on disk, not a copy rendered in the webview: the report the
/// operator reads is exactly the artifact in the run directory.
#[tauri::command]
pub fn experiment_open_report(
    app: AppHandle,
    run_id: String,
    store: Option<String>,
) -> Result<(), String> {
    let store = store_or_runs(store)?;
    let report = file_path(&app, &store, &run_id, "report.html")?;
    if !report.is_file() {
        return Err(format!("Run {run_id} has no report"));
    }
    reveal(&report)
}

#[cfg(test)]
mod tests {
    use super::{
        read_chunk_from, store_or_runs, validate_file_name, validate_run_id, validate_store,
        write_atomic_to,
    };
    use std::fs;
    use std::path::PathBuf;

    /// A fresh directory under the system temporary directory.
    fn scratch(name: &str) -> PathBuf {
        let directory =
            std::env::temp_dir().join(format!("astralock-rust-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).expect("scratch directory");
        directory
    }

    #[test]
    fn atomic_write_replaces_contents_and_leaves_no_temporary_file() {
        let directory = scratch("atomic");
        let target = directory.join("manifest.json");
        write_atomic_to(&target, b"{\"status\":\"running\"}").expect("first write");
        write_atomic_to(&target, b"{\"status\":\"completed\"}").expect("replacing write");

        assert_eq!(
            fs::read_to_string(&target).expect("read back"),
            "{\"status\":\"completed\"}"
        );
        let names: Vec<String> = fs::read_dir(&directory)
            .expect("list")
            .map(|entry| {
                entry
                    .expect("entry")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        assert_eq!(names, vec!["manifest.json".to_string()]);
        fs::remove_dir_all(&directory).expect("cleanup");
    }

    #[test]
    fn chunked_reads_reassemble_the_file_exactly_including_multibyte_text() {
        let directory = scratch("chunks");
        let target = directory.join("events.jsonl");
        let contents = "µrad,1\nline two\n".repeat(200);
        fs::write(&target, &contents).expect("write");

        for chunk in [1_u32, 3, 7, 64, 4096] {
            let mut assembled = Vec::new();
            let mut offset = 0_u64;
            loop {
                let piece = read_chunk_from(&target, offset, chunk).expect("chunk");
                offset += piece.len() as u64;
                let last = piece.len() < chunk as usize;
                assembled.extend(piece);
                if last {
                    break;
                }
            }
            assert_eq!(assembled, contents.as_bytes(), "chunk size {chunk}");
        }
        fs::remove_dir_all(&directory).expect("cleanup");
    }

    #[test]
    fn accepts_a_generated_run_id() {
        assert!(validate_run_id("run-20260101T000000Z-a1b2c").is_ok());
    }

    #[test]
    fn rejects_traversal_and_separators() {
        for candidate in ["..", "../escape", "a/b", "a\\b", "", "run id"] {
            assert!(
                validate_run_id(candidate).is_err(),
                "should reject {candidate:?}"
            );
        }
    }

    #[test]
    fn accepts_only_experiment_files() {
        assert!(validate_file_name("summary.json").is_ok());
        for candidate in ["../../secrets", "id_rsa", "summary.json.tmp", ""] {
            assert!(
                validate_file_name(candidate).is_err(),
                "should reject {candidate:?}"
            );
        }
    }

    #[test]
    fn accepts_the_benchmark_documents() {
        // Phase 9 added two file names, and only two.
        assert!(validate_file_name("suite.json").is_ok());
        assert!(validate_file_name("aggregate.json").is_ok());
    }

    #[test]
    fn accepts_only_the_two_stores() {
        assert!(validate_store("runs").is_ok());
        assert!(validate_store("benchmarks").is_ok());
        // Not a path, and cannot be made into one.
        for candidate in ["", "..", "../runs", "Runs", "runs/", "/etc", "secrets"] {
            assert!(
                validate_store(candidate).is_err(),
                "should reject {candidate:?}"
            );
        }
    }

    #[test]
    fn defaults_to_the_run_store() {
        // A caller that predates the parameter keeps addressing experiments.
        assert_eq!(store_or_runs(None).unwrap(), "runs");
        assert_eq!(
            store_or_runs(Some("benchmarks".to_owned())).unwrap(),
            "benchmarks"
        );
        assert!(store_or_runs(Some("elsewhere".to_owned())).is_err());
    }
}
