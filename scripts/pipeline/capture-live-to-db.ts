import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { JSDOM } from "jsdom";

import { parseBookDetailWithDiagnostics } from "../../src/modules/parser";
import { validateMinimumBookIngest } from "../../src/modules/ingest-validator";
import { parseWishListPageDiagnostics, type SubjectCountRange } from "../../src/modules/fetcher";
import { bookToZoteroBookPayload } from "../../src/modules/zotero-book-payload";
import { validateZoteroBookPayload } from "../../src/modules/zotero-payload-validator";
import type { BookMetadata, Creator } from "../../src/types";
import type { ValidationStatus } from "../../src/types/pipeline";
import packageJson from "../../package.json";

interface CliOptions {
  wishlistUrl: string;
  outPath: string;
  summaryPath: string;
  requestLogPath: string;
  maxPages: number;
  maxEntries: number;
  minDelayMs: number;
  maxDelayMs: number;
  testName: string;
  reset: boolean;
  fullReadlist: boolean;
  maxPagesProvided: boolean;
  maxEntriesProvided: boolean;
  confirmedLive: boolean;
}

interface RequestLogEntry {
  url: string;
  startedAt: string;
  finishedAt?: string;
  ok: boolean;
  status?: number;
  error?: string;
}

interface WishlistLink {
  url: string;
  title: string;
  position: number;
}

interface CapturedWishlistPage {
  pageIndex: number;
  sourceUrl: string;
  startOffset: number | null;
  subjectNum: SubjectCountRange | null;
  expectedStart: number | null;
  expectedEnd: number | null;
  visibleUniqueSubjectLinks: number;
  visibleDeficitAgainstRange: number | null;
  nextUrl?: string;
}

interface WishlistDiscovery {
  links: WishlistLink[];
  pages: CapturedWishlistPage[];
  declaredTotal: number | null;
  expectedPageCount: number | null;
  visibleUniqueSubjectLinks: number;
  visibleListEntries: number;
  visibleDeficitAgainstDeclaredTotal: number | null;
  stoppedByCap: boolean;
  stoppedByMissingNext: boolean;
  warnings: string[];
}

interface DetailFailure {
  url: string;
  stage: "fetch" | "parse" | "payload-validation";
  error: string;
}

interface CompletenessInput {
  declaredTotal: number | null;
  expectedPageCount: number | null;
  capturedListPages: number;
  visibleUniqueSubjectLinks: number;
  visibleDeficitAgainstDeclaredTotal: number | null;
  detailPagesAttempted: number;
  detailPagesSucceeded: number;
  rawRecordCount: number;
  importPreparedCount: number;
  importSkippedCount: number;
  stoppedByCap: boolean;
  stoppedByMissingNext: boolean;
  detailFailures: number;
  discoveryWarnings: string[];
}

export interface CaptureCompletenessSummary {
  completenessStatus:
    | "complete"
    | "complete-with-anonymous-visibility-warning"
    | "incomplete-missing-subject-num"
    | "incomplete-list-capture"
    | "incomplete-detail-capture"
    | "incomplete-sqlite-row-count";
  completenessWarnings: string[];
}

type ProgressReporter = (message: string) => void;

