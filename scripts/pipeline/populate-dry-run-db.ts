import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { JSDOM } from "jsdom";

import { parseBookDetailWithDiagnostics } from "../../src/modules/parser";
import { validateMinimumBookIngest } from "../../src/modules/ingest-validator";
import { bookToZoteroBookPayload } from "../../src/modules/zotero-book-payload";
import { validateZoteroBookPayload } from "../../src/modules/zotero-payload-validator";
import type { BookMetadata, Creator } from "../../src/types";
import type { ValidationStatus } from "../../src/types/pipeline";
import packageJson from "../../package.json";

interface FixtureManifest {
  fixtures: Array<{
    id: string;
    kind: "wishlist-page" | "subject-page";
    sourceUrl: string;
    file: string;
    expected?: string;
    capturedAt: string | null;
    capturedByMode: "synthetic" | "live-fixture-refresh" | "manual";
    purpose: string;
    redactions: string[];
    notes: string;
  }>;
}

interface WishlistLink {
  url: string;
  title: string;
  wishlistUrl: string;
  position: number;
}

interface CliOptions {
  outPath: string;
  summaryPath?: string;
  manifestPath: string;
  reset: boolean;
  testName: string;
  collectionStamp: string;
}

const rootDir = resolve(import.meta.dirname, "..", "..");
const deterministicTimestamp = "1970-01-01T00:00:00.000Z";
const dryRunTestName = "dry-fixture-pipeline";

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    outPath: join(rootDir, ".cache", "dry-run", "pipeline.sqlite"),
    summaryPath: join(rootDir, ".cache", "dry-run", "pipeline-summary.json"),
    manifestPath: join(rootDir, "fixtures", "douban", "synthetic", "manifest.json"),
    reset: true,
    testName: dryRunTestName,
    collectionStamp: formatCollectionTimestamp(deterministicTimestamp),
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out") {
      options.outPath = resolve(rootDir, argv[++i]);
    } else if (arg === "--summary") {
      options.summaryPath = resolve(rootDir, argv[++i]);
    } else if (arg === "--manifest") {
      options.manifestPath = resolve(rootDir, argv[++i]);
    } else if (arg === "--test-name") {
      options.testName = argv[++i];
    } else if (arg === "--collection-stamp") {
      options.collectionStamp = argv[++i];
    } else if (arg === "--no-reset") {
      options.reset = false;
    } else if (arg === "--reset") {
      options.reset = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!/^[A-Za-z0-9_.-]+$/.test(options.testName)) {
    throw new Error("--test-name must contain only letters, numbers, underscore, dot, or dash");
  }
  if (!/^\d{8}-\d{6}$/.test(options.collectionStamp)) {
    throw new Error("--collection-stamp must use YYYYMMDD-HHMMSS");
  }

  return options;
}

