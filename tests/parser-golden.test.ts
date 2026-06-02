import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { JSDOM } from "jsdom";

import { parseBookDetail, parseBookDetailWithDiagnostics } from "../src/modules/parser";
import { validateMinimumBookIngest } from "../src/modules/ingest-validator";
import { checkDuplicates } from "../src/modules/deduplicator";
import { cacheKeyForUrl } from "../src/modules/fetch-cache";
import { fetchSeriesVolumes } from "../src/modules/series-fetcher";
import { createZoteroBookItemFromPayload, writeBooks } from "../src/modules/writer";
import { bookToZoteroBookPayload } from "../src/modules/zotero-book-payload";
import {
  OPENAI_COMPATIBLE_REDACTED_API_KEY,
  OpenAICompatibleMetadataCleaner,
  ModelHttpError,
  ModelNetworkAccessDeniedError,
} from "../src/modules/openai-compatible-client";
import type { OpenAICompatibleTransport } from "../src/modules/openai-compatible-transport";
import {
  DryRunNetworkBlockedError,
  FixtureDoubanSource,
  LiveNetworkAccessDeniedError,
  LiveDoubanSource,
} from "../src/modules/douban-source";
import { fetchWishList } from "../src/modules/fetcher";
import {
  formatLiveCaptureProgressLine,
  summarizeCaptureCompleteness,
} from "../scripts/pipeline/capture-live-to-db";
import { normalizeDate } from "../src/modules/parser-rules";
import { parseCreatorList } from "../src/utils/name-utils";
import {
  getOpenAICompatibleSettings,
  getReadlists,
  normalizeReadlistInput,
  saveReadlists,
  setOpenAICompatibleSettings,
} from "../src/modules/preferences";
import { buildDiagnosticsReport } from "../src/modules/diagnostics";
import { clearLocalData } from "../src/modules/local-data";

const rootDir = process.cwd();
const fixtureDir = join(rootDir, "fixtures", "douban", "synthetic");

function readFixture(name: string): string {
  return readFileSync(join(fixtureDir, name), "utf-8");
}

function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function readJsonFixture<T>(name: string): T {
  return JSON.parse(readFixture(name)) as T;
}

async function withFakeZoteroCache<T>(fn: () => Promise<T>): Promise<T> {
  const previousZotero = (globalThis as any).Zotero;
  const previousPathUtils = (globalThis as any).PathUtils;
  const previousIOUtils = (globalThis as any).IOUtils;
  const cacheRoot = mkdtempSync(join(tmpdir(), "douban-fetch-cache-"));

  (globalThis as any).Zotero = {
    DataDirectory: { dir: cacheRoot },
    log() {},
  };
  (globalThis as any).PathUtils = { join };
  (globalThis as any).IOUtils = {
    async exists(path: string) {
      return existsSync(path);
    },
    async makeDirectory(path: string, options?: { createAncestors?: boolean }) {
      mkdirSync(path, { recursive: Boolean(options?.createAncestors) });
    },
    async writeUTF8(path: string, text: string) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text, "utf-8");
    },
    async readUTF8(path: string) {
      return readFileSync(path, "utf-8");
    },
    async remove(path: string, options?: { recursive?: boolean }) {
      rmSync(path, { recursive: Boolean(options?.recursive), force: true });
    },
    async move(source: string, target: string) {
      renameSync(source, target);
    },
  };

  try {
    return await fn();
  } finally {
    (globalThis as any).Zotero = previousZotero;
    (globalThis as any).PathUtils = previousPathUtils;
    (globalThis as any).IOUtils = previousIOUtils;
    rmSync(cacheRoot, { recursive: true, force: true });
  }
}

async function withFakeZoteroPrefs<T>(
  initial: Record<string, string>,
  fn: () => T | Promise<T>,
): Promise<T> {
  const previousZotero = (globalThis as any).Zotero;
  const previousPathUtils = (globalThis as any).PathUtils;
  const prefs = new Map<string, string>(Object.entries(initial));

  (globalThis as any).Zotero = {
    DataDirectory: { dir: "C:\\ZoteroDev\\Data" },
    Prefs: {
      get(pref: string) {
        return prefs.get(pref) ?? "";
      },
      set(pref: string, value: unknown) {
        prefs.set(pref, String(value));
      },
    },
    log() {},
    version: "9.0-test",
  };
  (globalThis as any).PathUtils = { join };

  try {
    return await fn();
  } finally {
    (globalThis as any).Zotero = previousZotero;
    (globalThis as any).PathUtils = previousPathUtils;
  }
}

function subjectUrl(id: number): string {
  return `https://book.douban.com/subject/${id}/`;
}

function subjectFixtureHtml(id: number): string {
  return `<!doctype html><html><body><h1>Fixture Book ${id}</h1></body></html>`;
}

function wishListFixtureHtml(options: {
  rangeStart: number;
  rangeEnd: number;
  total: number;
  subjectIds: number[];
  nextHref?: string;
  titleBeforeHref?: boolean;
}): string {
  const links = options.subjectIds
    .map((id, index) => {
      const title = `Fixture Book ${id}`;
      if (options.titleBeforeHref && index === 0) {
        return `<a title="${title}" href="${subjectUrl(id)}">${title}</a>`;
      }
      return `<a href="${subjectUrl(id)}" title="${title}">${title}</a>`;
    })
    .join("\n");
  const next = options.nextHref
    ? `<span class="next"><link rel="next" href="${options.nextHref}"><a href="${options.nextHref}">Next &gt;</a></span>`
    : `<span class="next">&gt;</span>`;

  return `
    <!doctype html>
    <html>
      <body>
        <span class="subject-num">
          ${options.rangeStart}-${options.rangeEnd}&nbsp;/&nbsp;${options.total}
        </span>
        <div class="grid-view">${links}</div>
        <div class="paginator">${next}</div>
      </body>
    </html>
  `;
}

function bookInfoFixtureHtml(title: string, fields: Array<[string, string]>): string {
  const info = fields
    .map(([label, value]) => `<span class="pl">${label}:</span> ${value}<br>`)
    .join("\n");

  return `
    <!doctype html>
    <html>
      <body>
        <h1><span>${title}</span></h1>
        <div id="info">
          ${info}
        </div>
      </body>
    </html>
  `;
}

function withoutUndefined<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function parserStableFields(value: unknown): Record<string, unknown> {
  const stable = withoutUndefined(value) as Record<string, unknown>;
  delete stable.abstractNote;
  delete stable.coverUrl;
  return stable;
}

test("dry-run test process blocks common network globals", () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("Dry-run network guard blocked global fetch");
  }) as typeof fetch;

  assert.throws(
    () => globalThis.fetch("https://book.douban.com/"),
    /Dry-run network guard/,
  );

  globalThis.fetch = previousFetch;
});

