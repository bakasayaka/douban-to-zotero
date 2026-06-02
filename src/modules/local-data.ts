import { clearCache, getCacheDirectory } from "./fetch-cache";
import {
  clearOpenAICompatibleApiKey,
  getOpenAICompatibleSettings,
  saveReadlists,
  setOpenAICompatibleSettings,
} from "./preferences";

const PLUGIN_LOG_DIR_NAME = "douban-to-zotero-logs";

export type LocalDataClearStatus =
  | "cleared"
  | "failed"
  | "not-found"
  | "skipped";

export interface ClearLocalDataOptions {
  temporaryFetchCache: boolean;
  pluginLogs: boolean;
  savedReadlists: boolean;
  openAISettings: boolean;
  openAIApiKey: boolean;
}

export interface ClearLocalDataResult {
  temporaryFetchCache: LocalDataClearStatus;
  pluginLogs: LocalDataClearStatus;
  savedReadlists: LocalDataClearStatus;
  openAISettings: LocalDataClearStatus;
  openAIApiKey: LocalDataClearStatus;
}

export function getPluginLogDirectory(): string {
  return PathUtils.join(Zotero.DataDirectory.dir, PLUGIN_LOG_DIR_NAME);
}

async function removeDirectoryIfPresent(path: string): Promise<LocalDataClearStatus> {
  try {
    if (!(await IOUtils.exists(path))) return "not-found";
    await IOUtils.remove(path, { recursive: true });
    return "cleared";
  } catch (e: any) {
    Zotero.log(
      `[Douban-to-Zotero] Local data cleanup failed for ${path}: ${e?.message || String(e)}`,
      "warning",
    );
    return "failed";
  }
}

async function clearTemporaryFetchCache(
  enabled: boolean,
): Promise<LocalDataClearStatus> {
  if (!enabled) return "skipped";
  try {
    if (!(await IOUtils.exists(getCacheDirectory()))) return "not-found";
  } catch {
    // Fall through to clearCache(), which logs the actionable failure details.
  }
  return (await clearCache()) ? "cleared" : "failed";
}

export async function clearLocalData(
  options: ClearLocalDataOptions,
): Promise<ClearLocalDataResult> {
  const result: ClearLocalDataResult = {
    temporaryFetchCache: await clearTemporaryFetchCache(
      options.temporaryFetchCache,
    ),
    pluginLogs: options.pluginLogs
      ? await removeDirectoryIfPresent(getPluginLogDirectory())
      : "skipped",
    savedReadlists: "skipped",
    openAISettings: "skipped",
    openAIApiKey: "skipped",
  };

  if (options.savedReadlists) {
    saveReadlists([]);
    result.savedReadlists = "cleared";
  }

  if (options.openAISettings) {
    const currentSettings = getOpenAICompatibleSettings();
    setOpenAICompatibleSettings({
      baseUrl: "",
      model: "",
      apiKey: options.openAIApiKey ? "" : currentSettings.apiKey,
    });
    result.openAISettings = "cleared";
    result.openAIApiKey = options.openAIApiKey ? "cleared" : "skipped";
  } else if (options.openAIApiKey) {
    clearOpenAICompatibleApiKey();
    result.openAIApiKey = "cleared";
  }

  return result;
}
