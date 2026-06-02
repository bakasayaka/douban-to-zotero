/**
 * 主解析器
 * 将豆瓣详情页 HTML 转换为结构化 BookMetadata
 */

import type { BookMetadata } from "../types";
import { validateMinimumBookIngest } from "./ingest-validator";
import { normalizeToISBN13 } from "../utils/isbn";
import {
  extractInfoFields,
  extractTitle,
  extractSeries,
  extractAbstract,
  extractCoverUrl,
  extractDoubanId,
  normalizeDate,
  extractAllCreators,
} from "./parser-rules";

const CJK_TITLE_CHAR = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/u;

export interface ParseBookDetailResult {
  book: BookMetadata;
  extractionWarnings: string[];
}

function normalizeTitlePart(value: string): string {
  return value
    .replace(/[：:]/g, ":")
    .replace(/\s+/g, "")
    .trim()
    .toLowerCase();
}

function titleAlreadyContainsSubtitle(mainTitle: string, subtitle: string): boolean {
  const normalizedTitle = normalizeTitlePart(mainTitle);
  const normalizedSubtitle = normalizeTitlePart(subtitle);
  return normalizedTitle.includes(`:${normalizedSubtitle}`);
}

function mergeTitleAndSubtitle(mainTitle: string, subtitle?: string): string {
  const cleanSubtitle = subtitle?.trim();
  if (!cleanSubtitle || titleAlreadyContainsSubtitle(mainTitle, cleanSubtitle)) {
    return mainTitle;
  }

  const separator = CJK_TITLE_CHAR.test(mainTitle) ? "：" : ": ";
  return `${mainTitle}${separator}${cleanSubtitle}`;
}

/**
 * 解析豆瓣图书详情页 HTML，返回结构化元数据
 * @param html 详情页完整 HTML
 * @param url 详情页 URL
 */
function parseBookDetailInternal(html: string, url: string): BookMetadata {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");

  // 通用字段提取：#info 按 <br> 切分为键值映射
  const fields = extractInfoFields(doc);

  // 提取各字段
  const mainTitle = extractTitle(doc);
  if (!mainTitle) {
    throw new Error(`无法提取书名: ${url}`);
  }

  // 副标题拼入完整标题（Zotero book 类型没有独立副标题字段）
  const subtitle = fields.get("副标题");
  const title = mergeTitleAndSubtitle(mainTitle, subtitle);

  const rawIsbn = fields.get("ISBN") || fields.get("统一书号") || "";
  const isbn13 = rawIsbn ? normalizeToISBN13(rawIsbn) : undefined;

  const rawDate = fields.get("出版年") || fields.get("出版时间") || "";

  const { creators, creatorNotes } = extractAllCreators(fields, doc);

  return {
    doubanUrl: url,
    doubanId: extractDoubanId(url),
    title,
    subtitle,
    creators,
    publisher: fields.get("出版社") || "",
    publishDate: normalizeDate(rawDate),
    isbn: rawIsbn || undefined,
    isbn13: isbn13 || undefined,
    pages: fields.get("页数"),
    price: fields.get("定价"),
    format: fields.get("装帧"),
    language: fields.get("语言"),
    series: extractSeries(doc) || fields.get("丛书"),
    seriesNumber: undefined, // 豆瓣详情页通常不标卷号，多卷导入时由 file-matcher 填充
    originalTitle: fields.get("原作名"),
    abstractNote: extractAbstract(doc),
    coverUrl: extractCoverUrl(doc),
    creatorNotes: creatorNotes.length > 0 ? creatorNotes : undefined,
  };
}

function extractionWarningsForBook(book: BookMetadata): string[] {
  const validation = validateMinimumBookIngest(book);
  return validation.warnings.flatMap((warning) => {
    if (warning === "minimum-ingest-missing-author-or-editor") {
      return ["parser-missing-author-or-editor"];
    }
    if (warning === "minimum-ingest-missing-language") {
      return ["parser-missing-language"];
    }
    if (warning.startsWith("minimum-ingest-unsupported-language-")) {
      return [
        warning.replace(
          "minimum-ingest-unsupported-language-",
          "parser-unsupported-language-",
        ),
      ];
    }
    return [];
  });
}

export function parseBookDetailWithDiagnostics(
  html: string,
  url: string,
): ParseBookDetailResult {
  const book = parseBookDetailInternal(html, url);
  return {
    book,
    extractionWarnings: extractionWarningsForBook(book),
  };
}

export function parseBookDetail(html: string, url: string): BookMetadata {
  return parseBookDetailWithDiagnostics(html, url).book;
}
