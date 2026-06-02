import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { JSDOM } from "jsdom";

import type { BookMetadata, Creator } from "../../src/types";
import type { ValidationStatus } from "../../src/types/pipeline";
import {
  ModelHttpError,
  ModelRateLimitError,
  normalizeBaseUrl,
  redactOpenAICompatibleBaseUrl,
  redactOpenAICompatibleSecrets,
} from "../../src/modules/openai-compatible-client";
import { FetchOpenAICompatibleTransport } from "../../src/modules/openai-compatible-transport";
import { parseBookDetailWithDiagnostics } from "../../src/modules/parser";
import {
  normalizeSupportedBookLanguage,
  SUPPORTED_BOOK_LANGUAGE_CODES,
  validateMinimumBookIngest,
} from "../../src/modules/ingest-validator";

type CleaningMode = "unrestricted" | "restricted";

interface CliOptions {
  samplesDir: string;
  outDir: string;
  baseUrl: string;
  apiKeyEnv: string;
  model: string;
  temperature: number;
  timeoutMs: number;
  maxRawChars: number;
  limit: number;
  concurrency: number;
  confirmedLive: boolean;
  continueOnError: boolean;
}

interface ReferenceSample {
  subjectId: string;
  sourceUrl: string;
  metadataPath: string;
  htmlPath: string;
  htmlKind: "sourceHtml" | "domHtml";
  html: string;
}

interface ModelRequestLogEntry {
  mode: CleaningMode;
  subjectId: string;
  url: string;
  startedAt: string;
  finishedAt?: string;
  ok: boolean;
  statusCode?: number;
  errorName?: string;
  errorMessage?: string;
}

interface ModeResult {
  mode: CleaningMode;
  ok: boolean;
  cleaned?: BookMetadata;
  validationStatus?: ValidationStatus;
  validationWarnings?: string[];
  changedFields?: string[];
  acceptedChangedFields?: string[];
  rejectedChangedFields?: string[];
  highRiskChangedFields?: string[];
  minimumFieldChanges?: string[];
  error?: string;
  statusCode?: number;
}

interface SampleComparison {
  subjectId: string;
  sourceUrl: string;
  metadataPath: string;
  htmlPath: string;
  htmlKind: "sourceHtml" | "domHtml";
  ruleBook?: BookMetadata;
  ruleValidationStatus?: ValidationStatus;
  ruleValidationWarnings?: string[];
  extractionWarnings?: string[];
  unrestricted?: ModeResult;
  restricted?: ModeResult;
  parserError?: string;
}

