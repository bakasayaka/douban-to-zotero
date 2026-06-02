import type { FetchResult, RawBookData } from "../types";
import { RateLimitError } from "../utils/http";
import {
  cacheBookHtmlWithIndex,
  loadCachedBookHtml,
  saveCacheIndex,
  type CacheIndex,
} from "./fetch-cache";
import {
  createLiveDoubanSource,
  type DoubanSource,
} from "./douban-source";

const WISH_LIST_BASE = "https://book.douban.com/people";
const ITEMS_PER_PAGE = 15;
const MAX_PAGES = 200;

export interface BookLink {
  url: string;
  title: string;
}

interface PageInfo {
  totalBooks: number;
  hasNext: boolean;
  nextUrl?: string;
}

export interface SubjectCountRange {
  start: number;
  end: number;
  total: number;
}

export interface WishListPageDiagnostics {
  links: BookLink[];
  totalBooks: number;
  hasNext: boolean;
  nextUrl?: string;
  subjectCountRange: SubjectCountRange | null;
  visibleEntryCount: number;
}

function normalizeSubjectUrl(url: string): string {
  if (url.startsWith("//")) return `https:${url}`;
  return new URL(url, "https://book.douban.com").toString();
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

function parseWishListPage(html: string): BookLink[] {
  const links: BookLink[] = [];
  const seen = new Set<string>();
  const candidates: Array<BookLink & { index: number }> = [];
  const subjectUrl = `((?:https?:)?//book\\.douban\\.com/subject/\\d+/?)`;
  const patterns = [
    {
      pattern: new RegExp(`<a\\s[^>]*?href="${subjectUrl}"[^>]*?title="([^"]*)"[^>]*?>`, "gi"),
      urlGroup: 1,
      titleGroup: 2,
    },
    {
      pattern: new RegExp(`<a\\s[^>]*?title="([^"]*)"[^>]*?href="${subjectUrl}"[^>]*?>`, "gi"),
      urlGroup: 2,
      titleGroup: 1,
    },
    {
      pattern: new RegExp(`<a\\s[^>]*?href="${subjectUrl}"[^>]*?>([\\s\\S]*?)</a>`, "gi"),
      urlGroup: 1,
      titleGroup: 2,
    },
  ];

  for (const { pattern, urlGroup, titleGroup } of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(html)) !== null) {
      const url = normalizeSubjectUrl(match[urlGroup]);
      const title = stripTags(match[titleGroup] ?? "");
      if (!title) continue;
      candidates.push({ index: match.index, url, title });
    }
  }

  candidates.sort((a, b) => a.index - b.index);
  for (const candidate of candidates) {
    if (seen.has(candidate.url)) continue;
    seen.add(candidate.url);
    links.push({ url: candidate.url, title: candidate.title });
  }

  return links;
}

