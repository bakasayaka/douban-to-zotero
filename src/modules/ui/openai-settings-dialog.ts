import {
  getOpenAICompatibleSettings,
  setOpenAICompatibleSettings,
} from "../preferences";
import { requiredElement } from "./dialog-helpers";

export function showOpenAISettingsDialog(win: Window): void {
  (win as any).openDialog(
    "chrome://doubantozoter/content/openai-settings-dialog.xhtml",
    "douban-openai-settings",
    "chrome,dialog,modal,centerscreen,resizable",
    { init: OpenAISettingsDialogUI.init },
  );
}

export class OpenAISettingsDialogUI {
  static init(dialogWin: Window): void {
    const doc = dialogWin.document;
    const baseUrl = requiredElement<HTMLInputElement>(doc, "openai-base-url");
    const model = requiredElement<HTMLInputElement>(doc, "openai-model");
    const apiKey = requiredElement<HTMLInputElement>(doc, "openai-api-key");
    const status = requiredElement<HTMLElement>(doc, "openai-status");
    let current = getOpenAICompatibleSettings();

    function renderStatus(): void {
      status.textContent = current.apiKey
        ? "API key is configured. It will not be shown in diagnostics."
        : "API key is not configured.";
    }

    baseUrl.value = current.baseUrl;
    model.value = current.model;
    apiKey.value = "";
    apiKey.placeholder = current.apiKey
      ? "API key configured; paste a new key to replace it"
      : "Paste API key";
    renderStatus();

    requiredElement(doc, "btn-save-openai-settings").addEventListener("click", () => {
      current = {
        baseUrl: baseUrl.value.trim(),
        model: model.value.trim(),
        apiKey: apiKey.value.trim() || current.apiKey,
      };
      setOpenAICompatibleSettings(current);
      apiKey.value = "";
      apiKey.placeholder = current.apiKey
        ? "API key configured; paste a new key to replace it"
        : "Paste API key";
      renderStatus();
    });

    requiredElement(doc, "btn-clear-openai-key").addEventListener("click", () => {
      current = { ...current, apiKey: "" };
      setOpenAICompatibleSettings(current);
      apiKey.value = "";
      apiKey.placeholder = "Paste API key";
      renderStatus();
    });

    requiredElement(doc, "btn-close-openai-settings").addEventListener("click", () => {
      dialogWin.close();
    });
  }
}
