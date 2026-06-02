import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { validateMinimumBookIngest } from "../../src/modules/ingest-validator";
import { bookToZoteroBookPayload } from "../../src/modules/zotero-book-payload";
import { validateZoteroBookPayload } from "../../src/modules/zotero-payload-validator";
import type { BookMetadata } from "../../src/types";
import type { ValidationStatus } from "../../src/types/pipeline";
import packageJson from "../../package.json";

type PromotionPolicy = "restricted-safe-v1";
type ReviewDecision = "accept" | "skip";

interface CliOptions {
  dbPath: string;
  summaryPath: string;
  manifestPath: string;
  reportPath: string;
  reviewManifestPath?: string;
  cleaningRunId?: string;
  pipelineRunId?: string;
  policy: PromotionPolicy;
  apply: boolean;
  preserveSkipped: boolean;
  testName: string;
  collectionStamp: string;
  limit: number;
}

interface CandidateRow {
  pipeline_run_id: string;
  source_execution_mode: string;
  openai_cleaning_run_id: string;
  openai_cleaned_record_id: string;
  raw_record_id: string;
  source_url: string;
  rule_cleaned_record_id: string;
  rule_cleaned_json: string;
  openai_cleaned_json: string;
  openai_validation_status: ValidationStatus;
  openai_validation_warnings_json: string;
  openai_field_provenance_json: string;
  openai_confidence_json: string;
}

interface Candidate {
  candidateId: string;
  rawRecordId: string;
  sourceUrl: string;
  ruleCleanedRecordId: string;
  openaiCleanedRecordId: string;
  ruleBook: BookMetadata;
  openaiBook: BookMetadata;
  validationStatus: ValidationStatus;
  validationWarnings: string[];
  payloadWarnings: string[];
  changedFields: string[];
  protectedChangedFields: string[];
  minimumFieldChanges: string[];
  recommendedDecision: ReviewDecision;
  decision: ReviewDecision;
  decisionNotes: string;
  promotionStatus: "prepared" | "skipped";
  promotionWarnings: string[];
}

interface ReviewManifestDecision {
  openaiCleanedRecordId?: string;
  candidateId?: string;
  decision?: ReviewDecision;
  notes?: string;
}

interface ReviewManifestFile {
  schemaVersion?: number;
  mode?: string;
  policy?: string;
  decisions?: ReviewManifestDecision[];
  candidates?: ReviewManifestDecision[];
}

const rootDir = resolve(import.meta.dirname, "..", "..");
const PROTECTED_FIELDS = new Set<keyof BookMetadata | "creators">([
  "doubanUrl",
  "doubanId",
  "title",
  "subtitle",
  "creators",
  "publisher",
  "publishDate",
  "isbn",
  "isbn13",
]);
const MINIMUM_FIELDS = new Set<keyof BookMetadata | "creators">([
  "title",
  "creators",
  "publisher",
  "publishDate",
  "language",
]);

function helpText(): string {
  return `
OpenAI-cleaned record review/promotion.

Generate a review manifest:
  npm run db:promote:openai-cleaned -- --db .cache/live/pipeline.sqlite

Apply an edited review manifest:
  npm run db:promote:openai-cleaned -- --db .cache/live/pipeline.sqlite --apply --review-manifest .cache/live/openai-cleaned-promotion-manifest.json

Options:
  --db <path>                  SQLite DB. Default: .cache/live/pipeline.sqlite
  --summary <path>             Summary JSON path.
  --manifest <path>            Review manifest output path.
  --report <path>              Markdown report path.
  --review-manifest <path>     Edited review manifest to apply.
  --cleaning-run-id <id>       OpenAI-compatible cleaning run. Default: latest.
  --pipeline-run-id <id>       Restrict source pipeline run.
  --policy <name>              Default: restricted-safe-v1.
  --apply                      Write export_records/import_records from accepted decisions.
  --preserve-skipped           Also write skipped import_records as review evidence.
  --test-name <name>           Default: openai-promoted-write.
  --collection-stamp <stamp>   YYYYMMDD-HHMMSS. Default: current time.
  --limit <number>             Default: 100.
`.trim();
}

