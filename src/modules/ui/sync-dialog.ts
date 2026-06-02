/**
 * 想读同步复核对话框
 * 展示抓取结果、去重状态，用户勾选确认后返回选中的书目
 */

import type { BookMetadata, DeduplicationResult } from "../../types";
import { validateMinimumBookIngest } from "../ingest-validator";

/**
 * 显示同步复核对话框
 * @returns 用户确认要导入的书目列表
 */
export async function showSyncDialog(
  win: Window,
  results: DeduplicationResult[],
): Promise<BookMetadata[]> {
  return new Promise((resolve) => {
    (win as any).openDialog(
      "chrome://doubantozoter/content/sync-dialog.xhtml",
      "douban-sync-review",
      "chrome,dialog,modal,centerscreen,resizable",
      { results, resolve, init: SyncDialogUI.init },
    );
  });
}

/** 对话框内部初始化逻辑（从 xhtml 的 onload 调用） */
export class SyncDialogUI {
  static init(dialogWin: Window) {
    const args = (dialogWin as any).arguments?.[0];
    if (!args) return;

    const { results, resolve } = args as {
      results: DeduplicationResult[];
      resolve: (books: BookMetadata[]) => void;
    };

    const doc = dialogWin.document;
    const listContainer = doc.getElementById("sync-list")!;
    const summaryEl = doc.getElementById("sync-summary")!;
    const selectedCountEl = doc.getElementById("selected-count")!;

    // 统计
    const newCount = results.filter((r) => r.matchType === "new").length;
    const dupCount = results.filter((r) => r.matchType === "duplicate").length;
    const suspectCount = results.filter(
      (r) => r.matchType === "suspect",
    ).length;
    const incompleteCount = results.filter(
      (r) => !validateMinimumBookIngest(r.book).eligible,
    ).length;
    summaryEl.textContent =
      `共 ${results.length} 本：${newCount} 本新书，${dupCount} 本重复，${suspectCount} 本疑似重复，${incompleteCount} 本信息不完整`;

    // 跟踪选中状态
    const selected = new Set<number>();

    // 构建列表
    results.forEach((result, index) => {
      const row = doc.createElement("div") as HTMLDivElement;
      row.style.cssText =
        "display: flex; align-items: center; padding: 8px; border-bottom: 1px solid #eee; gap: 8px;";
      const ingestValidation = validateMinimumBookIngest(result.book);

      // 复选框
      const checkbox = doc.createElement("input") as HTMLInputElement;
      checkbox.type = "checkbox";
      checkbox.dataset.index = String(index);

      if (result.matchType === "new" && ingestValidation.eligible) {
        checkbox.checked = true;
        selected.add(index);
      } else if (result.matchType === "duplicate" || !ingestValidation.eligible) {
        checkbox.disabled = true;
      }

      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          selected.add(index);
        } else {
          selected.delete(index);
        }
        updateSelectedCount();
      });

      // 状态标记
      const badge = doc.createElement("span") as HTMLSpanElement;
      badge.style.cssText =
        "display: inline-block; padding: 2px 6px; border-radius: 3px; font-size: 11px; min-width: 50px; text-align: center;";
      if (!ingestValidation.eligible) {
        badge.style.backgroundColor = "#fef2f2";
        badge.style.color = "#b91c1c";
        badge.textContent = "不完整";
      } else if (result.matchType === "new") {
        badge.style.backgroundColor = "#e6f7e6";
        badge.style.color = "#2d8a2d";
        badge.textContent = "新书";
      } else if (result.matchType === "duplicate") {
        badge.style.backgroundColor = "#f0f0f0";
        badge.style.color = "#888";
        badge.textContent = "重复";
      } else {
        badge.style.backgroundColor = "#fff7e6";
        badge.style.color = "#d48806";
        badge.textContent = "疑似重复";
      }

      // 书目信息
      const info = doc.createElement("div") as HTMLDivElement;
      info.style.cssText = "flex: 1; min-width: 0;";

      const title = doc.createElement("div") as HTMLDivElement;
      title.style.cssText = "font-weight: bold; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";
      title.textContent = result.book.title;

