/**
 * 各字段独立提取函数
 * 每个函数处理一种字段的清洗逻辑，便于单独调整
 */

import type { Creator } from "../types";
import { normalizePublicationDate } from "../utils/date";
import {
  parseCreatorList,
  parseCreatorListWithNotes,
  fieldNameToRole,
  formatCreator,
  dedupeCreatorRoleAliases,
} from "../utils/name-utils";

/**
 * 从 #info 区块 HTML 中按 <br> 切分，提取所有字段的键值映射
 * 这是企划 3.2.1 中描述的通用策略
 */
export function extractInfoFields(doc: Document): Map<string, string> {
  const info = doc.querySelector("#info");
  if (!info) {
    throw new Error("无法找到 #info 区块，页面结构可能已变化");
  }

  const fields = new Map<string, string>();
  const html = info.innerHTML;

  // 按 <br> 或 <br/> 或 <br /> 切分
  const lines = html.split(/<br\s*\/?>/i);

  for (const line of lines) {
    // 查找 <span class="pl"> 标签作为字段标签
    const labelMatch = line.match(
      /<span\s+class="pl">\s*(.*?)\s*<\/span>/i,
    );
    if (!labelMatch) continue;

    const fieldName = labelMatch[1]
      .replace(/<[^>]*>/g, "") // 去除嵌套 HTML
      .replace(/[:：\s]/g, "") // 去除冒号和空白
      .trim();

    // 字段值：标签之后的内容，去除所有 HTML 标签
    const valueHtml = line.slice(
      line.indexOf(labelMatch[0]) + labelMatch[0].length,
    );
    const value = valueHtml
      .replace(/<[^>]*>/g, "") // 去除 HTML 标签
      .replace(/&nbsp;/g, " ") // 替换 &nbsp;
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/\s+/g, " ") // 合并空白
      .replace(/^[\s:：]+/, "") // 去除前导冒号和空白
      .trim();

    if (fieldName && value) {
      fields.set(fieldName, value);
    }
  }

  return fields;
}

/**
 * 提取书名
 */
export function extractTitle(doc: Document): string {
  // 优先从 h1 > span 取
  const span = doc.querySelector("h1 span");
  if (span?.textContent?.trim()) {
    return span.textContent.trim();
  }

  // 备用：从 <title> 标签取
  const title = doc.querySelector("title");
  if (title?.textContent) {
    // 豆瓣 title 格式通常为 "书名 (豆瓣)"
    return title.textContent.replace(/\s*\(豆瓣\)\s*$/, "").trim();
  }

  return "";
}

/**
 * 提取丛书名（Series）
 * 企划 3.2.2：优先取 <a> 标签文本，再正则清理
 */
export function extractSeries(doc: Document): string | undefined {
  const info = doc.querySelector("#info");
  if (!info) return undefined;

  // 查找包含"丛书"的 <span class="pl">
  const labels = Array.from(info.querySelectorAll("span.pl"));
  for (const label of labels) {
    const text = label.textContent?.trim() || "";
    if (text.includes("丛书")) {
      // 优先取紧随其后的 <a> 标签
      const anchor = label.nextElementSibling;
      if (anchor?.tagName === "A") {
        return anchor.textContent?.trim() || undefined;
      }

      // 否则取到下一个 <br> 为止的文本
      let sibling = label.nextSibling;
      let value = "";
      while (sibling) {
        if (
          sibling.nodeType === 1 /* ELEMENT_NODE */ &&
          (sibling as Element).tagName === "BR"
        ) {
          break;
        }
        if (sibling.nodeType === 3 /* TEXT_NODE */) {
          value += sibling.textContent;
        } else if (sibling.nodeType === 1 /* ELEMENT_NODE */) {
          value += (sibling as Element).textContent;
        }
        sibling = sibling.nextSibling;
      }

      // 清理：去除 &nbsp;、ISBN 及后续内容
      value = value
        .replace(/&nbsp;/g, " ")
        .replace(/\s*ISBN[:：]?\s*[\d-]+.*$/i, "")
        .trim();

      return value || undefined;
    }
  }

  return undefined;
}

/**
 * 提取摘要/简介
 */