function parseArgs(argv: string[]): CliOptions {
  const now = new Date();
  const options: CliOptions = {
    dbPath: join(rootDir, ".cache", "live", "pipeline.sqlite"),
    summaryPath: join(rootDir, ".cache", "live", "openai-cleaned-promotion-summary.json"),
    manifestPath: join(rootDir, ".cache", "live", "openai-cleaned-promotion-manifest.json"),
    reportPath: join(rootDir, ".cache", "live", "openai-cleaned-promotion-report.md"),
    policy: "restricted-safe-v1",
    apply: false,
    preserveSkipped: false,
    testName: "openai-promoted-write",
    collectionStamp: formatCollectionTimestamp(now),
    limit: 100,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${helpText()}\n`);
      process.exit(0);
    } else if (arg === "--db") options.dbPath = resolve(rootDir, argv[++i]);
    else if (arg === "--summary") options.summaryPath = resolve(rootDir, argv[++i]);
    else if (arg === "--manifest") options.manifestPath = resolve(rootDir, argv[++i]);
    else if (arg === "--report") options.reportPath = resolve(rootDir, argv[++i]);
    else if (arg === "--review-manifest") options.reviewManifestPath = resolve(rootDir, argv[++i]);
    else if (arg === "--cleaning-run-id") options.cleaningRunId = argv[++i];
    else if (arg === "--pipeline-run-id") options.pipelineRunId = argv[++i];
    else if (arg === "--policy") options.policy = argv[++i] as PromotionPolicy;
    else if (arg === "--apply") options.apply = true;
    else if (arg === "--preserve-skipped") options.preserveSkipped = true;
    else if (arg === "--test-name") options.testName = argv[++i];
    else if (arg === "--collection-stamp") options.collectionStamp = argv[++i];
    else if (arg === "--limit") options.limit = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (options.policy !== "restricted-safe-v1") {
    throw new Error(`Unsupported promotion policy: ${options.policy}`);
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(options.testName)) {
    throw new Error("--test-name must contain only letters, numbers, underscore, dot, or dash");
  }
  if (!/^\d{8}-\d{6}$/.test(options.collectionStamp)) {
    throw new Error("--collection-stamp must use YYYYMMDD-HHMMSS");
  }
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 1000) {
    throw new Error("--limit must be an integer from 1 to 1000");
  }
  if (options.apply && !options.reviewManifestPath) {
    throw new Error("--apply requires --review-manifest");
  }

  return options;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function parseJson<T>(text: string, label: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (error: any) {
    throw new Error(`${label} is not valid JSON: ${error?.message || String(error)}`);
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function safeIdPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "-").replace(/-+/g, "-").slice(0, 80);
}

function formatCollectionTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

function targetCollectionName(version: string, testName: string, stamp: string): string {
  return `douban-to-zotero ${version} ${testName} ${stamp}`;
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

function validationWarnings(book: BookMetadata): string[] {
  const warnings = [...validateMinimumBookIngest(book).warnings];
  if (!book.isbn && !book.isbn13) warnings.push("missing-isbn");
  return Array.from(new Set(warnings)).sort();
}

function validationStatus(book: BookMetadata, warnings: string[]): ValidationStatus {
  return validateMinimumBookIngest(book).eligible
    ? warnings.length > 0 ? "warning" : "valid"
    : "invalid";
}

function candidateIdFor(openaiCleanedRecordId: string): string {
  return `candidate-${sha256(openaiCleanedRecordId).slice(0, 12)}`;
}

function readReviewDecisions(path?: string): Map<string, ReviewManifestDecision> {
  const decisions = new Map<string, ReviewManifestDecision>();
  if (!path) return decisions;

  const manifest = parseJson<ReviewManifestFile>(
    readFileSync(path, "utf-8"),
    "review manifest",
  );
  for (const decision of [...(manifest.decisions ?? []), ...(manifest.candidates ?? [])]) {
    if (decision.decision !== "accept" && decision.decision !== "skip") continue;
    if (decision.openaiCleanedRecordId) decisions.set(decision.openaiCleanedRecordId, decision);
    if (decision.candidateId) decisions.set(decision.candidateId, decision);
  }
  return decisions;
}

function latestOpenAICleaningRunId(db: DatabaseSync, options: CliOptions): string {
  const conditions = ["cleaner_kind = 'openai-compatible'"];
  const params: unknown[] = [];
  if (options.cleaningRunId) {
    conditions.push("cleaning_run_id = ?");
    params.push(options.cleaningRunId);
  }
  if (options.pipelineRunId) {
    conditions.push("pipeline_run_id = ?");
    params.push(options.pipelineRunId);
  }

  const row = db.prepare(`
    SELECT cleaning_run_id
    FROM cleaning_runs
    WHERE ${conditions.join(" AND ")}
    ORDER BY started_at DESC, cleaning_run_id DESC
    LIMIT 1
  `).get(...params) as { cleaning_run_id: string } | undefined;

  if (!row) throw new Error("No OpenAI-compatible cleaning run was found");
  return row.cleaning_run_id;
}

function loadCandidateRows(db: DatabaseSync, options: CliOptions, cleaningRunId: string): CandidateRow[] {
  const conditions = [
    "openai_run.cleaning_run_id = ?",
    "rule_run.cleaner_kind = 'rule-parser'",
    "rule_run.pipeline_run_id = openai_run.pipeline_run_id",
  ];
  const params: unknown[] = [cleaningRunId];
  if (options.pipelineRunId) {
    conditions.push("pipeline_runs.run_id = ?");
    params.push(options.pipelineRunId);
  }
  params.push(options.limit);

  return db.prepare(`
    SELECT
      pipeline_runs.run_id AS pipeline_run_id,
      pipeline_runs.execution_mode AS source_execution_mode,
      openai_run.cleaning_run_id AS openai_cleaning_run_id,
      openai.cleaned_record_id AS openai_cleaned_record_id,
      openai.raw_record_id,
      raw.source_url,
      rule.cleaned_record_id AS rule_cleaned_record_id,
      rule.cleaned_json AS rule_cleaned_json,
      openai.cleaned_json AS openai_cleaned_json,
      openai.validation_status AS openai_validation_status,
      openai.validation_warnings_json AS openai_validation_warnings_json,
      openai.field_provenance_json AS openai_field_provenance_json,
      openai.confidence_json AS openai_confidence_json
    FROM cleaned_records AS openai
    INNER JOIN cleaning_runs AS openai_run ON openai_run.cleaning_run_id = openai.cleaning_run_id
    INNER JOIN pipeline_runs ON pipeline_runs.run_id = openai_run.pipeline_run_id
    INNER JOIN raw_scraped_records AS raw ON raw.raw_record_id = openai.raw_record_id
    INNER JOIN cleaned_records AS rule ON rule.raw_record_id = openai.raw_record_id
    INNER JOIN cleaning_runs AS rule_run ON rule_run.cleaning_run_id = rule.cleaning_run_id
    WHERE ${conditions.join(" AND ")}
    ORDER BY openai.created_at ASC, openai.cleaned_record_id ASC, rule.created_at DESC
    LIMIT ?
  `).all(...params) as CandidateRow[];
}

function buildCandidates(
  rows: CandidateRow[],
  decisions: Map<string, ReviewManifestDecision>,
): Candidate[] {
  return rows.map((row) => {
    const ruleBook = parseJson<BookMetadata>(
      row.rule_cleaned_json,
      `${row.rule_cleaned_record_id}.cleaned_json`,
    );
    const openaiBook = parseJson<BookMetadata>(
      row.openai_cleaned_json,
      `${row.openai_cleaned_record_id}.cleaned_json`,
    );
    const changes = changedFields(ruleBook, openaiBook);
    const protectedChanges = changes.filter((field) =>
      PROTECTED_FIELDS.has(field as keyof BookMetadata | "creators")
    );
    const minimumChanges = changes.filter((field) =>
      MINIMUM_FIELDS.has(field as keyof BookMetadata | "creators")
    );
    const warnings = validationWarnings(openaiBook);
    const status = validationStatus(openaiBook, warnings);
    const payload = bookToZoteroBookPayload(openaiBook);
    const payloadValidation = validateZoteroBookPayload(payload);
    const candidateId = candidateIdFor(row.openai_cleaned_record_id);
    const decisionEntry =
      decisions.get(row.openai_cleaned_record_id) ?? decisions.get(candidateId);
    const decision = decisionEntry?.decision ?? "skip";
    const promotionWarnings = [
      ...warnings,
      ...payloadValidation.warnings,
      ...protectedChanges.map((field) => `protected-field-changed-${field}`),
      ...(decision !== "accept" ? ["review-decision-not-accepted"] : []),
    ];
    const prepared =
      decision === "accept" &&
      protectedChanges.length === 0 &&
      validateMinimumBookIngest(openaiBook).eligible &&
      payloadValidation.valid;

    return {
      candidateId,
      rawRecordId: row.raw_record_id,
      sourceUrl: row.source_url,
      ruleCleanedRecordId: row.rule_cleaned_record_id,
      openaiCleanedRecordId: row.openai_cleaned_record_id,
      ruleBook,
      openaiBook,
      validationStatus: status,
      validationWarnings: warnings,
      payloadWarnings: payloadValidation.warnings,
      changedFields: changes,
      protectedChangedFields: protectedChanges,
      minimumFieldChanges: minimumChanges,
      recommendedDecision:
        protectedChanges.length === 0 &&
        validateMinimumBookIngest(openaiBook).eligible &&
        payloadValidation.valid
          ? "accept"
          : "skip",
      decision,
      decisionNotes: decisionEntry?.notes ?? "",
      promotionStatus: prepared ? "prepared" : "skipped",
      promotionWarnings: Array.from(new Set(promotionWarnings)).sort(),
    };
  });
}

function manifestJson(options: CliOptions, cleaningRunId: string, candidates: Candidate[]) {
  return {
    schemaVersion: 1,
    mode: "openai-cleaned-promotion-review",
    policy: options.policy,
    sourceCleaningRunId: cleaningRunId,
    generatedAt: new Date().toISOString(),
    instructions: [
      "Set decision to accept only after reviewing the OpenAI-cleaned row against the rule-parser baseline.",
      "The restricted-safe-v1 policy will still block protected-field changes from becoming prepared import records.",
    ],
    candidates: candidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      rawRecordId: candidate.rawRecordId,
      sourceUrl: candidate.sourceUrl,
      ruleCleanedRecordId: candidate.ruleCleanedRecordId,
      openaiCleanedRecordId: candidate.openaiCleanedRecordId,
      decision: candidate.decision,
      recommendedDecision: candidate.recommendedDecision,
      notes: candidate.decisionNotes,
      validationStatus: candidate.validationStatus,
      validationWarnings: candidate.validationWarnings,
      payloadWarnings: candidate.payloadWarnings,
      changedFields: candidate.changedFields,
      protectedChangedFields: candidate.protectedChangedFields,
      minimumFieldChanges: candidate.minimumFieldChanges,
      ruleBook: candidate.ruleBook,
      openaiBook: candidate.openaiBook,
    })),
  };
}

function markdownReport(options: CliOptions, cleaningRunId: string, candidates: Candidate[], applied: boolean): string {
  const prepared = candidates.filter((candidate) => candidate.promotionStatus === "prepared").length;
  const accepted = candidates.filter((candidate) => candidate.decision === "accept").length;
  const protectedChanged = candidates.filter((candidate) => candidate.protectedChangedFields.length > 0).length;
  const rows = candidates
    .slice(0, 50)
    .map((candidate) =>
      `| ${candidate.openaiCleanedRecordId} | ${candidate.decision} | ${candidate.promotionStatus} | ${candidate.changedFields.join(", ") || "none"} | ${candidate.protectedChangedFields.join(", ") || "none"} | ${candidate.promotionWarnings.join(", ") || "none"} |`
    )
    .join("\n");

  return `# OpenAI-Cleaned Promotion Review

Generated at: ${new Date().toISOString()}

Policy: \`${options.policy}\`

Source cleaning run: \`${cleaningRunId}\`

Applied to SQLite: ${applied ? "yes" : "no"}

Candidates: ${candidates.length}

Accepted decisions: ${accepted}

Prepared import records: ${prepared}

Candidates with protected changes: ${protectedChanged}

## Candidate Summary

| OpenAI cleaned record | Decision | Promotion status | Changed fields | Protected changes | Promotion warnings |
|---|---|---|---|---|---|
${rows || "| none | | | | | |"}
`;
}

function insertPromotionRows(
  db: DatabaseSync,
  options: CliOptions,
  cleaningRunId: string,
  candidates: Candidate[],
): { exportRunId: string; importRunId: string; targetCollectionName: string; written: number; prepared: number; skipped: number } {
  const now = new Date().toISOString();
  const source = candidates[0];
  if (!source) throw new Error("No candidates to promote");

  const exportRunId = `export-run-openai-promotion-zotero-json-${options.collectionStamp}`;
  const importRunId = `import-run-openai-promotion-zotero-json-${options.collectionStamp}`;
  const targetName = targetCollectionName(packageJson.version, options.testName, options.collectionStamp);

  db.exec("BEGIN");
  try {
    db.prepare(`
      INSERT INTO export_runs
      (export_run_id, pipeline_run_id, format, target, started_at, completed_at, settings_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      exportRunId,
      (db.prepare("SELECT pipeline_run_id FROM cleaning_runs WHERE cleaning_run_id = ?").get(cleaningRunId) as { pipeline_run_id: string }).pipeline_run_id,
      "zotero-json",
      relative(rootDir, dirname(options.manifestPath)),
      now,
      now,
      json({
        policy: options.policy,
        sourceCleaningRunId: cleaningRunId,
        reviewManifestPath: relative(rootDir, options.reviewManifestPath ?? options.manifestPath),
        targetCollectionName: targetName,
      }),
    );

    db.prepare(`
      INSERT INTO import_runs
      (import_run_id, pipeline_run_id, execution_mode, target, status, started_at, completed_at, settings_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      importRunId,
      (db.prepare("SELECT pipeline_run_id FROM cleaning_runs WHERE cleaning_run_id = ?").get(cleaningRunId) as { pipeline_run_id: string }).pipeline_run_id,
      "dry-run",
      "zotero-json-payload",
      "prepared",
      now,
      now,
      json({
        zoteroWritesAllowed: false,
        policy: options.policy,
        sourceCleaningRunId: cleaningRunId,
        reviewManifestPath: relative(rootDir, options.reviewManifestPath ?? options.manifestPath),
        testName: options.testName,
        targetCollectionName: targetName,
        collectionNaming: "douban-to-zotero {version} {testName} {YYYYMMDD-HHMMSS}",
      }),
    );

    let written = 0;
    let prepared = 0;
    let skipped = 0;
    for (const candidate of candidates) {
      if (candidate.promotionStatus !== "prepared" && !options.preserveSkipped) continue;

      const payload = bookToZoteroBookPayload(candidate.openaiBook);
      const exportRecordId = `export-zotero-json-openai-promoted-${safeIdPart(candidate.openaiCleanedRecordId)}-${options.collectionStamp}`;
      const importRecordId = `import-zotero-json-openai-promoted-${safeIdPart(candidate.openaiCleanedRecordId)}-${options.collectionStamp}`;
      const status = candidate.promotionStatus;

      db.prepare(`
        INSERT INTO export_records
        (export_record_id, export_run_id, cleaned_record_id, internal_id, format, payload_text, payload_json, validation_status, validation_warnings_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        exportRecordId,
        exportRunId,
        candidate.openaiCleanedRecordId,
        exportRecordId,
        "zotero-json",
        null,
        json(payload),
        candidate.validationStatus,
        json(candidate.promotionWarnings),
        now,
      );

      db.prepare(`
        INSERT INTO import_records
        (import_record_id, import_run_id, cleaned_record_id, export_record_id, internal_id, zotero_item_id, item_payload_json, status, validation_warnings_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        importRecordId,
        importRunId,
        candidate.openaiCleanedRecordId,
        exportRecordId,
        importRecordId,
        null,
        json(payload),
        status,
        json(candidate.promotionWarnings),
        now,
      );

      written++;
      if (status === "prepared") prepared++;
      else skipped++;
    }

    db.exec("COMMIT");
    return { exportRunId, importRunId, targetCollectionName: targetName, written, prepared, skipped };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function runPromotionCli(argv: string[]): void {
  globalThis.fetch = (() => {
    throw new Error("OpenAI-cleaned promotion forbids network access");
  }) as typeof fetch;

  const options = parseArgs(argv);
  if (!existsSync(options.dbPath)) {
    throw new Error(`SQLite database does not exist: ${options.dbPath}`);
  }

  mkdirSync(dirname(options.summaryPath), { recursive: true });
  mkdirSync(dirname(options.manifestPath), { recursive: true });
  mkdirSync(dirname(options.reportPath), { recursive: true });

  const decisions = readReviewDecisions(options.apply ? options.reviewManifestPath : undefined);
  const db = new DatabaseSync(options.dbPath);
  db.exec("PRAGMA foreign_keys = ON");

  try {
    const cleaningRunId = latestOpenAICleaningRunId(db, options);
    const rows = loadCandidateRows(db, options, cleaningRunId);
    if (rows.length === 0) {
      throw new Error(`No OpenAI-compatible cleaned records were found for ${cleaningRunId}`);
    }

    const candidates = buildCandidates(rows, decisions);
    const applyResult = options.apply
      ? insertPromotionRows(db, options, cleaningRunId, candidates)
      : undefined;
    const manifest = manifestJson(options, cleaningRunId, candidates);
    const report = markdownReport(options, cleaningRunId, candidates, options.apply);
    const summary = {
      executionMode: "dry-run",
      mode: "openai-cleaned-promotion",
      dbPath: relative(rootDir, options.dbPath),
      policy: options.policy,
      sourceCleaningRunId: cleaningRunId,
      applied: options.apply,
      preserveSkipped: options.preserveSkipped,
      candidateCount: candidates.length,
      acceptedDecisions: candidates.filter((candidate) => candidate.decision === "accept").length,
      preparedCandidates: candidates.filter((candidate) => candidate.promotionStatus === "prepared").length,
      skippedCandidates: candidates.filter((candidate) => candidate.promotionStatus === "skipped").length,
      protectedChangedCandidates: candidates.filter((candidate) => candidate.protectedChangedFields.length > 0).length,
      manifestPath: relative(rootDir, options.manifestPath),
      reportPath: relative(rootDir, options.reportPath),
      networkRequests: 0,
      ...(applyResult ?? {}),
    };

    writeFileSync(options.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
    writeFileSync(options.reportPath, report, "utf-8");
    writeFileSync(options.summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf-8");
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } finally {
    db.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runPromotionCli(process.argv.slice(2));
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
