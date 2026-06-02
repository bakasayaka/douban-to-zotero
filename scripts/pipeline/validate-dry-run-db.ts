import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { validateZoteroBookPayload } from "../../src/modules/zotero-payload-validator";

interface CliOptions {
  dbPath: string;
  summaryPath: string;
}

const rootDir = resolve(import.meta.dirname, "..", "..");

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    dbPath: join(rootDir, ".cache", "dry-run", "pipeline.sqlite"),
    summaryPath: join(rootDir, ".cache", "dry-run", "pipeline-summary.json"),
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--db") {
      options.dbPath = resolve(rootDir, argv[++i]);
    } else if (arg === "--summary") {
      options.summaryPath = resolve(rootDir, argv[++i]);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function run() {
  if (process.env.DOUBAN_TO_ZOTERO_EXECUTION_MODE !== "dry-run") {
    throw new Error("validate-dry-run-db requires DOUBAN_TO_ZOTERO_EXECUTION_MODE=dry-run");
  }

  const options = parseArgs(process.argv.slice(2));
  assert(existsSync(options.dbPath), `Dry-run database does not exist: ${options.dbPath}`);
  assert(existsSync(options.summaryPath), `Dry-run summary does not exist: ${options.summaryPath}`);

  const summary = JSON.parse(readFileSync(options.summaryPath, "utf-8"));
  assert(summary.executionMode === "dry-run", "summary execution mode must be dry-run");
  assert(summary.networkRequests === 0, "dry-run summary must report zero network requests");
  assert(
    typeof summary.targetCollectionName === "string" &&
      /^douban-to-zotero \S+ \S+ \d{8}-\d{6}$/.test(summary.targetCollectionName),
    "summary must include a versioned test collection name",
  );

  const db = new DatabaseSync(options.dbPath, { readOnly: true });
  const formats = new Set(
    (db.prepare("SELECT DISTINCT format FROM export_records").all() as Array<{ format: string }>)
      .map((row) => row.format),
  );
  for (const format of ["zotero-json", "bibtex", "biblatex"]) {
    assert(formats.has(format), `missing export format: ${format}`);
  }

  const runs = db.prepare("SELECT execution_mode FROM pipeline_runs").all() as Array<{ execution_mode: string }>;
  assert(runs.length > 0, "pipeline_runs must not be empty");
  assert(runs.every((run) => run.execution_mode === "dry-run"), "all pipeline runs must be dry-run");

  const imports = db.prepare("SELECT import_record_id, item_payload_json, status, validation_warnings_json FROM import_records").all() as Array<{
    import_record_id: string;
    item_payload_json: string;
    status: string;
    validation_warnings_json: string;
  }>;
  assert(imports.length > 0, "import_records must not be empty");

  const importRuns = db.prepare("SELECT settings_json FROM import_runs").all() as Array<{
    settings_json: string;
  }>;
  assert(importRuns.length > 0, "import_runs must not be empty");
  for (const run of importRuns) {
    const settings = JSON.parse(run.settings_json);
    assert(
      typeof settings.targetCollectionName === "string" &&
        /^douban-to-zotero \S+ \S+ \d{8}-\d{6}$/.test(settings.targetCollectionName),
      "each import run must declare a versioned timestamped target collection",
    );
  }

  const payloadErrors: string[] = [];
  for (const record of imports) {
    const payload = JSON.parse(record.item_payload_json);
    const validation = validateZoteroBookPayload(payload);
    if (!validation.valid) {
      payloadErrors.push(`${record.import_record_id}: ${validation.warnings.join(", ")}`);
    }
    const warnings = JSON.parse(record.validation_warnings_json) as string[];
    const minimumWarnings = warnings.filter((warning) => warning.startsWith("minimum-ingest-"));
    if (record.status === "prepared") {
      assert(
        minimumWarnings.length === 0,
        `${record.import_record_id} is prepared despite minimum ingest warnings: ${minimumWarnings.join(", ")}`,
      );
    }
    if (record.status === "skipped") {
      assert(
        minimumWarnings.length > 0,
        `${record.import_record_id} is skipped without minimum ingest warnings`,
      );
    }
  }
  assert(payloadErrors.length === 0, `invalid Zotero payloads: ${payloadErrors.join("; ")}`);

  const result = {
    executionMode: "dry-run",
    exports: [...formats].sort(),
    importRecordsValidated: imports.length,
    targetCollectionName: summary.targetCollectionName,
    networkRequests: summary.networkRequests,
  };
  db.close();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

run();
