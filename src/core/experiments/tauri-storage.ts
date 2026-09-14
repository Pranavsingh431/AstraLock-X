/**
 * Experiment storage backed by the desktop host.
 *
 * Talks to the narrow Rust commands in `src-tauri/src/experiments.rs`, which
 * can only reach `<app data>/runs/<run id>/`. The operating system decides
 * where that is — `%APPDATA%\dev.astralock.x` on Windows,
 * `~/Library/Application Support/dev.astralock.x` on macOS,
 * `$XDG_DATA_HOME/dev.astralock.x` (usually `~/.local/share/...`) on Linux — so
 * nothing here hardcodes a path, and no elevated permission is needed.
 *
 * Every method is the same shape as the in-memory and filesystem
 * implementations, which is what lets the metrics and the recorder be tested in
 * plain Node and then run unchanged in the application.
 */

import { invoke } from '@tauri-apps/api/core';

import { LineSplitter } from './storage';
import type { ExperimentStorage, RunLocation } from './storage';

/** Bytes per IPC round trip when streaming a file. */
const READ_CHUNK_BYTES = 1 << 20;

/** Whether the application is running inside the Tauri host. */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export class TauriStorage implements ExperimentStorage {
  /**
   * Cached absolute paths, so `runPath` can stay synchronous.
   *
   * The interface shows the run directory to the operator from a render, which
   * cannot await, so the path is remembered when the run is created or listed.
   */
  private readonly paths = new Map<string, string>();

  public async createRun(runId: string): Promise<RunLocation> {
    const path = await invoke<string>('experiment_create_run', { runId });
    this.paths.set(runId, path);
    return { runId, path };
  }

  public async writeAtomic(runId: string, fileName: string, contents: string): Promise<void> {
    await invoke('experiment_write_atomic', { runId, fileName, contents });
  }

  public async append(runId: string, fileName: string, contents: string): Promise<void> {
    await invoke('experiment_append', { runId, fileName, contents });
  }

  public async readFile(runId: string, fileName: string): Promise<string> {
    return invoke<string>('experiment_read_file', { runId, fileName });
  }

  /**
   * Streams a file in raw byte chunks.
   *
   * Bytes rather than strings, decoded here with a streaming decoder, because a
   * chunk boundary can fall inside a multi-byte character and a string-typed
   * IPC reply cannot represent half of one.
   */
  public async readLines(
    runId: string,
    fileName: string,
    onLine: (line: string) => void,
  ): Promise<void> {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const splitter = new LineSplitter(onLine);
    let offset = 0;

    for (;;) {
      const chunk = new Uint8Array(
        await invoke<ArrayBuffer>('experiment_read_chunk', {
          runId,
          fileName,
          offset,
          length: READ_CHUNK_BYTES,
        }),
      );
      offset += chunk.byteLength;
      const last = chunk.byteLength < READ_CHUNK_BYTES;
      splitter.push(decoder.decode(chunk, { stream: !last }));
      if (last) break;
    }
    splitter.end();
  }

  public async fileSize(runId: string, fileName: string): Promise<number> {
    return invoke<number>('experiment_file_size', { runId, fileName });
  }

  public async listRuns(): Promise<readonly string[]> {
    return invoke<string[]>('experiment_list_runs');
  }

  public async deleteRun(runId: string): Promise<void> {
    await invoke('experiment_delete_run', { runId });
    this.paths.delete(runId);
  }

  public runPath(runId: string): string | null {
    return this.paths.get(runId) ?? null;
  }

  /** Resolves and caches a run's absolute path without creating it. */
  public async resolvePath(runId: string): Promise<string> {
    const path = await invoke<string>('experiment_run_path', { runId });
    this.paths.set(runId, path);
    return path;
  }

  /** The directory every run lives under, for display. */
  public async runsRoot(): Promise<string> {
    return invoke<string>('experiment_runs_root');
  }

  /** Opens the run's directory in the platform file manager. */
  public async reveal(runId: string): Promise<void> {
    await invoke('experiment_reveal_run', { runId });
  }

  /**
   * Opens the run's `report.html` with the platform's default handler.
   *
   * The host opens the file from disk rather than the webview rendering a copy,
   * so what the operator sees is exactly the artifact in the run directory.
   */
  public async openReport(runId: string): Promise<void> {
    await invoke('experiment_open_report', { runId });
  }
}

/**
 * Storage that refuses to pretend.
 *
 * Used when the application runs in a plain browser — `pnpm dev` without the
 * desktop host. Recording is genuinely unavailable there, and saying so is
 * better than writing to `localStorage` and calling it an experiment archive.
 */
export class UnavailableStorage implements ExperimentStorage {
  public static readonly reason =
    'Experiment recording needs the desktop application: a browser tab has nowhere durable to write run artifacts.';

  public createRun(): Promise<RunLocation> {
    return Promise.reject(new Error(UnavailableStorage.reason));
  }
  public writeAtomic(): Promise<void> {
    return Promise.reject(new Error(UnavailableStorage.reason));
  }
  public append(): Promise<void> {
    return Promise.reject(new Error(UnavailableStorage.reason));
  }
  public readFile(): Promise<string> {
    return Promise.reject(new Error(UnavailableStorage.reason));
  }
  public readLines(): Promise<void> {
    return Promise.reject(new Error(UnavailableStorage.reason));
  }
  public fileSize(): Promise<number> {
    return Promise.resolve(0);
  }
  public listRuns(): Promise<readonly string[]> {
    return Promise.resolve([]);
  }
  public deleteRun(): Promise<void> {
    return Promise.reject(new Error(UnavailableStorage.reason));
  }
  public runPath(): string | null {
    return null;
  }
}

/** The right storage for wherever the application is running. */
export function createStorage(): ExperimentStorage {
  return isTauri() ? new TauriStorage() : new UnavailableStorage();
}
