import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseWishListPageDiagnostics } from "../../src/modules/fetcher";

interface CliOptions {
  manifestPath: string;
  summaryPath?: string;
}

interface WishlistPageManifestEntry {
  personId: string;
  pageIndex: number;
  sourceUrl: string;
  file: string;
  subjectNum: {
    start: number;
    end: number;
    total: number;
    text?: string;
  } | null;
  expectedStart: number;
  expectedEnd: number;
  visibleUniqueSubjectLinks: number;
}

interface ReadlistManifestEntry {
  personId: string;
  declaredTotal: number;
  expectedPageCount: number;
  lastPageItemCount: number;
  selectedPageIndexes: number[];
}

interface CaptureManifest {
  schemaVersion: number;
  kind: string;
  executionMode: string;
  requestCount: number;
  readlists: ReadlistManifestEntry[];
  wishlistPages: WishlistPageManifestEntry[];
  subjectPages: Array<{ subjectId: string; sourceUrl: string }>;
}

const rootDir = resolve(import.meta.dirname, "..", "..");

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    manifestPath: "",
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--manifest") options.manifestPath = resolve(rootDir, argv[++i]);
    else if (arg === "--summary") options.summaryPath = resolve(rootDir, argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!options.manifestPath) throw new Error("Missing --manifest <path>");
  return options;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function assertManifest(manifest: CaptureManifest): void {
  if (manifest.schemaVersion !== 1) throw new Error("Unsupported readlist pagination manifest schema");
  if (manifest.kind !== "douban-readlist-pagination-reference-expansion-candidates") {
    throw new Error(`Unexpected manifest kind: ${manifest.kind}`);
  }
  if (manifest.executionMode !== "live") throw new Error("Readlist pagination manifest must be live evidence");
  if (!Array.isArray(manifest.readlists) || manifest.readlists.length === 0) {
    throw new Error("Manifest has no readlists");
  }
  if (!Array.isArray(manifest.wishlistPages) || manifest.wishlistPages.length === 0) {
    throw new Error("Manifest has no wishlistPages");
  }
  if (!Array.isArray(manifest.subjectPages) || manifest.subjectPages.length === 0) {
    throw new Error("Manifest has no subjectPages");
  }
}

function validateSubjectSelection(manifest: CaptureManifest): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const subject of manifest.subjectPages) {
    if (!/^https:\/\/book\.douban\.com\/subject\/\d+\/$/.test(subject.sourceUrl)) {
      errors.push(`invalid selected subject URL: ${subject.sourceUrl}`);
    }
    if (seen.has(subject.subjectId)) {
      errors.push(`duplicate selected subject ID: ${subject.subjectId}`);
    }
    seen.add(subject.subjectId);
  }
  return errors;
}

function validateReadlists(manifest: CaptureManifest): string[] {
  const errors: string[] = [];
  for (const readlist of manifest.readlists) {
    const expectedPageCount = Math.ceil(readlist.declaredTotal / 15);
    if (readlist.expectedPageCount !== expectedPageCount) {
      errors.push(
        `${readlist.personId}: expectedPageCount ${readlist.expectedPageCount} does not match ceil(${readlist.declaredTotal}/15)`,
      );
    }
    const expectedLastPageCount = readlist.declaredTotal === 0
      ? 0
      : ((readlist.declaredTotal - 1) % 15) + 1;
    if (readlist.lastPageItemCount !== expectedLastPageCount) {
      errors.push(
        `${readlist.personId}: lastPageItemCount ${readlist.lastPageItemCount} does not match declared total ${readlist.declaredTotal}`,
      );
    }
    for (const pageIndex of readlist.selectedPageIndexes) {
      if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= readlist.expectedPageCount) {
        errors.push(`${readlist.personId}: selected page ${pageIndex} is outside expected page range`);
      }
    }
  }
  return errors;
}

function validateWishlistPages(manifest: CaptureManifest): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const totalsByPerson = new Map(manifest.readlists.map((readlist) => [readlist.personId, readlist.declaredTotal]));

  for (const page of manifest.wishlistPages) {
    const filePath = resolve(rootDir, page.file);
    if (!existsSync(filePath)) {
      errors.push(`${page.personId} page ${page.pageIndex}: missing file ${page.file}`);
      continue;
    }

    const diagnostics = parseWishListPageDiagnostics(readFileSync(filePath, "utf-8"));
    const subjectNum = diagnostics.subjectCountRange;
    if (!subjectNum) {
      errors.push(`${page.personId} page ${page.pageIndex}: parser did not find subject-num`);
      continue;
    }

    const declaredTotal = totalsByPerson.get(page.personId);
    if (declaredTotal !== undefined && subjectNum.total !== declaredTotal) {
      errors.push(
        `${page.personId} page ${page.pageIndex}: subject-num total ${subjectNum.total} differs from first-page total ${declaredTotal}`,
      );
    }
    if (subjectNum.start !== page.expectedStart) {
      errors.push(
        `${page.personId} page ${page.pageIndex}: subject-num start ${subjectNum.start} differs from expected ${page.expectedStart}`,
      );
    }
    if (subjectNum.end !== page.expectedEnd) {
      errors.push(
        `${page.personId} page ${page.pageIndex}: subject-num end ${subjectNum.end} differs from expected ${page.expectedEnd}`,
      );
    }
    if (diagnostics.visibleEntryCount !== page.visibleUniqueSubjectLinks) {
      errors.push(
        `${page.personId} page ${page.pageIndex}: parser saw ${diagnostics.visibleEntryCount} links, manifest recorded ${page.visibleUniqueSubjectLinks}`,
      );
    }

    const rangeSize = subjectNum.end - subjectNum.start + 1;
    if (diagnostics.visibleEntryCount < rangeSize) {
      warnings.push(
        `${page.personId} page ${page.pageIndex}: subject-num range has ${rangeSize} entries but anonymous page exposes ${diagnostics.visibleEntryCount} unique subject links`,
      );
    }
  }

  return { errors, warnings };
}

function run(): void {
  const options = parseArgs(process.argv.slice(2));
  const manifest = readJson<CaptureManifest>(options.manifestPath);
  assertManifest(manifest);

  const errors = [
    ...validateReadlists(manifest),
    ...validateSubjectSelection(manifest),
  ];
  const pageValidation = validateWishlistPages(manifest);
  errors.push(...pageValidation.errors);

  const summary = {
    executionMode: process.env.DOUBAN_TO_ZOTERO_EXECUTION_MODE || "dry-run",
    manifest: options.manifestPath.replace(/\\/g, "/"),
    readlists: manifest.readlists.length,
    wishlistPages: manifest.wishlistPages.length,
    selectedSubjectPages: manifest.subjectPages.length,
    requestCount: manifest.requestCount,
    errors,
    warnings: pageValidation.warnings,
    passed: errors.length === 0,
  };

  if (options.summaryPath) {
    writeFileSync(options.summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  }

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (errors.length > 0) process.exit(1);
}

run();