const rootDir = resolve(import.meta.dirname, "..", "..");
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
const ALLOWED_CREATOR_TYPES = new Set([
  "author",
  "translator",
  "editor",
  "contributor",
  "seriesEditor",
]);
const REQUIRED_STRING_FIELDS = new Set<keyof BookMetadata>([
  "title",
  "publisher",
  "publishDate",
]);
const LANGUAGE_FIELD = "language" satisfies keyof BookMetadata;
const PROTECTED_RESTRICTED_FIELDS = new Set<keyof BookMetadata | "creators">([
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
const HIGH_RISK_FIELDS = new Set<keyof BookMetadata | "creators">([
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
Compare unrestricted and restricted OpenAI-compatible cleaning over browser reference samples.

Recommended wrapper:
  .\\scripts\\run-openai-compatible-cleaning-comparison.ps1 -ConfirmLive

Direct worker guard:
  $env:DOUBAN_TO_ZOTERO_EXECUTION_MODE = "live"
  $env:OPENAI_COMPATIBLE_BASE_URL = "https://api.example.com"
  $env:OPENAI_COMPATIBLE_API_KEY = "..."
  $env:OPENAI_COMPATIBLE_MODEL = "model-name"
  npm run reference:cleaning:compare -- --confirm-live

Options:
  --samples-dir <path>       Default: fixtures/douban/reference-samples
  --out-dir <path>           Default: .cache/live/openai-cleaning-comparison
  --base-url <url>           Default: OPENAI_COMPATIBLE_BASE_URL
  --api-key-env <name>       Default: OPENAI_COMPATIBLE_API_KEY
  --model <name>             Default: OPENAI_COMPATIBLE_MODEL
  --temperature <number>     Default: 0
  --timeout-ms <number>      Default: 60000
  --max-raw-chars <number>   Default: 12000
  --limit <number>           Default: 50
  --concurrency <number>     Default: 1
  --continue-on-error        Keep going after per-sample model errors.
  --confirm-live             Required.
`.trim();
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    samplesDir: join(rootDir, "fixtures", "douban", "reference-samples"),
    outDir: join(rootDir, ".cache", "live", "openai-cleaning-comparison"),
    baseUrl: process.env.OPENAI_COMPATIBLE_BASE_URL ?? "",
    apiKeyEnv: "OPENAI_COMPATIBLE_API_KEY",
    model: process.env.OPENAI_COMPATIBLE_MODEL ?? "",
    temperature: 0,
    timeoutMs: 60000,
    maxRawChars: 12000,
    limit: 50,
    concurrency: 1,
    confirmedLive: false,
    continueOnError: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${helpText()}\n`);
      process.exit(0);
    } else if (arg === "--samples-dir") options.samplesDir = resolve(rootDir, argv[++i]);
    else if (arg === "--out-dir") options.outDir = resolve(rootDir, argv[++i]);
    else if (arg === "--base-url") options.baseUrl = argv[++i];
    else if (arg === "--api-key-env") options.apiKeyEnv = argv[++i];
    else if (arg === "--model") options.model = argv[++i];
    else if (arg === "--temperature") options.temperature = Number(argv[++i]);
    else if (arg === "--timeout-ms") options.timeoutMs = Number(argv[++i]);
    else if (arg === "--max-raw-chars") options.maxRawChars = Number(argv[++i]);
    else if (arg === "--limit") options.limit = Number(argv[++i]);
    else if (arg === "--concurrency") options.concurrency = Number(argv[++i]);
    else if (arg === "--continue-on-error") options.continueOnError = true;
    else if (arg === "--confirm-live") options.confirmedLive = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isFinite(options.temperature)) throw new Error("--temperature must be numeric");
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1000) {
    throw new Error("--timeout-ms must be an integer >= 1000");
  }
  if (!Number.isInteger(options.maxRawChars) || options.maxRawChars < 1000) {
    throw new Error("--max-raw-chars must be an integer >= 1000");
  }
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 1000) {
    throw new Error("--limit must be an integer from 1 to 1000");
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 4) {
    throw new Error("--concurrency must be an integer from 1 to 4");
  }

  return options;
}

