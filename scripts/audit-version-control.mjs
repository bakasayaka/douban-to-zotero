import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const rootDir = resolve(import.meta.dirname, "..");
const strict = process.argv.includes("--strict");

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  return {
    status: result.status ?? 1,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
    error: result.error?.message ?? null,
  };
}

function readTextIfExists(path) {
  return existsSync(path) ? readFileSync(path, "utf-8") : "";
}

const gitVersion = run("git", ["--version"]);
const gitRoot = run("git", ["rev-parse", "--show-toplevel"]);
const insideWorkTree = gitRoot.status === 0;
const gitStatus = insideWorkTree ? run("git", ["status", "--short"]) : null;
const gitBranch = insideWorkTree ? run("git", ["branch", "--show-current"]) : null;
const gitRemotes = insideWorkTree ? run("git", ["remote", "-v"]) : null;
const gitTrackedFiles = insideWorkTree ? run("git", ["ls-files", "-z"]) : null;
const gitEffectiveUserName = insideWorkTree ? run("git", ["config", "--show-origin", "--get", "user.name"]) : null;
const gitEffectiveUserEmail = insideWorkTree ? run("git", ["config", "--show-origin", "--get", "user.email"]) : null;
const gitLocalUserName = insideWorkTree ? run("git", ["config", "--local", "--get", "user.name"]) : null;
const gitLocalUserEmail = insideWorkTree ? run("git", ["config", "--local", "--get", "user.email"]) : null;
const gitRecentAuthors = insideWorkTree
  ? run("git", ["log", "--format=%h%x09%an%x09%ae", "--max-count=30"])
  : null;

function parseGitConfigValue(result) {
  if (!result || result.status !== 0 || !result.stdout) return null;
  const text = result.stdout.trim();
  const tabIndex = text.lastIndexOf("\t");
  return tabIndex >= 0 ? text.slice(tabIndex + 1).trim() : text.trim();
}

function parseGitConfigOrigin(result) {
  if (!result || result.status !== 0 || !result.stdout) return null;
  const text = result.stdout.trim();
  const tabIndex = text.lastIndexOf("\t");
  return tabIndex >= 0 ? text.slice(0, tabIndex).trim() : null;
}

function parseTrackedFiles(result) {
  if (!result || result.status !== 0 || !result.stdout) return [];
  return result.stdout.split("\0").filter(Boolean).map((path) => path.replaceAll("\\", "/"));
}

function parseRecentAuthors(result) {
  if (!result || result.status !== 0 || !result.stdout) return [];
  return result.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    const [commit, name, email] = line.split("\t");
    return { commit, name, email };
  });
}

function identityLooksPublishable(value) {
  if (!value) return false;
  return !/\bun-canon\b|un-canon@hotmail\.com/i.test(value);
}

const gitignorePath = join(rootDir, ".gitignore");
const gitignoreText = readTextIfExists(gitignorePath);
const requiredIgnorePatterns = [
  "node_modules/",
  "build/",
  "artifacts/",
  ".cache/",
  "*.xpi",
  "*.sqlite",
  ".env",
  "docs/",
  "/*.md",
  "!/README.md",
  "fixtures/douban/captured/",
  "fixtures/douban/reference-samples/",
  "fixtures/douban/parser-golden/",
  "fixtures/douban/dry-run-cohorts/",
  "fixtures/douban/live-capture-studies/",
  "scripts/vm/",
  "webpage_example/",
  "code_review_skill/",
];
const missingIgnorePatterns = requiredIgnorePatterns.filter(
  (pattern) => !gitignoreText.split(/\r?\n/).map((line) => line.trim()).includes(pattern),
);