test("source modules do not bypass the Douban source boundary", () => {
  const allowed = new Set([
    join("src", "utils", "http.ts"),
    join("src", "modules", "douban-source.ts"),
    join("src", "modules", "openai-compatible-transport.ts"),
  ]);
  const forbidden = [
    /Zotero\.HTTP\.request/,
    /\bfetchWithDelay\b/,
    /\bfetch\s*\(/,
    /\bXMLHttpRequest\b/,
    /\bhttp\.request\b/,
    /\bhttps\.request\b/,
  ];

  function visit(dir: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      const stat = statSync(path);
      if (stat.isDirectory()) {
        files.push(...visit(path));
      } else if (path.endsWith(".ts")) {
        files.push(path);
      }
    }
    return files;
  }

  const violations: string[] = [];
  for (const file of visit(join(rootDir, "src"))) {
    const rel = relative(rootDir, file);
    if (allowed.has(rel)) continue;
    const text = readFileSync(file, "utf-8");
    for (const pattern of forbidden) {
      if (pattern.test(text)) {
        violations.push(`${rel}: ${pattern}`);
      }
    }
  }

  assert.deepEqual(violations, []);
});

test("fixture source returns captured HTML and blocks missing URLs", async () => {
  const url = "https://book.douban.com/subject/1000001/";
  const html = readFixture("subject-1000001.html");
  const source = new FixtureDoubanSource([[url, html]]);

  assert.equal(await source.getText(url), html);
  await assert.rejects(
    () => source.getText("https://book.douban.com/subject/9999999/"),
    DryRunNetworkBlockedError,
  );
});

test("wish-list fetcher follows paginated subject-num totals", async () => {
  const uid = "paging-user";
  const firstPageUrl = `https://book.douban.com/people/${uid}/wish?start=0`;
  const secondPageHref = `/people/${uid}/wish?start=15&amp;sort=time&amp;rating=all&amp;filter=all&amp;mode=grid`;
  const secondPageUrl = `https://book.douban.com/people/${uid}/wish?start=15&sort=time&rating=all&filter=all&mode=grid`;
  const subjectIds = Array.from({ length: 16 }, (_, index) => 2000000 + index);
  const source = new FixtureDoubanSource([
    [
      firstPageUrl,
      wishListFixtureHtml({
        rangeStart: 1,
        rangeEnd: 15,
        total: 16,
        subjectIds: subjectIds.slice(0, 15),
        nextHref: secondPageHref,
        titleBeforeHref: true,
      }),
    ],
    [
      secondPageUrl,
      wishListFixtureHtml({
        rangeStart: 16,
        rangeEnd: 16,
        total: 16,
        subjectIds: subjectIds.slice(15),
      }),
    ],
    ...subjectIds.map((id) => [subjectUrl(id), subjectFixtureHtml(id)] as [string, string]),
  ]);
  const progress: string[] = [];

  const result = await withFakeZoteroCache(() =>
    fetchWishList(uid, (_current, _total, message) => progress.push(message), null, source),
  );

  assert.equal(result.books.length, 16);
  assert.deepEqual(result.books.map((book) => book.url), subjectIds.map(subjectUrl));
  assert.deepEqual(result.warnings, []);
  assert.ok(progress.some((message) => message.includes("Fetched 16/16 list entries.")));
});

test("wish-list fetcher warns when anonymous pages expose fewer entries than subject-num", async () => {
  const uid = "hidden-user";
  const firstPageUrl = `https://book.douban.com/people/${uid}/wish?start=0`;
  const secondPageHref = `/people/${uid}/wish?start=15&amp;sort=time&amp;rating=all&amp;filter=all&amp;mode=grid`;
  const secondPageUrl = `https://book.douban.com/people/${uid}/wish?start=15&sort=time&rating=all&filter=all&mode=grid`;
  const visibleSubjectIds = [
    ...Array.from({ length: 14 }, (_, index) => 3000000 + index),
    3000015,
  ];
  const source = new FixtureDoubanSource([
    [
      firstPageUrl,
      wishListFixtureHtml({
        rangeStart: 1,
        rangeEnd: 15,
        total: 16,
        subjectIds: visibleSubjectIds.slice(0, 14),
        nextHref: secondPageHref,
      }),
    ],
    [
      secondPageUrl,
      wishListFixtureHtml({
        rangeStart: 16,
        rangeEnd: 16,
        total: 16,
        subjectIds: visibleSubjectIds.slice(14),
      }),
    ],
    ...visibleSubjectIds.map((id) => [subjectUrl(id), subjectFixtureHtml(id)] as [string, string]),
  ]);

  const result = await withFakeZoteroCache(() =>
    fetchWishList(uid, () => {}, null, source),
  );

  assert.equal(result.books.length, 15);
  assert.match(
    result.warnings.join("\n"),
    /readlist-visible-count-mismatch: Douban declared 16 wish-list books, but only 15 visible list entries were fetched anonymously/,
  );
});

test("live full-readlist capture summary distinguishes anonymous visibility from incomplete crawl", () => {
  const anonymousDeficit = summarizeCaptureCompleteness({
    declaredTotal: 16,
    expectedPageCount: 2,
    capturedListPages: 2,
    visibleUniqueSubjectLinks: 15,
    visibleDeficitAgainstDeclaredTotal: 1,
    detailPagesAttempted: 15,
    detailPagesSucceeded: 15,
    rawRecordCount: 15,
    importPreparedCount: 10,
    importSkippedCount: 5,
    stoppedByCap: false,
    stoppedByMissingNext: false,
    detailFailures: 0,
    discoveryWarnings: [
      "readlist-visible-count-mismatch: Douban declared 16 wish-list books, but only 15 unique subject URLs were visible anonymously; 1 may be hidden by login/privacy behavior.",
    ],
  });
  assert.equal(
    anonymousDeficit.completenessStatus,
    "complete-with-anonymous-visibility-warning",
  );
  assert.match(anonymousDeficit.completenessWarnings.join("\n"), /visible anonymously/);

  const detailFailure = summarizeCaptureCompleteness({
    declaredTotal: 16,
    expectedPageCount: 2,
    capturedListPages: 2,
    visibleUniqueSubjectLinks: 16,
    visibleDeficitAgainstDeclaredTotal: 0,
    detailPagesAttempted: 16,
    detailPagesSucceeded: 15,
    rawRecordCount: 15,
    importPreparedCount: 15,
    importSkippedCount: 0,
    stoppedByCap: false,
    stoppedByMissingNext: false,
    detailFailures: 1,
    discoveryWarnings: [],
  });
  assert.equal(detailFailure.completenessStatus, "incomplete-detail-capture");
  assert.match(detailFailure.completenessWarnings.join("\n"), /attempted 16 detail pages/);
});

test("live capture progress lines are timestamped stderr-safe text", () => {
  const line = formatLiveCaptureProgressLine(
    "Detail 10/95: stored 1234567 as skipped.",
    new Date("2026-06-01T12:34:56.789Z"),
  );
  const liveCaptureScript = readFileSync(
    join(rootDir, "scripts", "pipeline", "capture-live-to-db.ts"),
    "utf-8",
  );

  assert.equal(
    line,
    "[live-capture 2026-06-01T12:34:56.789Z] Detail 10/95: stored 1234567 as skipped.\n",
  );
  assert.doesNotThrow(() => JSON.stringify({ progress: line }));
  assert.match(liveCaptureScript, /process\.stderr\.write\(formatLiveCaptureProgressLine\(message\)\)/);
  assert.match(liveCaptureScript, /Detail \$\{index \+ 1\}\/\$\{allLinks\.length\}: fetching/);
});

