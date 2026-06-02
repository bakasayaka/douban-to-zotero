import {
  getDoubanUid,
  getReadlists,
  normalizeReadlistInput,
  setDoubanUid,
  type ReadlistConfig,
} from "./modules/preferences";
import { fetchWishList } from "./modules/fetcher";
import { parseBookDetail } from "./modules/parser";
import { checkDuplicates } from "./modules/deduplicator";
import { writeBooks } from "./modules/writer";
import { showSyncDialog } from "./modules/ui/sync-dialog";
import { showProgress } from "./modules/ui/progress";
import { loadCacheIndex, clearCache, formatCacheTime } from "./modules/fetch-cache";
import { runDevZoteroDuplicateSmokeIfRequested } from "./modules/dev-zotero-duplicate-smoke";
import { runDevZoteroWriteSmokeIfRequested } from "./modules/dev-zotero-write-smoke";
import { showReadlistsDialog } from "./modules/ui/readlists-dialog";
import { showOpenAISettingsDialog } from "./modules/ui/openai-settings-dialog";
import { showDiagnosticsDialog } from "./modules/ui/diagnostics-dialog";
import { showClearLocalDataDialog } from "./modules/ui/clear-local-data-dialog";
import type { BookMetadata } from "./types";

const menuIds: string[] = [];
let addonRootURI = "";
let preferencePaneRegistered = false;

const E2E_RESULT_PATH_PREF = "__prefsPrefix__.e2eResultPath";
const ADDON_MENU_ID = "douban-to-zotero-menu";

function getDevE2EResultPath(): string {
  if (!__DEV__) return "";
  try {
    const value = Zotero.Prefs.get(E2E_RESULT_PATH_PREF, true);
    return typeof value === "string" ? value.trim() : "";
  } catch (e: any) {
    Zotero.log(
      `[Douban-to-Zotero] E2E result path pref could not be read: ${e?.message || String(e)}`,
      "warning",
    );
    return "";
  }
}

async function writeDevE2EState(win: Window, phase: string) {
  const resultPath = getDevE2EResultPath();
  if (!resultPath) return;

  try {
    const doc = win.document;
    await IOUtils.writeUTF8(
      resultPath,
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          phase,
          buildMode: "development",
          addonRootURI,
          preferencePaneRegistered,
          toolsPopupPresent: Boolean(doc.getElementById("menu_ToolsPopup")),
          toolsMenuItemPresent: Boolean(doc.getElementById(ADDON_MENU_ID)),
          readlistsMenuItemPresent: Boolean(
            doc.getElementById("douban-to-zotero-readlists"),
          ),
          openAISettingsMenuItemPresent: Boolean(
            doc.getElementById("douban-to-zotero-openai-settings"),
          ),
          importReadlistsMenuItemPresent: Boolean(
            doc.getElementById("douban-to-zotero-import-readlists"),
          ),
          diagnosticsMenuItemPresent: Boolean(
            doc.getElementById("douban-to-zotero-diagnostics"),
          ),
          clearLocalDataMenuItemPresent: Boolean(
            doc.getElementById("douban-to-zotero-clear-local-data"),
          ),
          clearCacheMenuItemPresent: Boolean(
            doc.getElementById("douban-to-zotero-clear-local-data"),
          ),
          zoteroDataDirectory: Zotero.DataDirectory.dir,
        },
        null,
        2,
      ),
    );
    Zotero.log(`[Douban-to-Zotero] E2E state written to ${resultPath}`);
  } catch (e: any) {
    Zotero.log(
      `[Douban-to-Zotero] E2E state write failed: ${e?.message || String(e)}`,
      "warning",
    );
  }
}

function pickCollection(win: Window): { cancelled: boolean; collectionId?: number } {
  const libraryID = Zotero.Libraries.userLibraryID;
  const collections = Zotero.Collections.getByLibrary(libraryID);
  const names: string[] = ["My Library (no collection)"];
  const ids: (number | undefined)[] = [undefined];

  function addCollection(col: any, depth: number) {
    names.push("  ".repeat(depth) + col.name);
    ids.push(col.id);
    const children = Zotero.Collections.getByParent(col.id);
    for (const child of children) {
      addCollection(child, depth + 1);
    }
  }

  for (const col of collections) {
    if (!col.parentID) {
      addCollection(col, 0);
    }
  }

  const selected = { value: 0 };
  const ok = Services.prompt.select(
    win,
    "Douban to Zotero",
    "Choose the target Zotero collection.",
    names,
    selected,
  );

  if (!ok) return { cancelled: true };
  return { cancelled: false, collectionId: ids[selected.value] };
}