const rootDir = resolve(import.meta.dirname, "..", "..");
const ITEMS_PER_PAGE = 15;
const MAX_FULL_READLIST_PAGES = 200;
const DEFAULT_OUT_PATH = join(rootDir, ".cache", "live", "pipeline.sqlite");
const DEFAULT_SUMMARY_PATH = join(rootDir, ".cache", "live", "pipeline-summary.json");
const DEFAULT_REQUEST_LOG_PATH = join(rootDir, ".cache", "live", "request-log.json");
const requestLog: RequestLogEntry[] = [];

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    wishlistUrl: "",
    outPath: DEFAULT_OUT_PATH,
    summaryPath: DEFAULT_SUMMARY_PATH,
    requestLogPath: DEFAULT_REQUEST_LOG_PATH,
    maxPages: 1,
    maxEntries: 15,
    minDelayMs: 3000,
    maxDelayMs: 6000,
    testName: "live-capture",
    reset: false,
    fullReadlist: false,
    maxPagesProvided: false,
    maxEntriesProvided: false,
    confirmedLive: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--wishlist-url") options.wishlistUrl = argv[++i];
    else if (arg === "--out") {
      options.outPath = resolve(rootDir, argv[++i]);
    } else if (arg === "--summary") {
      options.summaryPath = resolve(rootDir, argv[++i]);
    } else if (arg === "--request-log") {
      options.requestLogPath = resolve(rootDir, argv[++i]);
    } else if (arg === "--max-pages") {
      options.maxPages = Number(argv[++i]);
      options.maxPagesProvided = true;
    } else if (arg === "--max-entries") {
      options.maxEntries = Number(argv[++i]);
      options.maxEntriesProvided = true;
    }
    else if (arg === "--min-delay-ms") options.minDelayMs = Number(argv[++i]);
    else if (arg === "--max-delay-ms") options.maxDelayMs = Number(argv[++i]);
    else if (arg === "--test-name") options.testName = argv[++i];
    else if (arg === "--reset") options.reset = true;
    else if (arg === "--full-readlist") options.fullReadlist = true;
    else if (arg === "--confirm-live") options.confirmedLive = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

export function formatLiveCaptureProgressLine(
  message: string,
  timestamp: Date = new Date(),
): string {
  return `[live-capture ${timestamp.toISOString()}] ${message}\n`;
}

