import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { JSDOM } from "jsdom";

interface StudyPlan {
  schemaVersion: number;
  name: string;
  executionMode: string;
  remoteFetchAllowed: boolean;
  allowedHostnames: string[];
  itemsPerPage: number;
  limits: {
    maxPeople: number;
    maxListPagesPerPerson: number;
    targetSubjectPages: number;
    maxRequestsPerRun: number;
    minDelayMs: number;
    maxDelayMs: number;
    retryCount: number;
  };
  people: Array<{
    id: string;
    wishUrl: string;
  }>;
}

interface CliOptions {
  planPath: string;
  outRoot: string;
  count: number;
  maxListPagesPerPerson?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
  seed?: string;
  confirmedLive: boolean;
}

interface RequestLogEntry {
  index: number;
  kind: "wishlist-page" | "subject-page";
  url: string;
  startedAt: string;
  finishedAt?: string;
  ok: boolean;
  status?: number;
  bytes?: number;
  sha256?: string;
  savedTo?: string;
  error?: string;
  context?: Record<string, unknown>;
}

interface LinkSource {
  personId: string;
  wishlistUrl: string;
  listPageUrl: string;
  pageIndex: number;
  positionInPage: number;
  title: string;
}

interface SubjectCandidate {
  url: string;
  subjectId: string;
  title: string;
  sources: LinkSource[];
}

interface CapturedWishlistPage {
  personId: string;
  wishUrl: string;
  pageIndex: number;
  sourceUrl: string;
  file: string;
  sha256: string;
  linkCount: number;
}

interface CapturedSubjectPage {
  subjectId: string;
  sourceUrl: string;
  file: string;
  sha256: string;
  title: string;
  selectedBy: {
    method: string;
    seed: string;
    rank: number;
  };
  sources: LinkSource[];
}

const rootDir = resolve(import.meta.dirname, "..", "..");
const defaultPlanPath = join(
  rootDir,
  "fixtures",
  "douban",
  "live-capture-studies",
  "structure-study-six-readlists.json",
);
const defaultOutRoot = join(rootDir, "fixtures", "douban", "captured");
const requestLog: RequestLogEntry[] = [];

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    planPath: defaultPlanPath,
    outRoot: defaultOutRoot,
    count: 10,
    confirmedLive: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--plan") options.planPath = resolve(rootDir, argv[++i]);
    else if (arg === "--out-dir") options.outRoot = resolve(rootDir, argv[++i]);
    else if (arg === "--count") options.count = Number(argv[++i]);
    else if (arg === "--max-list-pages-per-person") options.maxListPagesPerPerson = Number(argv[++i]);
    else if (arg === "--min-delay-ms") options.minDelayMs = Number(argv[++i]);
    else if (arg === "--max-delay-ms") options.maxDelayMs = Number(argv[++i]);
    else if (arg === "--seed") options.seed = argv[++i];
    else if (arg === "--confirm-live") options.confirmedLive = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function formatRunSuffix(isoTimestamp: string): string {
  return isoTimestamp.replace(/[-:.TZ]/g, "").slice(0, 14);
}

