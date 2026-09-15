/**
 * Reading and writing the raw sample files.
 *
 * Three decisions here are load-bearing.
 *
 * **Precision is chosen, not inherited.** A non-integer is written with 17
 * significant digits (`toExponential(16)`), the shortest form guaranteed to
 * parse back to the identical IEEE double. These files are the input to
 * `recomputeSummary`, and a value rounded to the three decimals that look tidy
 * in a table cannot reproduce the statistic it contributed to. Integers are
 * written plainly because they are already exact. The human-readable report
 * rounds; the machine-readable record does not.
 *
 * **Column names carry units, and the schema decides each column's kind.** A
 * column is a number, a nullable number, a boolean or a word because the zod
 * schema says so — not because a separate list here says so, which could drift
 * from the schema without anyone noticing. Every parsed row is then validated.
 *
 * **Files are read a line at a time.** A long run produces files far larger
 * than anyone should hold as one string, so parsing is incremental: the caller
 * feeds lines and receives validated rows, and nothing retains the text.
 */

import type { z } from 'zod';

import {
  EVALUATION_V3_COLUMNS,
  TELEMETRY_V2_COLUMNS,
  TELEMETRY_V3_COLUMNS,
  evaluationSampleSchema,
  experimentEventSchema,
  telemetrySampleSchema,
} from './schema';
import type { EvaluationSample, ExperimentEvent, TelemetrySample } from './schema';

type ColumnKind = 'number' | 'nullable-number' | 'boolean' | 'text';

interface Column {
  readonly name: string;
  readonly kind: ColumnKind;
}

/** Reads each column's kind from the schema itself. */
function columnsOf(schema: z.ZodObject): readonly Column[] {
  return Object.entries(schema.shape).map(([name, field]) => {
    const def = (field as z.ZodType).def as { type: string; innerType?: z.ZodType };
    if (def.type === 'number') return { name, kind: 'number' as const };
    if (def.type === 'boolean') return { name, kind: 'boolean' as const };
    if (def.type === 'string') return { name, kind: 'text' as const };
    if (def.type === 'nullable' && def.innerType?.def.type === 'number') {
      return { name, kind: 'nullable-number' as const };
    }
    throw new TypeError(`Column ${name} has a type a CSV row cannot carry: ${def.type}`);
  });
}

export const TELEMETRY_COLUMNS = columnsOf(telemetrySampleSchema);
/** The telemetry columns a schema-v1 (Phase 5) file has. */
export const TELEMETRY_V1_COLUMNS = TELEMETRY_COLUMNS.filter(
  (column) =>
    !(TELEMETRY_V2_COLUMNS as readonly string[]).includes(column.name) &&
    !(TELEMETRY_V3_COLUMNS as readonly string[]).includes(column.name),
);
/** The telemetry columns a schema-v2 (Phase 6, Phase 7) file has. */
export const TELEMETRY_V2_ONLY_COLUMNS = TELEMETRY_COLUMNS.filter(
  (column) => !(TELEMETRY_V3_COLUMNS as readonly string[]).includes(column.name),
);
export const EVALUATION_COLUMNS = columnsOf(evaluationSampleSchema);
/** The evaluation columns a schema-v1 or v2 (Phase 5, Phase 6) file has. */
export const EVALUATION_PRE_V3_COLUMNS = EVALUATION_COLUMNS.filter(
  (column) => !(EVALUATION_V3_COLUMNS as readonly string[]).includes(column.name),
);

/** Exact text for a double. */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    // A non-finite value is a bug upstream, and writing "NaN" into an archival
    // record would turn it into data.
    throw new RangeError(`Refusing to write a non-finite number: ${String(value)}`);
  }
  if (Object.is(value, -0)) return '-0';
  return Number.isInteger(value) ? String(value) : value.toExponential(16);
}

