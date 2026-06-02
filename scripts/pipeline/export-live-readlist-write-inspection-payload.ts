import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { bookToZoteroBookPayload } from "../../src/modules/zotero-book-payload";
import { validateZoteroBookPayload } from "../../src/modules/zotero-payload-validator";
import type { BookMetadata } from "../../src/types";
import type { ValidationStatus, ZoteroBookPayload } from "../../src/types/pipeline";
import packageJson from "../../package.json";

interface CliOptions {
  dbPath: string;
  outPath: string;
  cleaningRunId?: string;
  limit: number | null;
  testName: string;
  collectionStamp: string;
}

interface CleanedReadlistRow {
  cleaned_record_id: string;
  cleaning_run_id: string;
  raw_record_id: string;
  internal_id: string;
  cleaned_json: string;
  validation_status: ValidationStatus;
  validation_warnings_json: string;
  source_url: string;
  douban_subject_id: string | null;
  extraction_warnings_json: string;
  list_context_json: string;
  created_at: string;
}

interface ListContext {
  wishlistUrl?: string;
  wishlistTitle?: string;
  position?: number;
}

const rootDir = resolve(import.meta.dirname, "..", "..");
const DATASET_NAME = "FRL-95";
const DATASET_LABEL = "Full Readlist Cohort 95";

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    dbPath: join(rootDir, ".cache", "live", "pipeline.sqlite"),
    outPath: join(rootDir, ".cache", "dry-run", "live-readlist-write-inspection-payload.json"),
    limit: null,
    testName: "frl-95-reference-samples-write",
    collectionStamp: formatCollectionTimestamp(new Date().toISOString()),
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--db") options.dbPath = resolve(rootDir, argv[++i]);
    else if (arg === "--out") options.outPath = resolve(rootDir, argv[++i]);
    else if (arg === "--cleaning-run-id") options.cleaningRunId = argv[++i];
    else if (arg === "--limit") options.limit = Number.parseInt(argv[++i], 10);
    else if (arg === "--test-name") options.testName = argv[++i];
    else if (arg === "--collection-stamp") options.collectionStamp = argv[++i];
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (options.limit !== null && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 1000)) {
    throw new Error("--limit must be an integer from 1 to 1000");
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(options.testName)) {
    throw new Error("--test-name must contain only letters, numbers, underscore, dot, or dash");
  }
  if (!/^\d{8}-\d{6}$/.test(options.collectionStamp)) {
    throw new Error("--collection-stamp must use YYYYMMDD-HHMMSS");
  }

  return options;
}

function parseJson<T>(text: string, label: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (error: any) {
    throw new Error(`${label} is not valid JSON: ${error?.message || String(error)}`);
  }
}

function formatCollectionTimestamp(isoTimestamp: string): string {
  return isoTimestamp
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z")
    .replace("T", "-")
    .replace("Z", "");
}

function targetCollectionName(version: string, testName: string, stamp: string): string {
  return `douban-to-zotero ${version} ${testName} ${stamp}`;
}

function relativePath(path: string): string {
  return relative(rootDir, path);
}

function readLatestCleaningRunId(db: DatabaseSync): string {
  const row = db.prepare(`
    SELECT cleaning_run_id
    FROM cleaning_runs
    ORDER BY started_at DESC, cleaning_run_id DESC
    LIMIT 1
  `).get() as { cleaning_run_id?: string } | undefined;

  if (!row?.cleaning_run_id) {
    throw new Error("No cleaning_runs were found in the readlist database");
  }
  return row.cleaning_run_id;
}

function loadRows(db: DatabaseSync, cleaningRunId: string): CleanedReadlistRow[] {
  return db.prepare(`
    SELECT
      cr.cleaned_record_id,
      cr.cleaning_run_id,
      cr.raw_record_id,
      cr.internal_id,
      cr.cleaned_json,
      cr.validation_status,
      cr.validation_warnings_json,
      raw.source_url,
      raw.douban_subject_id,
      raw.extraction_warnings_json,
      raw.list_context_json,
      raw.created_at
    FROM cleaned_records AS cr
    INNER JOIN raw_scraped_records AS raw ON raw.raw_record_id = cr.raw_record_id
    WHERE cr.cleaning_run_id = ?
  `).all(cleaningRunId) as CleanedReadlistRow[];
}

function listContext(row: CleanedReadlistRow): ListContext {
  return parseJson<ListContext>(row.list_context_json, `${row.raw_record_id}.list_context_json`);
}

function rowSortKey(row: CleanedReadlistRow): { position: number; subjectId: string; rawRecordId: string } {
  const context = listContext(row);
  return {
    position: typeof context.position === "number" ? context.position : Number.MAX_SAFE_INTEGER,
    subjectId: row.douban_subject_id ?? "",
    rawRecordId: row.raw_record_id,
  };
}

function sortRowsInReadlistOrder(rows: CleanedReadlistRow[]): CleanedReadlistRow[] {
  return rows.slice().sort((a, b) => {
    const left = rowSortKey(a);
    const right = rowSortKey(b);
    return (
      left.position - right.position ||
      left.subjectId.localeCompare(right.subjectId) ||
      left.rawRecordId.localeCompare(right.rawRecordId)
    );
  });
}

