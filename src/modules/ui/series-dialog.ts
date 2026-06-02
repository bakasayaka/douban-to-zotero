import type { BookMetadata, Creator, VolumeEntry } from "../../types";
import {
  SUPPORTED_BOOK_LANGUAGE_CODES,
  validateMinimumBookIngest,
} from "../ingest-validator";
import { createLiveDoubanSource } from "../douban-source";
import { generateVolumesFromFiles, matchFiles } from "../file-matcher";
import { parseBookDetail } from "../parser";
import { fetchSeriesVolumes } from "../series-fetcher";
import { writeBooksWithAttachments } from "../writer";
import { parseCreatorList } from "../../utils/name-utils";
import { showProgress } from "./progress";

type CreatorInputType = "author" | "editor" | "translator";

interface SeriesDialogArgs {
  parentWin: Window;
  resolve: () => void;
}

interface ManualSharedMetadata {
  seriesName: string;
  creators: Creator[];
  publisher: string;
  publishDate: string;
  language: string;
}

function requiredElement<T extends Element = Element>(
  doc: Document,
  id: string,
): T {
  const element = doc.getElementById(id);
  if (!element) {
    throw new Error(`Series dialog is missing required element #${id}`);
  }
  return element as unknown as T;
}

function inputValue(doc: Document, id: string): string {
  return requiredElement<HTMLInputElement>(doc, id).value.trim();
}

function formatCreatorsForDisplay(
  creators: Creator[],
  role: Creator["creatorType"],
): string {
  return creators
    .filter((creator) => creator.creatorType === role)
    .map((creator) =>
      (creator.fieldMode === 1
        ? creator.lastName
        : `${creator.firstName} ${creator.lastName}`).trim(),
    )
    .filter(Boolean)
    .join(", ");
}

function creatorNames(vol: VolumeEntry, creatorType: CreatorInputType): string {
  return vol.metadata.creators
    .filter((creator) => creator.creatorType === creatorType)
    .map((creator) =>
      (creator.fieldMode === 1
        ? creator.lastName
        : `${creator.firstName} ${creator.lastName}`).trim(),
    )
    .filter(Boolean)
    .join(", ");
}

function setSupportedLanguage(select: HTMLSelectElement, value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized &&
    SUPPORTED_BOOK_LANGUAGE_CODES.includes(
      normalized as (typeof SUPPORTED_BOOK_LANGUAGE_CODES)[number],
    )
  ) {
    select.value = normalized;
  }
}

function populateLanguageSelect(select: HTMLSelectElement) {
  if (select.options.length > 0) return;

  const placeholder = select.ownerDocument.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Select language";
  select.appendChild(placeholder);

  for (const code of SUPPORTED_BOOK_LANGUAGE_CODES) {
    const option = select.ownerDocument.createElement("option");
    option.value = code;
    option.textContent = code;
    select.appendChild(option);
  }
}

function readManualSharedMetadata(doc: Document): ManualSharedMetadata {
  const authorRaw = inputValue(doc, "manual-author");
  const editorRaw = inputValue(doc, "manual-editor");
  const translatorRaw = inputValue(doc, "manual-translator");

  return {
    seriesName: inputValue(doc, "manual-series-name"),
    creators: [
      ...parseCreatorList(authorRaw, "author"),
      ...parseCreatorList(editorRaw, "editor"),
      ...parseCreatorList(translatorRaw, "translator"),
    ],
    publisher: inputValue(doc, "manual-publisher"),
    publishDate: inputValue(doc, "manual-publish-date"),
    language: inputValue(doc, "manual-language").toLowerCase(),
  };
}

