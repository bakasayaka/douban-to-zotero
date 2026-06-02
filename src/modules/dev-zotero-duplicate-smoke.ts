import type { BookMetadata, DeduplicationResult, MatchType } from "../types";
import { bookToZoteroBookPayload } from "./zotero-book-payload";
import { checkDuplicates } from "./deduplicator";
import { createZoteroBookItemFromPayload } from "./writer";

const DUPLICATE_SMOKE_ENABLED_PREF = "__prefsPrefix__.duplicateSmokeEnabled";
const DUPLICATE_SMOKE_PAYLOAD_PATH_PREF = "__prefsPrefix__.duplicateSmokePayloadPath";
const DUPLICATE_SMOKE_RESULT_PATH_PREF = "__prefsPrefix__.duplicateSmokeResultPath";

type ExpectedImportDecision = "skip-duplicate" | "review-suspect" | "eligible-new";

interface ZoteroDuplicateSmokeScenario {
  scenarioId: string;
  description?: string;
  existing: BookMetadata[];
  candidate: BookMetadata;
  expected: {
    matchType: MatchType;
    matchedTitle?: string;
    reasonIncludes?: string;
    importDecision: ExpectedImportDecision;
  };
}

interface ZoteroDuplicateSmokePayloadFile {
  schemaVersion: 1;
  mode: "zotero-duplicate-dry-payload";
  executionMode: "dry-run";
  exportedAt: string;
  scenarios: ZoteroDuplicateSmokeScenario[];
}

interface NetworkGuard {
  readonly requests: Array<{ primitive: string; detail: string }>;
  restore(): void;
}

function readStringPref(pref: string): string {
  const value = Zotero.Prefs.get(pref, true);
  return typeof value === "string" ? value.trim() : "";
}

function readBooleanPref(pref: string): boolean {
  return Zotero.Prefs.get(pref, true) === true;
}

function hasDuplicateSmokeRequest(): boolean {
  return (
    readBooleanPref(DUPLICATE_SMOKE_ENABLED_PREF) &&
    readStringPref(DUPLICATE_SMOKE_PAYLOAD_PATH_PREF).length > 0
  );
}

function disableDuplicateSmokeRequest(): boolean {
  try {
    Zotero.Prefs.set(DUPLICATE_SMOKE_ENABLED_PREF, false, true);
    Zotero.Prefs.set(DUPLICATE_SMOKE_PAYLOAD_PATH_PREF, "", true);
    Zotero.Prefs.set(DUPLICATE_SMOKE_RESULT_PATH_PREF, "", true);
    return (
      !readBooleanPref(DUPLICATE_SMOKE_ENABLED_PREF) &&
      readStringPref(DUPLICATE_SMOKE_PAYLOAD_PATH_PREF) === "" &&
      readStringPref(DUPLICATE_SMOKE_RESULT_PATH_PREF) === ""
    );
  } catch (error: any) {
    Zotero.log(
      `[Douban-to-Zotero] duplicate smoke one-shot cleanup failed: ${error?.message || String(error)}`,
      "warning",
    );
    return false;
  }
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await IOUtils.writeUTF8(path, `${JSON.stringify(value, null, 2)}\n`);
}

