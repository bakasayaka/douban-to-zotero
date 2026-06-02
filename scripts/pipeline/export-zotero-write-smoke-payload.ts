import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ZoteroBookPayload } from "../../src/types/pipeline";
import { validateZoteroBookPayload } from "../../src/modules/zotero-payload-validator";

interface CliOptions {
  dbPath: string;
  summaryPath: string;
  outPath: string;
  importRunId?: string;
  limit: number;
}

interface ImportRecordRow {
  import_record_id: string;
  import_run_id: string;
  internal_id: string;
  item_payload_json: string;
  status: string;
  validation_warnings_json: string;
  settings_json: string;
}

const rootDir = resolve(import.meta.dirname, "..", "..");
const COLLECTION_NAME_PATTERN = /^douban-to-zotero \S+ \S+ \d{8}-\d{6}$/;

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    dbPath: join(rootDir, ".cache", "dry-run", "pipeline.sqlite"),
    summaryPath: join(rootDir, ".cache", "dry-run", "pipeline-summary.json"),
    outPath: join(rootDir, ".cache", "dry-run", "zotero-write-smoke-payload.json"),
    limit: 3,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--db") {
      options.dbPath = resolve(rootDir, argv[++i]);
    } else if (arg === "--summary") {
      options.summaryPath = resolve(rootDir, argv[++i]);
    } else if (arg === "--out") {
      options.outPath = resolve(rootDir, argv[++i]);
    } else if (arg === "--import-run-id") {
      options.importRunId = argv[++i];
    } else if (arg === "--limit") {
      options.limit = Number.parseInt(argv[++i], 10);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 20) {
    throw new Error("--limit must be an integer from 1 to 20");
  }

  return options;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function parseJson<T>(text: string, label: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (error: any) {
    throw new Error(`${label} is not valid JSON: ${error?.message || String(error)}`);
  }
}

function relativePath(path: string): string {
  return relative(rootDir, path);
}

function run() {
  if (process.env.DOUBAN_TO_ZOTERO_EXECUTION_MODE !== "dry-run") {
    throw new Error("export-zotero-write-smoke-payload requires DOUBAN_TO_ZOTERO_EXECUTION_MODE=dry-run");
  }

  const options = parseArgs(process.argv.slice(2));
  assert(existsSync(options.dbPath), `Dry-run database does not exist: ${options.dbPath}`);
  if (!options.importRunId) {
    assert(existsSync(options.summaryPath), `Dry-run summary does not exist: ${options.summaryPath}`);
  }
  const summary = options.importRunId
    ? undefined
    : parseJson<{
        executionMode: string;
        targetCollectionName: string;
        networkRequests: number;
      }>(readFileSync(options.summaryPath, "utf-8"), "dry-run summary");

  if (!options.importRunId) {
    assert(summary?.executionMode === "dry-run", "summary execution mode must be dry-run");
    assert(summary.networkRequests === 0, "dry-run summary must report zero network requests");
    assert(
      COLLECTION_NAME_PATTERN.test(summary.targetCollectionName),
      "summary targetCollectionName must be versioned and timestamped",
    );
  }

  const db = new DatabaseSync(options.dbPath, { readOnly: true });
  try {
    const conditions = ["ir.status = 'prepared'"];
    const params: unknown[] = [];
    if (options.importRunId) {
      conditions.push("ir.import_run_id = ?");
      params.push(options.importRunId);
    }
    params.push(options.limit);

    const rows = db.prepare(`
      SELECT
        ir.import_record_id,
        ir.import_run_id,
        ir.internal_id,
        ir.item_payload_json,
        ir.status,
        ir.validation_warnings_json,
        run.settings_json
      FROM import_records AS ir
      INNER JOIN import_runs AS run ON run.import_run_id = ir.import_run_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY ir.created_at ASC, ir.import_record_id ASC
      LIMIT ?
    `).all(...params) as ImportRecordRow[];

    assert(rows.length > 0, "No prepared import_records were found");

    const records = rows.map((row) => {
      const payload = parseJson<ZoteroBookPayload>(
        row.item_payload_json,
        `${row.import_record_id}.item_payload_json`,
      );
      const payloadValidation = validateZoteroBookPayload(payload);
      assert(
        payloadValidation.valid,
        `${row.import_record_id} has invalid payload: ${payloadValidation.warnings.join(", ")}`,
      );

      const validationWarnings = parseJson<string[]>(
        row.validation_warnings_json,
        `${row.import_record_id}.validation_warnings_json`,
      );
      assert(
        validationWarnings.every((warning) => !warning.startsWith("minimum-ingest-")),
        `${row.import_record_id} still has minimum-ingest warnings`,
      );

      return {
        importRecordId: row.import_record_id,
        importRunId: row.import_run_id,
        internalId: row.internal_id,
        status: "prepared" as const,
        payload,
        validationWarnings,
      };
    });

    const runSettings = parseJson<{ targetCollectionName?: string }>(
      rows[0].settings_json,
      `${rows[0].import_run_id}.settings_json`,
    );
    assert(
      typeof runSettings.targetCollectionName === "string" &&
        COLLECTION_NAME_PATTERN.test(runSettings.targetCollectionName),
      "import run targetCollectionName must be versioned and timestamped",
    );
    if (summary) {
      assert(
        runSettings.targetCollectionName === summary.targetCollectionName,
        "import run targetCollectionName must match dry-run summary",
      );
    }
    const targetCollectionName = runSettings.targetCollectionName;
    assert(
      rows.every((row) => row.import_run_id === rows[0].import_run_id),
      "exported payload must come from a single import_run_id",
    );

    const payloadFile = {
      schemaVersion: 1,
      mode: "zotero-write-dry-payload",
      executionMode: "dry-run",
      targetCollectionName,
      sourceDbPath: relativePath(options.dbPath),
      summaryPath: summary ? relativePath(options.summaryPath) : null,
      exportedAt: new Date().toISOString(),
      recordCount: records.length,
      records,
    };

    mkdirSync(dirname(options.outPath), { recursive: true });
    writeFileSync(options.outPath, `${JSON.stringify(payloadFile, null, 2)}\n`, "utf-8");

    process.stdout.write(`${JSON.stringify({
      executionMode: "dry-run",
      mode: "zotero-write-dry-payload",
      outPath: relativePath(options.outPath),
      targetCollectionName,
      importRunId: rows[0].import_run_id,
      recordCount: records.length,
      networkRequests: summary?.networkRequests ?? 0,
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
