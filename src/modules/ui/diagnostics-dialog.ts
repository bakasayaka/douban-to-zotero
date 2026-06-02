import { buildDiagnosticsReport } from "../diagnostics";
import { requiredElement } from "./dialog-helpers";

export function showDiagnosticsDialog(win: Window): void {
  (win as any).openDialog(
    "chrome://doubantozoter/content/diagnostics-dialog.xhtml",
    "douban-diagnostics",
    "chrome,dialog,modal,centerscreen,resizable",
    { init: DiagnosticsDialogUI.init },
  );
}

export class DiagnosticsDialogUI {
  static init(dialogWin: Window): void {
    const doc = dialogWin.document;
    const report = requiredElement<HTMLTextAreaElement>(doc, "diagnostics-report");

    function refresh(): void {
      report.value = buildDiagnosticsReport();
    }

    requiredElement(doc, "btn-refresh-diagnostics").addEventListener("click", refresh);
    requiredElement(doc, "btn-close-diagnostics").addEventListener("click", () => {
      dialogWin.close();
    });
    refresh();
  }
}
