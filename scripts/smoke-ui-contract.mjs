import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const rootDir = resolve(import.meta.dirname, "..");

if (
  !process.env.DOUBAN_TO_ZOTERO_EXECUTION_MODE &&
  process.env.npm_lifecycle_event === "smoke:ui:dry"
) {
  process.env.DOUBAN_TO_ZOTERO_EXECUTION_MODE = "dry-run";
}

if (process.env.DOUBAN_TO_ZOTERO_EXECUTION_MODE !== "dry-run") {
  throw new Error("smoke-ui-contract requires DOUBAN_TO_ZOTERO_EXECUTION_MODE=dry-run");
}

function readText(...parts) {
  return readFileSync(join(rootDir, ...parts), "utf-8");
}

const hooks = readText("src", "hooks.ts");
const bootstrap = readText("addon", "bootstrap.js");
const indexTs = readText("src", "index.ts");
const syncDialog = readText("src", "modules", "ui", "sync-dialog.ts");
const readlistsDialog = readText("src", "modules", "ui", "readlists-dialog.ts");
const openaiSettingsDialog = readText("src", "modules", "ui", "openai-settings-dialog.ts");
const diagnosticsDialog = readText("src", "modules", "ui", "diagnostics-dialog.ts");
const clearLocalDataDialog = readText("src", "modules", "ui", "clear-local-data-dialog.ts");
const localData = readText("src", "modules", "local-data.ts");
const diagnostics = readText("src", "modules", "diagnostics.ts");
const preferences = readText("src", "modules", "preferences.ts");
const seriesDialog = readText("src", "modules", "ui", "series-dialog.ts");
const seriesDialogXhtml = readText("addon", "content", "series-dialog.xhtml");
const readlistsDialogXhtml = readText("addon", "content", "readlists-dialog.xhtml");
const openaiSettingsDialogXhtml = readText("addon", "content", "openai-settings-dialog.xhtml");
const diagnosticsDialogXhtml = readText("addon", "content", "diagnostics-dialog.xhtml");
const clearLocalDataDialogXhtml = readText("addon", "content", "clear-local-data-dialog.xhtml");
const addonManifest = JSON.parse(readText("addon", "manifest.json"));
const addonPrefs = readText("addon", "prefs.js");
const writer = readText("src", "modules", "writer.ts");
const devWriteSmoke = readText("src", "modules", "dev-zotero-write-smoke.ts");
const devDuplicateSmoke = readText("src", "modules", "dev-zotero-duplicate-smoke.ts");
const exportWritePayload = readText("scripts", "pipeline", "export-zotero-write-smoke-payload.ts");
const exportDuplicatePayload = readText("scripts", "pipeline", "export-zotero-duplicate-smoke-payload.ts");
const exportReferenceInspectionPayload = readText(
  "scripts",
  "pipeline",
  "export-reference-sample-write-inspection-payload.ts",
);
const exportReadlistReferenceInspectionPayload = readText(
  "scripts",
  "pipeline",
  "export-live-readlist-write-inspection-payload.ts",
);
const populateDryRunDb = readText("scripts", "pipeline", "populate-dry-run-db.ts");
const openaiCleaningScript = readText("scripts", "pipeline", "clean-openai-compatible-to-db.ts");
const openaiCleaningWrapper = readText("scripts", "run-openai-compatible-cleaning.ps1");
const openaiCleaningComparisonScript = readText("scripts", "pipeline", "compare-openai-cleaning-modes.ts");
const openaiCleaningComparisonWrapper = readText("scripts", "run-openai-compatible-cleaning-comparison.ps1");
const openaiComparisonImportScript = readText("scripts", "pipeline", "import-openai-cleaning-comparison-to-db.ts");
const openaiPromotionScript = readText("scripts", "pipeline", "promote-openai-cleaned-records.ts");
const readlistNormalizationReplayScript = readText("scripts", "pipeline", "replay-readlist-normalization-to-db.ts");
const openaiCleaningClient = readText("src", "modules", "openai-compatible-client.ts");
const rootReadme = readText("README.md");
const gitignoreText = readText(".gitignore");
const packageJson = JSON.parse(readText("package.json"));