function json(value: unknown): string {
  return JSON.stringify(value);
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

function testCollectionNameFromStamp(version: string, testName: string, stamp: string): string {
  return `douban-to-zotero ${version} ${testName} ${stamp}`;
}

function normalizeDoubanUrl(url: string): string {
  const parsed = new URL(url, "https://book.douban.com");
  parsed.protocol = "https:";
  parsed.hash = "";
  return parsed.toString();
}

function subjectIdFromUrl(url: string): string | undefined {
  return url.match(/\/subject\/(\d+)\/?/)?.[1];
}

function extractWishlistOwnerId(url: string): string | undefined {
  return decodeURIComponent(new URL(url).pathname.match(/\/people\/([^/]+)\/wish/)?.[1] ?? "");
}

function extractWishlistLinks(html: string, wishlistUrl: string): WishlistLink[] {
  const dom = new JSDOM(html);
  const links: WishlistLink[] = [];
  const seen = new Set<string>();

  for (const anchor of Array.from(dom.window.document.querySelectorAll("a[href*='/subject/']"))) {
    const href = anchor.getAttribute("href");
    if (!href) continue;

    const url = normalizeDoubanUrl(href);
    if (!/^https:\/\/book\.douban\.com\/subject\/\d+\/?$/.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);

    const title = anchor.getAttribute("title") || anchor.textContent?.replace(/\s+/g, " ").trim() || "";
    links.push({
      url,
      title,
      wishlistUrl,
      position: links.length + 1,
    });
  }

  return links;
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

function toBibLaTeX(book: BookMetadata): string {
  const authors = creatorNames(book.creators, "author").join(" and ");
  const translators = creatorNames(book.creators, "translator").join(" and ");
  const editors = creatorNames(book.creators, "editor").join(" and ");
  const fields = [
    bibField("title", book.title),
    bibField("author", authors),
    bibField("translator", translators),
    bibField("editor", editors),
    bibField("publisher", book.publisher),
    bibField("date", book.publishDate),
    bibField("isbn", book.isbn13 || book.isbn),
    bibField("pagetotal", book.pages),
    bibField("series", book.series),
    bibField("number", book.seriesNumber),
    bibField("url", book.doubanUrl),
    bibField("abstract", book.abstractNote),
  ].filter((field): field is string => Boolean(field));

  return `@book{douban-${book.doubanId},\n${fields.join(",\n")}\n}`;
}

function toBibTeX(book: BookMetadata): string {
  const authors = creatorNames(book.creators, "author").join(" and ");
  const editors = creatorNames(book.creators, "editor").join(" and ");
  const translators = creatorNames(book.creators, "translator").join(" and ");
  const year = book.publishDate?.match(/\d{4}/)?.[0];
  const noteParts = [
    translators ? `Translator: ${translators}` : "",
    book.originalTitle ? `Original title: ${book.originalTitle}` : "",
  ].filter(Boolean);
  const fields = [
    bibField("title", book.title),
    bibField("author", authors),
    bibField("editor", editors),
    bibField("publisher", book.publisher),
    bibField("year", year),
    bibField("isbn", book.isbn13 || book.isbn),
    bibField("pages", book.pages),
    bibField("series", book.series),
    bibField("url", book.doubanUrl),
    bibField("abstract", book.abstractNote),
    bibField("note", noteParts.join("; ")),
  ].filter((field): field is string => Boolean(field));

  return `@book{douban-${book.doubanId},\n${fields.join(",\n")}\n}`;
}

function toZoteroPayload(book: BookMetadata) {
  return bookToZoteroBookPayload(book);
}

function fieldProvenance(book: BookMetadata): Record<string, string> {
  const provenance: Record<string, string> = {};
  for (const key of Object.keys(book) as Array<keyof BookMetadata>) {
    provenance[key] = "rule-cleaned";
  }
  return provenance;
}

function validationWarnings(book: BookMetadata): string[] {
  const warnings: string[] = [];
  warnings.push(...validateMinimumBookIngest(book).warnings);
  if (!book.isbn && !book.isbn13) warnings.push("missing-isbn");
  return warnings;
}

function validationStatus(book: BookMetadata, warnings: string[]): ValidationStatus {
  return validateMinimumBookIngest(book).eligible
    ? warnings.length > 0 ? "warning" : "valid"
    : "invalid";
}

function run() {
  if (process.env.DOUBAN_TO_ZOTERO_EXECUTION_MODE !== "dry-run") {
    throw new Error("populate-dry-run-db requires DOUBAN_TO_ZOTERO_EXECUTION_MODE=dry-run");
  }

  globalThis.fetch = (() => {
    throw new Error("Dry-run database population forbids network access");
  }) as typeof fetch;

  const options = parseArgs(process.argv.slice(2));
  const manifestDir = dirname(options.manifestPath);
  const manifest = JSON.parse(readFileSync(options.manifestPath, "utf-8")) as FixtureManifest;
  const schemaSql = readFileSync(join(rootDir, "schemas", "pipeline.sqlite.sql"), "utf-8");

  if (options.reset && existsSync(options.outPath)) {
    rmSync(options.outPath);
  }
  mkdirSync(dirname(options.outPath), { recursive: true });

  const dom = new JSDOM("<!doctype html>");
  globalThis.DOMParser = dom.window.DOMParser;

  const wishlistLinks = new Map<string, WishlistLink>();
  const wishlistFixtures = manifest.fixtures.filter((fixture) => fixture.kind === "wishlist-page");
  for (const fixture of wishlistFixtures) {
    const html = readFileSync(join(manifestDir, fixture.file), "utf-8");
    for (const link of extractWishlistLinks(html, fixture.sourceUrl)) {
      wishlistLinks.set(link.url, link);
    }
  }

  const subjectFixtures = manifest.fixtures.filter((fixture) => fixture.kind === "subject-page");
  const collectionName = testCollectionNameFromStamp(
    packageJson.version,
    options.testName,
    options.collectionStamp,
  );
  const db = new DatabaseSync(options.outPath);
  db.exec(schemaSql);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("BEGIN");

  try {
    db.exec(`
      DELETE FROM import_records;
      DELETE FROM import_runs;
      DELETE FROM export_records;
      DELETE FROM export_runs;
      DELETE FROM cleaned_records;
      DELETE FROM cleaning_runs;
      DELETE FROM raw_scraped_records;
      DELETE FROM scrape_runs;
      DELETE FROM pipeline_runs;
    `);

    const pipelineRunId = "pipeline-run-dry-fixtures";
    const scrapeRunId = "scrape-run-synthetic-fixtures";
    const cleaningRunId = "cleaning-run-rule-parser-v1";
    const zoteroExportRunId = "export-run-zotero-json";
    const bibtexExportRunId = "export-run-bibtex";
    const biblatexExportRunId = "export-run-biblatex";
    const importRunId = "import-run-zotero-json-dry";

    db.prepare(`
      INSERT INTO pipeline_runs
      (run_id, execution_mode, status, source, input_manifest_path, started_at, completed_at, notes_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      pipelineRunId,
      "dry-run",
      "completed",
      "fixture-db-population",
      relative(rootDir, options.manifestPath),
      deterministicTimestamp,
      deterministicTimestamp,
      json(["No network requests are allowed in this command."]),
    );

    db.prepare(`
      INSERT INTO scrape_runs
      (scrape_run_id, pipeline_run_id, execution_mode, source_kind, fixture_manifest_path, request_count, started_at, completed_at, provenance_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      scrapeRunId,
      pipelineRunId,
      "dry-run",
      "fixture-replay",
      relative(rootDir, options.manifestPath),
      0,
      deterministicTimestamp,
      deterministicTimestamp,
      json({ fixtureCount: manifest.fixtures.length, wishlistPages: wishlistFixtures.length }),
    );

    db.prepare(`
      INSERT INTO cleaning_runs
      (cleaning_run_id, pipeline_run_id, execution_mode, cleaner_kind, provider, model, prompt_template_hash, settings_json, started_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      cleaningRunId,
      pipelineRunId,
      "dry-run",
      "rule-parser",
      "none",
      null,
      null,
      json({ llmCallsAllowed: false }),
      deterministicTimestamp,
      deterministicTimestamp,
    );

    for (const [exportRunId, format] of [
      [zoteroExportRunId, "zotero-json"],
      [bibtexExportRunId, "bibtex"],
      [biblatexExportRunId, "biblatex"],
    ] as const) {
      db.prepare(`
        INSERT INTO export_runs
        (export_run_id, pipeline_run_id, format, target, started_at, completed_at, settings_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        exportRunId,
        pipelineRunId,
        format,
        ".cache/dry-run",
        deterministicTimestamp,
        deterministicTimestamp,
        json({ canonical: format === "zotero-json", exchangeOnly: format !== "zotero-json" }),
      );
    }

    db.prepare(`
      INSERT INTO import_runs
      (import_run_id, pipeline_run_id, execution_mode, target, status, started_at, completed_at, settings_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      importRunId,
      pipelineRunId,
      "dry-run",
      "zotero-json-payload",
      "prepared",
      deterministicTimestamp,
      deterministicTimestamp,
      json({
        zoteroWritesAllowed: false,
        testName: options.testName,
        targetCollectionName: collectionName,
        collectionNaming: "douban-to-zotero {version} {testName} {YYYYMMDD-HHMMSS}",
      }),
    );

    for (const fixture of subjectFixtures) {
      const htmlPath = join(manifestDir, fixture.file);
      const html = readFileSync(htmlPath, "utf-8");
      const parsedResult = parseBookDetailWithDiagnostics(html, fixture.sourceUrl);
      const parsed = parsedResult.book;
      const expected = fixture.expected
        ? JSON.parse(readFileSync(join(manifestDir, fixture.expected), "utf-8"))
        : null;

      if (expected && JSON.stringify(parsed) !== JSON.stringify(expected)) {
        throw new Error(`Fixture ${fixture.id} no longer matches expected metadata`);
      }

      const rawRecordId = `raw-${fixture.id}`;
      const cleanedRecordId = `cleaned-${fixture.id}`;
      const zoteroPayload = toZoteroPayload(parsed);
      const warnings = validationWarnings(parsed);
      const ingestValidation = validateMinimumBookIngest(parsed);
      const payloadValidation = validateZoteroBookPayload(zoteroPayload);
      if (!payloadValidation.valid) {
        throw new Error(
          `Fixture ${fixture.id} produced an invalid Zotero payload: ${payloadValidation.warnings.join(", ")}`,
        );
      }
      const status = validationStatus(parsed, warnings);
      const link = wishlistLinks.get(normalizeDoubanUrl(fixture.sourceUrl));
      const sourceHash = sha256(html);

      db.prepare(`
        INSERT INTO raw_scraped_records
        (raw_record_id, scrape_run_id, internal_id, source_url, douban_subject_id, wishlist_owner_id, source_kind, raw_html, raw_html_sha256, list_context_json, extracted_metadata_json, extraction_warnings_json, provenance_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        rawRecordId,
        scrapeRunId,
        rawRecordId,
        fixture.sourceUrl,
        subjectIdFromUrl(fixture.sourceUrl) ?? null,
        link?.wishlistUrl ? extractWishlistOwnerId(link.wishlistUrl) : null,
        "douban-subject-page",
        html,
        sourceHash,
        json({
          wishlistUrl: link?.wishlistUrl,
          wishlistTitle: link?.title,
          position: link?.position,
        }),
        json(parsed),
        json(parsedResult.extractionWarnings),
        json({
          fixtureId: fixture.id,
          fixturePath: relative(rootDir, htmlPath),
          capturedAt: fixture.capturedAt,
          capturedByMode: fixture.capturedByMode,
          redactions: fixture.redactions,
          notes: fixture.notes,
        }),
        deterministicTimestamp,
      );

      db.prepare(`
        INSERT INTO cleaned_records
        (cleaned_record_id, cleaning_run_id, raw_record_id, internal_id, cleaned_json, validation_status, validation_warnings_json, field_provenance_json, confidence_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        cleanedRecordId,
        cleaningRunId,
        rawRecordId,
        cleanedRecordId,
        json(parsed),
        status,
        json(warnings),
        json(fieldProvenance(parsed)),
        json({}),
        deterministicTimestamp,
      );

      db.prepare(`
        INSERT INTO export_records
        (export_record_id, export_run_id, cleaned_record_id, internal_id, format, payload_text, payload_json, validation_status, validation_warnings_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        `export-zotero-json-${fixture.id}`,
        zoteroExportRunId,
        cleanedRecordId,
        `export-zotero-json-${fixture.id}`,
        "zotero-json",
        null,
        json(zoteroPayload),
        status,
        json(warnings),
        deterministicTimestamp,
      );

      db.prepare(`
        INSERT INTO export_records
        (export_record_id, export_run_id, cleaned_record_id, internal_id, format, payload_text, payload_json, validation_status, validation_warnings_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        `export-bibtex-${fixture.id}`,
        bibtexExportRunId,
        cleanedRecordId,
        `export-bibtex-${fixture.id}`,
        "bibtex",
        toBibTeX(parsed),
        null,
        status,
        json(warnings),
        deterministicTimestamp,
      );

      db.prepare(`
        INSERT INTO export_records
        (export_record_id, export_run_id, cleaned_record_id, internal_id, format, payload_text, payload_json, validation_status, validation_warnings_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        `export-biblatex-${fixture.id}`,
        biblatexExportRunId,
        cleanedRecordId,
        `export-biblatex-${fixture.id}`,
        "biblatex",
        toBibLaTeX(parsed),
        null,
        status,
        json(warnings),
        deterministicTimestamp,
      );

      db.prepare(`
        INSERT INTO import_records
        (import_record_id, import_run_id, cleaned_record_id, export_record_id, internal_id, zotero_item_id, item_payload_json, status, validation_warnings_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        `import-zotero-json-${fixture.id}`,
        importRunId,
        cleanedRecordId,
        `export-zotero-json-${fixture.id}`,
        `import-zotero-json-${fixture.id}`,
        null,
        json(zoteroPayload),
        ingestValidation.eligible ? "prepared" : "skipped",
        json([...warnings, ...payloadValidation.warnings]),
        deterministicTimestamp,
      );
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  const countSql = (sql: string): number => {
    const result = db.prepare(sql).get() as { count: number };
    return result.count;
  };

  const summary = {
    executionMode: "dry-run",
    dbPath: relative(rootDir, options.outPath),
    schemaPath: "schemas/pipeline.sqlite.sql",
    sourceManifest: relative(rootDir, options.manifestPath),
    targetCollectionName: collectionName,
    networkRequests: 0,
    tables: {
      pipelineRuns: countSql("SELECT COUNT(*) AS count FROM pipeline_runs"),
      scrapeRuns: countSql("SELECT COUNT(*) AS count FROM scrape_runs"),
      rawScrapedRecords: countSql("SELECT COUNT(*) AS count FROM raw_scraped_records"),
      cleaningRuns: countSql("SELECT COUNT(*) AS count FROM cleaning_runs"),
      cleanedRecords: countSql("SELECT COUNT(*) AS count FROM cleaned_records"),
      exportRuns: countSql("SELECT COUNT(*) AS count FROM export_runs"),
      exportRecords: countSql("SELECT COUNT(*) AS count FROM export_records"),
      importRuns: countSql("SELECT COUNT(*) AS count FROM import_runs"),
      importRecords: countSql("SELECT COUNT(*) AS count FROM import_records"),
    },
  };

  if (options.summaryPath) {
    mkdirSync(dirname(options.summaryPath), { recursive: true });
    writeFileSync(options.summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  }

  db.close();
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

try {
  run();
} catch (error) {
  console.error(error);
  process.exit(1);
}
