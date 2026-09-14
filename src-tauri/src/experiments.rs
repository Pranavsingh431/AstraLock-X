//! Persistent storage for experiment runs.
//!
//! Phase 5 needs runs to survive the application closing, on all three desktop
//! platforms, in a directory the operating system considers the right place for
//! application data. That is the whole job.
//!
//! It is implemented as a handful of narrow commands rather than by enabling a
//! general filesystem plugin. A plugin would grant the frontend the ability to
//! read and write wherever its scope allowed; these commands can only touch
//! files inside `<app data>/runs/<run id>/`, cannot traverse out of it, and
//! accept only the fixed set of file names an experiment consists of. The
//! smaller surface is worth the extra code.
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

/// The files an experiment run may contain.
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
];

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

/// Root directory for every run, created on first use.
fn runs_root(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("No application data directory: {error}"))?;
    let root = base.join("runs");
    fs::create_dir_all(&root)
        .map_err(|error| format!("Cannot create {}: {error}", root.display()))?;
    Ok(root)
}

/// Directory for one run, verified to sit inside the run root.
///
/// The identifier is already validated, so this is defence in depth rather than
/// the only check — but a path traversal that reached the user's home directory
/// would be a serious bug and the verification costs nothing.
fn run_dir(app: &AppHandle, run_id: &str) -> Result<PathBuf, String> {
    validate_run_id(run_id)?;
    let root = runs_root(app)?;
    let directory = root.join(run_id);

    if !directory.starts_with(&root) {
        return Err(format!("Run directory escapes the run root: {run_id}"));
    }
    Ok(directory)
}

fn file_path(app: &AppHandle, run_id: &str, file_name: &str) -> Result<PathBuf, String> {
    validate_file_name(file_name)?;
    Ok(run_dir(app, run_id)?.join(file_name))
}

#[tauri::command]
pub fn experiment_create_run(app: AppHandle, run_id: String) -> Result<String, String> {
    let directory = run_dir(&app, &run_id)?;
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Cannot create {}: {error}", directory.display()))?;
    Ok(directory.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn experiment_runs_root(app: AppHandle) -> Result<String, String> {
    Ok(runs_root(&app)?.to_string_lossy().into_owned())
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
) -> Result<(), String> {
    let target = file_path(&app, &run_id, &file_name)?;
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
) -> Result<(), String> {
    let target = file_path(&app, &run_id, &file_name)?;
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
) -> Result<String, String> {
    let target = file_path(&app, &run_id, &file_name)?;
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
) -> Result<Response, String> {
    let target = file_path(&app, &run_id, &file_name)?;
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
) -> Result<u64, String> {
    let target = file_path(&app, &run_id, &file_name)?;
    Ok(fs::metadata(&target).map(|meta| meta.len()).unwrap_or(0))
}

#[tauri::command]
pub fn experiment_list_runs(app: AppHandle) -> Result<Vec<String>, String> {
    let root = runs_root(&app)?;
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
pub fn experiment_delete_run(app: AppHandle, run_id: String) -> Result<(), String> {
    let directory = run_dir(&app, &run_id)?;
    if directory.exists() {
        fs::remove_dir_all(&directory)
            .map_err(|error| format!("Cannot delete {}: {error}", directory.display()))?;
    }
    Ok(())
}

#[tauri::command]
pub fn experiment_run_path(app: AppHandle, run_id: String) -> Result<String, String> {
    Ok(run_dir(&app, &run_id)?.to_string_lossy().into_owned())
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
pub fn experiment_reveal_run(app: AppHandle, run_id: String) -> Result<(), String> {
    let directory = run_dir(&app, &run_id)?;
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
pub fn experiment_open_report(app: AppHandle, run_id: String) -> Result<(), String> {
    let report = file_path(&app, &run_id, "report.html")?;
    if !report.is_file() {
        return Err(format!("Run {run_id} has no report"));
    }
    reveal(&report)
}

#[cfg(test)]
mod tests {
    use super::{read_chunk_from, validate_file_name, validate_run_id, write_atomic_to};
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
}
