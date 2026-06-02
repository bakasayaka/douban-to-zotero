import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { JSDOM } from "jsdom";

const rootDir = resolve(import.meta.dirname, "..");
const defaultPlanPath = join(
  rootDir,
  "fixtures",
  "douban",
  "live-capture-studies",
  "readlist-pagination-reference-expansion.json",
);
const defaultOutRoot = join(rootDir, "fixtures", "douban", "captured");
const referenceSamplesRoot = join(rootDir, "fixtures", "douban", "reference-samples");
const requestLog = [];

function parseArgs(argv) {
  const options = {
    planPath: defaultPlanPath,
    outRoot: defaultOutRoot,
    count: null,
    seed: null,
    minDelayMs: null,
    maxDelayMs: null,
    confirmLive: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--plan") options.planPath = resolve(rootDir, argv[++i]);
    else if (arg === "--out-dir") options.outRoot = resolve(rootDir, argv[++i]);
    else if (arg === "--count") options.count = Number(argv[++i]);
    else if (arg === "--seed") options.seed = argv[++i];
    else if (arg === "--min-delay-ms") options.minDelayMs = Number(argv[++i]);
    else if (arg === "--max-delay-ms") options.maxDelayMs = Number(argv[++i]);
    else if (arg === "--confirm-live") options.confirmLive = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function formatRunSuffix(isoTimestamp) {
  return isoTimestamp.replace(/[-:.TZ]/g, "").slice(0, 14);
}

function relativePath(path) {
  return relative(rootDir, path).replace(/\\/g, "/");
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function assertDoubanHost(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== "book.douban.com") {
    throw new Error(`Rejected non-Douban URL: ${url}`);
  }
  return parsed;
}

function assertWishlistUrl(url) {
  const parsed = assertDoubanHost(url);
  if (!/^\/people\/[^/]+\/wish$/.test(parsed.pathname)) {
    throw new Error(`Expected Douban wish-list URL: ${url}`);
  }
  parsed.search = "";
  parsed.hash = "";
  return parsed;
}

function normalizeWishlistPageUrl(wishUrl, pageIndex, itemsPerPage) {
  const parsed = assertWishlistUrl(wishUrl);
  parsed.searchParams.set("start", String(pageIndex * itemsPerPage));
  return parsed.toString();
}

function normalizeSubjectUrl(rawUrl, baseUrl) {
  const parsed = new URL(rawUrl, baseUrl);
  if (parsed.protocol !== "https:" || parsed.hostname !== "book.douban.com") return null;
  const match = parsed.pathname.match(/^\/subject\/(\d+)\/?$/);
  if (!match) return null;
  parsed.pathname = `/subject/${match[1]}/`;
  parsed.search = "";
  parsed.hash = "";
  return { url: parsed.toString(), subjectId: match[1] };
}

function safeFilePart(value) {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

function ensurePlan(plan) {
  if (plan.schemaVersion !== 1) throw new Error("Unsupported readlist expansion plan schema");
  if (plan.executionMode !== "live") throw new Error("Plan must declare executionMode=live");
  if (plan.remoteFetchAllowed !== true) throw new Error("Plan must explicitly allow remote fetch");
  if (!plan.allowedHostnames?.includes("book.douban.com")) {
    throw new Error("Plan must allow book.douban.com");
  }
  if (plan.people.length !== plan.limits.maxPeople) {
    throw new Error("Plan people count must match limits.maxPeople");
  }
  for (const person of plan.people) {
    const parsed = assertWishlistUrl(person.wishUrl);
    const id = decodeURIComponent(parsed.pathname.split("/")[2]);
    if (id !== person.id) throw new Error(`Plan person ID does not match URL: ${person.id}`);
  }
}

function readPlan(path) {
  if (!existsSync(path)) throw new Error(`Readlist expansion plan not found: ${path}`);
  const plan = JSON.parse(readFileSync(path, "utf-8"));
  ensurePlan(plan);
  return plan;
}

function isChallengeHtml(html) {
  const lower = html.toLowerCase();
  return lower.includes("sec.douban.com") || lower.includes("captcha");
}

async function fetchHtml(url, kind, minDelayMs, maxDelayMs, context) {
  assertDoubanHost(url);
  await sleep(randomDelay(minDelayMs, maxDelayMs));

  const entry = {
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
  } catch (error) {
    entry.finishedAt = new Date().toISOString();
    entry.error = error?.message || String(error);
    throw error;
  }
}

function parseSubjectNum(document) {
  const text = document.querySelector(".subject-num")?.textContent?.replace(/\s+/g, " ").trim() || "";
  const match = text.match(/(\d+)\s*-\s*(\d+)\s*\/\s*(\d+)/);
  if (!match) return null;
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    total: Number(match[3]),
    text,
  };
}

function parseNextUrl(document, baseUrl) {
  const href = document.querySelector(".next a[href], .next link[rel='next'][href]")?.getAttribute("href");
  return href ? new URL(href, baseUrl).toString() : null;
}

function extractSubjectLinks(html, pageContext) {
  const dom = new JSDOM(html);
  const document = dom.window.document;
  const byUrl = new Map();
  let position = 0;

  for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
    const href = anchor.getAttribute("href");
    if (!href) continue;
    const normalized = normalizeSubjectUrl(href, pageContext.sourceUrl);
    if (!normalized) continue;
    if (byUrl.has(normalized.url)) continue;

    position += 1;
    const title =
      anchor.getAttribute("title") ||
      anchor.textContent?.replace(/\s+/g, " ").trim() ||
      "";
    byUrl.set(normalized.url, {
      url: normalized.url,
      subjectId: normalized.subjectId,
      title,
      sources: [
        {
          personId: pageContext.personId,
          wishlistUrl: pageContext.wishlistUrl,
          listPageUrl: pageContext.sourceUrl,
          pageIndex: pageContext.pageIndex,
          positionInPage: position,
          title,
        },
      ],
    });
  }

  return {
    dom,
    subjectNum: parseSubjectNum(document),
    nextUrl: parseNextUrl(document, pageContext.sourceUrl),
    links: Array.from(byUrl.values()),
  };
}

function mergeCandidate(target, candidate) {
  const existing = target.get(candidate.url);
  if (!existing) {
    target.set(candidate.url, candidate);
    return;
  }
  if (!existing.title && candidate.title) existing.title = candidate.title;
  existing.sources.push(...candidate.sources);
}

function existingReferenceSubjectIds() {
  const ids = new Set();
  if (!existsSync(referenceSamplesRoot)) return ids;

  function visit(dir) {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      const stat = statSync(path);
      if (stat.isDirectory()) {
        const match = entry.match(/^subject-(\d+)$/);
        if (match) ids.add(match[1]);
        visit(path);
      }
    }
  }

  visit(referenceSamplesRoot);
  return ids;
}

