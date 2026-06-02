import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { JSDOM } from "jsdom";

import type { BookMetadata, Creator } from "../../src/types";
import type {
  FieldProvenanceKind,
  PipelineExecutionMode,
  ValidationStatus,
} from "../../src/types/pipeline";
import {
  OPENAI_COMPATIBLE_CLEANER_PROMPT_TEMPLATE_VERSION,
  OPENAI_COMPATIBLE_CLEANER_SYSTEM_PROMPT,
  OpenAICompatibleMetadataCleaner,
  redactOpenAICompatibleApiKey,
  type ModelRequestLogEntry,
} from "../../src/modules/openai-compatible-client";
import { FetchOpenAICompatibleTransport } from "../../src/modules/openai-compatible-transport";
import {
  normalizeSupportedBookLanguage,
  validateMinimumBookIngest,
} from "../../src/modules/ingest-validator";

interface CliOptions {
  dbPath: string;
  summaryPath: string;
  requestLogPath: string;
  baseUrl: string;
  apiKeyEnv: string;
  model: string;
  temperature: number;
  timeoutMs: number;
  limit: number;
  pipelineRunId?: string;
  sourceCleaningRunId?: string;
  continueOnError: boolean;
  allowDrySource: boolean;
  confirmedLive: boolean;
  maxRawChars: number;
}

interface SourceRow {
  pipeline_run_id: string;
  pipeline_execution_mode: PipelineExecutionMode;
  rule_cleaned_record_id: string;
  rule_cleaning_run_id: string;
  raw_record_id: string;
  source_url: string;
  raw_html: string;
  extraction_warnings_json: string;
  cleaned_json: string;
}

interface CleanedRecordResult {
  rawRecordId: string;
  sourceUrl: string;
  cleanedRecordId?: string;
  validationStatus?: ValidationStatus;
  validationWarnings?: string[];
  changedFields?: string[];
  requestLogStart: number;
  requestLogEnd: number;
  error?: string;
}

const rootDir = resolve(import.meta.dirname, "..", "..");
const ALLOWED_CREATOR_TYPES = new Set([
  "author",
  "translator",
  "editor",
  "contributor",
  "seriesEditor",
]);
const STRING_FIELDS = [
  "title",
  "subtitle",
  "publisher",
  "publishDate",
  "isbn",
  "isbn13",
  "pages",
  "price",
  "series",
  "seriesNumber",
  "volume",
  "numberOfVolumes",
  "edition",
  "place",
  "originalDate",
  "originalPublisher",
  "originalPlace",
  "format",
  "doi",
  "citationKey",
  "accessed",
  "issn",
  "archive",
  "archiveLocation",
  "shortTitle",
  "language",
  "callNumber",
  "license",
  "extra",
  "originalTitle",
  "abstractNote",
  "coverUrl",
] as const satisfies ReadonlyArray<keyof BookMetadata>;
const REQUIRED_STRING_FIELDS = new Set<keyof BookMetadata>([
  "title",
  "publisher",
  "publishDate",
]);
const LANGUAGE_FIELD = "language" satisfies keyof BookMetadata;