function relativePath(path: string): string {
  return relative(rootDir, path).replace(/\\/g, "/");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function randomDelay(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function assertDoubanHost(url: string): URL {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== "book.douban.com") {
    throw new Error(`Rejected non-Douban URL: ${url}`);
  }
  return parsed;
}

function assertWishlistUrl(url: string): URL {
  const parsed = assertDoubanHost(url);
  if (!/^\/people\/[^/]+\/wish$/.test(parsed.pathname)) {
    throw new Error(`Expected Douban wish-list URL: ${url}`);
  }
  if (parsed.hash) parsed.hash = "";
  return parsed;
}

function normalizeSubjectUrl(rawUrl: string, baseUrl: string): { url: string; subjectId: string } | null {
  const parsed = new URL(rawUrl, baseUrl);
  if (parsed.protocol !== "https:" || parsed.hostname !== "book.douban.com") return null;
  const match = parsed.pathname.match(/^\/subject\/(\d+)\/?$/);
  if (!match) return null;
  parsed.pathname = `/subject/${match[1]}/`;
  parsed.search = "";
  parsed.hash = "";
  return { url: parsed.toString(), subjectId: match[1] };
}

function pageUrl(wishlistUrl: string, pageIndex: number, itemsPerPage: number): string {
  const parsed = assertWishlistUrl(wishlistUrl);
  parsed.searchParams.set("start", String(pageIndex * itemsPerPage));
  parsed.hash = "";
  return parsed.toString();
}

function safeFilePart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

function ensureStudyPlan(plan: StudyPlan): void {
  if (plan.schemaVersion !== 1) throw new Error("Unsupported structure-study plan schema");
  if (plan.executionMode !== "live") throw new Error("Structure-study plan must declare executionMode=live");
  if (plan.remoteFetchAllowed !== true) throw new Error("Structure-study plan must explicitly allow remote fetch");
  if (!plan.allowedHostnames.includes("book.douban.com")) {
    throw new Error("Structure-study plan must allow book.douban.com");
  }
  if (plan.people.length !== plan.limits.maxPeople) {
    throw new Error("Structure-study people count must match maxPeople");
  }
  for (const person of plan.people) {
    const parsed = assertWishlistUrl(person.wishUrl);
    const id = decodeURIComponent(parsed.pathname.split("/")[2]);
    if (id !== person.id) throw new Error(`Plan person ID does not match URL: ${person.id}`);
  }
}

function readStudyPlan(path: string): StudyPlan {
  if (!existsSync(path)) throw new Error(`Structure-study plan not found: ${path}`);
  const plan = JSON.parse(readFileSync(path, "utf-8")) as StudyPlan;
  ensureStudyPlan(plan);
  return plan;
}

function isChallengeHtml(html: string): boolean {
  const lower = html.toLowerCase();
  return (
    lower.includes("sec.douban.com") ||
    lower.includes("captcha") ||
    html.includes("检测到有异常请求") ||
    html.includes("访问受限")
  );
}

async function fetchHtml(
  url: string,
  kind: RequestLogEntry["kind"],
  minDelayMs: number,
  maxDelayMs: number,
  context?: Record<string, unknown>,
): Promise<{ html: string; entry: RequestLogEntry }> {
  assertDoubanHost(url);
  await sleep(randomDelay(minDelayMs, maxDelayMs));

  const entry: RequestLogEntry = {
    index: requestLog.length + 1,
    kind,
    url,
    startedAt: new Date().toISOString(),
    ok: false,
    context,
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
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const html = await response.text();
    entry.bytes = Buffer.byteLength(html, "utf-8");
    entry.sha256 = sha256(html);
    if (isChallengeHtml(html)) throw new Error("Douban challenge page detected");

    entry.ok = true;
    entry.finishedAt = new Date().toISOString();
    return { html, entry };
  } catch (e: any) {
    entry.finishedAt = new Date().toISOString();
    entry.error = e.message || String(e);
    throw e;
  }
}

function extractSubjectLinks(html: string, source: Omit<LinkSource, "positionInPage" | "title">): SubjectCandidate[] {
  const dom = new JSDOM(html);
  const byUrl = new Map<string, SubjectCandidate>();

  for (const anchor of Array.from(dom.window.document.querySelectorAll("a[href]"))) {
    const href = anchor.getAttribute("href");
    if (!href) continue;
    const normalized = normalizeSubjectUrl(href, source.listPageUrl);
    if (!normalized) continue;

    const title =
      anchor.getAttribute("title") ||
      anchor.textContent?.replace(/\s+/g, " ").trim() ||
      "";
    const existing = byUrl.get(normalized.url);
    if (existing) {
      if (!existing.title && title) existing.title = title;
      continue;
    }

    byUrl.set(normalized.url, {
      url: normalized.url,
      subjectId: normalized.subjectId,
      title,
      sources: [
        {
          ...source,
          positionInPage: byUrl.size + 1,
          title,
        },
      ],
    });
  }

  return Array.from(byUrl.values());
}

function mergeCandidate(target: Map<string, SubjectCandidate>, candidate: SubjectCandidate): void {
  const existing = target.get(candidate.url);
  if (!existing) {
    target.set(candidate.url, candidate);
    return;
  }
  if (!existing.title && candidate.title) existing.title = candidate.title;
  existing.sources.push(...candidate.sources);
}

function selectSubjects(candidates: SubjectCandidate[], count: number, seed: string): SubjectCandidate[] {
  return [...candidates]
    .sort((a, b) => sha256(`${seed}\0${a.url}`).localeCompare(sha256(`${seed}\0${b.url}`)))
    .slice(0, count);
}

async function run() {
  if (process.env.DOUBAN_TO_ZOTERO_EXECUTION_MODE !== "live") {
    throw new Error("Structure-study capture requires DOUBAN_TO_ZOTERO_EXECUTION_MODE=live");
  }

  const options = parseArgs(process.argv.slice(2));
  if (!options.confirmedLive) throw new Error("Structure-study capture requires --confirm-live");
  if (!Number.isInteger(options.count) || options.count < 1) throw new Error("--count must be a positive integer");

  const plan = readStudyPlan(options.planPath);
  const maxListPagesPerPerson = options.maxListPagesPerPerson ?? plan.limits.maxListPagesPerPerson;
  const minDelayMs = options.minDelayMs ?? plan.limits.minDelayMs;
  const maxDelayMs = options.maxDelayMs ?? plan.limits.maxDelayMs;
  if (maxListPagesPerPerson < 1 || maxListPagesPerPerson > plan.limits.maxListPagesPerPerson) {
    throw new Error(`--max-list-pages-per-person must be between 1 and ${plan.limits.maxListPagesPerPerson}`);
  }
  if (options.count > plan.limits.targetSubjectPages) {
    throw new Error(`--count must not exceed plan targetSubjectPages (${plan.limits.targetSubjectPages})`);
  }
  if (minDelayMs < 1000 || maxDelayMs < minDelayMs) {
    throw new Error("--min-delay-ms must be at least 1000 and --max-delay-ms must be greater or equal");
  }

  const startedAt = new Date().toISOString();
  const runSuffix = formatRunSuffix(startedAt);
  const seed = options.seed ?? runSuffix;
  const outDir = join(options.outRoot, `structure-study-${runSuffix}`);
  const wishlistDir = join(outDir, "wishlists");
  const subjectDir = join(outDir, "subjects");
  mkdirSync(wishlistDir, { recursive: true });
  mkdirSync(subjectDir, { recursive: true });

  const candidatesByUrl = new Map<string, SubjectCandidate>();
  const capturedWishlistPages: CapturedWishlistPage[] = [];
  const capturedSubjectPages: CapturedSubjectPage[] = [];
  const requestLogPath = join(outDir, "request-log.json");
  const manifestPath = join(outDir, "manifest.json");

  try {
    for (const person of plan.people) {
      for (let pageIndex = 0; pageIndex < maxListPagesPerPerson; pageIndex++) {
        const sourceUrl = pageUrl(person.wishUrl, pageIndex, plan.itemsPerPage);
        const { html, entry } = await fetchHtml(sourceUrl, "wishlist-page", minDelayMs, maxDelayMs, {
          personId: person.id,
          pageIndex,
        });
        const file = join(wishlistDir, `${safeFilePart(person.id)}-page-${pageIndex + 1}.html`);
        writeFileSync(file, html);
        entry.savedTo = relativePath(file);

        const links = extractSubjectLinks(html, {
          personId: person.id,
          wishlistUrl: person.wishUrl,
          listPageUrl: sourceUrl,
          pageIndex,
        });
        for (const link of links) mergeCandidate(candidatesByUrl, link);

        capturedWishlistPages.push({
          personId: person.id,
          wishUrl: person.wishUrl,
          pageIndex,
          sourceUrl,
          file: relativePath(file),
          sha256: sha256(html),
          linkCount: links.length,
        });
      }
    }

    const candidates = Array.from(candidatesByUrl.values());
    if (candidates.length < options.count) {
      throw new Error(`Only ${candidates.length} unique subject candidates found; requested ${options.count}`);
    }

    const selected = selectSubjects(candidates, options.count, seed);
    for (const [index, candidate] of selected.entries()) {
      const { html, entry } = await fetchHtml(candidate.url, "subject-page", minDelayMs, maxDelayMs, {
        subjectId: candidate.subjectId,
        selectedRank: index + 1,
      });
      const file = join(subjectDir, `${candidate.subjectId}.html`);
      writeFileSync(file, html);
      entry.savedTo = relativePath(file);

      capturedSubjectPages.push({
        subjectId: candidate.subjectId,
        sourceUrl: candidate.url,
        file: relativePath(file),
        sha256: sha256(html),
        title: candidate.title,
        selectedBy: {
          method: "sha256(seed + subjectUrl) ascending",
          seed,
          rank: index + 1,
        },
        sources: candidate.sources,
      });
    }

    const completedAt = new Date().toISOString();
    const manifest = {
      schemaVersion: 1,
      kind: "douban-structure-study-http-snapshot",
      executionMode: "live",
      remoteFetchAllowed: true,
      referenceSampleStatus: "noncanonical-http-snapshot",
      sourcePlan: relativePath(options.planPath),
      capturedAt: startedAt,
      completedAt,
      outputRoot: relativePath(outDir),
      selection: {
        method: "sha256(seed + subjectUrl) ascending",
        seed,
        requestedSubjectPages: options.count,
        candidateSubjectPages: candidates.length,
        selectedSubjectPages: capturedSubjectPages.length,
        maxListPagesPerPerson,
      },
      requestPolicy: {
        allowedHostnames: plan.allowedHostnames,
        minDelayMs,
        maxDelayMs,
        retryCount: plan.limits.retryCount,
        maxRequestsPerRun: plan.limits.maxRequestsPerRun,
      },
      requestCount: requestLog.length,
      requestLog: relativePath(requestLogPath),
      wishlistPages: capturedWishlistPages,
      subjectPages: capturedSubjectPages,
      notes: [
        "Captured by explicit live structure-study helper as a URL-sampling audit aid.",
        "Do not treat script-saved HTML as the canonical reference corpus.",
        "For metadata-field analysis, save selected subject pages manually from a browser with a Save Page As style workflow.",
        "Do not treat these pages as dry-run golden fixtures until browser-saved HTML and expected metadata are reviewed.",
      ],
    };

    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(requestLogPath, `${JSON.stringify(requestLog, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({
      executionMode: "live",
      outputRoot: relativePath(outDir),
      manifest: relativePath(manifestPath),
      requestLog: relativePath(requestLogPath),
      wishlistPages: capturedWishlistPages.length,
      candidateSubjectPages: candidates.length,
      subjectPages: capturedSubjectPages.length,
      networkRequests: requestLog.length,
      seed,
    }, null, 2)}\n`);
  } catch (e) {
    const failedManifest = {
      schemaVersion: 1,
      kind: "douban-structure-study-http-snapshot",
      executionMode: "live",
      referenceSampleStatus: "noncanonical-http-snapshot",
      status: "failed",
      sourcePlan: relativePath(options.planPath),
      capturedAt: startedAt,
      failedAt: new Date().toISOString(),
      outputRoot: relativePath(outDir),
      requestCount: requestLog.length,
      requestLog: relativePath(requestLogPath),
      wishlistPages: capturedWishlistPages,
      subjectPages: capturedSubjectPages,
      error: e instanceof Error ? e.message : String(e),
    };
    writeFileSync(manifestPath, `${JSON.stringify(failedManifest, null, 2)}\n`);
    writeFileSync(requestLogPath, `${JSON.stringify(requestLog, null, 2)}\n`);
    throw e;
  }
}

run();