function normalizeCountText(value: string): string {
  return stripTags(value)
    .replace(/&nbsp;|&#160;|&#xA0;/gi, " ")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseSubjectCountRange(html: string): SubjectCountRange | null {
  const match = html.match(
    /<span\b[^>]*class=["'][^"']*\bsubject-num\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i,
  );
  if (!match) return null;

  const text = normalizeCountText(match[1]);
  const counts = text.match(/(\d+)\s*-\s*(\d+)\s*\/\s*(\d+)/);
  if (!counts) return null;

  return {
    start: Number(counts[1]),
    end: Number(counts[2]),
    total: Number(counts[3]),
  };
}

function parseNextPageUrl(html: string): string | undefined {
  const next = html.match(
    /<span\b[^>]*class=["'][^"']*\bnext\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i,
  )?.[1];
  if (!next) return undefined;

  const href = next.match(/\bhref=(["'])(.*?)\1/i)?.[2]
    ?.replace(/&amp;|&#38;/gi, "&");
  return href ? new URL(href, "https://book.douban.com").toString() : undefined;
}

function parsePageInfo(html: string): PageInfo {
  const h1Total = html.match(/<h1[^>]*>.*?\((\d+)\).*?<\/h1>/s)?.[1];
  const subjectCount = parseSubjectCountRange(html);
  const nextUrl = parseNextPageUrl(html);
  return {
    totalBooks: Number(subjectCount?.total ?? h1Total ?? 0),
    hasNext: Boolean(nextUrl),
    nextUrl,
  };
}

export function parseWishListPageDiagnostics(html: string): WishListPageDiagnostics {
  const links = parseWishListPage(html);
  const pageInfo = parsePageInfo(html);
  return {
    links,
    totalBooks: pageInfo.totalBooks,
    hasNext: pageInfo.hasNext,
    nextUrl: pageInfo.nextUrl,
    subjectCountRange: parseSubjectCountRange(html),
    visibleEntryCount: links.length,
  };
}

function pushWarningOnce(warnings: string[], warning: string): void {
  if (!warnings.includes(warning)) warnings.push(warning);
}

function recordCompletenessWarnings(
  warnings: string[],
  totalBooks: number,
  visibleEntryCount: number,
  uniqueEntryCount: number,
  fetchedPageCount: number,
): void {
  if (totalBooks <= 0) {
    if (uniqueEntryCount > 0) {
      pushWarningOnce(
        warnings,
        "readlist-total-unknown: Douban did not expose a readable wish-list total; completeness could not be verified.",
      );
    }
    return;
  }

  const expectedPageCount = Math.ceil(totalBooks / ITEMS_PER_PAGE);
  if (visibleEntryCount < totalBooks) {
    const hiddenCount = totalBooks - visibleEntryCount;
    pushWarningOnce(
      warnings,
      `readlist-visible-count-mismatch: Douban declared ${totalBooks} wish-list books, but only ${visibleEntryCount} visible list entries were fetched anonymously; ${hiddenCount} may be hidden by login/privacy behavior.`,
    );
  }

  if (uniqueEntryCount < visibleEntryCount) {
    pushWarningOnce(
      warnings,
      `readlist-duplicate-visible-links: ${visibleEntryCount} visible list entries resolved to ${uniqueEntryCount} unique subject URLs.`,
    );
  }

  if (fetchedPageCount < expectedPageCount && visibleEntryCount < totalBooks) {
    pushWarningOnce(
      warnings,
      `readlist-pagination-incomplete: Douban declared ${totalBooks} books, which implies ${expectedPageCount} pages at ${ITEMS_PER_PAGE} books per page, but only ${fetchedPageCount} pages were fetched.`,
    );
  }
}

async function saveProgressIndex(
  uid: string,
  totalBooks: number,
  allLinks: BookLink[],
  fetchedUrls: Set<string>,
  warnings: string[],
) {
  await saveCacheIndex({
    uid,
    timestamp: Date.now(),
    totalBooks,
    allLinks,
    fetchedUrls: [...fetchedUrls],
    warnings,
  });
}

export async function fetchWishList(
  uid: string,
  onProgress: (current: number, total: number, message: string) => void,
  cachedIndex: CacheIndex | null = null,
  source: DoubanSource = createLiveDoubanSource(),
): Promise<FetchResult> {
  let allLinks: BookLink[] = [];
  const warnings: string[] = [];
  let totalBooks = 0;
  const fetchedUrlSet = new Set<string>();

  if (cachedIndex?.allLinks) {
    allLinks = cachedIndex.allLinks;
    totalBooks = cachedIndex.totalBooks;
    warnings.push(...cachedIndex.warnings);
    for (const url of cachedIndex.fetchedUrls) fetchedUrlSet.add(url);
    recordCompletenessWarnings(
      warnings,
      totalBooks,
      allLinks.length,
      allLinks.length,
      totalBooks > 0 ? Math.ceil(allLinks.length / ITEMS_PER_PAGE) : 0,
    );
    onProgress(
      allLinks.length,
      totalBooks,
      `Resuming cached import with ${fetchedUrlSet.size}/${allLinks.length} detail pages.`,
    );
  }

  if (allLinks.length === 0) {
    onProgress(0, 0, "Fetching Douban wish list...");
    let pageUrl = `${WISH_LIST_BASE}/${uid}/wish?start=0`;
    let pageIndex = 1;
    let visibleEntryCount = 0;
    let fetchedPageCount = 0;
    const fetchedPageUrls = new Set<string>();

    while (pageIndex <= MAX_PAGES) {
      if (fetchedPageUrls.has(pageUrl)) {
        pushWarningOnce(
          warnings,
          `readlist-pagination-loop: next-page link repeated ${pageUrl}; stopped pagination.`,
        );
        break;
      }
      fetchedPageUrls.add(pageUrl);

      const html = await source.getText(pageUrl, { minDelay: 1000, maxDelay: 3000 });
      fetchedPageCount++;
      const diagnostics = parseWishListPageDiagnostics(html);
      const pageInfo = {
        totalBooks: diagnostics.totalBooks,
        hasNext: diagnostics.hasNext,
        nextUrl: diagnostics.nextUrl,
      };
      if (pageInfo.totalBooks > 0) {
        if (totalBooks === 0) {
          totalBooks = pageInfo.totalBooks;
        } else if (pageInfo.totalBooks !== totalBooks) {
          pushWarningOnce(
            warnings,
            `readlist-total-changed: Douban wish-list total changed from ${totalBooks} to ${pageInfo.totalBooks} during pagination.`,
          );
        }
      }

      const links = diagnostics.links;
      visibleEntryCount += links.length;
      if (links.length === 0) break;

      for (const link of links) {
        if (!allLinks.some((existing) => existing.url === link.url)) {
          allLinks.push(link);
        }
      }

      onProgress(
        allLinks.length,
        totalBooks,
        `Fetched ${allLinks.length}/${totalBooks || "?"} list entries.`,
      );

      if (totalBooks > 0 && allLinks.length >= totalBooks) break;
      if (!pageInfo.hasNext) break;
      pageUrl = pageInfo.nextUrl ?? `${WISH_LIST_BASE}/${uid}/wish?start=${pageIndex * ITEMS_PER_PAGE}`;
      pageIndex++;
    }

    if (pageIndex > MAX_PAGES) {
      Zotero.log(
        `[Douban-to-Zotero] Wish-list pagination reached ${MAX_PAGES} pages and stopped.`,
        "warning",
      );
    }

    recordCompletenessWarnings(
      warnings,
      totalBooks,
      visibleEntryCount,
      allLinks.length,
      fetchedPageCount,
    );

    if (allLinks.length > 0) {
      await saveProgressIndex(uid, totalBooks, allLinks, fetchedUrlSet, warnings);
    }
  }

  const books: RawBookData[] = [];
  const total = allLinks.length;
  for (let i = 0; i < allLinks.length; i++) {
    const link = allLinks[i];
    const cachedHtml = await loadCachedBookHtml(link.url);

    if (cachedHtml) {
      if (!fetchedUrlSet.has(link.url)) {
        Zotero.log(
          `[Douban-to-Zotero] Found cached HTML without an index entry; repairing index for ${link.url}.`,
          "warning",
        );
        fetchedUrlSet.add(link.url);
        await saveProgressIndex(uid, totalBooks, allLinks, fetchedUrlSet, warnings);
      }
      books.push({ url: link.url, html: cachedHtml });
      onProgress(i + 1, total, `Loaded cached book: ${link.title} (${i + 1}/${total})`);
      continue;
    }

    if (fetchedUrlSet.has(link.url)) {
      Zotero.log(
        `[Douban-to-Zotero] Cache index listed ${link.url}, but cached HTML was missing; refetching.`,
        "warning",
      );
    }

    onProgress(i + 1, total, `Fetching book: ${link.title} (${i + 1}/${total})`);
    try {
      const detailHtml = await source.getText(link.url);
      books.push({ url: link.url, html: detailHtml });
      fetchedUrlSet.add(link.url);
      await cacheBookHtmlWithIndex(link.url, detailHtml, {
        uid,
        timestamp: Date.now(),
        totalBooks,
        allLinks,
        fetchedUrls: [...fetchedUrlSet],
        warnings,
      });
    } catch (e: any) {
      Zotero.log(
        `[Douban-to-Zotero] Book fetch failed: ${link.url} - ${e.message || String(e)}`,
        "warning",
      );
      if (e instanceof RateLimitError) {
        onProgress(i + 1, total, "Rate limited; waiting before continuing...");
        await new Promise((resolve) => setTimeout(resolve, 30000));
      }
    }
  }

  return { books, warnings };
}