const writerUsesPayloadHelper = /const payload = createPayloadForIngestEligibleBook\(book\);[\s\S]*createZoteroBookItemFromPayload\(payload, collectionId\)/.test(writer);

const checks = {
  mvpBPublicReadmeScope: rootReadme.includes("The current first-version candidate scope is intentionally narrow") &&
    rootReadme.includes("OpenAI-compatible cleaning is optional and separate from normal import") &&
    rootReadme.includes("This public source tree intentionally excludes"),
  publicSourceBoundaryExcludesInternalVmHarness: rootReadme.includes("internal Hyper-V/Zotero VM E2E harness scripts") &&
    gitignoreText.split(/\r?\n/).map((line) => line.trim()).includes("scripts/vm/"),
  mvpBSubmenuRoot: hooks.includes('const ADDON_MENU_ID = "douban-to-zotero-menu"') &&
    hooks.includes("douban-to-zotero-menu-popup") &&
    hooks.includes("appendAddonSubmenu(win)") &&
    bootstrap.includes('getElementById("douban-to-zotero-menu")'),
  mvpBSubmenuItems: hooks.includes("douban-to-zotero-readlists") &&
    hooks.includes("Readlists...") &&
    hooks.includes("douban-to-zotero-openai-settings") &&
    hooks.includes("OpenAI-compatible Settings...") &&
    hooks.includes("douban-to-zotero-import-readlists") &&
    hooks.includes("Import Readlists...") &&
    hooks.includes("douban-to-zotero-diagnostics") &&
    hooks.includes("Diagnostics and Logs...") &&
    hooks.includes("douban-to-zotero-clear-local-data") &&
    hooks.includes("Clear Local Data..."),
  mvpBDialogExports: indexTs.includes("ReadlistsDialogUI") &&
    indexTs.includes("OpenAISettingsDialogUI") &&
    indexTs.includes("DiagnosticsDialogUI") &&
    indexTs.includes("ClearLocalDataDialogUI"),
  mvpBReadlistsPanel: readlistsDialog.includes("normalizeReadlistInput") &&
    readlistsDialog.includes("addOrUpdateReadlist") &&
    readlistsDialog.includes("deleteReadlist") &&
    readlistsDialogXhtml.includes("readlists-list") &&
    readlistsDialogXhtml.includes("readlist-input") &&
    preferences.includes("readlistsJson") &&
    preferences.includes("normalizeReadlistInput"),
  mvpBOpenAISettingsPanel: openaiSettingsDialog.includes("getOpenAICompatibleSettings") &&
    openaiSettingsDialog.includes("setOpenAICompatibleSettings") &&
    openaiSettingsDialog.includes("API key is configured") &&
    openaiSettingsDialogXhtml.includes("Experimental test feature") &&
    openaiSettingsDialogXhtml.includes("openai-base-url") &&
    openaiSettingsDialogXhtml.includes("openai-model") &&
    openaiSettingsDialogXhtml.includes("openai-api-key"),
  mvpBDiagnosticsPanel: diagnosticsDialog.includes("buildDiagnosticsReport") &&
    diagnosticsDialogXhtml.includes("diagnostics-report") &&
    diagnostics.includes("openAICompatibleApiKeyConfigured") &&
    diagnostics.includes("openAICompatibleApiKey: [redacted]") &&
    diagnostics.includes("redactOpenAICompatibleApiKey"),
  mvpBClearLocalDataPanel: clearLocalDataDialog.includes("clearLocalData") &&
    clearLocalDataDialog.includes("does not remove Zotero library items") &&
    clearLocalDataDialogXhtml.includes("clear-fetch-cache") &&
    clearLocalDataDialogXhtml.includes("clear-plugin-logs") &&
    clearLocalDataDialogXhtml.includes("clear-readlists") &&
    clearLocalDataDialogXhtml.includes("clear-openai-settings") &&
    clearLocalDataDialogXhtml.includes("clear-openai-api-key") &&
    localData.includes("clearCache") &&
    localData.includes("saveReadlists([])") &&
    localData.includes("getOpenAICompatibleSettings") &&
    localData.includes("apiKey: options.openAIApiKey ? \"\" : currentSettings.apiKey") &&
    diagnostics.includes("localDataCleanupExclusions: Zotero library items, fixtures, SQLite DBs, VM artifacts, repository files"),
  mvpBDefaultPrefs: addonPrefs.includes("readlistsJson") &&
    addonPrefs.includes("openaiCompatible.baseUrl") &&
    addonPrefs.includes("openaiCompatible.model") &&
    addonPrefs.includes("openaiCompatible.apiKey"),
  legacyClearImportCacheHelper: hooks.includes("static async clearImportCache") &&
    hooks.includes("Temporary Douban import cache cleared."),
  freshImportClearsCache: hooks.includes("if (!resumeFromCache)") && hooks.includes("await clearCache();"),
  successfulImportClearsCache: hooks.includes("Step 7") && hooks.includes("await clearCache();"),
  zotero9ManifestBaseline: addonManifest.applications?.zotero?.strict_min_version === "9.0" &&
    addonManifest.applications?.zotero?.strict_max_version === "9.*",
  incompleteImportDisabled: syncDialog.includes("validateMinimumBookIngest") && syncDialog.includes("checkbox.disabled = true"),
  seriesDialogIngestGuard: seriesDialog.includes("validateMinimumBookIngest") && seriesDialog.includes("Incomplete metadata"),
  seriesManualDateField: seriesDialogXhtml.includes("manual-publish-date"),
  seriesManualLanguageField: seriesDialogXhtml.includes("manual-language"),
  writerIngestGuard: writer.includes("validateMinimumBookIngest") && writer.includes("Incomplete metadata"),
  writerPayloadHelper: writer.includes("export async function createZoteroBookItemFromPayload") &&
    writer.includes("payload: ZoteroBookPayload"),
  writerPayloadValidation: writer.includes("validateZoteroBookPayload") &&
    writer.includes("Invalid Zotero book payload"),
  writerBookMetadataPayloadHelper: writer.includes("bookToZoteroBookPayload") &&
    writerUsesPayloadHelper,
  unit4DevWriteHook: hooks.includes("runDevZoteroWriteSmokeIfRequested") &&
    devWriteSmoke.includes("writeSmokePayloadPath") &&
    devWriteSmoke.includes("createZoteroBookItemFromPayload"),
  unit4WriteSmokeOneShotSourceGuard: devWriteSmoke.includes("function disableWriteSmokeRequest") &&
    devWriteSmoke.includes("Zotero.Prefs.set(WRITE_SMOKE_ENABLED_PREF, false, true)") &&
    devWriteSmoke.includes("oneShotPrefsCleared"),
  unit4TimestampedCollectionNameSource: populateDryRunDb.includes("--test-name") &&
    populateDryRunDb.includes("--collection-stamp") &&
    populateDryRunDb.includes("testCollectionNameFromStamp") &&
    devWriteSmoke.includes("write smoke target collection name is not run-scoped"),
  unit4ReferenceSamplePayloadExport: packageJson.scripts["smoke:reference-write:payload"] ===
    "node scripts/export-reference-sample-write-inspection-payload.mjs" &&
    exportReferenceInspectionPayload.includes("reference-sample-write-inspection-payload") &&
    exportReferenceInspectionPayload.includes("RS-100") &&
    exportReferenceInspectionPayload.includes("rs-100-reference-samples-write") &&
    exportReferenceInspectionPayload.includes("limit: null") &&
    exportReferenceInspectionPayload.includes("parseBookDetailWithDiagnostics") &&
    devWriteSmoke.includes("reference-sample-write-inspection-payload"),
  unit4ReadlistReferencePayloadExport: packageJson.scripts["smoke:readlist-reference-write:payload"] ===
    "node scripts/export-live-readlist-write-inspection-payload.mjs" &&
    exportReadlistReferenceInspectionPayload.includes("cleaned_records") &&
    exportReadlistReferenceInspectionPayload.includes("raw_scraped_records") &&
    exportReadlistReferenceInspectionPayload.includes("sourceRecordCount") &&
    exportReadlistReferenceInspectionPayload.includes("reference-sample-write-inspection-payload") &&
    exportReadlistReferenceInspectionPayload.includes("FRL-95") &&
    exportReadlistReferenceInspectionPayload.includes("frl-95-reference-samples-write") &&
    exportReadlistReferenceInspectionPayload.includes("Readlist sample:"),
  unit4ZoteroDuplicateDryHook: packageJson.scripts["smoke:zotero-duplicate:payload"] ===
    "node scripts/export-zotero-duplicate-smoke-payload.mjs" &&
    hooks.includes("runDevZoteroDuplicateSmokeIfRequested") &&
    devDuplicateSmoke.includes("duplicateSmokePayloadPath") &&
    devDuplicateSmoke.includes("checkDuplicates") &&
    devDuplicateSmoke.includes("createZoteroBookItemFromPayload") &&
    devDuplicateSmoke.includes("candidateNotWritten") &&
    devDuplicateSmoke.includes("review-suspect"),
  unit4PayloadExportPreparedOnly: exportWritePayload.includes("ir.status = 'prepared'") &&
    exportWritePayload.includes("validateZoteroBookPayload") &&
    exportWritePayload.includes("networkRequests === 0") &&
    exportWritePayload.includes("--import-run-id"),
  unit4DuplicatePayloadCoverage: exportDuplicatePayload.includes("isbn13-incoming-vs-isbn13-existing") &&
    exportDuplicatePayload.includes("isbn10-incoming-vs-isbn13-existing") &&
    exportDuplicatePayload.includes("isbn13-incoming-vs-isbn10-existing") &&
    exportDuplicatePayload.includes("title-publisher-year-fuzzy-duplicate") &&
    exportDuplicatePayload.includes("same-title-different-publisher-year-new") &&
    exportDuplicatePayload.includes("near-title-review-required-suspect") &&
    exportDuplicatePayload.includes("review-suspect") &&
    exportDuplicatePayload.includes("eligible-new"),
  openaiCleaningScriptEntry: packageJson.scripts["db:clean:openai-compatible"] ===
    "node scripts/clean-openai-compatible-to-db.mjs",
  openaiCleaningLiveGuard: openaiCleaningScript.includes('DOUBAN_TO_ZOTERO_EXECUTION_MODE !== "live"') &&
    openaiCleaningScript.includes("--confirm-live") &&
    openaiCleaningScript.includes("OPENAI_COMPATIBLE_API_KEY"),
  openaiCleaningDbIntegration: openaiCleaningScript.includes("OpenAICompatibleMetadataCleaner") &&
    openaiCleaningScript.includes('"openai-compatible"') &&
    openaiCleaningScript.includes("INSERT INTO cleaning_runs") &&
    openaiCleaningScript.includes("INSERT INTO cleaned_records"),
  openaiCleaningDrySourceGuard: openaiCleaningScript.includes("--allow-dry-source") &&
    openaiCleaningScript.includes("Source pipeline is dry-run"),
  openaiCleaningPlaintextWrapper: openaiCleaningWrapper.includes('$BaseUrl = "PASTE_YOUR_OPENAI_COMPATIBLE_BASE_URL_HERE"') &&
    openaiCleaningWrapper.includes('$Model = "PASTE_YOUR_MODEL_HERE"') &&
    openaiCleaningWrapper.includes('$ApiKey = "PASTE_YOUR_API_KEY_HERE"') &&
    openaiCleaningWrapper.includes('Set `$BaseUrl at the top') &&
    openaiCleaningWrapper.includes('Set `$Model at the top') &&
    openaiCleaningWrapper.includes("npm @args"),
  openaiCleaningNoKeyPersistence: openaiCleaningScript.includes("const apiKey = process.env[options.apiKeyEnv] ?? \"\"") &&
    openaiCleaningScript.includes("apiKey,") &&
    openaiCleaningScript.includes("settings_json") &&
    !openaiCleaningScript.includes("apiKeyEnv,") &&
    !openaiCleaningScript.includes("apiKey: options") &&
    !openaiCleaningScript.includes("apiKey: options.apiKey"),
  openaiCleaningKeyRedaction: openaiCleaningClient.includes("redactOpenAICompatibleApiKey") &&
    openaiCleaningClient.includes("OPENAI_COMPATIBLE_REDACTED_API_KEY") &&
    openaiCleaningScript.includes("persistenceSafeErrorMessage") &&
    openaiCleaningScript.includes("redactOpenAICompatibleApiKey(message, apiKey)"),
  openaiCleaningComparisonScriptEntry: packageJson.scripts["reference:cleaning:compare"] ===
    "node scripts/compare-openai-cleaning-modes.mjs",
  openaiCleaningComparisonLiveGuard: openaiCleaningComparisonScript.includes('DOUBAN_TO_ZOTERO_EXECUTION_MODE !== "live"') &&
    openaiCleaningComparisonScript.includes("--confirm-live") &&
    openaiCleaningComparisonScript.includes("OPENAI_COMPATIBLE_API_KEY"),
  openaiCleaningComparisonPlaintextWrapper: openaiCleaningComparisonWrapper.includes('$BaseUrl = "PASTE_YOUR_OPENAI_COMPATIBLE_BASE_URL_HERE"') &&
    openaiCleaningComparisonWrapper.includes('$Model = "PASTE_YOUR_MODEL_HERE"') &&
    openaiCleaningComparisonWrapper.includes('$ApiKey = "PASTE_YOUR_API_KEY_HERE"') &&
    openaiCleaningComparisonWrapper.includes('Set `$BaseUrl at the top') &&
    openaiCleaningComparisonWrapper.includes('Set `$Model at the top') &&
    openaiCleaningComparisonWrapper.includes("npm @args"),
  openaiCleaningComparisonRestrictedPolicy: openaiCleaningComparisonScript.includes("PROTECTED_RESTRICTED_FIELDS") &&
    openaiCleaningComparisonScript.includes('mode === "restricted"') &&
    openaiCleaningComparisonScript.includes("rejectedChangedFields") &&
    openaiCleaningComparisonScript.includes("HIGH_RISK_FIELDS"),
  openaiCleaningComparisonKeyRedaction: openaiCleaningComparisonScript.includes("redactOpenAICompatibleApiKey") &&
    openaiCleaningComparisonScript.includes("request-log.json") &&
    !openaiCleaningComparisonScript.includes("apiKey: options") &&
    !openaiCleaningComparisonScript.includes("apiKey: process.env"),
  openaiCleanedPromotionScriptEntry: packageJson.scripts["db:promote:openai-cleaned"] ===
    "node scripts/promote-openai-cleaned-records.mjs",
  openaiComparisonImportScriptEntry: packageJson.scripts["db:import:openai-comparison"] ===
    "node scripts/import-openai-cleaning-comparison-to-db.mjs",
  openaiComparisonImportNoNetwork: openaiComparisonImportScript.includes("OpenAI comparison artifact import forbids network access") &&
    openaiComparisonImportScript.includes("networkRequests: 0") &&
    !openaiComparisonImportScript.includes("OpenAICompatibleMetadataCleaner") &&
    !openaiComparisonImportScript.includes("FetchOpenAICompatibleTransport") &&
    !openaiComparisonImportScript.includes("ZoteroOpenAICompatibleTransport"),
  openaiComparisonImportWritesReviewDb: openaiComparisonImportScript.includes("INSERT INTO pipeline_runs") &&
    openaiComparisonImportScript.includes("INSERT INTO raw_scraped_records") &&
    openaiComparisonImportScript.includes("INSERT INTO cleaning_runs") &&
    openaiComparisonImportScript.includes("INSERT INTO cleaned_records") &&
    openaiComparisonImportScript.includes("cleaning-openai-${options.mode}-comparison"),
  openaiCleanedPromotionReviewBoundary: openaiPromotionScript.includes("restricted-safe-v1") &&
    openaiPromotionScript.includes("PROTECTED_FIELDS") &&
    openaiPromotionScript.includes("--apply requires --review-manifest") &&
    openaiPromotionScript.includes("decision !== \"accept\"") &&
    openaiPromotionScript.includes("protected-field-changed"),
  openaiCleanedPromotionNoNetwork: openaiPromotionScript.includes("OpenAI-cleaned promotion forbids network access") &&
    !openaiPromotionScript.includes("OpenAICompatibleMetadataCleaner") &&
    !openaiPromotionScript.includes("FetchOpenAICompatibleTransport") &&
    !openaiPromotionScript.includes("ZoteroOpenAICompatibleTransport"),
  openaiCleanedPromotionWritesImportRecords: openaiPromotionScript.includes("INSERT INTO export_records") &&
    openaiPromotionScript.includes("INSERT INTO import_records") &&
    openaiPromotionScript.includes("bookToZoteroBookPayload") &&
    openaiPromotionScript.includes("validateZoteroBookPayload") &&
    openaiPromotionScript.includes("targetCollectionName"),
  readlistNormalizationReplayNoNetwork: packageJson.scripts["db:replay:readlist-normalization"] ===
    "node scripts/replay-readlist-normalization-to-db.mjs" &&
    readlistNormalizationReplayScript.includes("--confirm-no-network") &&
    readlistNormalizationReplayScript.includes("readlist-normalization-replay-v1") &&
    readlistNormalizationReplayScript.includes('cleaner_kind, provider, model') &&
    readlistNormalizationReplayScript.includes('"replay"') &&
    readlistNormalizationReplayScript.includes('"none"') &&
    readlistNormalizationReplayScript.includes('const PRESERVED_MODEL_FIELDS = ["language"]') &&
    readlistNormalizationReplayScript.includes("networkRequests: 0") &&
    !readlistNormalizationReplayScript.includes("OpenAICompatibleMetadataCleaner") &&
    !readlistNormalizationReplayScript.includes("FetchOpenAICompatibleTransport") &&
    !readlistNormalizationReplayScript.includes("ZoteroOpenAICompatibleTransport"),
  publicSourceExcludesInternalEvidence: rootReadme.includes("parser-golden raw HTML") &&
    rootReadme.includes("internal development docs") &&
    rootReadme.includes("full readlist-study manifests") &&
    rootReadme.includes("internal Hyper-V/Zotero VM E2E harness scripts") &&
    rootReadme.includes("API keys"),
  publicSmokeDoesNotRequireVmHarnessFiles: !existsSync(
    join(rootDir, "scripts", "vm", "this-file-is-required-by-public-smoke.ps1"),
  ),
};

const failed = Object.entries(checks)
  .filter(([, passed]) => !passed)
  .map(([name]) => name);

if (failed.length > 0) {
  throw new Error(`UI smoke contract failed: ${failed.join(", ")}`);
}

process.stdout.write(`${JSON.stringify({
  executionMode: "dry-run",
  checks,
}, null, 2)}\n`);
