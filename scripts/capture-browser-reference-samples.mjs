import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { createServer } from "node:net";

const rootDir = resolve(import.meta.dirname, "..");
const defaultCandidateManifest = join(
  rootDir,
  "fixtures",
  "douban",
  "captured",
  "structure-study-20260528025151",
  "manifest.json",
);
const defaultOutRoot = join(rootDir, "fixtures", "douban", "reference-samples");
const defaultEdgePaths = [
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];

const blockedSubresourcePatterns = [
  "*.css",
  "*.js",
  "*.png",
  "*.jpg",
  "*.jpeg",
  "*.gif",
  "*.webp",
  "*.svg",
  "*.ico",
  "*.woff",
  "*.woff2",
  "*.ttf",
  "*.mp4",
  "*.mp3",
  "https://img*.doubanio.com/*",
  "https://*.googlesyndication.com/*",
  "https://*.doubleclick.net/*",
  "https://*.google-analytics.com/*",
];

function parseArgs(argv) {
  const options = {
    candidateManifest: defaultCandidateManifest,
    outRoot: defaultOutRoot,
    browserPath: "",
    confirmLive: false,
    headed: false,
    includeAssets: false,
    timeoutMs: 45000,
    postLoadDelayMs: 1500,
    interPageDelayMs: 0,
    urls: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--manifest") options.candidateManifest = resolve(rootDir, argv[++i]);
    else if (arg === "--out-dir") options.outRoot = resolve(rootDir, argv[++i]);
    else if (arg === "--browser") options.browserPath = resolve(argv[++i]);
    else if (arg === "--url") options.urls.push(argv[++i]);
    else if (arg === "--confirm-live") options.confirmLive = true;
    else if (arg === "--headed") options.headed = true;
    else if (arg === "--include-assets") options.includeAssets = true;
    else if (arg === "--timeout-ms") options.timeoutMs = Number(argv[++i]);
    else if (arg === "--post-load-delay-ms") options.postLoadDelayMs = Number(argv[++i]);
    else if (arg === "--inter-page-delay-ms") options.interPageDelayMs = Number(argv[++i]);
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

function findBrowserPath(explicitPath) {
  if (explicitPath) {
    if (!existsSync(explicitPath)) throw new Error(`Browser not found: ${explicitPath}`);
    return explicitPath;
  }
  const found = defaultEdgePaths.find((path) => existsSync(path));
  if (!found) throw new Error("Microsoft Edge was not found. Pass --browser <path-to-chrome-or-edge>.");
  return found;
}

function assertSubjectUrl(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== "book.douban.com") {
    throw new Error(`Reference capture only accepts https://book.douban.com subject URLs: ${url}`);
  }
  const match = parsed.pathname.match(/^\/subject\/(\d+)\/?$/);
  if (!match) throw new Error(`Reference capture requires a Douban subject URL: ${url}`);
  parsed.pathname = `/subject/${match[1]}/`;
  parsed.search = "";
  parsed.hash = "";
  return { url: parsed.toString(), subjectId: match[1] };
}

function loadCandidateUrls(options) {
  const fromArgs = options.urls.map((url) => assertSubjectUrl(url));
  if (fromArgs.length > 0) return fromArgs;

  const manifest = JSON.parse(readFileSync(options.candidateManifest, "utf-8"));
  if (!Array.isArray(manifest.subjectPages)) {
    throw new Error(`Candidate manifest has no subjectPages array: ${options.candidateManifest}`);
  }
  return manifest.subjectPages.map((page) => ({
    ...assertSubjectUrl(page.sourceUrl),
    sourceContext: {
      candidateManifest: relativePath(options.candidateManifest),
      title: page.title || "",
      selectedBy: page.selectedBy || null,
      sources: Array.isArray(page.sources) ? page.sources : [],
    },
  }));
}

function uniqueCandidates(candidates) {
  const seen = new Set();
  const unique = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.url)) continue;
    seen.add(candidate.url);
    unique.push(candidate);
  }
  return unique;
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate a local debug port")));
        return;
      }
      const port = address.port;
      server.close(() => resolvePort(port));
    });
  });
}