function readlistLabel(readlist: ReadlistConfig): string {
  return readlist.label
    ? `${readlist.label} (${readlist.uid})`
    : `${readlist.uid} - ${readlist.url}`;
}

function createMenuItem(
  doc: Document,
  id: string,
  label: string,
  command: () => void,
): Element {
  const menuItem = (doc as any).createXULElement("menuitem") as Element;
  menuItem.id = id;
  menuItem.setAttribute("label", label);
  menuItem.addEventListener("command", command);
  return menuItem;
}

function appendAddonSubmenu(win: Window): void {
  const doc = win.document;
  const toolsPopup = doc.getElementById("menu_ToolsPopup");
  if (!toolsPopup) {
    Zotero.log("[Douban-to-Zotero] Tools menu popup was not found", "warning");
    return;
  }

  const menu = (doc as any).createXULElement("menu") as Element;
  menu.id = ADDON_MENU_ID;
  menu.setAttribute("label", "Douban to Zotero");

  const popup = (doc as any).createXULElement("menupopup") as Element;
  popup.id = "douban-to-zotero-menu-popup";
  menu.appendChild(popup);

  popup.appendChild(
    createMenuItem(doc, "douban-to-zotero-readlists", "Readlists...", () =>
      showReadlistsDialog(win),
    ),
  );
  popup.appendChild(
    createMenuItem(
      doc,
      "douban-to-zotero-openai-settings",
      "OpenAI-compatible Settings...",
      () => showOpenAISettingsDialog(win),
    ),
  );
  popup.appendChild(
    createMenuItem(doc, "douban-to-zotero-import-readlists", "Import Readlists...", () =>
      Hooks.startConfiguredReadlistImport(win),
    ),
  );
  popup.appendChild(
    createMenuItem(
      doc,
      "douban-to-zotero-diagnostics",
      "Diagnostics and Logs...",
      () => showDiagnosticsDialog(win),
    ),
  );
  popup.appendChild(
    createMenuItem(doc, "douban-to-zotero-clear-local-data", "Clear Local Data...", () =>
      showClearLocalDataDialog(win),
    ),
  );

  toolsPopup.appendChild(menu);
  menuIds.push(menu.id);
}

function promptForUid(win: Window): string {
  const result = { value: "" };
  const ok = Services.prompt.prompt(
    win,
    "Douban UID",
    "Enter the Douban UID from a public wish-list URL.",
    result,
    null,
    {},
  );
  if (!ok) return "";
  const normalized = normalizeReadlistInput(result.value);
  return normalized?.uid ?? result.value.trim();
}

export class Hooks {
  static async onStartup(rootURI: string) {
    addonRootURI = rootURI;

    Zotero.PreferencePanes.register({
      pluginID: "__addonID__",
      src: rootURI + "content/preferences.xhtml",
      label: "Douban to Zotero",
    });
    preferencePaneRegistered = true;

    await runDevZoteroDuplicateSmokeIfRequested();
    await runDevZoteroWriteSmokeIfRequested();
  }

  static onShutdown() {
    // Runtime cleanup is handled by Zotero window unload hooks.
  }

  static onMainWindowLoad(win: Window) {
    appendAddonSubmenu(win);
    void writeDevE2EState(win, "main-window-load");
  }

  static onMainWindowUnload(win: Window) {
    const doc = win.document;
    for (const id of menuIds) {
      doc.getElementById(id)?.remove();
    }
  }

  static async startConfiguredReadlistImport(win: Window) {
    const readlists = getReadlists();
    if (readlists.length === 0) {
      const openConfig = Services.prompt.confirm(
        win,
        "Douban to Zotero",
        "No Douban readlists are configured. Open the Readlists panel now?",
      );
      if (openConfig) showReadlistsDialog(win);
      return;
    }

    let readlist = readlists[0];
    if (readlists.length > 1) {
      const selected = { value: 0 };
      const ok = Services.prompt.select(
        win,
        "Douban to Zotero",
        "Select a readlist to import.",
        readlists.map(readlistLabel),
        selected,
      );
      if (!ok) return;
      readlist = readlists[selected.value];
    }

    await Hooks.startWishListSync(win, readlist.uid);
  }