function ensureLiveAllowed(options: CliOptions) {
  if (process.env.DOUBAN_TO_ZOTERO_EXECUTION_MODE !== "live") {
    throw new Error("Cleaning comparison requires DOUBAN_TO_ZOTERO_EXECUTION_MODE=live");
  }
  if (!options.confirmedLive) {
    throw new Error("Cleaning comparison requires --confirm-live");
  }
  if (!options.baseUrl) {
    throw new Error("Cleaning comparison requires --base-url or OPENAI_COMPATIBLE_BASE_URL");
  }
  if (!options.model) {
    throw new Error("Cleaning comparison requires --model or OPENAI_COMPATIBLE_MODEL");
  }
  if (!process.env[options.apiKeyEnv]) {
    throw new Error(`Cleaning comparison requires API key env var ${options.apiKeyEnv}`);
  }
  options.baseUrl = normalizeBaseUrl(options.baseUrl);
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

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function resolveSampleFilePath(pathValue: unknown): string | null {
  const rawPath = cleanString(pathValue);
  if (!rawPath) return null;

  const path = resolve(rootDir, rawPath);
  if (!existsSync(path)) return null;
  return statSync(path).isFile() ? path : null;
}

function loadSamples(samplesDir: string, limit: number): ReferenceSample[] {
  return walk(samplesDir)
    .filter((path) => path.endsWith("metadata.json"))
    .map((metadataPath) => {
      const metadata = readJson<any>(metadataPath);
      const sourceHtmlPath = resolveSampleFilePath(metadata.files?.sourceHtml);
      const domHtmlPath = resolveSampleFilePath(metadata.files?.domHtml);
      const htmlKind = sourceHtmlPath ? "sourceHtml" : "domHtml";
      const htmlPath = sourceHtmlPath ?? domHtmlPath;
      if (!htmlPath) {
        throw new Error(`Sample ${metadata.subjectId} has no readable sourceHtml/domHtml`);
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
    .sort((a, b) => a.subjectId.localeCompare(b.subjectId))
    .slice(0, limit);
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
  const strings = value
    .map((entry) => cleanString(entry))
    .filter((entry): entry is string => Boolean(entry));
  return strings.length > 0 ? strings : undefined;
}

function cleanCreator(value: unknown): Creator | null {
  if (!isStringRecord(value)) return null;
  const creatorType = cleanString(value.creatorType);
  if (!creatorType || !ALLOWED_CREATOR_TYPES.has(creatorType)) return null;

  const firstName = cleanString(value.firstName) ?? "";
  const lastName = cleanString(value.lastName) ?? "";
  if (!firstName && !lastName) return null;

  return {
    firstName,
    lastName,
    creatorType: creatorType as Creator["creatorType"],
    fieldMode: value.fieldMode === 1 ? 1 : 0,
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

function normalizeModelBook(ruleBook: BookMetadata, modelBook: unknown, mode: CleaningMode): {
  cleaned: BookMetadata;
  rejectedChangedFields: string[];
} {
  if (!isStringRecord(modelBook)) {
    throw new Error("Model returned a non-object metadata value");
  }

  const candidate: BookMetadata = {
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
      candidate.language = language;
      continue;
    }
    if (REQUIRED_STRING_FIELDS.has(field) && !next) continue;
    (candidate as Record<string, unknown>)[field] = next;
  }

  const modelCreators = cleanCreators(modelBook.creators);
  if (modelCreators) candidate.creators = modelCreators;

  const creatorNotes = cleanStringArray(modelBook.creatorNotes);
  if (creatorNotes) candidate.creatorNotes = creatorNotes;

  candidate.doubanUrl = ruleBook.doubanUrl;
  candidate.doubanId = ruleBook.doubanId;

  const rejectedChangedFields: string[] = [];
  if (mode === "restricted") {
    for (const field of PROTECTED_RESTRICTED_FIELDS) {
      const before = stableValue((ruleBook as Record<string, unknown>)[field]);
      const after = stableValue((candidate as Record<string, unknown>)[field]);
      if (before !== after) {
        rejectedChangedFields.push(field);
        (candidate as Record<string, unknown>)[field] =
          (ruleBook as Record<string, unknown>)[field];
      }
    }
  }

  return { cleaned: candidate, rejectedChangedFields: rejectedChangedFields.sort() };
}

function stableValue(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function changedFields(a: BookMetadata, b: BookMetadata): string[] {
  const fields = new Set<string>([
    ...Object.keys(a),
    ...Object.keys(b),
  ]);
  return Array.from(fields)
    .filter((field) => stableValue((a as Record<string, unknown>)[field]) !== stableValue((b as Record<string, unknown>)[field]))
    .sort();
}

function minimumFieldChanges(fields: string[]): string[] {
  return fields.filter((field) => MINIMUM_FIELDS.has(field as keyof BookMetadata | "creators"));
}

function highRiskChanges(fields: string[]): string[] {
  return fields.filter((field) => HIGH_RISK_FIELDS.has(field as keyof BookMetadata | "creators"));
}

function extractReadableText(html: string, sourceUrl: string, ruleBook: BookMetadata, maxChars: number): string {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const chunks = [
    `Source URL: ${sourceUrl}`,
    `Rule metadata JSON: ${JSON.stringify(ruleBook)}`,
    `Page title: ${doc.querySelector("title")?.textContent?.replace(/\s+/g, " ").trim() ?? ""}`,
    `Heading: ${doc.querySelector("h1")?.textContent?.replace(/\s+/g, " ").trim() ?? ""}`,
    `Info block: ${doc.querySelector("#info")?.textContent?.replace(/\s+/g, " ").trim() ?? ""}`,
    `Intro: ${doc.querySelector("#link-report .intro, .intro")?.textContent?.replace(/\s+/g, " ").trim() ?? ""}`,
  ].filter(Boolean);
  return chunks.join("\n").slice(0, maxChars);
}

function parseJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error("Model response did not contain a JSON object");
  }
  return JSON.parse(text.slice(start, end + 1));
}

function systemPrompt(mode: CleaningMode): string {
  if (mode === "unrestricted") {
    return [
      "You clean Douban book metadata for a Zotero importer.",
      "You may correct any metadata field when the supplied page evidence supports the correction.",
      "Prefer to fill missing minimum-ingest fields such as creators, publisher, publishDate, and language when evidence strongly supports them.",
      "If rule metadata language is missing and page evidence strongly supports one edition language, fill language.",
      `Use only these ISO 639-1 language codes: ${SUPPORTED_BOOK_LANGUAGE_CODES.join(", ")}.`,
      "For translated editions, language means the language of this edition's text, not the original work.",
      "Chinese title, Chinese publisher, Chinese #info/intro text, or Chinese translator evidence may support zh even when the original author is foreign.",
      "Do not infer language from author nationality or original title alone.",
      "Do not invent unsupported facts. Preserve uncertainty by leaving fields empty or unchanged.",
      "Return one JSON object only, matching the BookMetadata shape.",
    ].join(" ");
  }

  return [
    "You clean Douban book metadata for a Zotero importer with restricted permissions.",
    "Protected fields must remain exactly as rule metadata unless the user later reviews them: doubanUrl, doubanId, title, subtitle, creators, publisher, publishDate, isbn, isbn13.",
    "You may propose only low-risk additions or cleanup for language, abstractNote, pages, price, format, series, seriesNumber, originalTitle, coverUrl, creatorNotes, and extra.",
    "If rule metadata language is missing and page evidence strongly supports one edition language, fill language.",
    `Use only these ISO 639-1 language codes: ${SUPPORTED_BOOK_LANGUAGE_CODES.join(", ")}.`,
    "For translated editions, language means the language of this edition's text, not the original work.",
    "Chinese title, Chinese publisher, Chinese #info/intro text, or Chinese translator evidence may support zh even when the original author is foreign.",
    "Do not infer language from author nationality or original title alone.",
    "Do not invent unsupported facts. Return one JSON object only, matching the BookMetadata shape.",
  ].join(" ");
}

async function callModel(
  options: CliOptions,
  apiKey: string,
  sample: ReferenceSample,
  ruleBook: BookMetadata,
  rawText: string,
  mode: CleaningMode,
  requestLog: ModelRequestLogEntry[],
): Promise<{ modelBook: unknown; statusCode: number }> {
  const url = `${options.baseUrl}/chat/completions`;
  const transport = new FetchOpenAICompatibleTransport();
  const entry: ModelRequestLogEntry = {
    mode,
    subjectId: sample.subjectId,
    url: redactOpenAICompatibleSecrets(url, apiKey),
    startedAt: new Date().toISOString(),
    ok: false,
  };
  requestLog.push(entry);

  try {
    const response = await transport.postJson(
      url,
      apiKey,
      {
        model: options.model,
        temperature: options.temperature,
        messages: [
          { role: "system", content: systemPrompt(mode) },
          {
            role: "user",
            content: JSON.stringify({
              mode,
              sourceUrl: sample.sourceUrl,
              subjectId: sample.subjectId,
              ruleMetadata: ruleBook,
              rawText,
            }),
          },
        ],
      },
      options.timeoutMs,
    );

    entry.statusCode = response.statusCode;
    if ([403, 418, 429].includes(response.statusCode)) {
      throw new ModelRateLimitError(response.statusCode, response.responseText);
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new ModelHttpError(
        `OpenAI-compatible comparison request failed: HTTP ${response.statusCode}`,
        response.statusCode,
        response.responseText,
      );
    }

    const body = JSON.parse(response.responseText);
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error("OpenAI-compatible response did not contain message content");
    }

    entry.ok = true;
    entry.finishedAt = new Date().toISOString();
    return {
      modelBook: parseJsonObject(content),
      statusCode: response.statusCode,
    };
  } catch (error: any) {
    entry.finishedAt = new Date().toISOString();
    entry.errorName = error?.name || "Error";
    entry.errorMessage = redactOpenAICompatibleSecrets(error?.message || String(error), apiKey);
    throw error;
  }
}

async function runMode(
  options: CliOptions,
  apiKey: string,
  sample: ReferenceSample,
  ruleBook: BookMetadata,
  rawText: string,
  mode: CleaningMode,
  requestLog: ModelRequestLogEntry[],
): Promise<ModeResult> {
  try {
    const { modelBook, statusCode } = await callModel(options, apiKey, sample, ruleBook, rawText, mode, requestLog);
    const { cleaned, rejectedChangedFields } = normalizeModelBook(ruleBook, modelBook, mode);
    const acceptedChangedFields = changedFields(ruleBook, cleaned);
    const warnings = validationWarnings(cleaned);
    return {
      mode,
      ok: true,
      cleaned,
      validationStatus: validationStatus(cleaned, warnings),
      validationWarnings: warnings,
      changedFields: Array.from(new Set([...acceptedChangedFields, ...rejectedChangedFields])).sort(),
      acceptedChangedFields,
      rejectedChangedFields,
      highRiskChangedFields: highRiskChanges(acceptedChangedFields),
      minimumFieldChanges: minimumFieldChanges(acceptedChangedFields),
      statusCode,
    };
  } catch (error: any) {
    return {
      mode,
      ok: false,
      error: redactOpenAICompatibleSecrets(error?.message || String(error), apiKey),
      statusCode: typeof error?.statusCode === "number" ? error.statusCode : undefined,
    };
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function runWorker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, runWorker));
  return results;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function summarizeMode(records: SampleComparison[], mode: CleaningMode) {
  const results = records.map((record) => record[mode]).filter((result): result is ModeResult => Boolean(result));
  const successful = results.filter((result) => result.ok);
  return {
    attempted: results.length,
    successful: successful.length,
    failed: results.filter((result) => !result.ok).length,
    valid: successful.filter((result) => result.validationStatus === "valid").length,
    warning: successful.filter((result) => result.validationStatus === "warning").length,
    invalid: successful.filter((result) => result.validationStatus === "invalid").length,
    noAcceptedChange: successful.filter((result) => (result.acceptedChangedFields ?? []).length === 0).length,
    anyAcceptedChange: successful.filter((result) => (result.acceptedChangedFields ?? []).length > 0).length,
    highRiskChanged: successful.filter((result) => (result.highRiskChangedFields ?? []).length > 0).length,
    minimumFieldChanged: successful.filter((result) => (result.minimumFieldChanges ?? []).length > 0).length,
    rejectedProtectedChanges: successful.filter((result) => (result.rejectedChangedFields ?? []).length > 0).length,
    fieldChangeCounts: countFields(successful.flatMap((result) => result.acceptedChangedFields ?? [])),
    rejectedFieldChangeCounts: countFields(successful.flatMap((result) => result.rejectedChangedFields ?? [])),
  };
}

function countFields(fields: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const field of fields) counts[field] = (counts[field] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function summarize(records: SampleComparison[], requestLog: ModelRequestLogEntry[], options: CliOptions) {
  return {
    executionMode: "live",
    mode: "openai-compatible-cleaning-comparison",
    model: options.model,
    baseUrl: redactOpenAICompatibleBaseUrl(options.baseUrl),
    sampleCount: records.length,
    parsedSamples: records.filter((record) => record.ruleBook).length,
    parserFailures: records.filter((record) => record.parserError).length,
    requestCount: requestLog.length,
    requestFailures: requestLog.filter((entry) => !entry.ok).length,
    unrestricted: summarizeMode(records, "unrestricted"),
    restricted: summarizeMode(records, "restricted"),
    pairwise: {
      bothSucceeded: records.filter((record) => record.unrestricted?.ok && record.restricted?.ok).length,
      unrestrictedMoreAcceptedChanges: records.filter(
        (record) =>
          (record.unrestricted?.acceptedChangedFields?.length ?? 0) >
          (record.restricted?.acceptedChangedFields?.length ?? 0),
      ).length,
      restrictedMoreAcceptedChanges: records.filter(
        (record) =>
          (record.restricted?.acceptedChangedFields?.length ?? 0) >
          (record.unrestricted?.acceptedChangedFields?.length ?? 0),
      ).length,
      sameAcceptedChanges: records.filter(
        (record) =>
          stableValue(record.unrestricted?.acceptedChangedFields ?? []) ===
          stableValue(record.restricted?.acceptedChangedFields ?? []),
      ).length,
    },
  };
}

function markdownReport(summary: any, records: SampleComparison[], options: CliOptions): string {
  const highRiskRows = records
    .filter((record) => (record.unrestricted?.highRiskChangedFields?.length ?? 0) > 0)
    .slice(0, 20)
    .map((record) => `| ${record.subjectId} | unrestricted | ${(record.unrestricted?.highRiskChangedFields ?? []).join(", ")} | ${(record.unrestricted?.acceptedChangedFields ?? []).join(", ")} |`)
    .join("\n");
  const rejectedRows = records
    .filter((record) => (record.restricted?.rejectedChangedFields?.length ?? 0) > 0)
    .slice(0, 20)
    .map((record) => `| ${record.subjectId} | ${(record.restricted?.rejectedChangedFields ?? []).join(", ")} | ${(record.restricted?.acceptedChangedFields ?? []).join(", ")} |`)
    .join("\n");

  return `# OpenAI-Compatible Cleaning Mode Comparison

Generated at: ${new Date().toISOString()}

Model: \`${options.model}\`

Base URL: \`${redactOpenAICompatibleBaseUrl(options.baseUrl)}\`

Samples: ${summary.sampleCount}

Requests: ${summary.requestCount}

## Summary

| Mode | Successful | Failed | Valid | Warning | Invalid | Any accepted change | High-risk changed | Rejected protected changes |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| unrestricted | ${summary.unrestricted.successful} | ${summary.unrestricted.failed} | ${summary.unrestricted.valid} | ${summary.unrestricted.warning} | ${summary.unrestricted.invalid} | ${summary.unrestricted.anyAcceptedChange} | ${summary.unrestricted.highRiskChanged} | ${summary.unrestricted.rejectedProtectedChanges} |
| restricted | ${summary.restricted.successful} | ${summary.restricted.failed} | ${summary.restricted.valid} | ${summary.restricted.warning} | ${summary.restricted.invalid} | ${summary.restricted.anyAcceptedChange} | ${summary.restricted.highRiskChanged} | ${summary.restricted.rejectedProtectedChanges} |

## Accepted Field Changes

Unrestricted:

\`\`\`json
${JSON.stringify(summary.unrestricted.fieldChangeCounts, null, 2)}
\`\`\`

Restricted:

\`\`\`json
${JSON.stringify(summary.restricted.fieldChangeCounts, null, 2)}
\`\`\`

## Restricted Protected Changes Rejected

\`\`\`json
${JSON.stringify(summary.restricted.rejectedFieldChangeCounts, null, 2)}
\`\`\`

## Unrestricted High-Risk Examples

| Subject | Mode | High-risk fields | Accepted fields |
|---|---|---|---|
${highRiskRows || "| none | | | |"}

## Restricted Rejection Examples

| Subject | Rejected protected fields | Accepted fields |
|---|---|---|
${rejectedRows || "| none | | |"}
`;
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  ensureLiveAllowed(options);
  const apiKey = process.env[options.apiKeyEnv] ?? "";
  mkdirSync(options.outDir, { recursive: true });

  const dom = new JSDOM("<!doctype html>");
  globalThis.DOMParser = dom.window.DOMParser;

  const samples = loadSamples(options.samplesDir, options.limit);
  const requestLog: ModelRequestLogEntry[] = [];

  const records = await mapWithConcurrency(samples, options.concurrency, async (sample, index) => {
    process.stdout.write(`[${index + 1}/${samples.length}] ${sample.subjectId}\n`);
    const record: SampleComparison = {
      subjectId: sample.subjectId,
      sourceUrl: sample.sourceUrl,
      metadataPath: relative(rootDir, sample.metadataPath),
      htmlPath: relative(rootDir, sample.htmlPath),
      htmlKind: sample.htmlKind,
    };

    try {
      const parsed = parseBookDetailWithDiagnostics(sample.html, sample.sourceUrl);
      const warnings = validationWarnings(parsed.book);
      const rawText = extractReadableText(sample.html, sample.sourceUrl, parsed.book, options.maxRawChars);
      record.ruleBook = parsed.book;
      record.ruleValidationWarnings = warnings;
      record.ruleValidationStatus = validationStatus(parsed.book, warnings);
      record.extractionWarnings = parsed.extractionWarnings;
      record.unrestricted = await runMode(options, apiKey, sample, parsed.book, rawText, "unrestricted", requestLog);
      if (!record.unrestricted.ok && !options.continueOnError) {
        throw new Error(record.unrestricted.error);
      }
      record.restricted = await runMode(options, apiKey, sample, parsed.book, rawText, "restricted", requestLog);
      if (!record.restricted.ok && !options.continueOnError) {
        throw new Error(record.restricted.error);
      }
    } catch (error: any) {
      record.parserError = redactOpenAICompatibleSecrets(error?.message || String(error), apiKey);
      if (!options.continueOnError) throw error;
    }

    return record;
  });

  const summary = summarize(records, requestLog, options);
  const artifacts = {
    summaryPath: join(options.outDir, "summary.json"),
    recordsPath: join(options.outDir, "records.json"),
    requestLogPath: join(options.outDir, "request-log.json"),
    reportPath: join(options.outDir, "report.md"),
  };

  writeFileSync(artifacts.summaryPath, `${JSON.stringify({
    ...summary,
    artifacts: Object.fromEntries(
      Object.entries(artifacts).map(([key, value]) => [key, relative(rootDir, value)]),
    ),
    inputHash: sha256(JSON.stringify(samples.map((sample) => ({
      subjectId: sample.subjectId,
      sourceUrl: sample.sourceUrl,
      htmlPath: relative(rootDir, sample.htmlPath),
    })))),
  }, null, 2)}\n`, "utf-8");
  writeFileSync(artifacts.recordsPath, `${JSON.stringify(records, null, 2)}\n`, "utf-8");
  writeFileSync(artifacts.requestLogPath, `${JSON.stringify(requestLog, null, 2)}\n`, "utf-8");
  writeFileSync(artifacts.reportPath, markdownReport(summary, records, options), "utf-8");

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