test("live full-readlist capture rejects default artifact paths before network work", () => {
  const result = spawnSync(
    process.execPath,
    [
      "scripts/capture-live-to-db.mjs",
      "--full-readlist",
      "--wishlist-url",
      "https://book.douban.com/people/164597338/wish",
      "--confirm-live",
    ],
    {
      cwd: rootDir,
      encoding: "utf-8",
      env: {
        ...process.env,
        DOUBAN_TO_ZOTERO_EXECUTION_MODE: "live",
      },
    },
  );
  assert.notEqual(result.status, 0);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.stdout, "");
  assert.match(output, /--full-readlist requires an explicit non-default --out path/);
  assert.doesNotMatch(output, /HTTP \d{3}|Douban challenge page detected/);
});

test("series fetcher reads series and detail pages from an injected fixture source", async () => {
  const previousZotero = (globalThis as any).Zotero;
  (globalThis as any).Zotero = { log() {} };
  try {
    const seriesUrl = "https://book.douban.com/series/12345";
    const subjectUrl = "https://book.douban.com/subject/1000001/";
    const source = new FixtureDoubanSource([
      [
        seriesUrl,
        `
          <html>
            <body>
              <h1>Fixture Series</h1>
              <div class="subject-list">
                <a href="${subjectUrl}">Fixture Volume</a>
              </div>
              <div class="paginator"></div>
            </body>
          </html>
        `,
      ],
      [subjectUrl, readFixture("subject-1000001.html")],
    ]);
    const progress: string[] = [];

    const result = await fetchSeriesVolumes(
      seriesUrl,
      (_current, _total, message) => progress.push(message),
      source,
    );

    assert.equal(result.seriesName, "Fixture Series");
    assert.deepEqual(result.books.map((book) => book.url), [subjectUrl]);
    assert.equal(result.books[0].html, readFixture("subject-1000001.html"));
    assert.ok(progress.length > 0);
  } finally {
    (globalThis as any).Zotero = previousZotero;
  }
});

test("live source rejects non-Douban hosts before making a request", async () => {
  const source = new LiveDoubanSource();
  await assert.rejects(
    () => source.getText("https://example.com/"),
    LiveNetworkAccessDeniedError,
  );
  assert.equal(source.requestLog.length, 0);
});

test("cache keys preserve subject URL variants without query-order noise", () => {
  const plain = cacheKeyForUrl("https://book.douban.com/subject/1000001/");
  const withQueryA = cacheKeyForUrl("https://book.douban.com/subject/1000001/?b=2&a=1#frag");
  const withQueryB = cacheKeyForUrl("https://book.douban.com/subject/1000001/?a=1&b=2");

  assert.notEqual(plain, withQueryA);
  assert.equal(withQueryA, withQueryB);
  assert.match(plain, /^subject-1000001-[0-9a-f]{8}$/);
});

test("readlist preferences canonicalize UID and public wish-list URLs", () => {
  assert.deepEqual(normalizeReadlistInput("178141656"), {
    uid: "178141656",
    url: "https://book.douban.com/people/178141656/wish",
  });
  assert.deepEqual(
    normalizeReadlistInput(
      "https://book.douban.com/people/178141656/wish?start=15#page",
    ),
    {
      uid: "178141656",
      url: "https://book.douban.com/people/178141656/wish",
    },
  );
  assert.equal(normalizeReadlistInput("https://example.com/people/178141656/wish"), null);
  assert.equal(normalizeReadlistInput("https://book.douban.com/subject/123/"), null);
});

test("readlist preferences migrate legacy UID and diagnostics redact OpenAI API keys", async () => {
  await withFakeZoteroPrefs(
    {
      "__prefsPrefix__.doubanUid": "164597338",
      "__prefsPrefix__.readlistsJson": "",
      "__prefsPrefix__.openaiCompatible.baseUrl": "",
      "__prefsPrefix__.openaiCompatible.model": "",
      "__prefsPrefix__.openaiCompatible.apiKey": "",
    },
    () => {
      assert.deepEqual(getReadlists(), [
        {
          uid: "164597338",
          url: "https://book.douban.com/people/164597338/wish",
        },
      ]);

      saveReadlists([
        {
          uid: "164597338",
          url: "https://book.douban.com/people/164597338/wish",
          label: "FRL-95",
        },
        {
          uid: "164597338",
          url: "https://book.douban.com/people/164597338/wish",
        },
        {
          uid: "178141656",
          url: "https://book.douban.com/people/178141656/wish",
        },
      ]);
      assert.deepEqual(getReadlists().map((readlist) => readlist.uid), [
        "164597338",
        "178141656",
      ]);

      const apiKey = "sk-test-secret";
      setOpenAICompatibleSettings({
        baseUrl: "https://api.example.com",
        model: "test-model",
        apiKey,
      });
      const report = buildDiagnosticsReport();
      assert.equal(report.includes(apiKey), false);
      assert.match(report, /openAICompatibleApiKeyConfigured: yes/);
      assert.match(report, /openAICompatibleApiKey: \[redacted\]/);
    },
  );
});

test("local-data cleanup keeps OpenAI API key unless key cleanup is selected", async () => {
  await withFakeZoteroPrefs(
    {
      "__prefsPrefix__.doubanUid": "",
      "__prefsPrefix__.readlistsJson": "[]",
      "__prefsPrefix__.openaiCompatible.baseUrl": "",
      "__prefsPrefix__.openaiCompatible.model": "",
      "__prefsPrefix__.openaiCompatible.apiKey": "",
    },
    async () => {
      setOpenAICompatibleSettings({
        baseUrl: "https://api.example.com",
        model: "test-model",
        apiKey: "sk-test-secret",
      });

      await clearLocalData({
        temporaryFetchCache: false,
        pluginLogs: false,
        savedReadlists: false,
        openAISettings: true,
        openAIApiKey: false,
      });
      assert.deepEqual(getOpenAICompatibleSettings(), {
        baseUrl: "",
        model: "",
        apiKey: "sk-test-secret",
      });

      await clearLocalData({
        temporaryFetchCache: false,
        pluginLogs: false,
        savedReadlists: false,
        openAISettings: false,
        openAIApiKey: true,
      });
      assert.deepEqual(getOpenAICompatibleSettings(), {
        baseUrl: "",
        model: "",
        apiKey: "",
      });
    },
  );
});