  static async startWishListSync(win: Window, requestedUid?: string) {
    let uid = requestedUid?.trim() || getDoubanUid();
    if (!uid) {
      uid = promptForUid(win);
      if (!uid) return;
      setDoubanUid(uid);
    }

    let resumeFromCache = false;
    const cachedIndex = await loadCacheIndex(uid);
    if (cachedIndex?.allLinks && cachedIndex.allLinks.length > 0) {
      const cachedCount = cachedIndex.fetchedUrls.length;
      const totalCount = cachedIndex.allLinks.length;
      const timeStr = formatCacheTime(cachedIndex.timestamp);
      resumeFromCache = Services.prompt.confirm(
        win,
        "Douban to Zotero",
        `Found interrupted fetch progress from ${timeStr}.\n\n` +
          `Cached detail pages: ${cachedCount}/${totalCount}\n\n` +
          "Resume from this temporary cache?",
      );
    }

    if (!resumeFromCache) {
      await clearCache();
    }

    const progressWin = showProgress(win, "Fetching Douban readlist...");

    try {
      const fetchResult = await fetchWishList(
        uid,
        (current, total, msg) => {
          progressWin.update(current, total, msg);
        },
        resumeFromCache ? cachedIndex : null,
      );

      progressWin.close();

      if (fetchResult.warnings.length > 0) {
        Services.prompt.alert(
          win,
          "Douban to Zotero - Fetch warnings",
          fetchResult.warnings.join("\n"),
        );
      }

      if (fetchResult.books.length === 0) {
        Services.prompt.alert(
          win,
          "Douban to Zotero",
          "No visible books were fetched from this readlist.",
        );
        return;
      }

      const books: BookMetadata[] = [];
      const parseErrors: string[] = [];
      for (const raw of fetchResult.books) {
        try {
          books.push(parseBookDetail(raw.html, raw.url));
        } catch (e: any) {
          parseErrors.push(`${raw.url}: ${e?.message || String(e)}`);
          Zotero.log(
            `[Douban-to-Zotero] Parse failed: ${raw.url} - ${e?.message || String(e)}`,
            "warning",
          );
        }
      }

      if (parseErrors.length > 0) {
        Services.prompt.alert(
          win,
          "Douban to Zotero - Parse warnings",
          `${parseErrors.length} page(s) could not be parsed.\n\n` +
            parseErrors.slice(0, 5).join("\n") +
            (parseErrors.length > 5
              ? `\n...and ${parseErrors.length - 5} more.`
              : ""),
        );
      }

      if (books.length === 0) {
        Services.prompt.alert(
          win,
          "Douban to Zotero",
          "No parsed books were eligible for review.",
        );
        return;
      }

      const results = await checkDuplicates(books);
      const selectedBooks = await showSyncDialog(win, results);
      if (selectedBooks.length === 0) return;

      const pick = pickCollection(win);
      if (pick.cancelled) return;

      const writeResult = await writeBooks(selectedBooks, pick.collectionId);

      // Step 7: successful import clears interrupted-fetch cache.
      await clearCache();

      Services.prompt.alert(
        win,
        "Douban to Zotero",
        `Imported ${writeResult.created} book(s).` +
          (writeResult.errors.length > 0
            ? `\n${writeResult.errors.length} item(s) failed.`
            : ""),
      );
    } catch (e: any) {
      progressWin.close();
      Services.prompt.alert(
        win,
        "Douban to Zotero - Import failed",
        e?.message || String(e),
      );
    }
  }

  static async clearImportCache(win: Window) {
    const ok = Services.prompt.confirm(
      win,
      "Douban to Zotero",
      "Clear the temporary Douban import cache?\n\n" +
        "This removes interrupted fetch progress only. It does not remove Zotero items, fixtures, or future audit records.",
    );
    if (!ok) return;

    const cleared = await clearCache();
    Services.prompt.alert(
      win,
      "Douban to Zotero",
      cleared
        ? "Temporary Douban import cache cleared."
        : "Temporary Douban import cache could not be cleared. Check the Zotero log for details.",
    );
  }
}