function installNetworkGuard(): NetworkGuard {
  const requests: Array<{ primitive: string; detail: string }> = [];
  const originalHttpRequest = (Zotero.HTTP as any).request;
  const globalObject = globalThis as any;
  const originalFetch = globalObject.fetch;

  (Zotero.HTTP as any).request = async (...args: any[]) => {
    requests.push({
      primitive: "zotero-http-request",
      detail: `${String(args[0] ?? "")} ${String(args[1] ?? "")}`.trim(),
    });
    throw new Error("Unit 4 dry-run duplicate smoke blocked Zotero HTTP request");
  };

  if (typeof originalFetch === "function") {
    globalObject.fetch = async (...args: any[]) => {
      requests.push({
        primitive: "fetch",
        detail: String(args[0] ?? ""),
      });
      throw new Error("Unit 4 dry-run duplicate smoke blocked fetch");
    };
  }

  return {
    requests,
    restore() {
      (Zotero.HTTP as any).request = originalHttpRequest;
      if (typeof originalFetch === "function") {
        globalObject.fetch = originalFetch;
      }
    },
  };
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function assertBookMetadata(value: unknown, label: string): asserts value is BookMetadata {
  const book = value as Partial<BookMetadata>;
  if (!book || typeof book !== "object") {
    throw new Error(`${label} is not an object`);
  }
  for (const field of ["doubanUrl", "doubanId", "title", "publisher", "publishDate"] as const) {
    if (!hasText(book[field])) {
      throw new Error(`${label} missing required field: ${field}`);
    }
  }
  if (!Array.isArray(book.creators) || book.creators.length === 0) {
    throw new Error(`${label} missing creators`);
  }
}

function assertPayloadFile(value: unknown): asserts value is ZoteroDuplicateSmokePayloadFile {
  const candidate = value as Partial<ZoteroDuplicateSmokePayloadFile>;
  if (!candidate || typeof candidate !== "object") {
    throw new Error("duplicate smoke payload is not an object");
  }
  if (candidate.schemaVersion !== 1) {
    throw new Error("duplicate smoke payload schemaVersion must be 1");
  }
  if (candidate.mode !== "zotero-duplicate-dry-payload") {
    throw new Error("duplicate smoke payload mode mismatch");
  }
  if (candidate.executionMode !== "dry-run") {
    throw new Error("duplicate smoke payload executionMode must be dry-run");
  }
  if (!Array.isArray(candidate.scenarios) || candidate.scenarios.length === 0) {
    throw new Error("duplicate smoke payload has no scenarios");
  }

  for (const scenario of candidate.scenarios) {
    if (!hasText(scenario.scenarioId)) {
      throw new Error("duplicate smoke scenario missing scenarioId");
    }
    if (!Array.isArray(scenario.existing) || scenario.existing.length === 0) {
      throw new Error(`duplicate smoke scenario has no existing records: ${scenario.scenarioId}`);
    }
    scenario.existing.forEach((book, index) => {
      assertBookMetadata(book, `${scenario.scenarioId}.existing[${index}]`);
    });
    assertBookMetadata(scenario.candidate, `${scenario.scenarioId}.candidate`);
    if (
      !scenario.expected ||
      !["new", "duplicate", "suspect"].includes(scenario.expected.matchType) ||
      !["skip-duplicate", "review-suspect", "eligible-new"].includes(
        scenario.expected.importDecision,
      )
    ) {
      throw new Error(`duplicate smoke scenario has invalid expected result: ${scenario.scenarioId}`);
    }
  }
}

function expectedImportDecision(result: DeduplicationResult): ExpectedImportDecision {
  if (result.matchType === "duplicate") return "skip-duplicate";
  if (result.matchType === "suspect") return "review-suspect";
  return "eligible-new";
}

async function countBookItems(): Promise<number> {
  const search = new Zotero.Search();
  search.libraryID = Zotero.Libraries.userLibraryID;
  search.addCondition("itemType", "is", "book");
  const ids = await search.search();
  return ids.length;
}

async function seedExistingBooks(scenario: ZoteroDuplicateSmokeScenario): Promise<number[]> {
  const itemIds: number[] = [];
  for (const book of scenario.existing) {
    const payload = bookToZoteroBookPayload(book);
    const item = await createZoteroBookItemFromPayload(payload);
    itemIds.push(Number(item.id));
  }
  return itemIds;
}

function resultMatchesScenario(
  result: DeduplicationResult,
  scenario: ZoteroDuplicateSmokeScenario,
): Record<string, boolean> {
  const reason = result.matchReason ?? "";
  return {
    matchType: result.matchType === scenario.expected.matchType,
    importDecision: expectedImportDecision(result) === scenario.expected.importDecision,
    matchedTitle: !scenario.expected.matchedTitle ||
      result.matchedItemTitle === scenario.expected.matchedTitle,
    reasonIncludes: !scenario.expected.reasonIncludes ||
      reason.includes(scenario.expected.reasonIncludes),
  };
}

function checkAllValues(value: Record<string, boolean>): boolean {
  return Object.values(value).every(Boolean);
}

export async function runDevZoteroDuplicateSmokeIfRequested(): Promise<void> {
  if (!__DEV__ || !hasDuplicateSmokeRequest()) return;

  const payloadPath = readStringPref(DUPLICATE_SMOKE_PAYLOAD_PATH_PREF);
  const resultPath = readStringPref(DUPLICATE_SMOKE_RESULT_PATH_PREF);
  const startedAt = new Date().toISOString();
  if (!resultPath) {
    disableDuplicateSmokeRequest();
    Zotero.log(
      "[Douban-to-Zotero] duplicate smoke requested but result path pref is empty",
      "warning",
    );
    return;
  }

  const networkGuard = installNetworkGuard();
  const errors: string[] = [];
  const scenarioResults: Array<{
    scenarioId: string;
    seedItemIds: number[];
    result: {
      matchType: MatchType;
      matchedItemId?: number;
      matchedItemTitle?: string;
      matchConfidence?: number;
      matchReason?: string;
      importDecision: ExpectedImportDecision;
    };
    checks: Record<string, boolean>;
  }> = [];

  try {
    const payloadText = await IOUtils.readUTF8(payloadPath);
    const payloadFile = JSON.parse(payloadText);
    assertPayloadFile(payloadFile);

    const dataDirectory = Zotero.DataDirectory.dir;
    const disposableDataDirectory =
      dataDirectory.toLowerCase().includes("zotero-duplicate-dry-") &&
      dataDirectory.toLowerCase().includes("\\data");
    if (!disposableDataDirectory) {
      throw new Error(`Zotero data directory is not a duplicate-smoke run directory: ${dataDirectory}`);
    }

    for (const scenario of payloadFile.scenarios) {
      const beforeSeedCount = await countBookItems();
      const seedItemIds = await seedExistingBooks(scenario);
      const afterSeedCount = await countBookItems();
      const [result] = await checkDuplicates([scenario.candidate]);
      const afterDuplicateCheckCount = await countBookItems();
      const checks = {
        seedCountMatches: afterSeedCount === beforeSeedCount + scenario.existing.length,
        singleResult: Boolean(result),
        candidateNotWritten: afterDuplicateCheckCount === afterSeedCount,
        ...resultMatchesScenario(result, scenario),
      };
      if (!checkAllValues(checks)) {
        errors.push(`duplicate smoke scenario failed: ${scenario.scenarioId}`);
      }
      scenarioResults.push({
        scenarioId: scenario.scenarioId,
        seedItemIds,
        result: {
          matchType: result.matchType,
          matchedItemId: result.matchedItemId,
          matchedItemTitle: result.matchedItemTitle,
          matchConfidence: result.matchConfidence,
          matchReason: result.matchReason,
          importDecision: expectedImportDecision(result),
        },
        checks,
      });
    }

    const oneShotPrefsCleared = disableDuplicateSmokeRequest();
    const checks = {
      payloadFileRead: true,
      dryRunMode: payloadFile.executionMode === "dry-run",
      disposableDataDirectory,
      scenarioCountMatches: scenarioResults.length === payloadFile.scenarios.length,
      scenariosPass: scenarioResults.every((scenario) => checkAllValues(scenario.checks)),
      noNetworkRequests: networkGuard.requests.length === 0,
      oneShotPrefsCleared,
    };
    const passed = checkAllValues(checks) && errors.length === 0;

    await writeJsonFile(resultPath, {
      schemaVersion: 1,
      mode: "zotero-duplicate-dry-addon",
      timestamp: new Date().toISOString(),
      startedAt,
      completedAt: new Date().toISOString(),
      passed,
      executionMode: payloadFile.executionMode,
      zoteroDataDirectory: dataDirectory,
      payloadPath,
      checks,
      scenarioResults,
      errors,
      networkRequests: networkGuard.requests,
    });
  } catch (error: any) {
    const oneShotPrefsCleared = disableDuplicateSmokeRequest();
    await writeJsonFile(resultPath, {
      schemaVersion: 1,
      mode: "zotero-duplicate-dry-addon",
      timestamp: new Date().toISOString(),
      startedAt,
      completedAt: new Date().toISOString(),
      passed: false,
      executionMode: "dry-run",
      payloadPath,
      checks: {
        noNetworkRequests: networkGuard.requests.length === 0,
        oneShotPrefsCleared,
      },
      scenarioResults,
      errors: [error?.message || String(error), ...errors],
      networkRequests: networkGuard.requests,
    });
  } finally {
    networkGuard.restore();
  }
}