const wrapperPaths = [
  join(rootDir, "scripts", "run-openai-compatible-cleaning.ps1"),
  join(rootDir, "scripts", "run-openai-compatible-cleaning-comparison.ps1"),
];
const wrapperFindings = wrapperPaths.map((path) => {
  const text = readTextIfExists(path);
  const likelyApiKeys = text.match(/\bsk-[A-Za-z0-9_-]{16,}\b/g) ?? [];
  const providerEndpointPattern = new RegExp("api\\." + "deepseek\\.com", "gi");
  const providerModelPattern = new RegExp("deepseek-" + "v4-flash", "gi");
  return {
    path: relative(rootDir, path).replaceAll("\\", "/"),
    exists: existsSync(path),
    hasBaseUrlPlaceholder: text.includes("PASTE_YOUR_OPENAI_COMPATIBLE_BASE_URL_HERE"),
    hasModelPlaceholder: text.includes("PASTE_YOUR_MODEL_HERE"),
    hasApiKeyPlaceholder: text.includes("PASTE_YOUR_API_KEY_HERE"),
    likelyApiKeyCount: likelyApiKeys.filter((key) => !/^sk-test/i.test(key)).length,
    providerSpecificValueCount: (
      (text.match(providerEndpointPattern) ?? []).length +
      (text.match(providerModelPattern) ?? []).length
    ),
  };
});

const trackedFiles = parseTrackedFiles(gitTrackedFiles);
const publishBlockedTrackedRules = [
  {
    name: "live-captured-douban-pages",
    pattern: /^fixtures\/douban\/captured\//,
    reason: "live capture evidence belongs in local test artifacts, not the GitHub source tree",
  },
  {
    name: "browser-reference-samples",
    pattern: /^fixtures\/douban\/reference-samples\//,
    reason: "browser-saved reference pages are local test data",
  },
  {
    name: "parser-golden-raw-fixtures",
    pattern: /^fixtures\/douban\/parser-golden\//,
    reason: "parser-golden raw HTML and expected snapshots are internal parser evidence, not first-version GitHub source",
  },
  {
    name: "readlist-study-manifests",
    pattern: /^fixtures\/douban\/(dry-run-cohorts|live-capture-studies)\//,
    reason: "readlist-study manifests contain project-specific Douban cohort evidence and should stay local",
  },
  {
    name: "internal-development-docs",
    pattern: /^docs\//,
    reason: "internal docs and audit logs require a separate publication review before GitHub source publication",
  },
  {
    name: "internal-vm-e2e-harness",
    pattern: /^scripts\/vm\//,
    reason: "internal Hyper-V/Zotero VM E2E harness scripts are local test platform code, not GitHub source",
  },
  {
    name: "root-internal-markdown",
    pattern: /^(?!README\.md$)[^/]+\.md$/,
    reason: "root-level markdown other than README is internal design/review material unless explicitly reviewed for publication",
  },
  {
    name: "legacy-webpage-example",
    pattern: /^webpage_example\//,
    reason: "legacy saved web page example is local sample data",
  },
  {
    name: "local-code-review-skill-copy",
    pattern: /^code_review_skill\//,
    reason: "local audit tooling should not be published as project source",
  },
  {
    name: "tracked-generated-artifact",
    pattern: /(^|\/)(build|artifacts|\.cache|node_modules)\//,
    reason: "generated local state is ignored for publication",
  },
  {
    name: "tracked-release-or-db-output",
    pattern: /\.(xpi|sqlite|sqlite3|log)$/i,
    reason: "release binaries and database/log outputs are release artifacts or local evidence, not source",
  },
];
const publishBlockedTrackedFiles = trackedFiles.flatMap((path) =>
  publishBlockedTrackedRules
    .filter((rule) => rule.pattern.test(path))
    .map((rule) => ({ path, rule: rule.name, reason: rule.reason })),
);

const secretScanTextExtensions = new Set([
  ".js", ".mjs", ".ts", ".tsx", ".json", ".md", ".ps1", ".xhtml", ".xml", ".html", ".htm", ".css",
  ".sql", ".txt", ".ftl", ".yml", ".yaml", ".toml", ".lock",
]);

function extensionOf(path) {
  const match = path.match(/(\.[^.\/]+)$/);
  return match ? match[1].toLowerCase() : "";
}

