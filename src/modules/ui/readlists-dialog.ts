import {
  addOrUpdateReadlist,
  deleteReadlist,
  getReadlists,
  normalizeReadlistInput,
  type ReadlistConfig,
} from "../preferences";
import { requiredElement } from "./dialog-helpers";

export function showReadlistsDialog(win: Window): void {
  (win as any).openDialog(
    "chrome://doubantozoter/content/readlists-dialog.xhtml",
    "douban-readlists",
    "chrome,dialog,modal,centerscreen,resizable",
    { init: ReadlistsDialogUI.init },
  );
}

function describeReadlist(readlist: ReadlistConfig): string {
  return readlist.label
    ? `${readlist.label} (${readlist.uid})`
    : `${readlist.uid} - ${readlist.url}`;
}

export class ReadlistsDialogUI {
  static init(dialogWin: Window): void {
    const doc = dialogWin.document;
    const list = requiredElement<HTMLSelectElement>(doc, "readlists-list");
    const input = requiredElement<HTMLInputElement>(doc, "readlist-input");
    const labelInput = requiredElement<HTMLInputElement>(doc, "readlist-label-input");
    const canonical = requiredElement<HTMLElement>(doc, "readlist-canonical");
    const status = requiredElement<HTMLElement>(doc, "readlists-status");

    function setStatus(message: string): void {
      status.textContent = message;
    }

    function render(readlists = getReadlists()): void {
      const selectedUid = list.value;
      list.innerHTML = "";
      for (const readlist of readlists) {
        const option = doc.createElement("option");
        option.value = readlist.uid;
        option.textContent = describeReadlist(readlist);
        list.appendChild(option);
      }
      if (selectedUid && readlists.some((readlist) => readlist.uid === selectedUid)) {
        list.value = selectedUid;
      }
      canonical.textContent =
        readlists.length === 0
          ? "No readlists configured."
          : `${readlists.length} readlist(s) configured.`;
    }

    function updateCanonicalPreview(): void {
      const normalized = normalizeReadlistInput(input.value);
      canonical.textContent = normalized
        ? `Canonical URL: ${normalized.url}`
        : "Enter a Douban UID or a https://book.douban.com/people/{uid}/wish URL.";
    }

    input.addEventListener("input", updateCanonicalPreview);
    requiredElement(doc, "btn-add-readlist").addEventListener("click", () => {
      const normalized = normalizeReadlistInput(input.value);
      if (!normalized) {
        setStatus("Readlist input must be a Douban UID or public wish-list URL.");
        return;
      }
      const label = labelInput.value.trim();
      const readlists = addOrUpdateReadlist({
        ...normalized,
        ...(label ? { label } : {}),
      });
      input.value = "";
      labelInput.value = "";
      render(readlists);
      list.value = normalized.uid;
      setStatus(`Saved readlist ${normalized.uid}.`);
    });

    requiredElement(doc, "btn-delete-readlist").addEventListener("click", () => {
      if (!list.value) {
        setStatus("Select a readlist to delete.");
        return;
      }
      const uid = list.value;
      const readlists = deleteReadlist(uid);
      render(readlists);
      setStatus(`Deleted readlist ${uid}.`);
    });

    requiredElement(doc, "btn-close-readlists").addEventListener("click", () => {
      dialogWin.close();
    });

    render();
    updateCanonicalPreview();
  }
}