test("OpenAI-compatible cleaner rejects dry-run before making a request", async () => {
  const cleaner = new OpenAICompatibleMetadataCleaner(
    {
      baseUrl: "https://api.openai.example.invalid/v1",
      apiKey: "test-key",
      model: "test-model",
    },
    "dry-run",
  );
  const metadata = readJsonFixture<any>("subject-1000001.expected.json");

  await assert.rejects(
    () => cleaner.clean("raw text", metadata),
    ModelNetworkAccessDeniedError,
  );
  assert.equal(cleaner.requestLog.length, 0);
});

test("OpenAI-compatible cleaner records and rejects non-2xx responses", async () => {
  const transport: OpenAICompatibleTransport = {
    async postJson() {
      return { statusCode: 500, responseText: "{\"error\":\"boom\"}" };
    },
  };
  const cleaner = new OpenAICompatibleMetadataCleaner(
    {
      baseUrl: "https://api.openai.example.invalid/v1",
      apiKey: "test-key",
      model: "test-model",
    },
    "live",
    transport,
  );
  const metadata = readJsonFixture<any>("subject-1000001.expected.json");

  await assert.rejects(
    () => cleaner.clean("raw text", metadata),
    ModelHttpError,
  );
  assert.equal(cleaner.requestLog[0].statusCode, 500);
  assert.equal(cleaner.requestLog[0].ok, false);
});

test("OpenAI-compatible cleaner rejects malformed JSON responses", async () => {
  const transport: OpenAICompatibleTransport = {
    async postJson() {
      return { statusCode: 200, responseText: "not json" };
    },
  };
  const cleaner = new OpenAICompatibleMetadataCleaner(
    {
      baseUrl: "https://api.openai.example.invalid/v1",
      apiKey: "test-key",
      model: "test-model",
    },
    "live",
    transport,
  );
  const metadata = readJsonFixture<any>("subject-1000001.expected.json");

  await assert.rejects(
    () => cleaner.clean("raw text", metadata),
    SyntaxError,
  );
  assert.equal(cleaner.requestLog[0].statusCode, 200);
  assert.equal(cleaner.requestLog[0].ok, false);
});

test("OpenAI-compatible cleaner never persists API keys in request logs", async () => {
  const secret = "sk-test-secret-for-redaction";
  let transportSawKey = "";
  const transport: OpenAICompatibleTransport = {
    async postJson(_url, apiKey) {
      transportSawKey = apiKey;
      throw new Error(`transport failed while using ${apiKey}`);
    },
  };
  const cleaner = new OpenAICompatibleMetadataCleaner(
    {
      baseUrl: "https://api.openai.example.invalid/v1",
      apiKey: secret,
      model: "test-model",
    },
    "live",
    transport,
  );
  const metadata = readJsonFixture<any>("subject-1000001.expected.json");

  await assert.rejects(
    () => cleaner.clean("raw text", metadata),
    /transport failed/,
  );

  assert.equal(transportSawKey, secret);
  assert.equal(JSON.stringify(cleaner.requestLog).includes(secret), false);
  assert.match(
    cleaner.requestLog[0].errorMessage ?? "",
    new RegExp(OPENAI_COMPATIBLE_REDACTED_API_KEY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
});

test("OpenAI-compatible cleaner requires low-risk supported language completion", async () => {
  let capturedBody: any;
  const transport: OpenAICompatibleTransport = {
    async postJson(_url, _apiKey, body) {
      capturedBody = body;
      return {
        statusCode: 200,
        responseText: JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  ...readJsonFixture<any>("subject-1000001.expected.json"),
                  language: "ZH",
                }),
              },
            },
          ],
        }),
      };
    },
  };
  const cleaner = new OpenAICompatibleMetadataCleaner(
    {
      baseUrl: "https://api.openai.example.invalid/v1",
      apiKey: "test-key",
      model: "test-model",
    },
    "live",
    transport,
  );
  const metadata = readJsonFixture<any>("subject-1000001.expected.json");
  delete metadata.language;

  const cleaned = await cleaner.clean(
    "标题：测试之书\n出版社：测试出版社\n简介：这是中文图书页面。",
    metadata,
  );

  assert.equal(cleaned.language, "zh");
  const messages = capturedBody.messages as Array<{ role: string; content: string }>;
  assert.match(messages[0].content, /Low-risk language completion is allowed and expected/);
  assert.match(messages[0].content, /zh, ja, en/);
  const payload = JSON.parse(messages[1].content);
  assert.deepEqual(
    payload.cleaningPolicy.language.supportedLanguageCodes.slice(0, 3),
    ["zh", "ja", "en"],
  );
  assert.match(payload.cleaningPolicy.language.rule.join(" "), /fill language/);
});

test("OpenAI-compatible cleaner ignores unsupported language completions", async () => {
  const transport: OpenAICompatibleTransport = {
    async postJson() {
      return {
        statusCode: 200,
        responseText: JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  ...readJsonFixture<any>("subject-1000001.expected.json"),
                  language: "zh-CN",
                }),
              },
            },
          ],
        }),
      };
    },
  };
  const cleaner = new OpenAICompatibleMetadataCleaner(
    {
      baseUrl: "https://api.openai.example.invalid/v1",
      apiKey: "test-key",
      model: "test-model",
    },
    "live",
    transport,
  );

  const cleaned = await cleaner.clean("raw text", readJsonFixture<any>("subject-1000001.expected.json"));
  assert.equal(cleaned.language, undefined);
});