export function extractAbstract(doc: Document): string | undefined {
  // 展开的完整简介
  const hidden = doc.querySelector(
    "#link-report .hidden .intro, #link-report .all .intro",
  );
  if (hidden?.textContent?.trim()) {
    return hidden.textContent.trim();
  }

  // 未展开的简介
  const intro = doc.querySelector("#link-report .intro");
  if (intro?.textContent?.trim()) {
    return intro.textContent.trim();
  }

  return undefined;
}

/**
 * 提取封面图 URL
 */
export function extractCoverUrl(doc: Document): string | undefined {
  const img = doc.querySelector("#mainpic img") as HTMLImageElement | null;
  return img?.src || undefined;
}

/**
 * 从豆瓣 URL 中提取 subject ID
 */
export function extractDoubanId(url: string): string {
  const match = url.match(/subject\/(\d+)/);
  return match ? match[1] : "";
}

/**
 * 提取出版日期并规范化
 * 豆瓣格式多样：2024-3、2024年3月、2024.3、2024
 * 输出只允许 YYYY / YYYY-MM / YYYY-MM-DD；不补不存在的月日精度。
 */
export function normalizeDate(raw: string): string {
  return normalizePublicationDate(raw);
}

/**
 * 从 #info 键值映射中提取所有 Creator
 * 处理独立字段（如"译者:"）和人名后缀角色词
 * 同时收集作者原名、国籍等附加信息用于 notes
 */
export function extractAllCreators(
  fields: Map<string, string>,
  doc: Document,
): { creators: Creator[]; creatorNotes: string[] } {
  const creators: Creator[] = [];
  const creatorNotes: string[] = [];
  const seenCreators = new Set<string>();

  function pushCreators(result: { creators: Creator[]; noteLines: string[] }): void {
    for (const creator of result.creators) {
      const nameKey = `${creator.firstName} ${creator.lastName}`.trim().toLowerCase();
      const key = `${creator.creatorType}:${nameKey}`;
      if (seenCreators.has(key)) continue;
      seenCreators.add(key);
      creators.push(creator);
    }
    for (const noteLine of result.noteLines) {
      if (!creatorNotes.includes(noteLine)) {
        creatorNotes.push(noteLine);
      }
    }
  }

  // 按字段名映射的角色
  const fieldCreatorMap: [string, Creator["creatorType"]][] = [
    ["作者", "author"],
    ["译者", "translator"],
    ["编者", "editor"],
    ["辑校", "editor"],
    ["校注", "contributor"],
    ["校对", "contributor"],
    ["点校", "contributor"],
  ];

  for (const [fieldName, role] of fieldCreatorMap) {
    const value = fields.get(fieldName);
    if (value) {
      const result = parseCreatorListWithNotes(value, role);
      pushCreators(result);
    }
  }

  for (const [fieldName, value] of fields) {
    const role = fieldNameToRole(fieldName);
    if (role) {
      pushCreators(parseCreatorListWithNotes(value, role));
    }
  }

  // 如果没有通过"作者"字段找到作者，尝试从 #info 直接查找
  if (!creators.some((c) => c.creatorType === "author")) {
    const info = doc.querySelector("#info");
    if (info) {
      const labels = Array.from(info.querySelectorAll("span.pl"));
      for (const label of labels) {
        const text = label.textContent?.trim().replace(/[:：]/g, "") || "";
        if (text === "作者" || text === "著者") {
          let sibling = label.nextSibling;
          const names: string[] = [];
          while (sibling) {
            if (
              sibling.nodeType === 1 /* ELEMENT_NODE */ &&
              (sibling as Element).tagName === "BR"
            ) {
              break;
            }
            if (
              sibling.nodeType === 1 /* ELEMENT_NODE */ &&
              (sibling as Element).tagName === "A"
            ) {
              const name = (sibling as Element).textContent?.trim();
              if (name) names.push(name);
            }
            sibling = sibling.nextSibling;
          }
          if (names.length > 0) {
            const result = parseCreatorListWithNotes(
              names.join("/"),
              "author",
            );
            pushCreators(result);
          }
        }
      }
    }
  }

  return { creators: dedupeCreatorRoleAliases(creators), creatorNotes };
}