function createManualVolume(
  shared: ManualSharedMetadata,
  index: number,
): VolumeEntry {
  const volumeNumber = String(index).padStart(2, "0");
  const metadata: BookMetadata = {
    doubanUrl: "",
    doubanId: "",
    title: `${shared.seriesName} ${volumeNumber}`,
    creators: [...shared.creators],
    publisher: shared.publisher,
    publishDate: shared.publishDate,
    language: shared.language,
    series: shared.seriesName,
    seriesNumber: volumeNumber,
  };

  return {
    volumeNumber,
    metadata,
    fileMatchStatus: "missing",
  };
}

function updateVolumeValidationState(doc: Document, volumes: VolumeEntry[]) {
  const importButton = requiredElement<HTMLElement>(doc, "btn-import-volumes");
  const summary = requiredElement<HTMLElement>(doc, "volume-summary");
  const invalid = volumes
    .map((volume, index) => ({
      index,
      validation: validateMinimumBookIngest(volume.metadata),
    }))
    .filter((entry) => !entry.validation.eligible);
  const matched = volumes.filter((volume) => volume.fileMatchStatus === "matched").length;

  for (const { index, validation } of invalid) {
    const el = doc.querySelector(
      `[data-volume-validation-index="${index}"]`,
    ) as HTMLElement | null;
    if (el) {
      el.textContent = `Missing: ${validation.missingFields.join(", ") || validation.warnings.join(", ")}`;
      el.style.color = "#b91c1c";
    }
  }

  for (let index = 0; index < volumes.length; index++) {
    if (invalid.some((entry) => entry.index === index)) continue;
    const el = doc.querySelector(
      `[data-volume-validation-index="${index}"]`,
    ) as HTMLElement | null;
    if (el) {
      el.textContent = "Ready";
      el.style.color = "#2d8a2d";
    }
  }

  const fileSummary = matched > 0
    ? `${matched} matched files, ${volumes.length - matched} missing files`
    : "no matched files";
  summary.textContent = invalid.length > 0
    ? `${volumes.length} volumes, ${invalid.length} incomplete (${fileSummary})`
    : `${volumes.length} volumes ready (${fileSummary})`;
  (importButton as HTMLButtonElement).disabled = volumes.length === 0 || invalid.length > 0;
}

