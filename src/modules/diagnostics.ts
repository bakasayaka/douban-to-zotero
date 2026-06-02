import { getCacheDirectory } from "./fetch-cache";
import { getPluginLogDirectory } from "./local-data";
import {
  getOpenAICompatibleSettings,
  getReadlists,
} from "./preferences";
import { redactOpenAICompatibleApiKey } from "./openai-compatible-client";

function boolLabel(value: boolean): string {
  return value ? "yes" : "no";
}

export function buildDiagnosticsReport(): string {
  const readlists = getReadlists();
  const openAISettings = getOpenAICompatibleSettings();
  const apiKeyConfigured = Boolean(openAISettings.apiKey);
  const lines = [
    "Douban to Zotero Diagnostics",
    `generatedAt: ${new Date().toISOString()}`,
    `addonId: __addonID__`,
    `zoteroVersion: ${String((Zotero as any).version ?? "unknown")}`,
    `dataDirectory: ${Zotero.DataDirectory.dir}`,
    `fetchCacheDirectory: ${getCacheDirectory()}`,
    `pluginLogDirectory: ${getPluginLogDirectory()}`,
    `readlistCount: ${readlists.length}`,
    `readlistUids: ${readlists.map((readlist) => readlist.uid).join(", ") || "(none)"}`,
    `openAICompatibleBaseUrl: ${openAISettings.baseUrl || "(not configured)"}`,
    `openAICompatibleModel: ${openAISettings.model || "(not configured)"}`,
    `openAICompatibleApiKeyConfigured: ${boolLabel(apiKeyConfigured)}`,
    "openAICompatibleApiKey: [redacted]",
    "localDataCleanupScope: fetch cache, plugin logs, saved readlists, OpenAI-compatible settings, API key",
    "localDataCleanupExclusions: Zotero library items, fixtures, SQLite DBs, VM artifacts, repository files",
  ];

  return redactOpenAICompatibleApiKey(lines.join("\n"), openAISettings.apiKey);
}