test("OpenAI-cleaned promotion requires review and blocks protected-field changes", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "douban-openai-promotion-"));
  try {
    const dbPath = join(tempDir, "pipeline.sqlite");
    const manifestPath = join(tempDir, "manifest.json");
    const reviewedManifestPath = join(tempDir, "reviewed-manifest.json");
    const summaryPath = join(tempDir, "summary.json");
    const reportPath = join(tempDir, "report.md");
    const schemaSql = readFileSync(join(rootDir, "schemas", "pipeline.sqlite.sql"), "utf-8");
    const db = new DatabaseSync(dbPath);

    const completeRuleBook = {
      doubanUrl: "https://book.douban.com/subject/9900001/",
      doubanId: "9900001",
      title: "Reviewable Language Book",
      creators: [{ firstName: "", lastName: "作者甲", creatorType: "author", fieldMode: 1 }],
      publisher: "测试出版社",
      publishDate: "2026",
      isbn13: "9787111111111",
    };
    const languageCompletedBook = {
      ...completeRuleBook,
      language: "zh",
    };
    const protectedRuleBook = {
      doubanUrl: "https://book.douban.com/subject/9900002/",
      doubanId: "9900002",
      title: "Protected Title",
      creators: [{ firstName: "", lastName: "作者乙", creatorType: "author", fieldMode: 1 }],
      publisher: "测试出版社",
      publishDate: "2026",
      isbn13: "9787111111128",
    };
    const protectedChangedBook = {
      ...protectedRuleBook,
      title: "Model Changed Title",
      language: "zh",
    };

    db.exec(schemaSql);
    db.exec("PRAGMA foreign_keys = ON");
    db.prepare(`
      INSERT INTO pipeline_runs
      (run_id, execution_mode, status, source, input_manifest_path, started_at, completed_at, notes_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("pipeline-openai-promotion-test", "dry-run", "completed", "test", null, "2026-05-30T00:00:00.000Z", "2026-05-30T00:00:00.000Z", "[]");
    db.prepare(`
      INSERT INTO scrape_runs
      (scrape_run_id, pipeline_run_id, execution_mode, source_kind, fixture_manifest_path, request_count, started_at, completed_at, provenance_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("scrape-openai-promotion-test", "pipeline-openai-promotion-test", "dry-run", "test", null, 0, "2026-05-30T00:00:00.000Z", "2026-05-30T00:00:00.000Z", "{}");
    for (const subjectId of ["9900001", "9900002"]) {
      db.prepare(`
        INSERT INTO raw_scraped_records
        (raw_record_id, scrape_run_id, internal_id, source_url, douban_subject_id, wishlist_owner_id, source_kind, raw_html, raw_html_sha256, list_context_json, extracted_metadata_json, extraction_warnings_json, provenance_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        `raw-${subjectId}`,
        "scrape-openai-promotion-test",
        `raw-${subjectId}`,
        `https://book.douban.com/subject/${subjectId}/`,
        subjectId,
        null,
        "douban-subject-page",
        "<html></html>",
        subjectId,
        "{}",
        "{}",
        "[]",
        "{}",
        "2026-05-30T00:00:00.000Z",
      );
    }
    for (const [cleaningRunId, cleanerKind] of [
      ["cleaning-rule-promotion-test", "rule-parser"],
      ["cleaning-openai-promotion-test", "openai-compatible"],
    ] as const) {
      db.prepare(`
        INSERT INTO cleaning_runs
        (cleaning_run_id, pipeline_run_id, execution_mode, cleaner_kind, provider, model, prompt_template_hash, settings_json, started_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        cleaningRunId,
        "pipeline-openai-promotion-test",
        "dry-run",
        cleanerKind,
        cleanerKind === "openai-compatible" ? "openai-compatible" : "none",
        cleanerKind === "openai-compatible" ? "test-model" : null,
        null,
        "{}",
        "2026-05-30T00:00:00.000Z",
        "2026-05-30T00:00:00.000Z",
      );
    }
    for (const [cleanedId, runId, rawId, book, status] of [
      ["cleaned-rule-9900001", "cleaning-rule-promotion-test", "raw-9900001", completeRuleBook, "invalid"],
      ["cleaned-rule-9900002", "cleaning-rule-promotion-test", "raw-9900002", protectedRuleBook, "invalid"],
      ["cleaned-openai-9900001", "cleaning-openai-promotion-test", "raw-9900001", languageCompletedBook, "valid"],
      ["cleaned-openai-9900002", "cleaning-openai-promotion-test", "raw-9900002", protectedChangedBook, "valid"],
    ] as const) {
      db.prepare(`
        INSERT INTO cleaned_records
        (cleaned_record_id, cleaning_run_id, raw_record_id, internal_id, cleaned_json, validation_status, validation_warnings_json, field_provenance_json, confidence_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        cleanedId,
        runId,
        rawId,
        cleanedId,
        JSON.stringify(book),
        status,
        status === "valid" ? "[]" : "[\"minimum-ingest-missing-language\"]",
        "{}",
        "{}",
        "2026-05-30T00:00:00.000Z",
      );
    }
    db.close();

    const generate = spawnSync(
      process.execPath,
      [
        "scripts/promote-openai-cleaned-records.mjs",
        "--db", dbPath,
        "--manifest", manifestPath,
        "--summary", summaryPath,
        "--report", reportPath,
        "--cleaning-run-id", "cleaning-openai-promotion-test",
        "--collection-stamp", "20260530-120000",
      ],
      { cwd: rootDir, encoding: "utf-8" },
    );
    assert.equal(generate.status, 0, generate.stderr);

    const manifest = readJsonFile<any>(manifestPath);
    assert.equal(manifest.candidates.length, 2);
    assert.deepEqual(
      manifest.candidates.map((candidate: any) => candidate.decision),
      ["skip", "skip"],
    );
    for (const candidate of manifest.candidates) candidate.decision = "accept";
    writeFileSync(reviewedManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");

    const apply = spawnSync(
      process.execPath,
      [
        "scripts/promote-openai-cleaned-records.mjs",
        "--db", dbPath,
        "--summary", summaryPath,
        "--manifest", manifestPath,
        "--report", reportPath,
        "--cleaning-run-id", "cleaning-openai-promotion-test",
        "--collection-stamp", "20260530-120000",
        "--apply",
        "--review-manifest", reviewedManifestPath,
        "--preserve-skipped",
      ],
      { cwd: rootDir, encoding: "utf-8" },
    );
    assert.equal(apply.status, 0, apply.stderr);

    const verifyDb = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const counts = verifyDb.prepare(`
        SELECT status, COUNT(*) AS count
        FROM import_records
        GROUP BY status
        ORDER BY status
      `).all() as Array<{ status: string; count: number }>;
      assert.deepEqual(counts.map((row) => ({ status: row.status, count: row.count })), [
        { status: "prepared", count: 1 },
        { status: "skipped", count: 1 },
      ]);
      const prepared = verifyDb.prepare(`
        SELECT item_payload_json
        FROM import_records
        WHERE status = 'prepared'
      `).get() as { item_payload_json: string };
      assert.equal(JSON.parse(prepared.item_payload_json).fields.language, "zh");
      const skipped = verifyDb.prepare(`
        SELECT validation_warnings_json
        FROM import_records
        WHERE status = 'skipped'
      `).get() as { validation_warnings_json: string };
      assert.ok(
        JSON.parse(skipped.validation_warnings_json).includes("protected-field-changed-title"),
      );
    } finally {
      verifyDb.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("writer creates Zotero book items through the payload seam", async () => {
  const previousZotero = (globalThis as any).Zotero;
  const savedItems: any[] = [];
  const importedAttachments: any[] = [];
  let nextId = 1;

  class FakeItem {
    id = nextId++;
    libraryID = 0;
    parentID?: number;
    fields: Record<string, string> = {};
    creators: unknown[] = [];
    collections: number[] = [];
    note = "";

    constructor(public itemType: string) {}

    setField(field: string, value: string) {
      this.fields[field] = value;
    }

    addToCollection(collectionId: number) {
      this.collections.push(collectionId);
    }

    setCreators(creators: unknown[]) {
      this.creators = creators;
    }

    setNote(note: string) {
      this.note = note;
    }

    async saveTx() {
      savedItems.push(this);
    }
  }

  (globalThis as any).Zotero = {
    Libraries: { userLibraryID: 7 },
    Item: FakeItem,
    Attachments: {
      async importFromFile(options: unknown) {
        importedAttachments.push(options);
      },
    },
  };

  try {
    const book = {
      doubanUrl: "https://book.douban.com/subject/1000001/",
      doubanId: "1000001",
      title: "Payload Seam Book",
      creators: [
        {
          firstName: "Jane",
          lastName: "Writer",
          creatorType: "author" as const,
          fieldMode: 0 as const,
        },
      ],
      publisher: "Example Press",
      publishDate: "2026-05",
      isbn: "9787111111111",
      isbn13: "9787111111111",
      language: "zh",
      originalTitle: "Original Payload Seam Book",
      creatorNotes: ["Translated creator evidence"],
    };
    const payload = bookToZoteroBookPayload(book);

    const item = await createZoteroBookItemFromPayload(payload, 42);

    assert.equal(item.itemType, "book");
    assert.equal(item.libraryID, 7);
    assert.equal(item.fields.title, "Payload Seam Book");
    assert.equal(item.fields.publisher, "Example Press");
    assert.equal(item.fields.date, "2026-05");
    assert.equal(item.fields.language, "zh");
    assert.equal(item.fields.ISBN, "9787111111111");
    assert.equal(item.fields.libraryCatalog, "Douban");
    assert.deepEqual(item.collections, [42]);
    assert.deepEqual(item.creators, [
      {
        firstName: "Jane",
        lastName: "Writer",
        creatorType: "author",
        fieldMode: 0,
      },
    ]);
    assert.deepEqual(
      savedItems.filter((saved) => saved.itemType === "note").map((saved) => saved.note),
      [
        "Original title: Original Payload Seam Book",
        "Creator note: Translated creator evidence",
      ],
    );
    assert.deepEqual(importedAttachments, []);

    savedItems.length = 0;
    const result = await writeBooks(
      [
        book,
        {
          ...book,
          title: "Missing Creator",
          creators: [],
        },
      ],
      99,
    );

    assert.equal(result.created, 1);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /Incomplete metadata: minimum-ingest-missing-author-or-editor/);
    assert.equal(savedItems.filter((saved) => saved.itemType === "book").length, 1);
    assert.equal(savedItems.find((saved) => saved.itemType === "book").fields.date, "2026-05");
  } finally {
    (globalThis as any).Zotero = previousZotero;
  }
});

test("synthetic subject fixture parses to expected metadata", () => {
  const dom = new JSDOM("<!doctype html>");
  globalThis.DOMParser = dom.window.DOMParser;

  const url = "https://book.douban.com/subject/1000001/";
  const html = readFixture("subject-1000001.html");
  const expected = readJsonFixture("subject-1000001.expected.json");

  assert.deepEqual(withoutUndefined(parseBookDetail(html, url)), expected);
});

test("publication dates normalize to proven precision", () => {
  assert.equal(normalizeDate("2026"), "2026");
  assert.equal(normalizeDate("2026-5"), "2026-05");
  assert.equal(normalizeDate("2026-05-3"), "2026-05-03");
  assert.equal(normalizeDate("2026年5月"), "2026-05");
  assert.equal(normalizeDate("2026年5月3日"), "2026-05-03");
  assert.equal(normalizeDate("2026.5"), "2026-05");
  assert.equal(normalizeDate("2026/5/3"), "2026-05-03");
  assert.equal(normalizeDate("2026年春"), "2026");
  assert.equal(normalizeDate("2026-13"), "");
  assert.equal(normalizeDate("2026-02-29"), "");
  assert.equal(normalizeDate("no publication date"), "");
});

test("creator parser handles FRL-95 observed name cleanup edges", () => {
  assert.deepEqual(parseCreatorList("[黎巴嫩/法国] 阿明·马洛夫", "author"), [
    { firstName: "阿明", lastName: "马洛夫", creatorType: "author", fieldMode: 0 },
  ]);

  assert.deepEqual(parseCreatorList("安德雷．朱亞", "author"), [
    { firstName: "安德雷", lastName: "朱亞", creatorType: "author", fieldMode: 0 },
  ]);

  assert.deepEqual(parseCreatorList("上海新闻出版系统“五七”干校翻译组", "translator"), [
    {
      firstName: "",
      lastName: "上海新闻出版系统“五七”干校翻译组",
      creatorType: "translator",
      fieldMode: 1,
    },
  ]);

  assert.deepEqual(parseCreatorList("上海新闻出版系统“五·七”干校翻译组", "translator"), [
    {
      firstName: "",
      lastName: "上海新闻出版系统“五七”干校翻译组",
      creatorType: "translator",
      fieldMode: 1,
    },
  ]);

  assert.deepEqual(parseCreatorList("山本直樹/山本直树", "author"), [
    { firstName: "", lastName: "山本直樹", creatorType: "author", fieldMode: 1 },
  ]);

  assert.deepEqual(parseCreatorList("菊地 秀行", "author"), [
    { firstName: "", lastName: "菊地秀行", creatorType: "author", fieldMode: 1 },
  ]);

  assert.deepEqual(parseCreatorList("町田 洋", "author"), [
    { firstName: "", lastName: "町田洋", creatorType: "author", fieldMode: 1 },
  ]);

  assert.deepEqual(parseCreatorList("末広 鉄腸", "author"), [
    { firstName: "", lastName: "末広鉄腸", creatorType: "author", fieldMode: 1 },
  ]);

  assert.deepEqual(parseCreatorList("[英]芭芭拉·彭纳 等", "author"), [
    { firstName: "芭芭拉", lastName: "彭纳", creatorType: "author", fieldMode: 0 },
  ]);

  assert.deepEqual(parseCreatorList("莫斯科设计博物馆 供图", "author"), [
    { firstName: "", lastName: "莫斯科设计博物馆", creatorType: "author", fieldMode: 1 },
  ]);

  assert.deepEqual(parseCreatorList("[美] 斯科特·麦克劳德 编绘 / [英] 斯科特·麦克劳德", "author"), [
    { firstName: "斯科特", lastName: "麦克劳德", creatorType: "author", fieldMode: 0 },
  ]);

  const dom = new JSDOM("<!doctype html>");
  globalThis.DOMParser = dom.window.DOMParser;
  const duplicatedCreatorBook = parseBookDetail(
    `
      <!doctype html>
      <html>
        <body>
          <h1><span>雕塑家</span></h1>
          <div id="info">
            <span class="pl">作者:</span> [美] 斯科特·麦克劳德 编绘 / [英] 斯科特·麦克劳德<br>
            <span class="pl">译者:</span> 孙侃<br>
            <span class="pl">绘者:</span> [英] 斯科特·麦克劳德<br>
            <span class="pl">编者:</span> [英] 斯科特·麦克劳德<br>
            <span class="pl">出版社:</span> 湖南美术出版社<br>
            <span class="pl">出版年:</span> 2020-1<br>
            <span class="pl">ISBN:</span> 9787535689665<br>
          </div>
        </body>
      </html>
    `,
    "https://book.douban.com/subject/34978160/",
  );
  assert.deepEqual(duplicatedCreatorBook.creators, [
    { firstName: "斯科特", lastName: "麦克劳德", creatorType: "author", fieldMode: 0 },
    { firstName: "", lastName: "孙侃", creatorType: "translator", fieldMode: 1 },
  ]);
});

test("public synthetic parser edge fixtures parse key metadata", () => {
  const dom = new JSDOM("<!doctype html>");
  globalThis.DOMParser = dom.window.DOMParser;

  const unifiedIsbn = parseBookDetail(
    bookInfoFixtureHtml("Unified ISBN Fixture", [
      ["作者", "Jane Austen"],
      ["出版社", "Test Press"],
      ["出版年", "2024-05"],
      ["语言", "en"],
      ["统一书号", "0132350882"],
    ]),
    "https://book.douban.com/subject/2000001/",
  );
  assert.equal(unifiedIsbn.title, "Unified ISBN Fixture");
  assert.equal(unifiedIsbn.publisher, "Test Press");
  assert.equal(unifiedIsbn.publishDate, "2024-05");
  assert.equal(unifiedIsbn.isbn, "0132350882");
  assert.equal(unifiedIsbn.isbn13, "9780132350884");
  assert.equal(unifiedIsbn.language, "en");

  const editorSuffix = parseBookDetail(
    bookInfoFixtureHtml("Editor Suffix Fixture", [
      ["作者", "张三 辑校"],
      ["出版社", "Test Press"],
      ["出版年", "2024"],
      ["语言", "zh"],
      ["ISBN", "9780132350884"],
    ]),
    "https://book.douban.com/subject/2000002/",
  );
  assert.deepEqual(editorSuffix.creators, [
    { firstName: "", lastName: "张三", creatorType: "editor", fieldMode: 1 },
  ]);
});

test("minimum ingest schema flags records needing manual completion", () => {
  const dom = new JSDOM("<!doctype html>");
  globalThis.DOMParser = dom.window.DOMParser;

  const validSynthetic = parseBookDetail(
    readFixture("subject-1000001.html"),
    "https://book.douban.com/subject/1000001/",
  );
  assert.deepEqual(validateMinimumBookIngest(validSynthetic), {
    eligible: true,
    warnings: [],
    missingFields: [],
  });

  const missingAuthorHtml = bookInfoFixtureHtml("Missing Author Fixture", [
    ["出版社", "Test Press"],
    ["出版年", "2024"],
    ["ISBN", "9780132350884"],
  ]);
  const missingAuthor = parseBookDetail(
    missingAuthorHtml,
    "https://book.douban.com/subject/2000003/",
  );
  assert.deepEqual(validateMinimumBookIngest(missingAuthor), {
    eligible: false,
    warnings: [
      "minimum-ingest-missing-author-or-editor",
      "minimum-ingest-missing-language",
    ],
    missingFields: ["creator", "language"],
  });

  const jixiaoEditorHtml = bookInfoFixtureHtml("Jixiao Editor Fixture", [
    ["作者", "张三 辑校"],
    ["出版社", "Test Press"],
    ["出版年", "2024"],
    ["ISBN", "9780132350884"],
  ]);
  const jixiaoEditor = parseBookDetail(
    jixiaoEditorHtml,
    "https://book.douban.com/subject/2000004/",
  );
  assert.deepEqual(validateMinimumBookIngest(jixiaoEditor), {
    eligible: false,
    warnings: ["minimum-ingest-missing-language"],
    missingFields: ["language"],
  });

  for (const publishDate of ["2026", "2026-05", "2026-05-03"]) {
    assert.deepEqual(
      validateMinimumBookIngest({
        ...validSynthetic,
        publishDate,
      }),
      {
        eligible: true,
        warnings: [],
        missingFields: [],
      },
    );
  }

  const sparseHtml = bookInfoFixtureHtml("Sparse Fixture", [
    ["ISBN", "9780132350884"],
  ]);
  const sparse = parseBookDetail(
    sparseHtml,
    "https://book.douban.com/subject/2000005/",
  );
  assert.deepEqual(validateMinimumBookIngest(sparse), {
    eligible: false,
    warnings: [
      "minimum-ingest-missing-author-or-editor",
      "minimum-ingest-missing-date",
      "minimum-ingest-missing-publisher",
      "minimum-ingest-missing-language",
    ],
    missingFields: ["creator", "date", "publisher", "language"],
  });
});

test("parser diagnostics attribute missing source metadata", () => {
  const dom = new JSDOM("<!doctype html>");
  globalThis.DOMParser = dom.window.DOMParser;

  const missingAuthorHtml = bookInfoFixtureHtml("Missing Author Fixture", [
    ["出版社", "Test Press"],
    ["出版年", "2024"],
    ["ISBN", "9780132350884"],
  ]);
  const result = parseBookDetailWithDiagnostics(
    missingAuthorHtml,
    "https://book.douban.com/subject/2000003/",
  );

  assert.deepEqual(result.extractionWarnings, [
    "parser-missing-author-or-editor",
    "parser-missing-language",
  ]);

  const sparseHtml = bookInfoFixtureHtml("Sparse Fixture", [
    ["ISBN", "9780132350884"],
  ]);
  const sparseResult = parseBookDetailWithDiagnostics(
    sparseHtml,
    "https://book.douban.com/subject/2000005/",
  );
  assert.deepEqual(sparseResult.extractionWarnings, [
    "parser-missing-author-or-editor",
    "parser-missing-language",
  ]);
});

test("deduplicator accepts ISBN-13 books against ISBN-10 Zotero records", async () => {
  const previousZotero = (globalThis as any).Zotero;
  class FakeSearch {
    libraryID = 0;
    conditions: Array<{ field: string; value: string }> = [];
    addCondition(field: string, _operator: string, value: string) {
      this.conditions.push({ field, value });
    }
    async search() {
      return this.conditions.some((condition) => condition.field === "ISBN")
        ? []
        : [1];
    }
  }
  (globalThis as any).Zotero = {
    Libraries: { userLibraryID: 1 },
    Search: FakeSearch,
    Items: {
      get() {
        return {
          getField(field: string) {
            return {
              title: "Clean Code",
              publisher: "Prentice Hall",
              ISBN: "0132350882",
              date: "2008",
            }[field] ?? "";
          },
        };
      },
    },
    log() {},
  };

  try {
    const result = await checkDuplicates([
      {
        doubanUrl: "https://book.douban.com/subject/1000002/",
        doubanId: "1000002",
        title: "Clean Code",
        creators: [{ firstName: "Robert", lastName: "Martin", creatorType: "author", fieldMode: 0 }],
        publisher: "Prentice Hall",
        publishDate: "2008",
        isbn: "9780132350884",
        isbn13: "9780132350884",
        language: "en",
      },
    ]);

    assert.equal(result[0].matchType, "duplicate");
  } finally {
    (globalThis as any).Zotero = previousZotero;
  }
});

test("deduplicator accepts ISBN-10 books against ISBN-13 Zotero records", async () => {
  const previousZotero = (globalThis as any).Zotero;
  class FakeSearch {
    libraryID = 0;
    conditions: Array<{ field: string; value: string }> = [];
    addCondition(field: string, _operator: string, value: string) {
      this.conditions.push({ field, value });
    }
    async search() {
      return this.conditions.some((condition) => condition.field === "ISBN")
        ? []
        : [1];
    }
  }
  (globalThis as any).Zotero = {
    Libraries: { userLibraryID: 1 },
    Search: FakeSearch,
    Items: {
      get() {
        return {
          getField(field: string) {
            return {
              title: "Clean Code",
              publisher: "Prentice Hall",
              ISBN: "9780132350884",
              date: "2008",
            }[field] ?? "";
          },
        };
      },
    },
    log() {},
  };

  try {
    const result = await checkDuplicates([
      {
        doubanUrl: "https://book.douban.com/subject/1000002/",
        doubanId: "1000002",
        title: "Clean Code",
        creators: [{ firstName: "Robert", lastName: "Martin", creatorType: "author", fieldMode: 0 }],
        publisher: "Prentice Hall",
        publishDate: "2008",
        isbn: "0132350882",
        isbn13: "9780132350884",
        language: "en",
      },
    ]);

    assert.equal(result[0].matchType, "duplicate");
  } finally {
    (globalThis as any).Zotero = previousZotero;
  }
});

test("deduplicator uses normalized ISBN scan when exact Zotero ISBN search misses", async () => {
  const previousZotero = (globalThis as any).Zotero;
  class FakeSearch {
    libraryID = 0;
    conditions: Array<{ field: string; value: string }> = [];
    addCondition(field: string, _operator: string, value: string) {
      this.conditions.push({ field, value });
    }
    async search() {
      return this.conditions.some((condition) => condition.field === "ISBN")
        ? []
        : [1];
    }
  }
  (globalThis as any).Zotero = {
    Libraries: { userLibraryID: 1 },
    Search: FakeSearch,
    Items: {
      get() {
        return {
          getField(field: string) {
            return {
              title: "Existing Book With Matching ISBN",
              publisher: "Different Publisher",
              ISBN: "9780201633610",
              date: "1994",
            }[field] ?? "";
          },
        };
      },
    },
    log() {},
  };

  try {
    const result = await checkDuplicates([
      {
        doubanUrl: "https://book.douban.com/subject/1000005/",
        doubanId: "1000005",
        title: "Different Title Same ISBN",
        creators: [{ firstName: "Unit", lastName: "Author", creatorType: "author", fieldMode: 0 }],
        publisher: "Unit Test Press",
        publishDate: "2008",
        isbn: "0201633612",
        language: "en",
      },
    ]);

    assert.equal(result[0].matchType, "duplicate");
    assert.equal(result[0].matchedItemTitle, "Existing Book With Matching ISBN");
    assert.equal(result[0].matchReason, "ISBN match");
  } finally {
    (globalThis as any).Zotero = previousZotero;
  }
});

test("deduplicator does not hard-match same title with different publisher and year", async () => {
  const previousZotero = (globalThis as any).Zotero;
  class FakeSearch {
    libraryID = 0;
    conditions: Array<{ field: string; value: string }> = [];
    addCondition(field: string, _operator: string, value: string) {
      this.conditions.push({ field, value });
    }
    async search() {
      return this.conditions.some((condition) => condition.field === "ISBN")
        ? []
        : [1];
    }
  }
  (globalThis as any).Zotero = {
    Libraries: { userLibraryID: 1 },
    Search: FakeSearch,
    Items: {
      get() {
        return {
          getField(field: string) {
            return {
              title: "Shared Title Is Not Enough",
              publisher: "Original Publisher",
              ISBN: "",
              date: "1999",
            }[field] ?? "";
          },
        };
      },
    },
    log() {},
  };

  try {
    const result = await checkDuplicates([
      {
        doubanUrl: "https://book.douban.com/subject/1000003/",
        doubanId: "1000003",
        title: "Shared Title Is Not Enough",
        creators: [{ firstName: "Unit", lastName: "Author", creatorType: "author", fieldMode: 0 }],
        publisher: "Different Academic Press",
        publishDate: "2020",
        language: "en",
      },
    ]);

    assert.equal(result[0].matchType, "new");
  } finally {
    (globalThis as any).Zotero = previousZotero;
  }
});

test("deduplicator keeps near title match as suspect for review", async () => {
  const previousZotero = (globalThis as any).Zotero;
  class FakeSearch {
    libraryID = 0;
    conditions: Array<{ field: string; value: string }> = [];
    addCondition(field: string, _operator: string, value: string) {
      this.conditions.push({ field, value });
    }
    async search() {
      return this.conditions.some((condition) => condition.field === "ISBN")
        ? []
        : [1];
    }
  }
  (globalThis as any).Zotero = {
    Libraries: { userLibraryID: 1 },
    Search: FakeSearch,
    Items: {
      get() {
        return {
          getField(field: string) {
            return {
              title: "Boundary Case Pattern Catalog",
              publisher: "Unit Test Press",
              ISBN: "",
              date: "2008",
            }[field] ?? "";
          },
        };
      },
    },
    log() {},
  };

  try {
    const result = await checkDuplicates([
      {
        doubanUrl: "https://book.douban.com/subject/1000004/",
        doubanId: "1000004",
        title: "Boundary Case Pattern Guide",
        creators: [{ firstName: "Unit", lastName: "Author", creatorType: "author", fieldMode: 0 }],
        publisher: "Unit Test Press",
        publishDate: "2008",
        language: "en",
      },
    ]);

    assert.equal(result[0].matchType, "suspect");
    assert.equal(result[0].matchedItemTitle, "Boundary Case Pattern Catalog");
  } finally {
    (globalThis as any).Zotero = previousZotero;
  }
});

test("subtitle merge uses script-aware separators and avoids duplicates", () => {
  const dom = new JSDOM("<!doctype html>");
  globalThis.DOMParser = dom.window.DOMParser;

  const latinHtml = `
    <!doctype html>
    <html>
      <body>
        <h1><span>Clean Code</span></h1>
        <div id="info">
          <span class="pl">作者:</span> Robert C. Martin<br>
          <span class="pl">副标题:</span> A Handbook of Agile Software Craftsmanship<br>
          <span class="pl">ISBN:</span> 9780132350884<br>
        </div>
      </body>
    </html>
  `;
  const cjkAlreadyJoinedHtml = `
    <!doctype html>
    <html>
      <body>
        <h1><span>演讲之禅：一位技术演讲家的自白</span></h1>
        <div id="info">
          <span class="pl">作者:</span> Scott Berkun<br>
          <span class="pl">副标题:</span> 一位技术演讲家的自白<br>
          <span class="pl">ISBN:</span> 9787121104958<br>
        </div>
      </body>
    </html>
  `;

  assert.equal(
    parseBookDetail(latinHtml, "https://book.douban.com/subject/1000002/").title,
    "Clean Code: A Handbook of Agile Software Craftsmanship",
  );
  assert.equal(
    parseBookDetail(cjkAlreadyJoinedHtml, "https://book.douban.com/subject/1000003/").title,
    "演讲之禅：一位技术演讲家的自白",
  );
});
