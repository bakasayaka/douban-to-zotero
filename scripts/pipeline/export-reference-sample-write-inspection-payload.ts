import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { JSDOM } from "jsdom";

import {
  isSupportedBookLanguage,
  validateMinimumBookIngest,
} from "../../src/modules/ingest-validator";
import { parseBookDetailWithDiagnostics } from "../../src/modules/parser";
import { bookToZoteroBookPayload } from "../../src/modules/zotero-book-payload";
import { validateZoteroBookPayload } from "../../src/modules/zotero-payload-validator";
import type { BookMetadata } from "../../src/types";
import type { ValidationStatus, ZoteroBookPayload } from "../../src/types/pipeline";
import packageJson from "../../package.json";

interface CliOptions {
  samplesDir: string;
  outPath: string;
  limit: number | null;
  testName: string;
  collectionStamp: string;
}

interface ReferenceSample {
  subjectId: string;
  sourceUrl: string;
  metadataPath: string;
  htmlPath: string;
  htmlKind: "sourceHtml" | "domHtml";
  html: string;
}

const rootDir = resolve(import.meta.dirname, "..", "..");
const DATASET_NAME = "RS-100";
const DATASET_LABEL = "Reference Sample Corpus 100";

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    samplesDir: join(rootDir, "fixtures", "douban", "reference-samples"),
    outPath: join(rootDir, ".cache", "dry-run", "reference-sample-write-inspection-payload.json"),
    limit: null,
    testName: "rs-100-reference-samples-write",
    collectionStamp: formatCollectionTimestamp(new Date().toISOString()),
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--samples-dir") options.samplesDir = resolve(rootDir, argv[++i]);
    else if (arg === "--out") options.outPath = resolve(rootDir, argv[++i]);
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

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

function resolveSampleFilePath(pathValue: unknown): string | null {
  const rawPath = cleanString(pathValue);
  if (!rawPath) return null;

  const path = resolve(rootDir, rawPath);
  if (!existsSync(path)) return null;
  return statSync(path).isFile() ? path : null;
}

function walk(dir: string): string[] {
  const paths: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) paths.push(...walk(path));
    else paths.push(path);
  }
  return paths;
}

function loadSamples(samplesDir: string, limit: number | null): ReferenceSample[] {
  const samples = walk(samplesDir)
    .filter((path) => path.endsWith("metadata.json"))
    .map((metadataPath) => {
      const metadata = readJson<any>(metadataPath);
      const sourceHtmlPath = resolveSampleFilePath(metadata.files?.sourceHtml);
      const domHtmlPath = resolveSampleFilePath(metadata.files?.domHtml);
      const htmlKind = sourceHtmlPath ? "sourceHtml" : "domHtml";
      const htmlPath = sourceHtmlPath ?? domHtmlPath;
      if (!htmlPath) {
        throw new Error(`Reference sample ${metadata.subjectId} has no readable sourceHtml/domHtml`);
      }

      return {
        subjectId: String(metadata.subjectId),
        sourceUrl: String(metadata.sourceUrl),
        metadataPath,
        htmlPath,
        htmlKind,
        html: readFileSync(htmlPath, "utf-8"),
      } satisfies ReferenceSample;
    })
    .sort((a, b) => a.subjectId.localeCompare(b.subjectId));
  return limit === null ? samples : samples.slice(0, limit);
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

function validationStatus(book: BookMetadata, warnings: string[]): ValidationStatus {
  return validateMinimumBookIngest(book).eligible
    ? warnings.length > 0 ? "warning" : "valid"
    : "invalid";
}

function validationWarnings(book: BookMetadata): string[] {
  const warnings = [...validateMinimumBookIngest(book).warnings];
  if (book.language && !isSupportedBookLanguage(book.language)) {
    warnings.push(`minimum-ingest-unsupported-language-${book.language}`);
  }
  return Array.from(new Set(warnings)).sort();
}

function addInspectionNotes(
  payload: ZoteroBookPayload,
  sample: ReferenceSample,
  validationStatusValue: ValidationStatus,
  validationWarningsValue: string[],
  extractionWarnings: string[],
): ZoteroBookPayload {
  return {
    ...payload,
    notes: [
      ...payload.notes,
      {
        source: "validation",
        note: [
          `Reference sample: ${sample.subjectId}`,
          `Source URL: ${sample.sourceUrl}`,
          `Validation status: ${validationStatusValue}`,
          `Validation warnings: ${validationWarningsValue.length ? validationWarningsValue.join(", ") : "none"}`,
          `Extraction warnings: ${extractionWarnings.length ? extractionWarnings.join(", ") : "none"}`,
        ].join("\n"),
      },
    ],
  };
}

function relativePath(path: string): string {
  return relative(rootDir, path);
}

function run() {
  if (process.env.DOUBAN_TO_ZOTERO_EXECUTION_MODE !== "dry-run") {
    throw new Error("reference sample write inspection payload export requires DOUBAN_TO_ZOTERO_EXECUTION_MODE=dry-run");
  }

  const options = parseArgs(process.argv.slice(2));
  const dom = new JSDOM("<!doctype html>");
  globalThis.DOMParser = dom.window.DOMParser;

  const samples = loadSamples(options.samplesDir, options.limit);
  const records = samples.map((sample) => {
    const parsed = parseBookDetailWithDiagnostics(sample.html, sample.sourceUrl);
    const warnings = validationWarnings(parsed.book);
    const status = validationStatus(parsed.book, warnings);
    const payload = addInspectionNotes(
      bookToZoteroBookPayload(parsed.book),
      sample,
      status,
      warnings,
      parsed.extractionWarnings,
    );
    const payloadValidation = validateZoteroBookPayload(payload);
    if (!payloadValidation.valid) {
      throw new Error(
        `Reference sample ${sample.subjectId} produced an invalid Zotero payload: ${payloadValidation.warnings.join(", ")}`,
      );
    }

    return {
      importRecordId: `reference-sample-${sample.subjectId}`,
      internalId: `reference-sample-${sample.subjectId}`,
      status: "inspection" as const,
      sourceUrl: sample.sourceUrl,
      subjectId: sample.subjectId,
      metadataPath: relativePath(sample.metadataPath),
      htmlPath: relativePath(sample.htmlPath),
      htmlKind: sample.htmlKind,
      validationStatus: status,
      validationWarnings: warnings,
      extractionWarnings: parsed.extractionWarnings,
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
    sourceDbPath: relativePath(options.samplesDir),
    summaryPath: relativePath(options.outPath),
    exportedAt: new Date().toISOString(),
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
    recordCount: records.length,
    validationStatusCounts: payloadFile.validationStatusCounts,
    networkRequests: 0,
  }, null, 2)}\n`);
}

try {
  run();
} catch (error) {
  console.error(error);
  process.exit(1);
}