function renderVolumeList(doc: Document, volumes: VolumeEntry[]): () => void {
  const container = requiredElement<HTMLElement>(doc, "volume-list");
  container.style.display = "";
  container.innerHTML = "";

  const editors: Array<() => void> = [];
  const header = doc.createElement("div");
  header.style.cssText =
    "display: grid; grid-template-columns: 44px minmax(120px, 1fr) 96px 96px 96px 104px 86px 78px 150px 120px; gap: 6px; padding: 8px; font-weight: bold; border-bottom: 2px solid #ccc; font-size: 12px;";
  header.innerHTML = `
    <span>Vol.</span>
    <span>Title</span>
    <span>Author</span>
    <span>Editor</span>
    <span>Translator</span>
    <span>Publisher</span>
    <span>Date</span>
    <span>Lang</span>
    <span>Status</span>
    <span>File</span>
  `;
  container.appendChild(header);

  volumes.forEach((volume, index) => {
    const row = doc.createElement("div");
    row.style.cssText =
      "display: grid; grid-template-columns: 44px minmax(120px, 1fr) 96px 96px 96px 104px 86px 78px 150px 120px; gap: 6px; align-items: center; padding: 6px 8px; border-bottom: 1px solid #eee; font-size: 12px;";

    const volumeNumber = doc.createElement("span");
    volumeNumber.textContent = volume.volumeNumber;

    const title = doc.createElement("span");
    title.style.cssText = "overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";
    title.textContent = volume.metadata.title;

    function makeCreatorInput(creatorType: CreatorInputType): HTMLInputElement {
      const input = doc.createElement("input") as HTMLInputElement;
      input.type = "text";
      input.style.cssText = "width: 88px; font-size: 12px; padding: 2px 4px;";
      input.value = creatorNames(volume, creatorType);
      const sync = () => {
        const updated = parseCreatorList(input.value, creatorType);
        volume.metadata.creators = [
          ...volume.metadata.creators.filter((creator) => creator.creatorType !== creatorType),
          ...updated,
        ];
        updateVolumeValidationState(doc, volumes);
      };
      input.addEventListener("input", sync);
      input.addEventListener("blur", sync);
      editors.push(sync);
      return input;
    }

    const authorInput = makeCreatorInput("author");
    const editorInput = makeCreatorInput("editor");
    const translatorInput = makeCreatorInput("translator");

    const publisherInput = doc.createElement("input") as HTMLInputElement;
    publisherInput.type = "text";
    publisherInput.style.cssText = "width: 96px; font-size: 12px; padding: 2px 4px;";
    publisherInput.value = volume.metadata.publisher;
    const syncPublisher = () => {
      volume.metadata.publisher = publisherInput.value.trim();
      updateVolumeValidationState(doc, volumes);
    };
    publisherInput.addEventListener("input", syncPublisher);
    publisherInput.addEventListener("blur", syncPublisher);
    editors.push(syncPublisher);

    const dateInput = doc.createElement("input") as HTMLInputElement;
    dateInput.type = "text";
    dateInput.style.cssText = "width: 78px; font-size: 12px; padding: 2px 4px;";
    dateInput.value = volume.metadata.publishDate;
    const syncDate = () => {
      volume.metadata.publishDate = dateInput.value.trim();
      updateVolumeValidationState(doc, volumes);
    };
    dateInput.addEventListener("input", syncDate);
    dateInput.addEventListener("blur", syncDate);
    editors.push(syncDate);

    const languageSelect = doc.createElement("select") as HTMLSelectElement;
    languageSelect.style.cssText = "width: 72px; font-size: 12px;";
    populateLanguageSelect(languageSelect);
    setSupportedLanguage(languageSelect, volume.metadata.language);
    const syncLanguage = () => {
      volume.metadata.language = languageSelect.value.trim().toLowerCase();
      updateVolumeValidationState(doc, volumes);
    };
    languageSelect.addEventListener("change", syncLanguage);
    editors.push(syncLanguage);

    const status = doc.createElement("span");
    status.setAttribute("data-volume-validation-index", String(index));

    const fileStatus = doc.createElement("span");
    fileStatus.style.cssText = "overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";
    if (volume.localFilePath) {
      fileStatus.textContent = volume.localFilePath.split(/[/\\]/).pop() || volume.localFilePath;
      fileStatus.style.color = "#2d8a2d";
    } else {
      fileStatus.textContent = "(none)";
      fileStatus.style.color = "#777";
    }

    row.append(
      volumeNumber,
      title,
      authorInput,
      editorInput,
      translatorInput,
      publisherInput,
      dateInput,
      languageSelect,
      status,
      fileStatus,
    );
    container.appendChild(row);
  });

  updateVolumeValidationState(doc, volumes);
  return () => {
    for (const sync of editors) sync();
    updateVolumeValidationState(doc, volumes);
  };
}

export async function showSeriesDialog(win: Window): Promise<void> {
  return new Promise((resolve) => {
    (win as any).openDialog(
      "chrome://doubantozoter/content/series-dialog.xhtml",
      "douban-series-import",
      "chrome,dialog,modal,centerscreen,resizable",
      { parentWin: win, resolve, init: SeriesDialogUI.init },
    );
  });
}