async function waitForJson(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (e) {
      lastError = e;
    }
    await sleep(250);
  }
  throw lastError || new Error(`Timed out waiting for ${url}`);
}

async function createTarget(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" });
  if (!response.ok) throw new Error(`Failed to create browser target: HTTP ${response.status}`);
  return await response.json();
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
  }

  async connect() {
    if (typeof WebSocket === "undefined") {
      throw new Error("This script requires Node with global WebSocket support");
    }
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolveConnect, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out connecting to browser CDP")), 10000);
      this.ws.addEventListener("open", () => {
        clearTimeout(timeout);
        resolveConnect();
      }, { once: true });
      this.ws.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("Browser CDP WebSocket error"));
      }, { once: true });
    });
    this.ws.addEventListener("message", (event) => this.handleMessage(event));
  }

  handleMessage(event) {
    const data = JSON.parse(event.data);
    if (data.id && this.pending.has(data.id)) {
      const { resolveCommand, rejectCommand } = this.pending.get(data.id);
      this.pending.delete(data.id);
      if (data.error) rejectCommand(new Error(`${data.error.message || "CDP error"} ${data.error.data || ""}`.trim()));
      else resolveCommand(data.result || {});
      return;
    }
    if (data.method && this.handlers.has(data.method)) {
      for (const handler of this.handlers.get(data.method)) handler(data.params || {});
    }
  }

  on(method, handler) {
    const handlers = this.handlers.get(method) || [];
    handlers.push(handler);
    this.handlers.set(method, handlers);
  }

  once(method, predicate, timeoutMs) {
    return new Promise((resolveEvent, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      const handler = (params) => {
        if (predicate && !predicate(params)) return;
        clearTimeout(timer);
        const handlers = this.handlers.get(method) || [];
        this.handlers.set(method, handlers.filter((candidate) => candidate !== handler));
        resolveEvent(params);
      };
      this.on(method, handler);
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolveCommand, rejectCommand) => {
      this.pending.set(id, { resolveCommand, rejectCommand });
    });
  }

  close() {
    if (this.ws) this.ws.close();
  }
}

function isChallengeText(text) {
  return (
    text.includes("sec.douban.com") ||
    text.toLowerCase().includes("captcha") ||
    text.includes("检测到有异常请求") ||
    text.includes("访问受限")
  );
}

