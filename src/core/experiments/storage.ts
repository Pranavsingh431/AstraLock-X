/**
 * Where experiment artifacts go.
 *
 * The experiment core must run in a plain Node test, in a browser and inside
 * Tauri, so it does not know what a file is. It knows this interface, and the
 * three implementations that satisfy it live at the edges: in memory for tests,
 * on the filesystem for headless runs, and behind Tauri's API for the desktop
 * application.
 *
 * Two properties matter more than the API shape.
 *
 * **Appends are ordered.** The recorder writes events and samples as a stream;
 * an implementation that reordered or interleaved them would corrupt the log
 * silently.
 *
 * **Critical writes are atomic.** A manifest or a summary half-written by a
 * process that died is worse than one that is missing: it reads as valid. Those
 * go through `writeAtomic`, which writes a temporary file and renames it, so a
 * reader sees either the old content or the new one and never a fragment.
 */

/** A run's identity and where its files live. */
export interface RunLocation {
  readonly runId: string;
  /** Implementation-defined; shown in the interface so a user can find it. */
  readonly path: string;
}

export interface ExperimentStorage {
  /** Creates the directory for a run and returns where it went. */
  createRun(runId: string): Promise<RunLocation>;

  /**
   * Replaces a file's entire contents, atomically.
   *
   * For the manifest and the summary: a torn write of either produces a
   * directory that looks like a valid completed experiment and is not one.
   */
  writeAtomic(runId: string, fileName: string, contents: string): Promise<void>;

  /** Appends to a file, creating it if needed. Order is preserved. */
  append(runId: string, fileName: string, contents: string): Promise<void>;

  /** Reads a whole file. For the small JSON artifacts; use `readLines` for samples. */
  readFile(runId: string, fileName: string): Promise<string>;

  /**
   * Streams a file line by line, in order, without holding it in memory.
   *
   * The sample files of a long run are far larger than anything should hold as
   * one string, and the summary and report are computed by streaming them. The
   * callback receives each line without its terminator; a final line with no
   * terminator is delivered too.
   */
  readLines(runId: string, fileName: string, onLine: (line: string) => void): Promise<void>;

  /** Byte length of a file, for the size reporting in the Reports view. */
  fileSize(runId: string, fileName: string): Promise<number>;

  /** Every run id present, newest first where the implementation can tell. */
  listRuns(): Promise<readonly string[]>;

  deleteRun(runId: string): Promise<void>;

  /** Absolute location of a run, for "open folder". `null` when there isn't one. */
  runPath(runId: string): string | null;
}

/** Names of the files in a run directory. Fixed, so a reader knows what to look for. */
export const RUN_FILES = {
  manifest: 'manifest.json',
  scenario: 'scenario.json',
  algorithm: 'algorithm.json',
  events: 'events.jsonl',
  telemetry: 'telemetry.csv',
  evaluation: 'evaluation.csv',
  summary: 'summary.json',
  report: 'report.html',
} as const;

/**
 * In-memory storage, for tests and for a headless run that wants no files.
 *
 * Behaves like the real thing in every respect the recorder can observe,
 * including rejecting reads of files that were never written — a test that
 * silently got an empty string back would pass while the recorder was broken.
 */
export class MemoryStorage implements ExperimentStorage {
  private readonly runs = new Map<string, Map<string, string>>();

  public createRun(runId: string): Promise<RunLocation> {
    if (this.runs.has(runId)) {
      return Promise.reject(new Error(`Run ${runId} already exists`));
    }
    this.runs.set(runId, new Map());
    return Promise.resolve({ runId, path: `memory://${runId}` });
  }

  public writeAtomic(runId: string, fileName: string, contents: string): Promise<void> {
    this.filesFor(runId).set(fileName, contents);
    return Promise.resolve();
  }

  public append(runId: string, fileName: string, contents: string): Promise<void> {
    const files = this.filesFor(runId);
    files.set(fileName, (files.get(fileName) ?? '') + contents);
    return Promise.resolve();
  }

  public readFile(runId: string, fileName: string): Promise<string> {
    const contents = this.filesFor(runId).get(fileName);
    if (contents === undefined) {
      return Promise.reject(new Error(`No such file: ${runId}/${fileName}`));
    }
    return Promise.resolve(contents);
  }

  public async readLines(
    runId: string,
    fileName: string,
    onLine: (line: string) => void,
  ): Promise<void> {
    const contents = await this.readFile(runId, fileName);
    forEachLine(contents, onLine);
  }

  public fileSize(runId: string, fileName: string): Promise<number> {
    const contents = this.filesFor(runId).get(fileName);
    return Promise.resolve(contents === undefined ? 0 : new TextEncoder().encode(contents).length);
  }

  public listRuns(): Promise<readonly string[]> {
    return Promise.resolve([...this.runs.keys()].reverse());
  }

  public deleteRun(runId: string): Promise<void> {
    this.runs.delete(runId);
    return Promise.resolve();
  }

  public runPath(): string | null {
    return null;
  }

  private filesFor(runId: string): Map<string, string> {
    const files = this.runs.get(runId);
    if (files === undefined) throw new Error(`No such run: ${runId}`);
    return files;
  }
}

/**
 * Calls `onLine` for each line of a string, without building an array of them.
 *
 * Shared by the storage implementations so every one of them agrees on what a
 * line is: `\n`-terminated, a trailing `\r` removed, a final unterminated line
 * included, and nothing after a final terminator.
 */
export function forEachLine(contents: string, onLine: (line: string) => void): void {
  let start = 0;
  for (;;) {
    const end = contents.indexOf('\n', start);
    if (end === -1) {
      if (start < contents.length) onLine(stripCarriageReturn(contents.slice(start)));
      return;
    }
    onLine(stripCarriageReturn(contents.slice(start, end)));
    start = end + 1;
  }
}

const stripCarriageReturn = (line: string): string =>
  line.endsWith('\r') ? line.slice(0, -1) : line;

/**
 * Splits a stream of text chunks into lines, carrying a partial line between
 * chunks. For implementations that read a file in pieces.
 */
export class LineSplitter {
  private pending = '';

  constructor(private readonly onLine: (line: string) => void) {}

  public push(chunk: string): void {
    const text = this.pending + chunk;
    const last = text.lastIndexOf('\n');
    if (last === -1) {
      this.pending = text;
      return;
    }
    forEachLine(text.slice(0, last), this.onLine);
    this.pending = text.slice(last + 1);
  }

  public end(): void {
    if (this.pending.length > 0) this.onLine(stripCarriageReturn(this.pending));
    this.pending = '';
  }
}
