import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { JSDOM } from "jsdom";

import { parseBookDetailWithDiagnostics } from "../../src/modules/parser";
import {
  normalizeSupportedBookLanguage,
  validateMinimumBookIngest,
} from "../../src/modules/ingest-validator";
import type { BookMetadata } from "../../src/types";
import type { FieldProvenanceKind, ValidationStatus } from "../../src/types/pipeline";

interface CliOptions {
  dbPath: string;
  summaryPath: string;
  sourceCleaningRunId?: string;
  confirmedNoNetwork: boolean;
}

interface SourceRow {
  cleaned_record_id: string;
  cleaning_run_id: string;
  pipeline_run_id: string;
  raw_record_id: string;
  source_url: string;
  douban_subject_id: string | null;
  raw_html: string;
  cleaned_json: string;
}

interface ReplayRecordSummary {
  rawRecordId: string;
  subjectId: string | null;
  sourceUrl: string;
  cleanedRecordId: string;
  validationStatus: ValidationStatus;
  validationWarnings: string[];
  extractionWarnings: string[];
  preservedLanguage?: string;
}

const rootDir = resolve(import.meta.dirname, "..", "..");
const PRESERVED_MODEL_FIELDS = ["language"] as const;

function helpText(): string {
  return `
Replay readlist normalization into cleaned_records without network access.

This worker reparses existing raw_scraped_records.raw_html with the current
deterministic parser and preserves only low-risk language completion from a
previous OpenAI-compatible cleaning run.

Usage:
  npm run db:replay:readlist-normalization -- --db <sqlite-db> --confirm-no-network

Options:
  --db <path>                    SQLite DB to update.
  --summary <path>               Summary JSON path.
  --source-cleaning-run-id <id>  Source OpenAI-compatible cleaning run. Default: latest.
  --confirm-no-network           Required.
`.trim();
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    dbPath: join(rootDir, ".cache", "live", "pipeline.sqlite"),
    summaryPath: join(rootDir, ".cache", "live", "readlist-normalization-replay-summary.json"),
    confirmedNoNetwork: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${helpText()}\n`);
      process.exit(0);
    } else if (arg === "--db") options.dbPath = resolve(rootDir, argv[++i]);
    else if (arg === "--summary") options.summaryPath = resolve(rootDir, argv[++i]);
    else if (arg === "--source-cleaning-run-id") options.sourceCleaningRunId = argv[++i];
    else if (arg === "--confirm-no-network") options.confirmedNoNetwork = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function runStamp(date: Date): string {
  return date.toISOString().replace(/[-:.TZ]/g, "").slice(0, 17);
}

function relativePath(path: string): string {
  return relative(rootDir, path);
}

function validationWarnings(book: BookMetadata): string[] {
  const warnings = [...validateMinimumBookIngest(book).warnings];
  if (!book.isbn && !book.isbn13) warnings.push("missing-isbn");
  return warnings;
}

function validationStatus(book: BookMetadata, warnings: string[]): ValidationStatus {
  return validateMinimumBookIngest(book).eligible
    ? warnings.length > 0 ? "warning" : "valid"
    : "invalid";
}

function parseJson<T>(text: string, label: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (error: any) {
    throw new Error(`${label} is not valid JSON: ${error?.message || String(error)}`);
  }
}

function latestOpenAICompatibleCleaningRunId(db: DatabaseSync): string {
  const row = db.prepare(`
    SELECT cleaning_run_id
    FROM cleaning_runs
    WHERE cleaner_kind = 'openai-compatible'
    ORDER BY started_at DESC, cleaning_run_id DESC
    LIMIT 1
  `).get() as { cleaning_run_id?: string } | undefined;

  if (!row?.cleaning_run_id) {
    throw new Error("No openai-compatible cleaning run was found");
  }
  return row.cleaning_run_id;
}

function loadSourceRows(db: DatabaseSync, cleaningRunId: string): SourceRow[] {
  return db.prepare(`
    SELECT
      source.cleaned_record_id,
      source.cleaning_run_id,
      runs.pipeline_run_id,
      source.raw_record_id,
      raw.source_url,
      raw.douban_subject_id,
      raw.raw_html,
      source.cleaned_json
    FROM cleaned_records AS source
    INNER JOIN cleaning_runs AS runs ON runs.cleaning_run_id = source.cleaning_run_id
    INNER JOIN raw_scraped_records AS raw ON raw.raw_record_id = source.raw_record_id
    WHERE source.cleaning_run_id = ?
    ORDER BY raw.created_at ASC, source.cleaned_record_id ASC
  `).all(cleaningRunId) as SourceRow[];
}

function mergePreservedModelFields(parsed: BookMetadata, sourceBook: BookMetadata): BookMetadata {
  const merged: BookMetadata = { ...parsed };
  const sourceLanguage = typeof sourceBook.language === "string"
    ? normalizeSupportedBookLanguage(sourceBook.language)
    : undefined;
  if (!merged.language && sourceLanguage) {
    merged.language = sourceLanguage;
  }
  return merged;
}

function fieldProvenance(book: BookMetadata): Partial<Record<keyof BookMetadata | "creators", FieldProvenanceKind>> {
  const provenance: Partial<Record<keyof BookMetadata | "creators", FieldProvenanceKind>> = {};
  for (const field of Object.keys(book) as Array<keyof BookMetadata>) {
    if (field === "language") continue;
    provenance[field] = "rule-cleaned";
  }
  provenance.creators = "rule-cleaned";
  if (book.language) provenance.language = "llm-cleaned";
  return provenance;
}

function confidence(book: BookMetadata): Partial<Record<keyof BookMetadata | "creators", number>> {
  const values: Partial<Record<keyof BookMetadata | "creators", number>> = {};
  for (const field of Object.keys(book) as Array<keyof BookMetadata>) {
    if (field === "language") continue;
    values[field] = 0.9;
  }
  values.creators = 0.9;
  if (book.language) values.language = 0.7;
  return values;
}

function subjectIdPart(row: SourceRow): string {
  return row.douban_subject_id ?? row.raw_record_id.replace(/[^A-Za-z0-9_.-]/g, "-");
}

function run(): void {
  if (process.env.DOUBAN_TO_ZOTERO_EXECUTION_MODE !== "dry-run") {
    throw new Error("readlist normalization replay must run with DOUBAN_TO_ZOTERO_EXECUTION_MODE=dry-run");
  }

  const options = parseArgs(process.argv.slice(2));
  if (!options.confirmedNoNetwork) {
    throw new Error("readlist normalization replay requires --confirm-no-network");
  }

  const dom = new JSDOM("<!doctype html>");
  globalThis.DOMParser = dom.window.DOMParser;

  const db = new DatabaseSync(options.dbPath);
  db.exec("PRAGMA foreign_keys = ON");

  try {
    const startedAt = new Date().toISOString();
    const suffix = runStamp(new Date(startedAt));
    const sourceCleaningRunId = options.sourceCleaningRunId ?? latestOpenAICompatibleCleaningRunId(db);
    const sourceRows = loadSourceRows(db, sourceCleaningRunId);
    if (sourceRows.length === 0) {
      throw new Error(`No cleaned_records found for source cleaning run ${sourceCleaningRunId}`);
    }

    const pipelineRunIds = new Set(sourceRows.map((row) => row.pipeline_run_id));
    if (pipelineRunIds.size !== 1) {
      throw new Error("Source cleaning run spans multiple pipeline runs");
    }
    const pipelineRunId = [...pipelineRunIds][0];
    const replayCleaningRunId = `cleaning-run-replay-normalized-${suffix}`;
    const summaries: ReplayRecordSummary[] = [];
    const preservedLanguageSubjects: string[] = [];

    db.exec("BEGIN");
    try {
      db.prepare(`
        INSERT INTO cleaning_runs
        (cleaning_run_id, pipeline_run_id, execution_mode, cleaner_kind, provider, model, prompt_template_hash, settings_json, started_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        replayCleaningRunId,
        pipelineRunId,
        "live",
        "replay",
        "none",
        null,
        null,
        json({
          mode: "readlist-normalization-replay-v1",
          sourceCleaningRunId,
          preservedModelFields: PRESERVED_MODEL_FIELDS,
          networkRequests: 0,
        }),
        startedAt,
        startedAt,
      );

      for (const row of sourceRows) {
        const parsed = parseBookDetailWithDiagnostics(row.raw_html, row.source_url);
        const sourceBook = parseJson<BookMetadata>(row.cleaned_json, `${row.cleaned_record_id}.cleaned_json`);
        const cleaned = mergePreservedModelFields(parsed.book, sourceBook);
        const warnings = validationWarnings(cleaned);
        const status = validationStatus(cleaned, warnings);
        const idPart = subjectIdPart(row);
        const cleanedRecordId = `cleaned-replay-normalized-${idPart}-${suffix}`;

        if (cleaned.language && !parsed.book.language) {
          preservedLanguageSubjects.push(idPart);
        }

        db.prepare(`
          INSERT INTO cleaned_records
          (cleaned_record_id, cleaning_run_id, raw_record_id, internal_id, cleaned_json, validation_status, validation_warnings_json, field_provenance_json, confidence_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          cleanedRecordId,
          replayCleaningRunId,
          row.raw_record_id,
          cleanedRecordId,
          json(cleaned),
          status,
          json(warnings),
          json(fieldProvenance(cleaned)),
          json(confidence(cleaned)),
          startedAt,
        );

        summaries.push({
          rawRecordId: row.raw_record_id,
          subjectId: row.douban_subject_id,
          sourceUrl: row.source_url,
          cleanedRecordId,
          validationStatus: status,
          validationWarnings: warnings,
          extractionWarnings: parsed.extractionWarnings,
          preservedLanguage: cleaned.language && !parsed.book.language ? cleaned.language : undefined,
        });
      }

      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    const validationStatusCounts = summaries.reduce<Record<string, number>>((counts, record) => {
      counts[record.validationStatus] = (counts[record.validationStatus] ?? 0) + 1;
      return counts;
    }, {});

    const summary = {
      executionMode: "dry-run",
      mode: "readlist-normalization-replay-v1",
      dbPath: relativePath(options.dbPath),
      sourceCleaningRunId,
      replayCleaningRunId,
      recordCount: summaries.length,
      preservedModelFields: PRESERVED_MODEL_FIELDS,
      preservedLanguageCount: preservedLanguageSubjects.length,
      validationStatusCounts,
      networkRequests: 0,
      records: summaries,
    };

    mkdirSync(dirname(options.summaryPath), { recursive: true });
    writeFileSync(options.summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf-8");
    process.stdout.write(`${JSON.stringify({
      executionMode: summary.executionMode,
      mode: summary.mode,
      dbPath: summary.dbPath,
      summaryPath: relativePath(options.summaryPath),
      sourceCleaningRunId,
      replayCleaningRunId,
      recordCount: summary.recordCount,
      preservedLanguageCount: summary.preservedLanguageCount,
      validationStatusCounts,
      networkRequests: 0,
    }, null, 2)}\n`);
  } finally {
    db.close();
  }
}

try {
  run();
} catch (error) {
  console.error(error);
  process.exit(1);
}