function addInspectionNotes(
  payload: ZoteroBookPayload,
  row: CleanedReadlistRow,
  context: ListContext,
  validationWarnings: string[],
  extractionWarnings: string[],
): ZoteroBookPayload {
  return {
    ...payload,
    notes: [
      ...payload.notes,
      {
        source: "validation",
        note: [
          `Readlist sample: ${row.douban_subject_id ?? row.raw_record_id}`,
          `Source URL: ${row.source_url}`,
          `Wishlist URL: ${context.wishlistUrl ?? "unknown"}`,
          `Wishlist position: ${typeof context.position === "number" ? context.position : "unknown"}`,
          `Wishlist title: ${context.wishlistTitle ?? "unknown"}`,
          `Cleaning run: ${row.cleaning_run_id}`,
          `Validation status: ${row.validation_status}`,
          `Validation warnings: ${validationWarnings.length ? validationWarnings.join(", ") : "none"}`,
          `Extraction warnings: ${extractionWarnings.length ? extractionWarnings.join(", ") : "none"}`,
        ].join("\n"),
      },
    ],
  };
}

function run() {
  if (process.env.DOUBAN_TO_ZOTERO_EXECUTION_MODE !== "dry-run") {
    throw new Error("live readlist write inspection payload export requires DOUBAN_TO_ZOTERO_EXECUTION_MODE=dry-run");
  }

  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(options.dbPath)) {
    throw new Error(`Readlist database does not exist: ${options.dbPath}`);
  }

  const db = new DatabaseSync(options.dbPath, { readOnly: true });
  try {
    const cleaningRunId = options.cleaningRunId ?? readLatestCleaningRunId(db);
    const loadedRows = sortRowsInReadlistOrder(loadRows(db, cleaningRunId));
    const rows = options.limit === null ? loadedRows : loadedRows.slice(0, options.limit);
    if (rows.length === 0) {
      throw new Error(`No cleaned_records found for cleaning run ${cleaningRunId}`);
    }

    const records = rows.map((row) => {
      const book = parseJson<BookMetadata>(row.cleaned_json, `${row.cleaned_record_id}.cleaned_json`);
      const context = listContext(row);
      const validationWarnings = parseJson<string[]>(
        row.validation_warnings_json,
        `${row.cleaned_record_id}.validation_warnings_json`,
      );
      const extractionWarnings = parseJson<string[]>(
        row.extraction_warnings_json,
        `${row.raw_record_id}.extraction_warnings_json`,
      );
      const payload = addInspectionNotes(
        bookToZoteroBookPayload(book),
        row,
        context,
        validationWarnings,
        extractionWarnings,
      );
      const payloadValidation = validateZoteroBookPayload(payload);
      if (!payloadValidation.valid) {
        throw new Error(
          `${row.cleaned_record_id} produced an invalid Zotero payload: ${payloadValidation.warnings.join(", ")}`,
        );
      }

      return {
        importRecordId: `readlist-sample-${row.douban_subject_id ?? row.raw_record_id}`,
        internalId: row.internal_id,
        status: "inspection" as const,
        sourceUrl: row.source_url,
        subjectId: row.douban_subject_id,
        rawRecordId: row.raw_record_id,
        cleanedRecordId: row.cleaned_record_id,
        cleaningRunId: row.cleaning_run_id,
        readlistPosition: context.position,
        validationStatus: row.validation_status,
        validationWarnings,
        extractionWarnings,
        payload,
      };
    });

    const payloadFile = {
      schemaVersion: 1,
      mode: "reference-sample-write-inspection-payload",
      executionMode: "dry-run",
      datasetName: DATASET_NAME,
      datasetLabel: DATASET_LABEL,
      targetCollectionName: targetCollectionName(packageJson.version, options.testName, options.collectionStamp),
      sourceDbPath: relativePath(options.dbPath),
      summaryPath: relativePath(options.outPath),
      exportedAt: new Date().toISOString(),
      cleaningRunId,
      sourceRecordCount: loadedRows.length,
      recordCount: records.length,
      validationStatusCounts: records.reduce<Record<string, number>>((counts, record) => {
        counts[record.validationStatus] = (counts[record.validationStatus] ?? 0) + 1;
        return counts;
      }, {}),
      records,
    };

    mkdirSync(dirname(options.outPath), { recursive: true });
    writeFileSync(options.outPath, `${JSON.stringify(payloadFile, null, 2)}\n`, "utf-8");

    process.stdout.write(`${JSON.stringify({
      executionMode: "dry-run",
      mode: payloadFile.mode,
      datasetName: payloadFile.datasetName,
      outPath: relativePath(options.outPath),
      targetCollectionName: payloadFile.targetCollectionName,
      sourceDbPath: payloadFile.sourceDbPath,
      cleaningRunId,
      sourceRecordCount: payloadFile.sourceRecordCount,
      recordCount: records.length,
      validationStatusCounts: payloadFile.validationStatusCounts,
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
