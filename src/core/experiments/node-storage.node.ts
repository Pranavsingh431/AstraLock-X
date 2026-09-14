/**
 * Filesystem storage for headless runs and tests.
 *
 * Node-only, kept in its own module so the experiment core never imports
 * `node:fs` and stays usable in the browser and under Tauri.
 */

import { createReadStream } from 'node:fs';
import { appendFile, mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { LineSplitter } from './storage';
import type { ExperimentStorage, RunLocation } from './storage';

export class NodeFileStorage implements ExperimentStorage {
  constructor(private readonly root: string) {}

  public async createRun(runId: string): Promise<RunLocation> {
    const path = this.directory(runId);
    await mkdir(path, { recursive: true });
    return { runId, path };
  }

  /**
   * Write, flush to disk, then rename.
   *
   * `rename` within a directory replaces the target atomically on every
   * platform this runs on, so a reader sees either the previous contents or the
   * complete new ones. The flush before it matters too: without it a power
   * loss can leave the renamed file present but empty on some filesystems.
   */
  public async writeAtomic(runId: string, fileName: string, contents: string): Promise<void> {
    const target = join(this.directory(runId), fileName);
    const temporary = `${target}.tmp`;
    const handle = await open(temporary, 'w');
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
  }

  public async append(runId: string, fileName: string, contents: string): Promise<void> {
    await appendFile(join(this.directory(runId), fileName), contents, 'utf8');
  }

  public async readFile(runId: string, fileName: string): Promise<string> {
    return readFile(join(this.directory(runId), fileName), 'utf8');
  }

  public async readLines(
    runId: string,
    fileName: string,
    onLine: (line: string) => void,
  ): Promise<void> {
    const splitter = new LineSplitter(onLine);
    const stream = createReadStream(join(this.directory(runId), fileName), {
      encoding: 'utf8',
      highWaterMark: 1 << 20,
    });
    for await (const chunk of stream) splitter.push(chunk as string);
    splitter.end();
  }

  public async fileSize(runId: string, fileName: string): Promise<number> {
    try {
      return (await stat(join(this.directory(runId), fileName))).size;
    } catch {
      return 0;
    }
  }

  public async listRuns(): Promise<readonly string[]> {
    try {
      const entries = await readdir(this.root, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
        .reverse();
    } catch {
      return [];
    }
  }

  public async deleteRun(runId: string): Promise<void> {
    await rm(this.directory(runId), { recursive: true, force: true });
  }

  public runPath(runId: string): string {
    return this.directory(runId);
  }

  private directory(runId: string): string {
    // Run ids are generated, not user-supplied, but a traversal here would
    // write outside the run root and that is worth one line to prevent.
    if (!/^[A-Za-z0-9_-]+$/.test(runId)) throw new Error(`Unsafe run id: ${runId}`);
    return resolve(this.root, runId);
  }
}
