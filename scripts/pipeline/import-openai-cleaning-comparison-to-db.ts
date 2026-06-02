import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

import type { BookMetadata } from "../../src/types";
import type { ValidationStatus } from "../../src/types/pipeline";

interface CleaningModeResult {
  mode: "unrestricted" | "restricted";
  ok?: boolean;
  cleaned?: BookMetadata;
  validationStatus?: ValidationStatus;
  validationWarnings?: string[];
  changedFields?: string[];
  acceptedChangedFields?: string[];
  rejectedChangedFields?: string[];
  highRiskChangedFields?: string[];
  minimumFieldChanges?: string[];
  statusCode?: number;
  error?: string;
}

interface ComparisonRecord {
  subjectId: string;
  sourceUrl: string;
  metadataPath?: string;
  htmlPath?: string;
  htmlKind?: string;
  ruleBook: BookMetadata;
  ruleValidationWarnings?: string[];
  ruleValidationStatus?: ValidationStatus;
  extractionWarnings?: string[];
  unrestricted?: CleaningModeResult;
  restricted?: CleaningModeResult;
}

interface CliOptions {
  recordsPath: string;
  outPath: string;
  summaryPath: string;
  reset: boolean;
  mode: "restricted" | "unrestricted";
  subjectIds: string[];
  limit: number;
  batchId: string;
}

const rootDir = resolve(import.meta.dirname, "..", "..");
const defaultSubjectIds = [
  "1055470",
  "10580967",
  "10588872",
  "1857578",
  "2076034",
];
const protectedFields = [
  "doubanUrl",
  "doubanId",
  "title",
  "subtitle",
  "creators",
  "publisher",
  "publishDate",
  "isbn",
  "isbn13",
] as const;