function reportProgress(message: string): void {
  process.stderr.write(formatLiveCaptureProgressLine(message));
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function formatCollectionTimestamp(isoTimestamp: string): string {
  return isoTimestamp
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z")
    .replace("T", "-")
    .replace("Z", "");
}

function testCollectionName(version: string, testName: string, isoTimestamp: string): string {
  return `douban-to-zotero ${version} ${testName} ${formatCollectionTimestamp(isoTimestamp)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function assertLiveWishlistUrl(url: string): URL {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== "book.douban.com") {
    throw new Error("Live capture only accepts https://book.douban.com wish-list URLs");
  }
  if (!/^\/people\/[^/]+\/wish$/.test(parsed.pathname)) {
    throw new Error("Live capture requires a Douban wish-list URL");
  }
  return parsed;
}

function pageUrl(wishlistUrl: string, start: number): string {
  const parsed = new URL(wishlistUrl);
  parsed.searchParams.set("start", String(start));
  parsed.hash = "";
  return parsed.toString();
}

function startOffsetFromUrl(url: string): number | null {
  const start = new URL(url).searchParams.get("start");
  if (start === null) return null;
  const parsed = Number(start);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeSubjectUrl(url: string): string {
  const parsed = new URL(url, "https://book.douban.com");
  parsed.protocol = "https:";
  parsed.hash = "";
  parsed.search = "";
  return parsed.toString();
}

function extractWishlistLinks(html: string): WishlistLink[] {
  const dom = new JSDOM(html);
  const links: WishlistLink[] = [];
  const seen = new Set<string>();
  for (const anchor of Array.from(dom.window.document.querySelectorAll("a[href*='/subject/']"))) {
    const href = anchor.getAttribute("href");
    if (!href) continue;
    const url = normalizeSubjectUrl(href);
    if (!/^https:\/\/book\.douban\.com\/subject\/\d+\/?$/.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    links.push({
      url,
      title: anchor.getAttribute("title") || anchor.textContent?.replace(/\s+/g, " ").trim() || "",
      position: links.length + 1,
    });
  }
  return links;
}

function assertFullReadlistOutputPaths(options: CliOptions): void {
  if (!options.fullReadlist) return;

  const defaults = [
    [options.outPath, DEFAULT_OUT_PATH, "--out"],
    [options.summaryPath, DEFAULT_SUMMARY_PATH, "--summary"],
    [options.requestLogPath, DEFAULT_REQUEST_LOG_PATH, "--request-log"],
  ] as const;
  for (const [actual, defaultPath, flag] of defaults) {
    if (actual === defaultPath) {
      throw new Error(
        `--full-readlist requires an explicit non-default ${flag} path; use a run-scoped .cache/live/full-readlist-*/ artifact path.`,
      );
    }
  }
}

async function fetchText(url: string, options: CliOptions): Promise<string> {
  const parsed = new URL(url);
  if (parsed.hostname !== "book.douban.com") {
    throw new Error(`Rejected non-Douban URL: ${url}`);
  }
  await sleep(randomDelay(options.minDelayMs, options.maxDelayMs));
  const entry: RequestLogEntry = {
    url,
    startedAt: new Date().toISOString(),
    ok: false,
  };
  requestLog.push(entry);
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
    });
    entry.status = response.status;
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
    const text = await response.text();
    if (text.includes("sec.douban.com") || text.includes("captcha")) {
      throw new Error(`Douban challenge page detected: ${url}`);
    }
    entry.ok = true;
    entry.finishedAt = new Date().toISOString();
    return text;
  } catch (e: any) {
    entry.finishedAt = new Date().toISOString();
    entry.error = e.message || String(e);
    throw e;
  }
}

function creatorNames(creators: Creator[], creatorType: string): string[] {
  return creators
    .filter((creator) => creator.creatorType === creatorType)
    .map((creator) => creator.fieldMode === 1 ? creator.lastName : `${creator.firstName} ${creator.lastName}`.trim())
    .filter(Boolean);
}

function escapeBibValue(value: string): string {
  return value.replace(/\\/g, "\\textbackslash{}").replace(/[{}]/g, (ch) => `\\${ch}`);
}

function bibField(name: string, value: string | undefined): string | null {
  if (!value) return null;
  return `  ${name} = {${escapeBibValue(value)}}`;
}

function toBibTeX(book: BookMetadata): string {
  const year = book.publishDate?.match(/\d{4}/)?.[0];
  const fields = [
    bibField("title", book.title),
    bibField("author", creatorNames(book.creators, "author").join(" and ")),
    bibField("editor", creatorNames(book.creators, "editor").join(" and ")),
    bibField("publisher", book.publisher),
    bibField("year", year),
    bibField("isbn", book.isbn13 || book.isbn),
    bibField("url", book.doubanUrl),
  ].filter((field): field is string => Boolean(field));
  return `@book{douban-${book.doubanId},\n${fields.join(",\n")}\n}`;
}

function toBibLaTeX(book: BookMetadata): string {
  const fields = [
    bibField("title", book.title),
    bibField("author", creatorNames(book.creators, "author").join(" and ")),
    bibField("translator", creatorNames(book.creators, "translator").join(" and ")),
    bibField("editor", creatorNames(book.creators, "editor").join(" and ")),
    bibField("publisher", book.publisher),
    bibField("date", book.publishDate),
    bibField("isbn", book.isbn13 || book.isbn),
    bibField("url", book.doubanUrl),
  ].filter((field): field is string => Boolean(field));
  return `@book{douban-${book.doubanId},\n${fields.join(",\n")}\n}`;
}

function toZoteroPayload(book: BookMetadata) {
  return bookToZoteroBookPayload(book);
}

function subjectIdFromUrl(url: string): string | undefined {
  return url.match(/\/subject\/(\d+)\/?/)?.[1];
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

function pushWarningOnce(warnings: string[], warning: string): void {
  if (!warnings.includes(warning)) warnings.push(warning);
}

function expectedRangeEnd(pageIndex: number, declaredTotal: number | null): number | null {
  if (declaredTotal === null) return null;
  return Math.min((pageIndex + 1) * ITEMS_PER_PAGE, declaredTotal);
}

function detailFailureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function discoverWishlist(
  options: CliOptions,
  wishlistUrl: string,
  onProgress: ProgressReporter,
): Promise<WishlistDiscovery> {
  const links: WishlistLink[] = [];
  const pages: CapturedWishlistPage[] = [];
  const warnings: string[] = [];
  const seenLinks = new Set<string>();
  const seenPageUrls = new Set<string>();
  let declaredTotal: number | null = null;
  let expectedPageCount: number | null = null;
  let visibleListEntries = 0;
  let stoppedByCap = false;
  let stoppedByMissingNext = false;
  let currentPageUrl = pageUrl(wishlistUrl, 0);
  const pageCap = options.fullReadlist && !options.maxPagesProvided
    ? MAX_FULL_READLIST_PAGES
    : options.maxPages;
  const entryCap = options.fullReadlist && !options.maxEntriesProvided
    ? Number.POSITIVE_INFINITY
    : options.maxEntries;

  for (let pageIndex = 0; pageIndex < pageCap && links.length < entryCap; pageIndex++) {
    if (seenPageUrls.has(currentPageUrl)) {
      pushWarningOnce(
        warnings,
        `readlist-pagination-loop: next-page link repeated ${currentPageUrl}; stopped pagination.`,
      );
      stoppedByCap = true;
      break;
    }
    seenPageUrls.add(currentPageUrl);

    onProgress(`List page ${pageIndex + 1}: fetching ${currentPageUrl}`);
    const html = await fetchText(currentPageUrl, options);
    const diagnostics = parseWishListPageDiagnostics(html);
    if (pageIndex === 0) {
      declaredTotal = diagnostics.subjectCountRange?.total ?? null;
      expectedPageCount = declaredTotal === null ? null : Math.ceil(declaredTotal / ITEMS_PER_PAGE);
      if (options.fullReadlist && declaredTotal === null) {
        throw new Error(`--full-readlist requires a subject-num counter on ${currentPageUrl}`);
      }
    } else if (
      declaredTotal !== null &&
      diagnostics.subjectCountRange !== null &&
      diagnostics.subjectCountRange.total !== declaredTotal
    ) {
      pushWarningOnce(
        warnings,
        `readlist-declared-total-changed: first page declared ${declaredTotal}, but page ${pageIndex + 1} declared ${diagnostics.subjectCountRange.total}.`,
      );
    }

    const pageLinks = options.fullReadlist
      ? diagnostics.links
      : extractWishlistLinks(html);
    visibleListEntries += pageLinks.length;
    for (const link of pageLinks) {
      const url = normalizeSubjectUrl(link.url);
      if (seenLinks.has(url)) continue;
      seenLinks.add(url);
      links.push({
        url,
        title: link.title,
        position: links.length + 1,
      });
      if (links.length >= entryCap) break;
    }

    const subjectNum = diagnostics.subjectCountRange;
    const rangeSize = subjectNum === null ? null : subjectNum.end - subjectNum.start + 1;
    pages.push({
      pageIndex,
      sourceUrl: currentPageUrl,
      startOffset: startOffsetFromUrl(currentPageUrl),
      subjectNum,
      expectedStart: declaredTotal === null ? null : pageIndex * ITEMS_PER_PAGE + 1,
      expectedEnd: expectedRangeEnd(pageIndex, declaredTotal),
      visibleUniqueSubjectLinks: pageLinks.length,
      visibleDeficitAgainstRange: rangeSize === null
        ? null
        : Math.max(0, rangeSize - pageLinks.length),
      nextUrl: diagnostics.nextUrl,
    });

    const pageTotalLabel = expectedPageCount === null ? "?" : String(expectedPageCount);
    const subjectNumLabel = subjectNum === null
      ? "subject-num unavailable"
      : `${subjectNum.start}-${subjectNum.end}/${subjectNum.total}`;
    onProgress(
      `List page ${pageIndex + 1}/${pageTotalLabel}: ${subjectNumLabel}; ` +
        `${pageLinks.length} visible links, ${links.length} unique total.`,
    );

    if (!options.fullReadlist) {
      currentPageUrl = pageUrl(wishlistUrl, (pageIndex + 1) * ITEMS_PER_PAGE);
      continue;
    }
    if (declaredTotal !== null && visibleListEntries >= declaredTotal) break;
    if (expectedPageCount !== null && pages.length >= expectedPageCount) break;
    if (!diagnostics.nextUrl) {
      stoppedByMissingNext = true;
      break;
    }
    currentPageUrl = diagnostics.nextUrl;
  }

  if (pages.length >= pageCap && options.fullReadlist && expectedPageCount !== null && pages.length < expectedPageCount) {
    stoppedByCap = true;
  }
  if (links.length >= entryCap && options.fullReadlist && declaredTotal !== null && links.length < declaredTotal) {
    stoppedByCap = true;
  }

  const visibleDeficitAgainstDeclaredTotal = declaredTotal === null
    ? null
    : Math.max(0, declaredTotal - links.length);
  if (visibleDeficitAgainstDeclaredTotal !== null && visibleDeficitAgainstDeclaredTotal > 0) {
    pushWarningOnce(
      warnings,
      `readlist-visible-count-mismatch: Douban declared ${declaredTotal} wish-list books, but only ${links.length} unique subject URLs were visible anonymously; ${visibleDeficitAgainstDeclaredTotal} may be hidden by login/privacy behavior.`,
    );
  }

  return {
    links,
    pages,
    declaredTotal,
    expectedPageCount,
    visibleUniqueSubjectLinks: links.length,
    visibleListEntries,
    visibleDeficitAgainstDeclaredTotal,
    stoppedByCap,
    stoppedByMissingNext,
    warnings,
  };
}

export function summarizeCaptureCompleteness(input: CompletenessInput): CaptureCompletenessSummary {
  const completenessWarnings = [...input.discoveryWarnings];
  if (input.declaredTotal === null || input.expectedPageCount === null) {
    return {
      completenessStatus: "incomplete-missing-subject-num",
      completenessWarnings,
    };
  }

  if (
    input.stoppedByCap ||
    input.stoppedByMissingNext ||
    input.capturedListPages < input.expectedPageCount
  ) {
    pushWarningOnce(
      completenessWarnings,
      `readlist-pagination-incomplete: Douban declared ${input.declaredTotal} books, which implies ${input.expectedPageCount} pages, but only ${input.capturedListPages} list pages were captured.`,
    );
    return {
      completenessStatus: "incomplete-list-capture",
      completenessWarnings,
    };
  }

  if (
    input.detailFailures > 0 ||
    input.detailPagesSucceeded < input.detailPagesAttempted ||
    input.detailPagesSucceeded < input.visibleUniqueSubjectLinks
  ) {
    pushWarningOnce(
      completenessWarnings,
      `readlist-detail-capture-incomplete: attempted ${input.detailPagesAttempted} detail pages, succeeded ${input.detailPagesSucceeded}, and recorded ${input.detailFailures} failures.`,
    );
    return {
      completenessStatus: "incomplete-detail-capture",
      completenessWarnings,
    };
  }

  if (input.rawRecordCount !== input.detailPagesSucceeded) {
    pushWarningOnce(
      completenessWarnings,
      `sqlite-row-count-mismatch: ${input.detailPagesSucceeded} detail pages succeeded but raw_scraped_records has ${input.rawRecordCount} rows.`,
    );
    return {
      completenessStatus: "incomplete-sqlite-row-count",
      completenessWarnings,
    };
  }

  if ((input.visibleDeficitAgainstDeclaredTotal ?? 0) > 0) {
    return {
      completenessStatus: "complete-with-anonymous-visibility-warning",
      completenessWarnings,
    };
  }

  return {
    completenessStatus: "complete",
    completenessWarnings,
  };
}

async function run() {
  if (process.env.DOUBAN_TO_ZOTERO_EXECUTION_MODE !== "live") {
    throw new Error("Live capture requires DOUBAN_TO_ZOTERO_EXECUTION_MODE=live");
  }

  const options = parseArgs(process.argv.slice(2));
  if (!options.confirmedLive) {
    throw new Error("Live capture requires --confirm-live");
  }
  const wishlistUrl = assertLiveWishlistUrl(options.wishlistUrl).toString();
  assertFullReadlistOutputPaths(options);
  if (options.maxPages < 1 || options.maxEntries < 1) {
    throw new Error("max-pages and max-entries must be positive");
  }

  if (options.reset && existsSync(options.outPath)) rmSync(options.outPath);
  mkdirSync(dirname(options.outPath), { recursive: true });
  mkdirSync(dirname(options.summaryPath), { recursive: true });
  mkdirSync(dirname(options.requestLogPath), { recursive: true });

  const schemaSql = readFileSync(join(rootDir, "schemas", "pipeline.sqlite.sql"), "utf-8");
  const dom = new JSDOM("<!doctype html>");
  globalThis.DOMParser = dom.window.DOMParser;

  const db = new DatabaseSync(options.outPath);
  db.exec(schemaSql);
  db.exec("PRAGMA foreign_keys = ON");

  const startedAt = new Date().toISOString();
  const runSuffix = startedAt.replace(/[-:.TZ]/g, "").slice(0, 14);
  const pipelineRunId = `pipeline-run-live-${runSuffix}`;
  const scrapeRunId = `scrape-run-live-${runSuffix}`;
  const cleaningRunId = `cleaning-run-live-rule-parser-${runSuffix}`;
  const importRunId = `import-run-live-zotero-json-${runSuffix}`;
  const exportRuns = [
    [`export-run-live-zotero-json-${runSuffix}`, "zotero-json"],
    [`export-run-live-bibtex-${runSuffix}`, "bibtex"],
    [`export-run-live-biblatex-${runSuffix}`, "biblatex"],
  ] as const;
  const collectionName = testCollectionName(packageJson.version, options.testName, startedAt);

  reportProgress(
    `Starting ${options.fullReadlist ? "full-readlist" : "bounded"} live capture for ${wishlistUrl}`,
  );
  reportProgress(
    `Artifacts: db=${relative(rootDir, options.outPath)}, ` +
      `summary=${relative(rootDir, options.summaryPath)}, ` +
      `requestLog=${relative(rootDir, options.requestLogPath)}`,
  );

  const discovery = await discoverWishlist(options, wishlistUrl, reportProgress);
  const allLinks = discovery.links;
  const detailFailures: DetailFailure[] = [];
  reportProgress(
    `List discovery complete: ${discovery.pages.length} pages, ` +
      `${discovery.visibleUniqueSubjectLinks} unique visible subjects, declared total ${discovery.declaredTotal ?? "unknown"}.`,
  );
  reportProgress(`Fetching ${allLinks.length} detail pages...`);

  db.exec("BEGIN");
  try {
    db.prepare(`
      INSERT INTO pipeline_runs
      (run_id, execution_mode, status, source, input_manifest_path, started_at, completed_at, notes_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(pipelineRunId, "live", "completed", "live-capture", wishlistUrl, startedAt, startedAt, json([]));

    db.prepare(`
      INSERT INTO scrape_runs
      (scrape_run_id, pipeline_run_id, execution_mode, source_kind, fixture_manifest_path, request_count, started_at, completed_at, provenance_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(scrapeRunId, pipelineRunId, "live", "douban-wishlist", null, requestLog.length, startedAt, startedAt, json({ wishlistUrl }));

    db.prepare(`
      INSERT INTO cleaning_runs
      (cleaning_run_id, pipeline_run_id, execution_mode, cleaner_kind, provider, model, prompt_template_hash, settings_json, started_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(cleaningRunId, pipelineRunId, "live", "rule-parser", "none", null, null, json({}), startedAt, startedAt);

    for (const [exportRunId, format] of exportRuns) {
      db.prepare(`
        INSERT INTO export_runs
        (export_run_id, pipeline_run_id, format, target, started_at, completed_at, settings_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(exportRunId, pipelineRunId, format, ".cache/live", startedAt, startedAt, json({}));
    }

    db.prepare(`
      INSERT INTO import_runs
      (import_run_id, pipeline_run_id, execution_mode, target, status, started_at, completed_at, settings_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      importRunId,
      pipelineRunId,
      "live",
      "zotero-json-payload",
      "prepared",
      startedAt,
      startedAt,
      json({
        zoteroWritesAllowed: false,
        testName: options.testName,
        targetCollectionName: collectionName,
        collectionNaming: "douban-to-zotero {version} {testName} {YYYYMMDD-HHMMSS}",
      }),
    );

    for (const [index, link] of allLinks.entries()) {
      reportProgress(`Detail ${index + 1}/${allLinks.length}: fetching ${link.url}`);
      let html: string;
      try {
        html = await fetchText(link.url, options);
      } catch (e) {
        detailFailures.push({ url: link.url, stage: "fetch", error: detailFailureMessage(e) });
        reportProgress(`Detail ${index + 1}/${allLinks.length}: fetch failed - ${detailFailureMessage(e)}`);
        continue;
      }

      let parsedResult: ReturnType<typeof parseBookDetailWithDiagnostics>;
      let parsed: BookMetadata;
      let payload: ReturnType<typeof toZoteroPayload>;
      let warnings: string[];
      let ingestValidation: ReturnType<typeof validateMinimumBookIngest>;
      let payloadValidation: ReturnType<typeof validateZoteroBookPayload>;
      try {
        parsedResult = parseBookDetailWithDiagnostics(html, link.url);
        parsed = parsedResult.book;
        payload = toZoteroPayload(parsed);
        warnings = validationWarnings(parsed);
        ingestValidation = validateMinimumBookIngest(parsed);
        payloadValidation = validateZoteroBookPayload(payload);
        if (!payloadValidation.valid) {
          detailFailures.push({
            url: link.url,
            stage: "payload-validation",
            error: payloadValidation.warnings.join(", "),
          });
          reportProgress(
            `Detail ${index + 1}/${allLinks.length}: payload skipped by validation - ${payloadValidation.warnings.join(", ")}`,
          );
          continue;
        }
      } catch (e) {
        detailFailures.push({ url: link.url, stage: "parse", error: detailFailureMessage(e) });
        reportProgress(`Detail ${index + 1}/${allLinks.length}: parse failed - ${detailFailureMessage(e)}`);
        continue;
      }

      const subjectId = subjectIdFromUrl(link.url) ?? sha256(link.url).slice(0, 12);
      const rawId = `raw-live-${subjectId}-${runSuffix}`;
      const cleanedId = `cleaned-live-${subjectId}-${runSuffix}`;
      const status = validationStatus(parsed, warnings);

      db.prepare(`
        INSERT INTO raw_scraped_records
        (raw_record_id, scrape_run_id, internal_id, source_url, douban_subject_id, wishlist_owner_id, source_kind, raw_html, raw_html_sha256, list_context_json, extracted_metadata_json, extraction_warnings_json, provenance_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        rawId,
        scrapeRunId,
        rawId,
        link.url,
        subjectId,
        assertLiveWishlistUrl(wishlistUrl).pathname.split("/")[2],
        "douban-subject-page",
        html,
        sha256(html),
        json({ wishlistUrl, wishlistTitle: link.title, position: index + 1 }),
        json(parsed),
        json(parsedResult.extractionWarnings),
        json({ capturedByMode: "live", requestLogged: true }),
        startedAt,
      );

      db.prepare(`
        INSERT INTO cleaned_records
        (cleaned_record_id, cleaning_run_id, raw_record_id, internal_id, cleaned_json, validation_status, validation_warnings_json, field_provenance_json, confidence_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(cleanedId, cleaningRunId, rawId, cleanedId, json(parsed), status, json(warnings), json({}), json({}), startedAt);

      for (const [exportRunId, format] of exportRuns) {
        const text = format === "bibtex" ? toBibTeX(parsed) : format === "biblatex" ? toBibLaTeX(parsed) : null;
        const payloadJson = format === "zotero-json" ? json(payload) : null;
        db.prepare(`
          INSERT INTO export_records
          (export_record_id, export_run_id, cleaned_record_id, internal_id, format, payload_text, payload_json, validation_status, validation_warnings_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(`export-${format}-live-${subjectId}-${runSuffix}`, exportRunId, cleanedId, `export-${format}-live-${subjectId}-${runSuffix}`, format, text, payloadJson, status, json(warnings), startedAt);
      }

      db.prepare(`
        INSERT INTO import_records
        (import_record_id, import_run_id, cleaned_record_id, export_record_id, internal_id, zotero_item_id, item_payload_json, status, validation_warnings_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        `import-live-${subjectId}-${runSuffix}`,
        importRunId,
        cleanedId,
        `export-zotero-json-live-${subjectId}-${runSuffix}`,
        `import-live-${subjectId}-${runSuffix}`,
        null,
        json(payload),
        ingestValidation.eligible ? "prepared" : "skipped",
        json([...warnings, ...payloadValidation.warnings]),
        startedAt,
      );
      reportProgress(
        `Detail ${index + 1}/${allLinks.length}: stored ${subjectId} as ` +
          `${ingestValidation.eligible ? "prepared" : "skipped"}.`,
      );
    }

    db.prepare("UPDATE scrape_runs SET request_count = ?, completed_at = ? WHERE scrape_run_id = ?")
      .run(requestLog.length, new Date().toISOString(), scrapeRunId);

    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  } finally {
    writeFileSync(options.requestLogPath, `${JSON.stringify(requestLog, null, 2)}\n`);
  }

  const rawRecordCount = Number(
    db.prepare("SELECT COUNT(*) AS count FROM raw_scraped_records WHERE scrape_run_id = ?")
      .get(scrapeRunId).count,
  );
  const importCounts = db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'prepared' THEN 1 ELSE 0 END) AS prepared,
      SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped
    FROM import_records
    WHERE import_run_id = ?
  `).get(importRunId) as { prepared: number | null; skipped: number | null };
  const importPreparedCount = Number(importCounts.prepared ?? 0);
  const importSkippedCount = Number(importCounts.skipped ?? 0);
  const detailPagesAttempted = allLinks.length;
  const detailPagesSucceeded = rawRecordCount;
  const completeness = summarizeCaptureCompleteness({
    declaredTotal: discovery.declaredTotal,
    expectedPageCount: discovery.expectedPageCount,
    capturedListPages: discovery.pages.length,
    visibleUniqueSubjectLinks: discovery.visibleUniqueSubjectLinks,
    visibleDeficitAgainstDeclaredTotal: discovery.visibleDeficitAgainstDeclaredTotal,
    detailPagesAttempted,
    detailPagesSucceeded,
    rawRecordCount,
    importPreparedCount,
    importSkippedCount,
    stoppedByCap: discovery.stoppedByCap,
    stoppedByMissingNext: discovery.stoppedByMissingNext,
    detailFailures: detailFailures.length,
    discoveryWarnings: discovery.warnings,
  });

  const summary = {
    executionMode: "live",
    captureMode: options.fullReadlist ? "full-readlist" : "bounded",
    dbPath: relative(rootDir, options.outPath),
    wishlistUrl,
    targetCollectionName: collectionName,
    fullReadlist: options.fullReadlist,
    maxPages: options.maxPages,
    maxEntries: options.maxEntries,
    declaredTotal: discovery.declaredTotal,
    expectedPageCount: discovery.expectedPageCount,
    capturedListPages: discovery.pages.length,
    capturedListPageDiagnostics: discovery.pages,
    visibleListEntries: discovery.visibleListEntries,
    visibleUniqueSubjectLinks: discovery.visibleUniqueSubjectLinks,
    visibleDeficitAgainstDeclaredTotal: discovery.visibleDeficitAgainstDeclaredTotal,
    discoveredEntries: allLinks.length,
    detailPagesAttempted,
    detailPagesSucceeded,
    detailFailures,
    rawRecordCount,
    importPreparedCount,
    importSkippedCount,
    completenessStatus: completeness.completenessStatus,
    completenessWarnings: completeness.completenessWarnings,
    networkRequests: requestLog.length,
    requestLogPath: relative(rootDir, options.requestLogPath),
  };
  writeFileSync(options.summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  db.close();
  reportProgress(
    `Capture complete: ${completeness.completenessStatus}; ` +
      `${rawRecordCount} raw records, ${importPreparedCount} prepared, ${importSkippedCount} skipped, ` +
      `${requestLog.length} network requests.`,
  );
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

const invokedPath = process.argv[1]?.replace(/\\/g, "/") ?? "";
if (
  invokedPath.endsWith("/capture-live-to-db.mjs") &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  run();
}