function chooseRandomPageIndexes({ personId, pageCount, seed, randomPagesPerPerson, existing }) {
  const chosen = new Set(existing);
  const candidates = Array.from({ length: pageCount }, (_, index) => index)
    .filter((index) => !chosen.has(index))
    .sort((a, b) =>
      sha256(`${seed}\0${personId}\0${a}`).localeCompare(sha256(`${seed}\0${personId}\0${b}`)),
    );
  for (const pageIndex of candidates.slice(0, randomPagesPerPerson)) {
    chosen.add(pageIndex);
  }
  return chosen;
}

function selectSubjects(candidates, count, seed) {
  return [...candidates]
    .sort((a, b) => sha256(`${seed}\0${a.url}`).localeCompare(sha256(`${seed}\0${b.url}`)))
    .slice(0, count);
}

async function run() {
  if (process.env.DOUBAN_TO_ZOTERO_EXECUTION_MODE !== "live") {
    throw new Error("Readlist pagination candidate capture requires DOUBAN_TO_ZOTERO_EXECUTION_MODE=live");
  }

  const options = parseArgs(process.argv.slice(2));
  if (!options.confirmLive) throw new Error("Readlist pagination candidate capture requires --confirm-live");

  const plan = readPlan(options.planPath);
  const count = options.count ?? plan.limits.targetSubjectPages;
  const minDelayMs = options.minDelayMs ?? plan.limits.minDelayMs;
  const maxDelayMs = options.maxDelayMs ?? plan.limits.maxDelayMs;
  if (!Number.isInteger(count) || count < 1 || count > plan.limits.targetSubjectPages) {
    throw new Error(`--count must be between 1 and ${plan.limits.targetSubjectPages}`);
  }
  if (minDelayMs < 1000 || maxDelayMs < minDelayMs) {
    throw new Error("--min-delay-ms must be at least 1000 and --max-delay-ms must be greater or equal");
  }

  const startedAt = new Date().toISOString();
  const runSuffix = formatRunSuffix(startedAt);
  const seed = options.seed ?? runSuffix;
  const outDir = join(options.outRoot, `readlist-pagination-${runSuffix}`);
  const wishlistDir = join(outDir, "wishlists");
  mkdirSync(wishlistDir, { recursive: true });

  const requestLogPath = join(outDir, "request-log.json");
  const manifestPath = join(outDir, "manifest.json");
  const allCandidates = new Map();
  const capturedWishlistPages = [];
  const readlists = [];
  const fullCoveragePeople = new Set(plan.limits.fullCoveragePeople || []);

  try {
    for (const person of plan.people) {
      const firstPageUrl = normalizeWishlistPageUrl(person.wishUrl, 0, plan.itemsPerPage);
      const firstPage = await fetchHtml(firstPageUrl, "wishlist-page", minDelayMs, maxDelayMs, {
        personId: person.id,
        pageIndex: 0,
        purpose: "count-preflight",
      });
      const firstParsed = extractSubjectLinks(firstPage.html, {
        personId: person.id,
        wishlistUrl: person.wishUrl,
        sourceUrl: firstPageUrl,
        pageIndex: 0,
      });
      if (!firstParsed.subjectNum) throw new Error(`Missing subject-num on ${firstPageUrl}`);

      const declaredTotal = firstParsed.subjectNum.total;
      const pageCount = Math.ceil(declaredTotal / plan.itemsPerPage);
      let pageIndexes = new Set([0]);
      if (fullCoveragePeople.has(person.id) && pageCount <= plan.limits.fullCoverageMaxPages) {
        for (let index = 0; index < pageCount; index++) pageIndexes.add(index);
      }
      pageIndexes = chooseRandomPageIndexes({
        personId: person.id,
        pageCount,
        seed,
        randomPagesPerPerson: plan.limits.randomPagesPerPerson,
        existing: pageIndexes,
      });

      const readlistSummary = {
        personId: person.id,
        wishUrl: person.wishUrl,
        declaredTotal,
        expectedPageCount: pageCount,
        lastPageItemCount: declaredTotal === 0 ? 0 : ((declaredTotal - 1) % plan.itemsPerPage) + 1,
        selectedPageIndexes: Array.from(pageIndexes).sort((a, b) => a - b),
        capturedPages: [],
      };
      readlists.push(readlistSummary);

      for (const pageIndex of readlistSummary.selectedPageIndexes) {
        const sourceUrl = normalizeWishlistPageUrl(person.wishUrl, pageIndex, plan.itemsPerPage);
        const html = pageIndex === 0
          ? firstPage.html
          : (await fetchHtml(sourceUrl, "wishlist-page", minDelayMs, maxDelayMs, {
              personId: person.id,
              pageIndex,
              purpose: "selected-random-page",
            })).html;
        const entry = requestLog.find((candidate) => candidate.url === sourceUrl);
        const parsed = pageIndex === 0
          ? firstParsed
          : extractSubjectLinks(html, {
              personId: person.id,
              wishlistUrl: person.wishUrl,
              sourceUrl,
              pageIndex,
            });

        const file = join(wishlistDir, `${safeFilePart(person.id)}-page-${pageIndex + 1}.html`);
        writeFileSync(file, html);
        if (entry) entry.savedTo = relativePath(file);

        for (const link of parsed.links) mergeCandidate(allCandidates, link);

        const rangeSize = parsed.subjectNum
          ? parsed.subjectNum.end - parsed.subjectNum.start + 1
          : null;
        const pageCheck = {
          personId: person.id,
          pageIndex,
          sourceUrl,
          file: relativePath(file),
          sha256: sha256(html),
          subjectNum: parsed.subjectNum,
          declaredTotalMatchesFirstPage: parsed.subjectNum?.total === declaredTotal,
          expectedStart: pageIndex * plan.itemsPerPage + 1,
          expectedEnd: Math.min((pageIndex + 1) * plan.itemsPerPage, declaredTotal),
          rangeSize,
          visibleUniqueSubjectLinks: parsed.links.length,
          visibleDeficitAgainstRange: rangeSize === null ? null : Math.max(0, rangeSize - parsed.links.length),
          nextUrl: parsed.nextUrl,
        };
        capturedWishlistPages.push(pageCheck);
        readlistSummary.capturedPages.push(pageCheck);
      }
    }

    if (capturedWishlistPages.length > plan.limits.maxListRequestsPerRun) {
      throw new Error(`Captured ${capturedWishlistPages.length} list pages, exceeding maxListRequestsPerRun`);
    }

    const existingSubjects = existingReferenceSubjectIds();
    const candidates = Array.from(allCandidates.values());
    const newCandidates = candidates.filter((candidate) => !existingSubjects.has(candidate.subjectId));
    if (newCandidates.length < count) {
      throw new Error(`Only ${newCandidates.length} new subject candidates found; requested ${count}`);
    }

    const selected = selectSubjects(newCandidates, count, seed).map((candidate, index) => ({
      subjectId: candidate.subjectId,
      sourceUrl: candidate.url,
      title: candidate.title,
      selectedBy: {
        method: "sha256(seed + subjectUrl) ascending",
        seed,
        rank: index + 1,
      },
      sources: candidate.sources,
    }));

    const completedAt = new Date().toISOString();
    const manifest = {
      schemaVersion: 1,
      kind: "douban-readlist-pagination-reference-expansion-candidates",
      executionMode: "live",
      remoteFetchAllowed: true,
      sourcePlan: relativePath(options.planPath),
      capturedAt: startedAt,
      completedAt,
      outputRoot: relativePath(outDir),
      selection: {
        method: "first-page count preflight plus seeded random readlist pages",
        subjectSelectionMethod: "sha256(seed + subjectUrl) ascending",
        seed,
        requestedSubjectPages: count,
        selectedSubjectPages: selected.length,
        candidateSubjectPages: candidates.length,
        newCandidateSubjectPages: newCandidates.length,
        existingReferenceSubjectIdsExcluded: existingSubjects.size,
      },
      requestPolicy: {
        allowedHostnames: plan.allowedHostnames,
        itemsPerPage: plan.itemsPerPage,
        minDelayMs,
        maxDelayMs,
        maxListRequestsPerRun: plan.limits.maxListRequestsPerRun,
        maxRequestsPerRun: plan.limits.maxRequestsPerRun,
      },
      requestCount: requestLog.length,
      requestLog: relativePath(requestLogPath),
      readlists,
      wishlistPages: capturedWishlistPages,
      subjectPages: selected,
      notes: [
        "Wishlist pages are live HTTP snapshots used for pagination/count evidence and candidate URL selection.",
        "Subject pages are not captured by this script; pass this manifest to npm run reference:capture:browser.",
        "Reference-sample corpus expansion counts only after browser capture succeeds.",
      ],
    };

    if (requestLog.length + selected.length > plan.limits.maxRequestsPerRun) {
      throw new Error(`Planned total requests ${requestLog.length + selected.length} exceeds maxRequestsPerRun`);
    }

    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(requestLogPath, `${JSON.stringify(requestLog, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({
      executionMode: "live",
      outputRoot: relativePath(outDir),
      manifest: relativePath(manifestPath),
      requestLog: relativePath(requestLogPath),
      readlists: readlists.length,
      wishlistPages: capturedWishlistPages.length,
      candidateSubjectPages: candidates.length,
      newCandidateSubjectPages: newCandidates.length,
      selectedSubjectPages: selected.length,
      networkRequests: requestLog.length,
      seed,
    }, null, 2)}\n`);
  } catch (error) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(requestLogPath, `${JSON.stringify(requestLog, null, 2)}\n`);
    writeFileSync(manifestPath, `${JSON.stringify({
      schemaVersion: 1,
      kind: "douban-readlist-pagination-reference-expansion-candidates",
      executionMode: "live",
      status: "failed",
      sourcePlan: relativePath(options.planPath),
      capturedAt: startedAt,
      failedAt: new Date().toISOString(),
      outputRoot: relativePath(outDir),
      requestCount: requestLog.length,
      requestLog: relativePath(requestLogPath),
      readlists,
      wishlistPages: capturedWishlistPages,
      error: error?.message || String(error),
    }, null, 2)}\n`);
    throw error;
  }
}

run();