async function captureOne({ cdp, candidate, outDir, options, browserPath, browserVersion }) {
  const capturedAt = new Date().toISOString();
  const subjectDir = join(outDir, `subject-${candidate.subjectId}`);
  mkdirSync(subjectDir, { recursive: true });

  const networkEvents = [];
  let mainDocumentRequestId = "";
  let mainDocumentResponse = null;

  cdp.on("Network.responseReceived", (params) => {
    const entry = {
      type: params.type,
      url: params.response?.url,
      status: params.response?.status,
      mimeType: params.response?.mimeType,
    };
    networkEvents.push(entry);
    if (params.type === "Document" && params.response?.url?.startsWith(candidate.url)) {
      mainDocumentRequestId = params.requestId;
      mainDocumentResponse = entry;
    }
  });

  await cdp.send("Network.enable");
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setLocaleOverride", { locale: "zh-CN" }).catch(() => {});
  await cdp.send("Network.setUserAgentOverride", {
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    acceptLanguage: "zh-CN,zh;q=0.9,en;q=0.8",
  });
  if (!options.includeAssets) {
    await cdp.send("Network.setBlockedURLs", { urls: blockedSubresourcePatterns });
  }

  const loadEvent = cdp.once("Page.loadEventFired", null, options.timeoutMs).catch(() => null);
  await cdp.send("Page.navigate", { url: candidate.url });
  await loadEvent;
  await sleep(options.postLoadDelayMs);

  const titleResult = await cdp.send("Runtime.evaluate", {
    expression: "document.title",
    returnByValue: true,
  });
  const currentUrlResult = await cdp.send("Runtime.evaluate", {
    expression: "location.href",
    returnByValue: true,
  });
  const bodyTextResult = await cdp.send("Runtime.evaluate", {
    expression: "document.body ? document.body.innerText.slice(0, 5000) : ''",
    returnByValue: true,
  });
  const domHtmlResult = await cdp.send("Runtime.evaluate", {
    expression: "document.documentElement ? document.documentElement.outerHTML : ''",
    returnByValue: true,
  });

  const pageTitle = titleResult.result?.value || "";
  const finalUrl = currentUrlResult.result?.value || "";
  const bodyText = bodyTextResult.result?.value || "";
  const domHtml = domHtmlResult.result?.value || "";
  if (isChallengeText(`${pageTitle}\n${finalUrl}\n${bodyText}\n${domHtml.slice(0, 2000)}`)) {
    throw new Error(`Douban challenge detected while capturing ${candidate.url}`);
  }

  let sourceHtml = "";
  let sourceUnavailableReason = "";
  if (mainDocumentRequestId) {
    try {
      const responseBody = await cdp.send("Network.getResponseBody", { requestId: mainDocumentRequestId });
      sourceHtml = responseBody.base64Encoded
        ? Buffer.from(responseBody.body, "base64").toString("utf-8")
        : responseBody.body;
    } catch (e) {
      sourceUnavailableReason = e.message || String(e);
    }
  } else {
    sourceUnavailableReason = "main document request ID was not observed";
  }

  const mhtml = await cdp.send("Page.captureSnapshot", { format: "mhtml" });
  const sourcePath = join(subjectDir, "source.html");
  const domPath = join(subjectDir, "dom.html");
  const mhtmlPath = join(subjectDir, "page.mhtml");
  const metadataPath = join(subjectDir, "metadata.json");

  if (sourceHtml) writeFileSync(sourcePath, sourceHtml);
  writeFileSync(domPath, domHtml);
  writeFileSync(mhtmlPath, mhtml.data || "");

  const metadata = {
    schemaVersion: 1,
    kind: "douban-browser-reference-sample",
    referenceSampleStatus: "browser-automated-reference-candidate",
    subjectId: candidate.subjectId,
    sourceUrl: candidate.url,
    finalUrl,
    title: pageTitle,
    capturedAt,
    browser: {
      executable: browserPath,
      version: browserVersion.Browser || null,
      headless: !options.headed,
    },
    saveMode: {
      sourceHtml: sourceHtml ? "Chrome DevTools Protocol Network.getResponseBody for the browser main document" : "unavailable",
      domHtml: "Chrome DevTools Protocol Runtime.evaluate document.documentElement.outerHTML",
      mhtml: "Chrome DevTools Protocol Page.captureSnapshot",
      subresourcesBlocked: !options.includeAssets,
      blockedPatterns: options.includeAssets ? [] : blockedSubresourcePatterns,
    },
    files: {
      sourceHtml: sourceHtml ? relativePath(sourcePath) : null,
      domHtml: relativePath(domPath),
      mhtml: relativePath(mhtmlPath),
      metadata: relativePath(metadataPath),
    },
    hashes: {
      sourceHtmlSha256: sourceHtml ? sha256(sourceHtml) : null,
      domHtmlSha256: sha256(domHtml),
      mhtmlSha256: sha256(mhtml.data || ""),
    },
    network: {
      mainDocumentResponse,
      observedResponseCount: networkEvents.length,
      sourceUnavailableReason: sourceUnavailableReason || null,
    },
    candidateSource: candidate.sourceContext || null,
    notes: [
      "Captured by browser automation, not by the add-on scraping pipeline, SQLite live-capture pipeline, or parser code.",
      "Review this sample manually before promoting it into a dry-run golden fixture.",
    ],
  };

  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  return metadata;
}