function helpText(): string {
  return `
OpenAI-compatible metadata cleaning integration.

Recommended user-facing command:
  .\\scripts\\run-openai-compatible-cleaning.ps1 -ConfirmLive

The wrapper keeps endpoint, model, and API key as editable plaintext values at
the top of the PowerShell file. This Node worker still accepts env/CLI inputs for
automation and for the wrapper's temporary process environment.

Direct worker live guard:
  $env:DOUBAN_TO_ZOTERO_EXECUTION_MODE = "live"
  $env:OPENAI_COMPATIBLE_BASE_URL = "https://api.example.com/v1"
  $env:OPENAI_COMPATIBLE_API_KEY = "..."
  $env:OPENAI_COMPATIBLE_MODEL = "model-name"
  npm run db:clean:openai-compatible -- --confirm-live

Options:
  --db <path>                    SQLite DB to update. Default: .cache/live/pipeline.sqlite
  --summary <path>               Summary JSON path. Default: .cache/live/openai-cleaning-summary.json
  --request-log <path>           Model request log JSON path. Default: .cache/live/openai-cleaning-request-log.json
  --base-url <url>               OpenAI-compatible base URL. Default: OPENAI_COMPATIBLE_BASE_URL
  --api-key-env <name>           API key env var. Default: OPENAI_COMPATIBLE_API_KEY
  --model <name>                 Model name. Default: OPENAI_COMPATIBLE_MODEL
  --temperature <number>         Default: 0
  --timeout-ms <number>          Default: 60000
  --limit <number>               Max records to clean. Default: 5
  --pipeline-run-id <id>         Source pipeline run. Default: latest rule-parser run
  --source-cleaning-run-id <id>  Source rule-parser cleaning run.
  --continue-on-error            Continue after per-record model errors.
  --allow-dry-source             Permit cleaning records from a dry-run source pipeline.
  --max-raw-chars <number>       Raw text sent to the model. Default: 12000
  --confirm-live                 Required.
`.trim();
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    dbPath: join(rootDir, ".cache", "live", "pipeline.sqlite"),
    summaryPath: join(rootDir, ".cache", "live", "openai-cleaning-summary.json"),
    requestLogPath: join(rootDir, ".cache", "live", "openai-cleaning-request-log.json"),
    baseUrl: process.env.OPENAI_COMPATIBLE_BASE_URL ?? "",
    apiKeyEnv: "OPENAI_COMPATIBLE_API_KEY",
    model: process.env.OPENAI_COMPATIBLE_MODEL ?? "",
    temperature: 0,
    timeoutMs: 60000,
    limit: 5,
    continueOnError: false,
    allowDrySource: false,
    confirmedLive: false,
    maxRawChars: 12000,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${helpText()}\n`);
      process.exit(0);
    } else if (arg === "--db") options.dbPath = resolve(rootDir, argv[++i]);
    else if (arg === "--summary") options.summaryPath = resolve(rootDir, argv[++i]);
    else if (arg === "--request-log") options.requestLogPath = resolve(rootDir, argv[++i]);
    else if (arg === "--base-url") options.baseUrl = argv[++i];
    else if (arg === "--api-key-env") options.apiKeyEnv = argv[++i];
    else if (arg === "--model") options.model = argv[++i];
    else if (arg === "--temperature") options.temperature = Number(argv[++i]);
    else if (arg === "--timeout-ms") options.timeoutMs = Number(argv[++i]);
    else if (arg === "--limit") options.limit = Number(argv[++i]);
    else if (arg === "--pipeline-run-id") options.pipelineRunId = argv[++i];
    else if (arg === "--source-cleaning-run-id") options.sourceCleaningRunId = argv[++i];
    else if (arg === "--continue-on-error") options.continueOnError = true;
    else if (arg === "--allow-dry-source") options.allowDrySource = true;
    else if (arg === "--max-raw-chars") options.maxRawChars = Number(argv[++i]);
    else if (arg === "--confirm-live") options.confirmedLive = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isFinite(options.temperature)) throw new Error("--temperature must be numeric");
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1000) {
    throw new Error("--timeout-ms must be an integer >= 1000");
  }
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) {
    throw new Error("--limit must be an integer from 1 to 100");
  }
  if (!Number.isInteger(options.maxRawChars) || options.maxRawChars < 1000) {
    throw new Error("--max-raw-chars must be an integer >= 1000");
  }

  return options;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function runStamp(date: Date): string {
  return date.toISOString().replace(/[-:.TZ]/g, "").slice(0, 17);
}

function safeIdPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "-").replace(/-+/g, "-").slice(0, 64);
}

function promptTemplateHash(): string {
  return sha256(
    JSON.stringify({
      version: OPENAI_COMPATIBLE_CLEANER_PROMPT_TEMPLATE_VERSION,
      systemPrompt: OPENAI_COMPATIBLE_CLEANER_SYSTEM_PROMPT,
      userPayloadShape: ["ruleMetadata", "rawText", "cleaningPolicy.language"],
    }),
  );
}

function persistenceSafeErrorMessage(error: unknown, apiKey?: string): string {
  const message = error instanceof Error
    ? error.message
    : String(error);
  return redactOpenAICompatibleApiKey(message, apiKey);
}

function parseJson<T>(text: string, label: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (error: any) {
    throw new Error(`${label} is not valid JSON: ${error?.message || String(error)}`);
  }
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

function isStringRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

function cleanStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .map((entry) => cleanString(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function cleanCreator(value: unknown): Creator | null {
  if (!isStringRecord(value)) return null;
  const creatorType = cleanString(value.creatorType);
  if (!creatorType || !ALLOWED_CREATOR_TYPES.has(creatorType)) return null;

  const fieldMode = value.fieldMode === 1 ? 1 : 0;
  const firstName = cleanString(value.firstName) ?? "";
  const lastName = cleanString(value.lastName) ?? "";
  if (!firstName && !lastName) return null;

  return {
    firstName,
    lastName,
    creatorType: creatorType as Creator["creatorType"],
    fieldMode,
    needsReview: value.needsReview === true ? true : undefined,
  };
}

function cleanCreators(value: unknown): Creator[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const creators = value
    .map((entry) => cleanCreator(entry))
    .filter((entry): entry is Creator => entry !== null);
  return creators.length > 0 ? creators : undefined;
}

function normalizeModelBook(ruleBook: BookMetadata, modelBook: unknown): BookMetadata {
  if (!isStringRecord(modelBook)) {
    throw new Error("OpenAI-compatible cleaner returned a non-object metadata value");
  }

  const merged: BookMetadata = {
    ...ruleBook,
    doubanUrl: ruleBook.doubanUrl,
    doubanId: ruleBook.doubanId,
  };

  for (const field of STRING_FIELDS) {
    const next = cleanString(modelBook[field]);
    if (next === undefined) continue;
    if (field === LANGUAGE_FIELD) {
      const language = normalizeSupportedBookLanguage(next);
      if (!language) continue;
      merged.language = language;
      continue;
    }
    if (REQUIRED_STRING_FIELDS.has(field) && !next) continue;
    (merged as Record<string, unknown>)[field] = next;
  }

  const modelCreators = cleanCreators(modelBook.creators);
  if (modelCreators) merged.creators = modelCreators;

  const creatorNotes = cleanStringArray(modelBook.creatorNotes);
  if (creatorNotes) merged.creatorNotes = creatorNotes;

  merged.doubanUrl = ruleBook.doubanUrl;
  merged.doubanId = ruleBook.doubanId;
  return merged;
}

function stableValue(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function fieldProvenance(
  ruleBook: BookMetadata,
  cleanedBook: BookMetadata,
): Partial<Record<keyof BookMetadata | "creators", FieldProvenanceKind>> {
  const provenance: Partial<Record<keyof BookMetadata | "creators", FieldProvenanceKind>> = {};
  const fields = new Set<keyof BookMetadata>([
    ...(Object.keys(ruleBook) as Array<keyof BookMetadata>),
    ...(Object.keys(cleanedBook) as Array<keyof BookMetadata>),
  ]);

  for (const field of fields) {
    provenance[field] =
      stableValue(ruleBook[field]) === stableValue(cleanedBook[field])
        ? "rule-cleaned"
        : "llm-cleaned";
  }
  provenance.doubanUrl = "rule-cleaned";
  provenance.doubanId = "rule-cleaned";
  return provenance;
}

function changedFields(ruleBook: BookMetadata, cleanedBook: BookMetadata): string[] {
  return Object.entries(fieldProvenance(ruleBook, cleanedBook))
    .filter(([, provenance]) => provenance === "llm-cleaned")
    .map(([field]) => field)
    .sort();
}

function confidenceForBook(
  ruleBook: BookMetadata,
  cleanedBook: BookMetadata,
): Partial<Record<keyof BookMetadata | "creators", number>> {
  const confidence: Partial<Record<keyof BookMetadata | "creators", number>> = {};
  for (const field of Object.keys(fieldProvenance(ruleBook, cleanedBook)) as Array<keyof BookMetadata | "creators">) {
    confidence[field] =
      stableValue((ruleBook as Record<string, unknown>)[field]) ===
      stableValue((cleanedBook as Record<string, unknown>)[field])
        ? 0.9
        : 0.7;
  }
  return confidence;
}

function extractReadableText(rawHtml: string, sourceUrl: string, ruleBook: BookMetadata, maxChars: number): string {
  const dom = new JSDOM(rawHtml);
  const doc = dom.window.document;
  const chunks = [
    `Source URL: ${sourceUrl}`,
    `Rule metadata: ${JSON.stringify(ruleBook)}`,
    `Page title: ${doc.querySelector("title")?.textContent?.trim() ?? ""}`,
    `Heading: ${doc.querySelector("h1")?.textContent?.replace(/\s+/g, " ").trim() ?? ""}`,
    `Info: ${doc.querySelector("#info")?.textContent?.replace(/\s+/g, " ").trim() ?? ""}`,
    `Intro: ${doc.querySelector("#link-report .intro, .intro")?.textContent?.replace(/\s+/g, " ").trim() ?? ""}`,
  ].filter(Boolean);
  return chunks.join("\n").slice(0, maxChars);
}

function latestPipelineRunId(db: DatabaseSync, options: CliOptions): string {
  const conditions = ["cleaning_runs.cleaner_kind = 'rule-parser'"];
  const params: unknown[] = [];
  if (options.sourceCleaningRunId) {
    conditions.push("cleaning_runs.cleaning_run_id = ?");
    params.push(options.sourceCleaningRunId);
  }
  if (options.pipelineRunId) {
    conditions.push("pipeline_runs.run_id = ?");
    params.push(options.pipelineRunId);
  }

  const row = db.prepare(`
    SELECT pipeline_runs.run_id
    FROM pipeline_runs
    INNER JOIN cleaning_runs ON cleaning_runs.pipeline_run_id = pipeline_runs.run_id
    WHERE ${conditions.join(" AND ")}
    ORDER BY pipeline_runs.started_at DESC, pipeline_runs.run_id DESC
    LIMIT 1
  `).get(...params) as { run_id: string } | undefined;

  if (!row) {
    throw new Error("No source rule-parser cleaning run was found in the selected database");
  }
  return row.run_id;
}

function sourceRows(db: DatabaseSync, options: CliOptions, pipelineRunId: string): SourceRow[] {
  const conditions = [
    "pipeline_runs.run_id = ?",
    "cleaning_runs.cleaner_kind = 'rule-parser'",
  ];
  const params: unknown[] = [pipelineRunId];
  if (options.sourceCleaningRunId) {
    conditions.push("cleaning_runs.cleaning_run_id = ?");
    params.push(options.sourceCleaningRunId);
  }
  params.push(options.limit);

  return db.prepare(`
    SELECT
      pipeline_runs.run_id AS pipeline_run_id,
      pipeline_runs.execution_mode AS pipeline_execution_mode,
      cleaned_records.cleaned_record_id AS rule_cleaned_record_id,
      cleaning_runs.cleaning_run_id AS rule_cleaning_run_id,
      cleaned_records.raw_record_id,
      raw_scraped_records.source_url,
      raw_scraped_records.raw_html,
      raw_scraped_records.extraction_warnings_json,
      cleaned_records.cleaned_json
    FROM cleaned_records
    INNER JOIN cleaning_runs ON cleaning_runs.cleaning_run_id = cleaned_records.cleaning_run_id
    INNER JOIN pipeline_runs ON pipeline_runs.run_id = cleaning_runs.pipeline_run_id
    INNER JOIN raw_scraped_records ON raw_scraped_records.raw_record_id = cleaned_records.raw_record_id
    WHERE ${conditions.join(" AND ")}
    ORDER BY cleaned_records.created_at ASC, cleaned_records.cleaned_record_id ASC
    LIMIT ?
  `).all(...params) as SourceRow[];
}

function ensureLiveAllowed(options: CliOptions) {
  if (process.env.DOUBAN_TO_ZOTERO_EXECUTION_MODE !== "live") {
    throw new Error("OpenAI-compatible cleaning requires DOUBAN_TO_ZOTERO_EXECUTION_MODE=live");
  }
  if (!options.confirmedLive) {
    throw new Error("OpenAI-compatible cleaning requires --confirm-live");
  }
  if (!options.baseUrl) {
    throw new Error("OpenAI-compatible cleaning requires --base-url or OPENAI_COMPATIBLE_BASE_URL");
  }
  if (!options.model) {
    throw new Error("OpenAI-compatible cleaning requires --model or OPENAI_COMPATIBLE_MODEL");
  }
  if (!process.env[options.apiKeyEnv]) {
    throw new Error(`OpenAI-compatible cleaning requires API key env var ${options.apiKeyEnv}`);
  }
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  ensureLiveAllowed(options);
  if (!existsSync(options.dbPath)) {
    throw new Error(`SQLite database does not exist: ${options.dbPath}`);
  }

  mkdirSync(dirname(options.summaryPath), { recursive: true });
  mkdirSync(dirname(options.requestLogPath), { recursive: true });

  const started = new Date();
  const startedAt = started.toISOString();
  const stamp = runStamp(started);
  const modelId = safeIdPart(options.model);
  const cleaningRunId = `cleaning-run-openai-compatible-${modelId}-${stamp}`;
  const requestLog: ModelRequestLogEntry[] = [];
  const results: CleanedRecordResult[] = [];
  const db = new DatabaseSync(options.dbPath);
  db.exec("PRAGMA foreign_keys = ON");

  try {
    const pipelineRunId = latestPipelineRunId(db, options);
    const rows = sourceRows(db, options, pipelineRunId);
    if (rows.length === 0) {
      throw new Error(`No rule-parser cleaned records were found for pipeline run ${pipelineRunId}`);
    }
    const sourceExecutionMode = rows[0].pipeline_execution_mode;
    if (sourceExecutionMode === "dry-run" && !options.allowDrySource) {
      throw new Error("Source pipeline is dry-run; pass --allow-dry-source to clean fixture records with a live model");
    }

    db.prepare(`
      INSERT INTO cleaning_runs
      (cleaning_run_id, pipeline_run_id, execution_mode, cleaner_kind, provider, model, prompt_template_hash, settings_json, started_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      cleaningRunId,
      pipelineRunId,
      "live",
      "openai-compatible",
      "openai-compatible",
      options.model,
      promptTemplateHash(),
      json({
        baseUrl: options.baseUrl,
        temperature: options.temperature,
        timeoutMs: options.timeoutMs,
        limit: options.limit,
        sourceExecutionMode,
        sourceCleaningRunId: options.sourceCleaningRunId ?? null,
        allowDrySource: options.allowDrySource,
        promptTemplateVersion: OPENAI_COMPATIBLE_CLEANER_PROMPT_TEMPLATE_VERSION,
      }),
      startedAt,
      null,
    );

    const apiKey = process.env[options.apiKeyEnv] ?? "";
    const cleaner = new OpenAICompatibleMetadataCleaner(
      {
        baseUrl: options.baseUrl,
        apiKey,
        model: options.model,
        temperature: options.temperature,
        timeoutMs: options.timeoutMs,
      },
      "live",
      new FetchOpenAICompatibleTransport(),
    );

    for (const row of rows) {
      const requestLogStart = cleaner.requestLog.length;
      try {
        const ruleBook = parseJson<BookMetadata>(
          row.cleaned_json,
          `${row.rule_cleaned_record_id}.cleaned_json`,
        );
        const rawText = extractReadableText(
          row.raw_html,
          row.source_url,
          ruleBook,
          options.maxRawChars,
        );
        const modelBook = await cleaner.clean(rawText, ruleBook);
        const cleanedBook = normalizeModelBook(ruleBook, modelBook);
        const warnings = validationWarnings(cleanedBook);
        const status = validationStatus(cleanedBook, warnings);
        const cleanedRecordId = `cleaned-openai-compatible-${safeIdPart(row.raw_record_id)}-${stamp}`;
        const changes = changedFields(ruleBook, cleanedBook);

        db.prepare(`
          INSERT INTO cleaned_records
          (cleaned_record_id, cleaning_run_id, raw_record_id, internal_id, cleaned_json, validation_status, validation_warnings_json, field_provenance_json, confidence_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          cleanedRecordId,
          cleaningRunId,
          row.raw_record_id,
          cleanedRecordId,
          json(cleanedBook),
          status,
          json(warnings),
          json(fieldProvenance(ruleBook, cleanedBook)),
          json(confidenceForBook(ruleBook, cleanedBook)),
          new Date().toISOString(),
        );

        results.push({
          rawRecordId: row.raw_record_id,
          sourceUrl: row.source_url,
          cleanedRecordId,
          validationStatus: status,
          validationWarnings: warnings,
          changedFields: changes,
          requestLogStart,
          requestLogEnd: cleaner.requestLog.length,
        });
      } catch (error: any) {
        const message = persistenceSafeErrorMessage(error, apiKey);
        results.push({
          rawRecordId: row.raw_record_id,
          sourceUrl: row.source_url,
          requestLogStart,
          requestLogEnd: cleaner.requestLog.length,
          error: message,
        });
        if (!options.continueOnError) throw new Error(message);
      } finally {
        requestLog.splice(0, requestLog.length, ...cleaner.requestLog);
        writeFileSync(options.requestLogPath, `${JSON.stringify(requestLog, null, 2)}\n`, "utf-8");
      }
    }

    db.prepare("UPDATE cleaning_runs SET completed_at = ? WHERE cleaning_run_id = ?")
      .run(new Date().toISOString(), cleaningRunId);

    const successful = results.filter((result) => result.cleanedRecordId).length;
    const failed = results.filter((result) => result.error).length;
    const summary = {
      executionMode: "live",
      mode: "openai-compatible-cleaning",
      dbPath: relative(rootDir, options.dbPath),
      cleaningRunId,
      pipelineRunId,
      sourceExecutionMode,
      sourceRecords: rows.length,
      successful,
      failed,
      model: options.model,
      baseUrl: options.baseUrl,
      requestLogPath: relative(rootDir, options.requestLogPath),
      requestCount: requestLog.length,
      results,
    };
    writeFileSync(options.summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf-8");
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

    if (failed > 0) process.exit(1);
  } finally {
    db.close();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
