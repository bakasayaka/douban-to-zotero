import { clearLocalData, type ClearLocalDataResult } from "../local-data";
import { requiredElement } from "./dialog-helpers";

export function showClearLocalDataDialog(win: Window): void {
  (win as any).openDialog(
    "chrome://doubantozoter/content/clear-local-data-dialog.xhtml",
    "douban-clear-local-data",
    "chrome,dialog,modal,centerscreen,resizable",
    { init: ClearLocalDataDialogUI.init },
  );
}

function formatResult(result: ClearLocalDataResult): string {
  return [
    `Temporary fetch cache: ${result.temporaryFetchCache}`,
    `Plugin logs: ${result.pluginLogs}`,
    `Saved readlists: ${result.savedReadlists}`,
    `OpenAI-compatible settings: ${result.openAISettings}`,
    `OpenAI-compatible API key: ${result.openAIApiKey}`,
  ].join("\n");
}

export class ClearLocalDataDialogUI {
  static init(dialogWin: Window): void {
    const doc = dialogWin.document;
    const cache = requiredElement<HTMLInputElement>(doc, "clear-fetch-cache");
    const logs = requiredElement<HTMLInputElement>(doc, "clear-plugin-logs");
    const readlists = requiredElement<HTMLInputElement>(doc, "clear-readlists");
    const openAISettings = requiredElement<HTMLInputElement>(
      doc,
      "clear-openai-settings",
    );
    const openAIApiKey = requiredElement<HTMLInputElement>(doc, "clear-openai-api-key");
    const status = requiredElement<HTMLElement>(doc, "clear-local-data-status");

    requiredElement(doc, "btn-apply-clear-local-data").addEventListener(
      "click",
      async () => {
        const ok = Services.prompt.confirm(
          dialogWin,
          "Douban to Zotero",
          "Clear the selected local plugin data?\n\nThis does not remove Zotero library items, fixtures, SQLite DBs, VM artifacts, or repository files.",
        );
        if (!ok) return;

        status.textContent = "Clearing selected local data...";
        const result = await clearLocalData({
          temporaryFetchCache: cache.checked,
          pluginLogs: logs.checked,
          savedReadlists: readlists.checked,
          openAISettings: openAISettings.checked,
          openAIApiKey: openAIApiKey.checked,
        });
        status.textContent = formatResult(result);
      },
    );

    requiredElement(doc, "btn-close-clear-local-data").addEventListener("click", () => {
      dialogWin.close();
    });
  }
}