function lineNumberForIndex(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
}

function scanTrackedTextFile(path) {
  const ext = extensionOf(path);
  if (ext && !secretScanTextExtensions.has(ext)) return [];

  const absolute = join(rootDir, path);
  if (!existsSync(absolute)) return [];

  let text = "";
  try {
    text = readFileSync(absolute, "utf-8");
  } catch {
    return [];
  }

  const findings = [];
  const providerEndpointPattern = new RegExp("api\\." + "deepseek\\.com", "gi");
  const providerModelPattern = new RegExp("deepseek-" + "v4-flash", "gi");
  const patterns = [
    {
      kind: "active-api-key",
      pattern: /\bsk-(?!test(?:\b|-)|example(?:\b|-)|placeholder(?:\b|-))[A-Za-z0-9_-]{16,}\b/g,
    },
    {
      kind: "provider-specific-api-url",
      pattern: providerEndpointPattern,
    },
    {
      kind: "provider-specific-model",
      pattern: providerModelPattern,
    },
    {
      kind: "host-user-path",
      pattern: /C:\\Users\\[^\\\r\n"']+/g,
    },
  ];

  for (const { kind, pattern } of patterns) {
    for (const match of text.matchAll(pattern)) {
      findings.push({
        path,
        line: lineNumberForIndex(text, match.index ?? 0),
        kind,
      });
    }
  }

  return findings;
}

const trackedContentFindings = trackedFiles.flatMap(scanTrackedTextFile);
const localUserName = parseGitConfigValue(gitLocalUserName);
const localUserEmail = parseGitConfigValue(gitLocalUserEmail);
const effectiveUserName = parseGitConfigValue(gitEffectiveUserName);
const effectiveUserEmail = parseGitConfigValue(gitEffectiveUserEmail);
const recentAuthors = parseRecentAuthors(gitRecentAuthors);
const blockedRecentAuthors = recentAuthors.filter((author) =>
  !identityLooksPublishable(author.name) || !identityLooksPublishable(author.email)
);

const generatedRoots = ["node_modules", "build", "artifacts", ".cache"].map((name) => ({
  name,
  exists: existsSync(join(rootDir, name)),
}));

const attention = [];

if (gitVersion.status !== 0) {
  attention.push("Git CLI is not available on PATH.");
}

if (!insideWorkTree) {
  attention.push("Workspace is not inside a local Git repository; run tracking audit before git init or remote binding.");
}

if (!existsSync(gitignorePath)) {
  attention.push(".gitignore is missing.");
} else if (missingIgnorePatterns.length > 0) {
  attention.push(`.gitignore is missing generated-state patterns: ${missingIgnorePatterns.join(", ")}`);
}

for (const wrapper of wrapperFindings) {
  if (!wrapper.exists) {
    attention.push(`API wrapper is missing: ${wrapper.path}`);
  } else {
    if (!wrapper.hasBaseUrlPlaceholder || !wrapper.hasModelPlaceholder || !wrapper.hasApiKeyPlaceholder) {
      attention.push(`API wrapper lacks publishable endpoint/model/key placeholders: ${wrapper.path}`);
    }
    if (wrapper.likelyApiKeyCount > 0) {
      attention.push(`API wrapper appears to contain active API key material: ${wrapper.path}`);
    }
    if (wrapper.providerSpecificValueCount > 0) {
      attention.push(`API wrapper appears to contain provider-specific test endpoint/model values: ${wrapper.path}`);
    }
  }
}

if (insideWorkTree) {
  if (!identityLooksPublishable(localUserName) || !identityLooksPublishable(localUserEmail)) {
    attention.push("Local Git user.name/user.email are not configured for publication-safe commits.");
  }
  if (!identityLooksPublishable(effectiveUserName) || !identityLooksPublishable(effectiveUserEmail)) {
    attention.push("Effective Git identity is not publication-safe.");
  }
  if (blockedRecentAuthors.length > 0) {
    attention.push(`Recent Git history contains non-publication author identity in ${blockedRecentAuthors.length} commit(s).`);
  }
}

const statusLines = gitStatus?.stdout ? gitStatus.stdout.split(/\r?\n/).filter(Boolean) : [];
const generatedStatusLines = statusLines.filter((line) =>
  /\s(node_modules|build|artifacts|\.cache)\//.test(line) || /\.xpi$/.test(line),
);

if (generatedStatusLines.length > 0) {
  attention.push("Git status contains generated artifacts that should not be published.");
}

if (publishBlockedTrackedFiles.length > 0) {
  attention.push(`Git tracks ${publishBlockedTrackedFiles.length} file(s) that are blocked from GitHub source publication.`);
}

if (trackedContentFindings.length > 0) {
  attention.push(`Tracked source scan found ${trackedContentFindings.length} publish-sensitive content finding(s).`);
}

const report = {
  mode: "version-control-audit",
  timestamp: new Date().toISOString(),
  rootDir: "<local-workspace>",
  strict,
  decisionRecord: "README.md#publication-boundary",
  git: {
    available: gitVersion.status === 0,
    version: gitVersion.stdout || gitVersion.stderr || gitVersion.error,
    insideWorkTree,
    root: insideWorkTree ? "<local-workspace>" : null,
    branch: insideWorkTree ? gitBranch?.stdout || null : null,
    remotes: insideWorkTree && gitRemotes?.stdout
      ? gitRemotes.stdout.split(/\r?\n/).filter(Boolean)
      : [],
    statusShort: statusLines,
    identity: {
      local: {
        name: localUserName,
        email: localUserEmail,
      },
      effective: {
        name: effectiveUserName,
        email: effectiveUserEmail,
        nameOrigin: parseGitConfigOrigin(gitEffectiveUserName),
        emailOrigin: parseGitConfigOrigin(gitEffectiveUserEmail),
      },
      recentBlockedAuthors: blockedRecentAuthors,
    },
  },
  workspace: {
    gitignorePresent: existsSync(gitignorePath),
    requiredIgnorePatterns,
    missingIgnorePatterns,
    generatedRoots,
    wrappers: wrapperFindings,
    publishBlockedTrackedFiles: {
      count: publishBlockedTrackedFiles.length,
      sample: publishBlockedTrackedFiles.slice(0, 30),
    },
    trackedContentFindings: {
      count: trackedContentFindings.length,
      sample: trackedContentFindings.slice(0, 30),
    },
  },
  checks: {
    gitBinaryAvailable: gitVersion.status === 0,
    workspaceIsGitRepo: insideWorkTree,
    gitignoreCoversGeneratedState: existsSync(gitignorePath) && missingIgnorePatterns.length === 0,
    wrappersArePublishablePlaceholders: wrapperFindings.every((wrapper) =>
      wrapper.exists &&
      wrapper.hasBaseUrlPlaceholder &&
      wrapper.hasModelPlaceholder &&
      wrapper.hasApiKeyPlaceholder &&
      wrapper.likelyApiKeyCount === 0 &&
      wrapper.providerSpecificValueCount === 0
    ),
    generatedArtifactsAbsentFromGitStatus: generatedStatusLines.length === 0,
    gitIdentityConfiguredForPublication:
      identityLooksPublishable(localUserName) &&
      identityLooksPublishable(localUserEmail) &&
      identityLooksPublishable(effectiveUserName) &&
      identityLooksPublishable(effectiveUserEmail),
    recentCommitAuthorsPublicationSafe: blockedRecentAuthors.length === 0,
    publishBlockedTrackedFilesAbsent: publishBlockedTrackedFiles.length === 0,
    trackedContentFindingsAbsent: trackedContentFindings.length === 0,
  },
  attention,
};

console.log(JSON.stringify(report, null, 2));

if (strict && attention.length > 0) {
  process.exit(1);
}
