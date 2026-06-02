import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

import type { BookMetadata, MatchType } from "../../src/types";
import packageJson from "../../package.json";

type ExpectedImportDecision = "skip-duplicate" | "review-suspect" | "eligible-new";

interface DuplicateSmokeScenario {
  scenarioId: string;
  description: string;
  existing: BookMetadata[];
  candidate: BookMetadata;
  expected: {
    matchType: MatchType;
    matchedTitle?: string;
    reasonIncludes?: string;
    importDecision: ExpectedImportDecision;
  };
}

interface CliOptions {
  outPath: string;
}

const rootDir = resolve(import.meta.dirname, "..", "..");

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    outPath: resolve(rootDir, ".cache", "dry-run", "zotero-duplicate-smoke-payload.json"),
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out") options.outPath = resolve(rootDir, argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function book(overrides: Partial<BookMetadata> & Pick<BookMetadata, "doubanId" | "title">): BookMetadata {
  return {
    doubanUrl: `https://book.douban.com/subject/${overrides.doubanId}/`,
    doubanId: overrides.doubanId,
    title: overrides.title,
    creators: [
      {
        firstName: "Unit",
        lastName: "Author",
        creatorType: "author",
        fieldMode: 0,
      },
    ],
    publisher: "Unit Test Press",
    publishDate: "2008",
    language: "en",
    ...overrides,
  };
}

const scenarios: DuplicateSmokeScenario[] = [
  {
    scenarioId: "isbn13-incoming-vs-isbn13-existing",
    description: "Exact ISBN-13 candidate matches an existing Zotero ISBN-13 item.",
    existing: [
      book({
        doubanId: "90000001",
        title: "ISBN13 Direct Match Existing",
        isbn13: "9780132350884",
      }),
    ],
    candidate: book({
      doubanId: "90000002",
      title: "ISBN13 Direct Match Candidate",
      isbn13: "9780132350884",
    }),
    expected: {
      matchType: "duplicate",
      matchedTitle: "ISBN13 Direct Match Existing",
      reasonIncludes: "ISBN",
      importDecision: "skip-duplicate",
    },
  },
  {
    scenarioId: "isbn10-incoming-vs-isbn13-existing",
    description: "ISBN-10 candidate normalizes to ISBN-13 and matches an existing ISBN-13 item.",
    existing: [
      book({
        doubanId: "90000003",
        title: "Incoming ISBN10 Crosswalk Existing",
        isbn13: "9780201633610",
      }),
    ],
    candidate: book({
      doubanId: "90000004",
      title: "Incoming ISBN10 Crosswalk Candidate",
      isbn: "0201633612",
    }),
    expected: {
      matchType: "duplicate",
      matchedTitle: "Incoming ISBN10 Crosswalk Existing",
      reasonIncludes: "ISBN",
      importDecision: "skip-duplicate",
    },
  },
  {
    scenarioId: "isbn13-incoming-vs-isbn10-existing",
    description: "ISBN-13 candidate matches an existing ISBN-10 item through normalized fallback.",
    existing: [
      book({
        doubanId: "90000005",
        title: "Existing ISBN10 Crosswalk",
        isbn: "0321125215",
      }),
    ],
    candidate: book({
      doubanId: "90000006",
      title: "Existing ISBN10 Crosswalk",
      isbn13: "9780321125217",
    }),
    expected: {
      matchType: "duplicate",
      matchedTitle: "Existing ISBN10 Crosswalk",
      reasonIncludes: "ISBN",
      importDecision: "skip-duplicate",
    },
  },
  {
    scenarioId: "title-publisher-year-fuzzy-duplicate",
    description: "No ISBN is present, but title, publisher, and year are strong enough for duplicate.",
    existing: [
      book({
        doubanId: "90000007",
        title: "Title Publisher Year Duplicate",
        isbn: undefined,
        isbn13: undefined,
      }),
    ],
    candidate: book({
      doubanId: "90000008",
      title: "Title Publisher Year Duplicate",
      isbn: undefined,
      isbn13: undefined,
    }),
    expected: {
      matchType: "duplicate",
      matchedTitle: "Title Publisher Year Duplicate",
      reasonIncludes: "title+publisher+year",
      importDecision: "skip-duplicate",
    },
  },
  {
    scenarioId: "same-title-different-publisher-year-new",
    description: "Same title alone is not enough when publisher and year disagree.",
    existing: [
      book({
        doubanId: "90000009",
        title: "Shared Title Is Not Enough",
        publisher: "Original Publisher",
        publishDate: "1999",
      }),
    ],
    candidate: book({
      doubanId: "90000010",
      title: "Shared Title Is Not Enough",
      publisher: "Different Academic Press",
      publishDate: "2020",
    }),
    expected: {
      matchType: "new",
      importDecision: "eligible-new",
    },
  },
  {
    scenarioId: "near-title-review-required-suspect",
    description: "A near title with same publisher and year remains review-required, not automatic write.",
    existing: [
      book({
        doubanId: "90000011",
        title: "Boundary Case Pattern Catalog",
      }),
    ],
    candidate: book({
      doubanId: "90000012",
      title: "Boundary Case Pattern Guide",
    }),
    expected: {
      matchType: "suspect",
      matchedTitle: "Boundary Case Pattern Catalog",
      reasonIncludes: "fuzzy match",
      importDecision: "review-suspect",
    },
  },
];

function relativePath(path: string): string {
  return relative(rootDir, path);
}

function run() {
  if (process.env.DOUBAN_TO_ZOTERO_EXECUTION_MODE !== "dry-run") {
    throw new Error("Zotero duplicate smoke payload export requires DOUBAN_TO_ZOTERO_EXECUTION_MODE=dry-run");
  }

  const options = parseArgs(process.argv.slice(2));
  const payload = {
    schemaVersion: 1,
    mode: "zotero-duplicate-dry-payload",
    executionMode: "dry-run",
    addonVersion: packageJson.version,
    exportedAt: new Date().toISOString(),
    scenarioCount: scenarios.length,
    scenarios,
  };

  mkdirSync(dirname(options.outPath), { recursive: true });
  writeFileSync(options.outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");

  process.stdout.write(`${JSON.stringify({
    executionMode: "dry-run",
    mode: payload.mode,
    outPath: relativePath(options.outPath),
    scenarioCount: payload.scenarioCount,
    scenarioIds: scenarios.map((scenario) => scenario.scenarioId),
    networkRequests: 0,
  }, null, 2)}\n`);
}

try {
  run();
} catch (error) {
  console.error(error);
  process.exit(1);
}