      const meta = doc.createElement("div") as HTMLDivElement;
      meta.style.cssText = "font-size: 12px; color: #666; margin-top: 2px;";
      const authors = result.book.creators
        .filter((c) => c.creatorType === "author")
        .map((c) => (c.fieldMode === 1 ? c.lastName : `${c.firstName} ${c.lastName}`))
        .join(", ");
      meta.textContent = [authors, result.book.publisher, result.book.publishDate]
        .filter(Boolean)
        .join(" / ");

      info.appendChild(title);
      info.appendChild(meta);

      // 原书名和作者原名预览（将写入 note）
      const noteItems: string[] = [];
      if (result.book.originalTitle) {
        noteItems.push(result.book.originalTitle);
      }
      if (result.book.creatorNotes && result.book.creatorNotes.length > 0) {
        noteItems.push(...result.book.creatorNotes);
      }
      if (noteItems.length > 0) {
        const notePreview = doc.createElement("div") as HTMLDivElement;
        notePreview.style.cssText =
          "font-size: 11px; color: #8b8b8b; margin-top: 2px; font-style: italic;";
        notePreview.textContent = `note: ${noteItems.join(" / ")}`;
        info.appendChild(notePreview);
      }

      if (!ingestValidation.eligible) {
        const incompleteInfo = doc.createElement("div") as HTMLDivElement;
        incompleteInfo.style.cssText =
          "font-size: 11px; color: #b91c1c; margin-top: 2px;";
        incompleteInfo.textContent =
          `需补全后导入: ${ingestValidation.missingFields.join(", ")}`;
        info.appendChild(incompleteInfo);
      }

      // 匹配信息（疑似重复时显示）
      if (result.matchType === "suspect" && result.matchedItemTitle) {
        const matchInfo = doc.createElement("div") as HTMLDivElement;
        matchInfo.style.cssText =
          "font-size: 11px; color: #d48806; margin-top: 2px;";
        matchInfo.textContent =
          `↳ 疑似匹配: "${result.matchedItemTitle}" (${result.matchReason})`;
        info.appendChild(matchInfo);
      } else if (result.matchType === "duplicate" && result.matchedItemTitle) {
        const matchInfo = doc.createElement("div") as HTMLDivElement;
        matchInfo.style.cssText =
          "font-size: 11px; color: #888; margin-top: 2px;";
        matchInfo.textContent = `↳ 已存在: "${result.matchedItemTitle}"`;
        info.appendChild(matchInfo);
      }

      row.appendChild(checkbox);
      row.appendChild(badge);
      row.appendChild(info);
      listContainer.appendChild(row);
    });

    function updateSelectedCount() {
      selectedCountEl.textContent = `已选 ${selected.size} 本`;
    }
    updateSelectedCount();

    // 按钮事件
    doc.getElementById("btn-select-all")!.addEventListener("click", () => {
      const checkboxes = listContainer.querySelectorAll(
        'input[type="checkbox"]:not(:disabled)',
      ) as NodeListOf<HTMLInputElement>;
      checkboxes.forEach((cb) => {
        cb.checked = true;
        selected.add(Number(cb.dataset.index));
      });
      updateSelectedCount();
    });

    doc.getElementById("btn-deselect-all")!.addEventListener("click", () => {
      const checkboxes = listContainer.querySelectorAll(
        'input[type="checkbox"]',
      ) as NodeListOf<HTMLInputElement>;
      checkboxes.forEach((cb) => {
        cb.checked = false;
      });
      selected.clear();
      updateSelectedCount();
    });

    doc.getElementById("btn-import")!.addEventListener("click", () => {
      const selectedBooks = Array.from(selected).map(
        (i) => results[i].book,
      );
      resolve(selectedBooks);
      dialogWin.close();
    });

    doc.getElementById("btn-cancel")!.addEventListener("click", () => {
      resolve([]);
      dialogWin.close();
    });

    // 窗口关闭时兜底 resolve（Promise 只 resolve 一次，按钮已触发过的不受影响）
    dialogWin.addEventListener("unload", () => resolve([]));
  }
}