function helpText(): string {
  return `
Import existing OpenAI-compatible cleaning comparison artifacts into the SQLite
promotion schema. This is an offline artifact transformation: it must not call
the model, fetch Douban, or write to Zotero.

Example:
  npm run db:import:openai-comparison -- --subject-ids 1055470,10580967,10588872,1857578,2076034

Options:
  --records <path>       Comparison records JSON. Default: .cache/live/openai-cleaning-comparison/records.json
  --out <path>           Output SQLite DB. Default: .cache/live/openai-cleaned-promotion-small-batch.sqlite
  --summary <path>       Summary JSON path.
  --mode <name>          restricted or unrestricted. Default: restricted.
  --subject-ids <ids>    Comma-separated Douban subject IDs. Default: conservative five-record language-only batch.
  --limit <number>       Auto-select safe records when --subject-ids is omitted. Default: 5.
  --batch-id <id>        Stable ID suffix for run/record IDs. Default: small-batch-review-20260531.
  --reset                Remove the output DB before writing. Default.
  --no-reset             Append to the output DB.
`.trim();
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    recordsPath: join(rootDir, ".cache", "live", "openai-cleaning-comparison", "records.json"),
    outPath: join(rootDir, ".cache", "live", "openai-cleaned-promotion-small-batch.sqlite"),
    summaryPath: join(rootDir, ".cache", "live", "openai-cleaned-promotion-small-batch-source-summary.json"),
    reset: true,
    mode: "restricted",
    subjectIds: defaultSubjectIds,
    limit: 5,
    batchId: "small-batch-review-20260531",
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${helpText()}\n`);
      process.exit(0);
    } else if (arg === "--records") options.recordsPath = resolve(rootDir, argv[++i]);
    else if (arg === "--out") options.outPath = resolve(rootDir, argv[++i]);
    else if (arg === "--summary") options.summaryPath = resolve(rootDir, argv[++i]);
    else if (arg === "--mode") options.mode = argv[++i] as CliOptions["mode"];
    else if (arg === "--subject-ids") {
      options.subjectIds = argv[++i].split(",").map((id) => id.trim()).filter(Boolean);
    } else if (arg === "--limit") options.limit = Number(argv[++i]);
    else if (arg === "--batch-id") options.batchId = argv[++i];
    else if (arg === "--reset") options.reset = true;
    else if (arg === "--no-reset") options.reset = false;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (options.mode !== "restricted" && options.mode !== "unrestricted") {
    throw new Error("--mode must be restricted or unrestricted");
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(options.batchId)) {
    throw new Error("--batch-id must contain only letters, numbers, underscore, dot, or dash");
  }
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 1000) {
    throw new Error("--limit must be an integer from 1 to 1000");
  }
  if (options.subjectIds.length === 0) {
    throw new Error("--subject-ids must contain at least one ID when provided");
  }

  return options;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function parseJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function stableValue(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function changedFields(a: BookMetadata, b: BookMetadata): string[] {
  const fields = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
  return Array.from(fields)
    .filter((field) => stableValue((a as Record<string, unknown>)[field]) !== stableValue((b as Record<string, unknown>)[field]))
    .sort();
}

function protectedChanges(a: BookMetadata, b: BookMetadata): string[] {
  const changes = changedFields(a, b);
  return changes.filter((field) => protectedFields.includes(field as typeof protectedFields[number]));
}

function provenanceFor(book: BookMetadata, source: string): Record<string, string> {
  const provenance: Record<string, string> = {};
  for (const field of Object.keys(book)) provenance[field] = source;
  return provenance;
}

function safeIdPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "-").replace(/-+/g, "-").slice(0, 80);
}

function selectRecords(records: ComparisonRecord[], options: CliOptions): ComparisonRecord[] {
  const byId = new Map(records.map((record) => [record.subjectId, record]));
  const explicit = options.subjectIds.map((id) => {
    const record = byId.get(id);
    if (!record) throw new Error(`Comparison records do not contain subject ID ${id}`);
    return record;
  });

  if (explicit.length > 0) return explicit;

  return records
    .filter((record) => {
      const result = record[options.mode];
      return result?.ok === true &&
        result.validationStatus === "valid" &&
        Boolean(result.cleaned) &&
        protectedChanges(record.ruleBook, result.cleaned as BookMetadata).length === 0;
    })
    .slice(0, options.limit);
}

function readHtml(record: ComparisonRecord): string {
  if (!record.htmlPath) return "";
  const htmlPath = resolve(rootDir, record.htmlPath);
  return existsSync(htmlPath) ? readFileSync(htmlPath, "utf-8") : "";
}

function insertRows(db: DatabaseSync, records: ComparisonRecord[], options: CliOptions): void {
  const now = new Date().toISOString();
  const schemaSql = readFileSync(join(rootDir, "schemas", "pipeline.sqlite.sql"), "utf-8");
  const pipelineRunId = `pipeline-openai-comparison-${options.batchId}`;
  const scrapeRunId = `scrape-openai-comparison-${options.batchId}`;
  const ruleCleaningRunId = `cleaning-rule-openai-comparison-${options.batchId}`;
  const openaiCleaningRunId = `cleaning-openai-${options.mode}-comparison-${options.batchId}`;

  db.exec(schemaSql);
  db.exec("BEGIN");
  try {
    db.prepare(`
      INSERT INTO pipeline_runs
      (run_id, execution_mode, status, source, input_manifest_path, started_at, completed_at, notes_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      pipelineRunId,
      "live",
      "completed",
      "openai-cleaning-comparison-artifact",
      relative(rootDir, options.recordsPath),
      now,
      now,
      json([
        "Offline import of existing OpenAI-compatible comparison evidence.",
        "No model call, Douban fetch, or Zotero write is performed by this script.",
      ]),
    );

    db.prepare(`
      INSERT INTO scrape_runs
      (scrape_run_id, pipeline_run_id, execution_mode, source_kind, fixture_manifest_path, request_count, started_at, completed_at, provenance_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      scrapeRunId,
      pipelineRunId,
      "live",
      "browser-reference-sample",
      relative(rootDir, options.recordsPath),
      0,
      now,
      now,
      json({
        source: "openai-cleaning-comparison/records.json",
        semanticLayer: "review-candidate-import",
      }),
    );

    for (const [cleaningRunId, cleanerKind] of [
      [ruleCleaningRunId, "rule-parser"],
      [openaiCleaningRunId, "openai-compatible"],
    ] as const) {
      db.prepare(`
        INSERT INTO cleaning_runs
        (cleaning_run_id, pipeline_run_id, execution_mode, cleaner_kind, provider, model, prompt_template_hash, settings_json, started_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        cleaningRunId,
        pipelineRunId,
        "live",
        cleanerKind,
        cleanerKind === "openai-compatible" ? "openai-compatible-comparison-artifact" : null,
        cleanerKind === "openai-compatible" ? "artifact-restricted-result" : null,
        null,
        json({
          importedFrom: relative(rootDir, options.recordsPath),
          comparisonMode: cleanerKind === "openai-compatible" ? options.mode : undefined,
          networkRequests: 0,
        }),
        now,
        now,
      );
    }

    for (const record of records) {
      const result = record[options.mode];
      if (!result?.ok || !result.cleaned) {
        throw new Error(`Subject ${record.subjectId} does not have a successful ${options.mode} result`);
      }
      const subjectPart = safeIdPart(record.subjectId);
      const rawRecordId = `raw-openai-comparison-${subjectPart}`;
      const html = readHtml(record);
      const htmlHash = sha256(html || `${record.sourceUrl}\n${record.subjectId}`);

      db.prepare(`
        INSERT INTO raw_scraped_records
        (raw_record_id, scrape_run_id, internal_id, source_url, douban_subject_id, wishlist_owner_id, source_kind, raw_html, raw_html_sha256, list_context_json, extracted_metadata_json, extraction_warnings_json, provenance_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        rawRecordId,
        scrapeRunId,
        `raw-openai-comparison-${subjectPart}`,
        record.sourceUrl,
        record.subjectId,
        null,
        "browser-reference-sample",
        html,
        htmlHash,
        json({}),
        json(record.ruleBook),
        json(record.extractionWarnings ?? []),
        json({
          metadataPath: record.metadataPath,
          htmlPath: record.htmlPath,
          htmlKind: record.htmlKind,
          importedFrom: relative(rootDir, options.recordsPath),
        }),
        now,
      );

      const ruleWarnings = record.ruleValidationWarnings ?? [];
      db.prepare(`
        INSERT INTO cleaned_records
        (cleaned_record_id, cleaning_run_id, raw_record_id, internal_id, cleaned_json, validation_status, validation_warnings_json, field_provenance_json, confidence_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        `cleaned-rule-openai-comparison-${subjectPart}`,
        ruleCleaningRunId,
        rawRecordId,
        `cleaned-rule-openai-comparison-${subjectPart}`,
        json(record.ruleBook),
        record.ruleValidationStatus ?? (ruleWarnings.length ? "warning" : "valid"),
        json(ruleWarnings),
        json(provenanceFor(record.ruleBook, "rule-parser")),
        json({}),
        now,
      );

      db.prepare(`
        INSERT INTO cleaned_records
        (cleaned_record_id, cleaning_run_id, raw_record_id, internal_id, cleaned_json, validation_status, validation_warnings_json, field_provenance_json, confidence_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        `cleaned-openai-${options.mode}-comparison-${subjectPart}`,
        openaiCleaningRunId,
        rawRecordId,
        `cleaned-openai-${options.mode}-comparison-${subjectPart}`,
        json(result.cleaned),
        result.validationStatus ?? "invalid",
        json(result.validationWarnings ?? []),
        json({
          ...provenanceFor(result.cleaned, "openai-compatible-comparison-artifact"),
          acceptedChangedFields: result.acceptedChangedFields ?? [],
          rejectedChangedFields: result.rejectedChangedFields ?? [],
        }),
        json({
          statusCode: result.statusCode,
          changedFields: result.changedFields ?? [],
          highRiskChangedFields: result.highRiskChangedFields ?? [],
          minimumFieldChanges: result.minimumFieldChanges ?? [],
          networkRequests: 0,
        }),
        now,
      );
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function runCli(argv: string[]): void {
  globalThis.fetch = (() => {
    throw new Error("OpenAI comparison artifact import forbids network access");
  }) as typeof fetch;

  const options = parseArgs(argv);
  if (!existsSync(options.recordsPath)) {
    throw new Error(`Comparison records JSON does not exist: ${options.recordsPath}`);
  }
  if (options.reset && existsSync(options.outPath)) rmSync(options.outPath);
  mkdirSync(dirname(options.outPath), { recursive: true });
  mkdirSync(dirname(options.summaryPath), { recursive: true });

  const allRecords = parseJson<ComparisonRecord[]>(options.recordsPath);
  const selectedRecords = selectRecords(allRecords, options);
  if (selectedRecords.length === 0) throw new Error("No comparison records selected");

  const db = new DatabaseSync(options.outPath);
  db.exec("PRAGMA foreign_keys = ON");
  try {
    insertRows(db, selectedRecords, options);
  } finally {
    db.close();
  }

  const summary = {
    executionMode: "live",
    mode: "openai-cleaning-comparison-artifact-import",
    dbPath: relative(rootDir, options.outPath),
    recordsPath: relative(rootDir, options.recordsPath),
    comparisonMode: options.mode,
    batchId: options.batchId,
    selectedSubjectIds: selectedRecords.map((record) => record.subjectId),
    selectedCount: selectedRecords.length,
    networkRequests: 0,
    zoteroWrites: 0,
    openaiCleaningRunId: `cleaning-openai-${options.mode}-comparison-${options.batchId}`,
    ruleCleaningRunId: `cleaning-rule-openai-comparison-${options.batchId}`,
  };
  writeFileSync(options.summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf-8");
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
