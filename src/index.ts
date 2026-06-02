import { Hooks } from "./hooks";
import { SyncDialogUI } from "./modules/ui/sync-dialog";
import { ClearLocalDataDialogUI } from "./modules/ui/clear-local-data-dialog";
import { DiagnosticsDialogUI } from "./modules/ui/diagnostics-dialog";
import { OpenAISettingsDialogUI } from "./modules/ui/openai-settings-dialog";
import { ReadlistsDialogUI } from "./modules/ui/readlists-dialog";

// Expose to global scope for bootstrap.js and dialog onload handlers
export {
  ClearLocalDataDialogUI,
  DiagnosticsDialogUI,
  Hooks,
  OpenAISettingsDialogUI,
  ReadlistsDialogUI,
  SyncDialogUI,
};