export class SeriesDialogUI {
  static init(dialogWin: Window) {
    const args = (dialogWin as any).arguments?.[0] as SeriesDialogArgs | undefined;
    if (!args) return;

    const { parentWin, resolve } = args;
    const doc = dialogWin.document;
    let volumes: VolumeEntry[] = [];
    let selectedDir = "";
    let syncVolumeEdits = () => {};

    try {
      const sourceDouban = requiredElement<HTMLInputElement>(doc, "source-douban");
      const sourceManual = requiredElement<HTMLInputElement>(doc, "source-manual");
      const doubanFields = requiredElement<HTMLElement>(doc, "douban-source-fields");
      const manualFields = requiredElement<HTMLElement>(doc, "manual-source-fields");
      const manualLanguage = requiredElement<HTMLSelectElement>(doc, "manual-language");
      populateLanguageSelect(manualLanguage);

      sourceDouban.addEventListener("change", () => {
        doubanFields.style.display = "";
        manualFields.style.display = "none";
      });
      sourceManual.addEventListener("change", () => {
        doubanFields.style.display = "none";
        manualFields.style.display = "";
      });

      requiredElement<HTMLElement>(doc, "btn-browse").addEventListener("click", () => {
        const fp = Components.classes[
          "@mozilla.org/filepicker;1"
        ].createInstance(Components.interfaces.nsIFilePicker);
        fp.init(dialogWin, "Choose file directory", fp.modeGetFolder);
        fp.open((result: number) => {
          if (result === fp.returnOK || result === fp.returnReplace) {
            selectedDir = fp.file.path;
            requiredElement<HTMLInputElement>(doc, "file-dir").value = selectedDir;
          }
        });
      });

      requiredElement<HTMLElement>(doc, "btn-fill-template").addEventListener("click", async () => {
        const templateUrl = inputValue(doc, "manual-template-url");
        if (!templateUrl) {
          Services.prompt.alert(dialogWin, "Missing URL", "Enter a Douban subject URL.");
          return;
        }
        if (!templateUrl.includes("book.douban.com/subject/")) {
          Services.prompt.alert(dialogWin, "Invalid URL", "Enter a Douban subject URL.");
          return;
        }

        const progressWin = showProgress(parentWin, "Fetching template metadata...");
        try {
          progressWin.update(0, 1, "Fetching...");
          const html = await createLiveDoubanSource().getText(templateUrl);
          const meta = parseBookDetail(html, templateUrl);

          const seriesInput = requiredElement<HTMLInputElement>(doc, "manual-series-name");
          if (meta.series) seriesInput.value = meta.series;
          else if (meta.title) seriesInput.value = meta.title;

          requiredElement<HTMLInputElement>(doc, "manual-author").value =
            formatCreatorsForDisplay(meta.creators, "author");
          requiredElement<HTMLInputElement>(doc, "manual-editor").value =
            formatCreatorsForDisplay(meta.creators, "editor");
          requiredElement<HTMLInputElement>(doc, "manual-translator").value =
            formatCreatorsForDisplay(meta.creators, "translator");
          if (meta.publisher) {
            requiredElement<HTMLInputElement>(doc, "manual-publisher").value = meta.publisher;
          }
          if (meta.publishDate) {
            requiredElement<HTMLInputElement>(doc, "manual-publish-date").value = meta.publishDate;
          }
          setSupportedLanguage(manualLanguage, meta.language);
        } catch (e: any) {
          Services.prompt.alert(
            dialogWin,
            "Template fetch failed",
            e.message || String(e),
          );
        } finally {
          progressWin.close();
        }
      });

      requiredElement<HTMLElement>(doc, "btn-fetch").addEventListener("click", async () => {
        try {
          if (sourceDouban.checked) {
            const seriesUrl = inputValue(doc, "series-url");
            if (!seriesUrl) {
              Services.prompt.alert(dialogWin, "Missing URL", "Enter a Douban series URL.");
              return;
            }

            const progressWin = showProgress(parentWin, "Fetching series...");
            try {
              const { seriesName, books } = await fetchSeriesVolumes(
                seriesUrl,
                (current, total, message) => progressWin.update(current, total, message),
                createLiveDoubanSource(),
              );

              if (books.length === 0) {
                Services.prompt.alert(dialogWin, "No volumes", "No books were found for this series.");
                return;
              }

              volumes = books.map((book, index) => {
                const meta = parseBookDetail(book.html, book.url);
                const volumeNumber = String(index + 1).padStart(2, "0");
                return {
                  volumeNumber,
                  metadata: {
                    ...meta,
                    series: seriesName || meta.series || "",
                    seriesNumber: volumeNumber,
                  },
                  fileMatchStatus: "missing" as const,
                };
              });

              if (selectedDir) {
                volumes = await matchFiles(selectedDir, volumes);
              }
            } finally {
              progressWin.close();
            }
          } else {
            const shared = readManualSharedMetadata(doc);
            if (!shared.seriesName) {
              Services.prompt.alert(dialogWin, "Missing series name", "Enter a series name.");
              return;
            }

            if (selectedDir) {
              volumes = await generateVolumesFromFiles(selectedDir, {
                title: shared.seriesName,
                series: shared.seriesName,
                creators: shared.creators,
                publisher: shared.publisher,
                publishDate: shared.publishDate,
                language: shared.language,
              });
            } else {
              const volumeCount = parseInt(inputValue(doc, "manual-volume-count"), 10) || 1;
              volumes = Array.from(
                { length: Math.max(1, volumeCount) },
                (_, index) => createManualVolume(shared, index + 1),
              );
            }
          }

          syncVolumeEdits = renderVolumeList(doc, volumes);
        } catch (e: any) {
          Services.prompt.alert(dialogWin, "Series import failed", e.message || String(e));
        }
      });

      requiredElement<HTMLElement>(doc, "btn-import-volumes").addEventListener("click", async () => {
        if (volumes.length === 0) return;
        syncVolumeEdits();

        const invalid = volumes.filter(
          (volume) => !validateMinimumBookIngest(volume.metadata).eligible,
        );
        if (invalid.length > 0) {
          Services.prompt.alert(
            dialogWin,
            "Incomplete metadata",
            "Complete publisher, date, language, and at least one author/editor before importing.",
          );
          return;
        }

        const pick = pickCollectionForDialog(parentWin);
        if (pick.cancelled) return;

        try {
          const result = await writeBooksWithAttachments(volumes, pick.collectionId);
          Services.prompt.alert(
            dialogWin,
            "Series import complete",
            `Created ${result.created} items.` +
              (result.errors.length > 0
                ? `\n${result.errors.length} items failed.`
                : ""),
          );
          resolve();
          dialogWin.close();
        } catch (e: any) {
          Services.prompt.alert(dialogWin, "Import failed", e.message || String(e));
        }
      });

      requiredElement<HTMLElement>(doc, "btn-close").addEventListener("click", () => {
        resolve();
        dialogWin.close();
      });

      dialogWin.addEventListener("unload", () => resolve());
    } catch (e: any) {
      Zotero.log(`[Douban-to-Zotero] Series dialog initialization failed: ${e.message || String(e)}`, "error");
      Services.prompt.alert(dialogWin, "Series dialog failed", e.message || String(e));
      resolve();
    }
  }
}

function pickCollectionForDialog(win: Window): { cancelled: boolean; collectionId?: number } {
  const libraryID = Zotero.Libraries.userLibraryID;
  const collections = Zotero.Collections.getByLibrary(libraryID);

  const names: string[] = ["My Library"];
  const ids: Array<number | undefined> = [undefined];

  function addCollection(collection: any, depth: number) {
    names.push("  ".repeat(depth) + collection.name);
    ids.push(collection.id);
    for (const child of Zotero.Collections.getByParent(collection.id)) {
      addCollection(child, depth + 1);
    }
  }

  for (const collection of collections) {
    if (!collection.parentID) addCollection(collection, 0);
  }

  const selected = { value: 0 };
  const ok = Services.prompt.select(
    win,
    "Choose collection",
    "Choose the Zotero collection for imported volumes.",
    names,
    selected,
  );

  if (!ok) return { cancelled: true };
  return { cancelled: false, collectionId: ids[selected.value] };
}