function cell(column: Column, value: unknown): string {
  switch (column.kind) {
    case 'number':
      if (typeof value !== 'number') break;
      return formatNumber(value);
    case 'nullable-number':
      if (value === null) return '';
      if (typeof value !== 'number') break;
      return formatNumber(value);
    case 'boolean':
      if (typeof value !== 'boolean') break;
      return value ? '1' : '0';
    case 'text':
      if (typeof value !== 'string') break;
      // Words only. Quoting rules are where CSV writers and readers disagree,
      // so a value that would need quoting is refused rather than escaped.
      if (/[,"\r\n]/.test(value)) {
        throw new RangeError(`Column ${column.name} cannot hold ${JSON.stringify(value)}`);
      }
      return value;
  }
  throw new TypeError(`Column ${column.name} expected ${column.kind}, got ${typeof value}`);
}

const header = (columns: readonly Column[]): string => columns.map((c) => c.name).join(',');
const row = (columns: readonly Column[], sample: Record<string, unknown>): string =>
  columns.map((column) => cell(column, sample[column.name])).join(',');

export const telemetryHeader = (): string => header(TELEMETRY_COLUMNS);
export const evaluationHeader = (): string => header(EVALUATION_COLUMNS);
export const telemetryRow = (sample: TelemetrySample): string => row(TELEMETRY_COLUMNS, sample);
export const evaluationRow = (sample: EvaluationSample): string => row(EVALUATION_COLUMNS, sample);

function parseCell(column: Column, text: string): unknown {
  switch (column.kind) {
    case 'number':
      return text === '' ? Number.NaN : Number(text);
    case 'nullable-number':
      return text === '' ? null : Number(text);
    case 'boolean':
      if (text === '1') return true;
      if (text === '0') return false;
      return text;
    case 'text':
      return text;
  }
}

/**
 * An incremental parser for one sample file.
 *
 * Feed it lines in order. The first must be the exact header this build writes:
 * a file with renamed, reordered or missing columns is rejected, because
 * reading it positionally would silently put one quantity in another's place.
 */
export class CsvSampleParser<T> {
  private headerSeen = false;
  private lineNumber = 0;
  private active: readonly Column[];
  private absent: readonly Column[] = [];

  /**
   * @param columns the current schema's columns, in order
   * @param earlier column layouts of earlier schema versions this build still
   *   reads. A file with one of those exact headers is parsed with it, and the
   *   columns it lacks are read as empty.
   */
  constructor(
    private readonly columns: readonly Column[],
    private readonly schema: z.ZodType<T>,
    private readonly fileName: string,
    private readonly earlier: readonly (readonly Column[])[] = [],
  ) {
    this.active = columns;
  }

  /** Returns the parsed row, or `null` for the header and blank lines. */
  public line(text: string): T | null {
    this.lineNumber += 1;
    if (text.trim().length === 0) return null;

    if (!this.headerSeen) {
      const layout = [this.columns, ...this.earlier].find((columns) => header(columns) === text);
      if (layout === undefined) {
        throw new Error(
          `${this.fileName}: header does not match any schema version this build reads.\n  expected ${header(this.columns)}\n  found    ${text}`,
        );
      }
      this.active = layout;
      this.absent = this.columns.filter((column) => !layout.includes(column));
      this.headerSeen = true;
      return null;
    }

    const cells = text.split(',');
    if (cells.length !== this.active.length) {
      throw new Error(
        `${this.fileName}:${String(this.lineNumber)}: expected ${String(this.active.length)} cells, found ${String(cells.length)}`,
      );
    }
    const record: Record<string, unknown> = {};
    this.active.forEach((column, index) => {
      record[column.name] = parseCell(column, cells[index]!);
    });
    // A column this file predates reads as absent. For a numeric column that is
    // null — the same "not recorded" every modern run writes — and for a text
    // column it is the empty string, which is how an empty cell already parses.
    // Using null for both would make an old file's text columns a shape no
    // current file can produce, and every consumer would need a second case for
    // a distinction that carries no information.
    for (const column of this.absent) {
      record[column.name] = column.kind === 'text' ? '' : null;
    }

    const parsed = this.schema.safeParse(record);
    if (!parsed.success) {
      throw new Error(
        `${this.fileName}:${String(this.lineNumber)}: invalid row: ${parsed.error.message}`,
      );
    }
    return parsed.data;
  }

  /** Whether a header was ever seen. A file without one is not a sample file. */
  public get sawHeader(): boolean {
    return this.headerSeen;
  }
}

export const telemetryParser = (): CsvSampleParser<TelemetrySample> =>
  new CsvSampleParser(TELEMETRY_COLUMNS, telemetrySampleSchema, 'telemetry.csv', [
    TELEMETRY_V2_ONLY_COLUMNS,
    TELEMETRY_V1_COLUMNS,
  ]);

export const evaluationParser = (): CsvSampleParser<EvaluationSample> =>
  new CsvSampleParser(EVALUATION_COLUMNS, evaluationSampleSchema, 'evaluation.csv', [
    EVALUATION_PRE_V3_COLUMNS,
  ]);

/** Parses one line of events.jsonl, or `null` for a blank line. */
export function parseEventLine(text: string, lineNumber: number): ExperimentEvent | null {
  if (text.trim().length === 0) return null;
  const parsed = experimentEventSchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new Error(`events.jsonl:${String(lineNumber)}: invalid event: ${parsed.error.message}`);
  }
  return parsed.data;
}

/** Splits a whole string into lines; for small files and tests. */
export const linesOf = (contents: string): string[] => contents.split('\n');

/** Parses a whole telemetry file held in memory. Tests and small files only. */
export function parseTelemetryCsv(contents: string): TelemetrySample[] {
  const parser = telemetryParser();
  return linesOf(contents)
    .map((line) => parser.line(line))
    .filter((sample): sample is TelemetrySample => sample !== null);
}

/** Parses a whole evaluation file held in memory. Tests and small files only. */
export function parseEvaluationCsv(contents: string): EvaluationSample[] {
  const parser = evaluationParser();
  return linesOf(contents)
    .map((line) => parser.line(line))
    .filter((sample): sample is EvaluationSample => sample !== null);
}

/** Parses a whole event log held in memory. Tests and small files only. */
export function parseEventLog(contents: string): ExperimentEvent[] {
  return linesOf(contents)
    .map((line, index) => parseEventLine(line, index + 1))
    .filter((event): event is ExperimentEvent => event !== null);
}