async function run() {
  if (process.env.DOUBAN_TO_ZOTERO_EXECUTION_MODE !== "live") {
    throw new Error("Browser reference capture requires DOUBAN_TO_ZOTERO_EXECUTION_MODE=live");
  }

  const options = parseArgs(process.argv.slice(2));
  if (!options.confirmLive) throw new Error("Browser reference capture requires --confirm-live");

  const candidates = uniqueCandidates(loadCandidateUrls(options));
  if (candidates.length === 0) throw new Error("No candidate subject URLs were provided");

  const startedAt = new Date().toISOString();
  const runSuffix = formatRunSuffix(startedAt);
  const outDir = join(options.outRoot, `browser-save-${runSuffix}`);
  mkdirSync(outDir, { recursive: true });

  const browserPath = findBrowserPath(options.browserPath);
  const port = await freePort();
  const browserProfileDir = join(tmpdir(), `douban-to-zotero-browser-reference-${runSuffix}`);
  const browserArgs = [
    `--remote-debugging-port=${port}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${browserProfileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-features=Translate,OptimizationHints,MediaRouter",
    "--disable-gpu",
    "--lang=zh-CN",
    "about:blank",
  ];
  if (!options.headed) browserArgs.splice(browserArgs.length - 1, 0, "--headless=new");

  const browser = spawn(browserPath, browserArgs, {
    cwd: rootDir,
    stdio: "ignore",
  });

  const capturedSamples = [];
  const failures = [];
  let cdp = null;

  try {
    const browserVersion = await waitForJson(`http://127.0.0.1:${port}/json/version`, 15000);
    const target = await createTarget(port);
    cdp = new CdpClient(target.webSocketDebuggerUrl);
    await cdp.connect();

    for (const candidate of candidates) {
      try {
        capturedSamples.push(await captureOne({ cdp, candidate, outDir, options, browserPath, browserVersion }));
      } catch (e) {
        failures.push({
          sourceUrl: candidate.url,
          subjectId: candidate.subjectId,
          error: e.message || String(e),
        });
      }
      if (options.interPageDelayMs > 0) await sleep(options.interPageDelayMs);
    }
  } finally {
    if (cdp) cdp.close();
    browser.kill();
    await sleep(500);
    rmSync(browserProfileDir, { recursive: true, force: true });
  }

  const completedAt = new Date().toISOString();
  const manifest = {
    schemaVersion: 1,
    kind: "douban-browser-reference-sample-run",
    executionMode: "live",
    remoteFetchAllowed: true,
    source: options.urls.length > 0 ? "cli-urls" : relativePath(options.candidateManifest),
    outputRoot: relativePath(outDir),
    capturedAt: startedAt,
    completedAt,
    browser: {
      executable: browserPath,
      headless: !options.headed,
    },
    collectionMethod: "automated browser capture through Chrome DevTools Protocol",
    independenceBoundary: "not plugin scraping pipeline; not SQLite live-capture pipeline; not parser code",
    requestedSubjectPages: candidates.length,
    capturedSubjectPages: capturedSamples.length,
    failedSubjectPages: failures.length,
    samples: capturedSamples.map((sample) => ({
      subjectId: sample.subjectId,
      sourceUrl: sample.sourceUrl,
      finalUrl: sample.finalUrl,
      title: sample.title,
      metadata: sample.files.metadata,
      sourceHtml: sample.files.sourceHtml,
      domHtml: sample.files.domHtml,
      mhtml: sample.files.mhtml,
    })),
    failures,
    notes: [
      "These are browser-automated reference candidates.",
      "Review source.html, dom.html, and page.mhtml manually before promoting a sample into dry-run fixtures.",
    ],
  };

  const manifestPath = join(outDir, "manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  process.stdout.write(`${JSON.stringify({
    executionMode: "live",
    outputRoot: relativePath(outDir),
    manifest: relativePath(manifestPath),
    requestedSubjectPages: candidates.length,
    capturedSubjectPages: capturedSamples.length,
    failedSubjectPages: failures.length,
  }, null, 2)}\n`);

  if (failures.length > 0) process.exit(1);
}

run();
