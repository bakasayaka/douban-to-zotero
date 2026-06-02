/**
 * 丛书抓取模块
 * 从豆瓣丛书页面获取全部卷次列表，逐卷抓取详情页
 */

import type { RawBookData } from "../types";
import { RateLimitError } from "../utils/http";
import type { DoubanSource } from "./douban-source";

/**
 * 从丛书页面 HTML 中提取书目列表区域的链接
 *
 * 豆瓣丛书页面结构：
 * - 主列表在 <div class="subject-list"> 内
 * - 每本书是一个 <div class="subject-item">
 * - 标题链接在 <h2> 标签内: <h2><a href="/subject/12345/">书名</a></h2>
 * - 页面其他区域（侧栏推荐、页脚等）也包含 /subject/ 链接，必须排除
 */
function parseSeriesPage(html: string): { url: string; title: string }[] {
  const links: { url: string; title: string }[] = [];
  const seen = new Set<string>();

  // 策略 1：提取 subject-list 容器内的 subject-item 中的标题链接
  // 先用正则定位每个 subject-item 区块，再从中提取 <h2> 内的链接
  const itemPattern = /<div[^>]+class=["'][^"']*subject-item[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
  let itemMatch;

  while ((itemMatch = itemPattern.exec(html)) !== null) {
    const itemHtml = itemMatch[1];
    // 从 subject-item 内的 <h2> 中提取链接
    const h2Link = itemHtml.match(
      /<h2[^>]*>\s*<a[^>]+href=["']((?:https?:)?\/\/book\.douban\.com\/subject\/\d+\/?)["'][^>]*>([\s\S]*?)<\/a>/i,
    );
    if (h2Link) {
      let url = h2Link[1];
      if (url.startsWith("//")) url = "https:" + url;
      const title = h2Link[2].replace(/<[^>]*>/g, "").trim();
      const subjectId = url.match(/subject\/(\d+)/)?.[1];
      if (subjectId && !seen.has(subjectId) && title) {
        seen.add(subjectId);
        links.push({ url, title });
      }
    }
  }

  // 策略 2：如果策略 1 未匹配到（页面结构变化），缩小范围到 subject-list 容器
  if (links.length === 0) {
    const listMatch = html.match(
      /<div[^>]+class=["'][^"']*subject-list[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*(?:<div[^>]+class=["'](?:paginator|aside)|$)/i,
    );
    const searchArea = listMatch ? listMatch[1] : "";

    if (searchArea) {
      const linkPattern =
        /<a[^>]+href=["']((?:https?:)?\/\/book\.douban\.com\/subject\/\d+\/?)["'][^>]*>([\s\S]*?)<\/a>/gi;
      let linkMatch;
      while ((linkMatch = linkPattern.exec(searchArea)) !== null) {
        let url = linkMatch[1];
        if (url.startsWith("//")) url = "https:" + url;
        const title = linkMatch[2].replace(/<[^>]*>/g, "").trim();
        const subjectId = url.match(/subject\/(\d+)/)?.[1];
        // 跳过封面图片链接（内含 <img>）和空标题
        if (subjectId && !seen.has(subjectId) && title && !linkMatch[2].includes("<img")) {
          seen.add(subjectId);
          links.push({ url, title });
        }
      }
    }
  }

  return links;
}

/**
 * 从丛书首页提取总册数
 * 页面上有「册数: 49」或「册 数：49」字样
 */
function parseTotalCount(html: string): number | null {
  const match = html.match(/册\s*数[：:]\s*(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * 检测丛书页面是否有下一页
 */
function hasNextPage(html: string): boolean {
  // 豆瓣分页器末页: <span class="next">&gt;</span>（无 <a> 标签）
  // 非末页: <span class="next"><a href="...">后页&gt;</a></span>
  return /class=["']next["'][^>]*>\s*<a\s/i.test(html);
}

/**
 * 从丛书页面提取丛书名称
 */
function parseSeriesName(html: string): string {
  const match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  return match ? match[1].replace(/<[^>]*>/g, "").trim() : "";
}

/**
 * 抓取丛书的所有卷次详情页
 * @param seriesUrl 豆瓣丛书页面 URL，如 https://book.douban.com/series/12345
 * @param onProgress 进度回调
 * @returns 丛书名称和每卷的原始 HTML 数据
 */
export async function fetchSeriesVolumes(
  seriesUrl: string,
  onProgress: (current: number, total: number, message: string) => void,
  source: DoubanSource,
): Promise<{ seriesName: string; books: RawBookData[] }> {
  // 用 Set 跟踪已收集的 subject ID，跨页去重
  const seenIds = new Set<string>();
  const allLinks: { url: string; title: string }[] = [];
  let seriesName = "";
  let totalCount: number | null = null;
  let pageStart = 0;
  let pageIndex = 1;

  // 安全上限：防止无限循环
  const MAX_PAGES = 50;

  // Step 1: 逐页收集丛书中的所有书目链接
  onProgress(0, 0, "正在获取丛书目录...");

  while (pageIndex <= MAX_PAGES) {
    const pageUrl =
      pageStart === 0 ? seriesUrl : `${seriesUrl}?start=${pageStart}`;

    let html: string;
    try {
      html = await source.getText(pageUrl, {
        minDelay: 1000,
        maxDelay: 3000,
      });
    } catch (e: any) {
      if (e instanceof RateLimitError) {
        // Phase 1 触发限流：暂停 30 秒后重试当前页
        onProgress(
          allLinks.length,
          totalCount ?? 0,
          `触发限流，等待 30 秒后重试第 ${pageIndex} 页...`,
        );
        await new Promise((resolve) => setTimeout(resolve, 30000));
        try {
          html = await source.getText(pageUrl, {
            minDelay: 3000,
            maxDelay: 6000,
          });
        } catch {
          // 重试仍然失败，用已收集到的链接继续
          Zotero.log(
            `[Douban-to-Zotero] 丛书目录第 ${pageIndex} 页限流重试失败，使用已收集的 ${allLinks.length} 条链接`,
            "warning",
          );
          break;
        }
      } else {
        throw e;
      }
    }

    if (pageIndex === 1) {
      seriesName = parseSeriesName(html);
      totalCount = parseTotalCount(html);
      Zotero.log(
        `[Douban-to-Zotero] 丛书「${seriesName}」，标注册数: ${totalCount ?? "未知"}`,
      );
    }

    const links = parseSeriesPage(html);
    if (links.length === 0) break;

    // 跨页去重：只添加之前没见过的链接
    let newCount = 0;
    for (const link of links) {
      const subjectId = link.url.match(/subject\/(\d+)/)?.[1];
      if (subjectId && !seenIds.has(subjectId)) {
        seenIds.add(subjectId);
        allLinks.push(link);
        newCount++;
      }
    }

    // 如果当前页没有任何新链接，说明已经循环了，停止
    if (newCount === 0) {
      Zotero.log(
        `[Douban-to-Zotero] 丛书第 ${pageIndex} 页无新条目，停止翻页`,
        "warning",
      );
      break;
    }

    const totalDisplay = totalCount ?? 0;
    onProgress(
      allLinks.length,
      totalDisplay,
      `已发现 ${allLinks.length}${totalCount ? `/${totalCount}` : ""} 卷（第 ${pageIndex} 页）...`,
    );

    // 如果已经收集到了页面标注的总册数，停止翻页
    if (totalCount && allLinks.length >= totalCount) break;

    if (!hasNextPage(html)) break;

    pageStart += 20; // 丛书页面每页 20 条
    pageIndex++;
  }

  if (pageIndex > MAX_PAGES) {
    Zotero.log(
      `[Douban-to-Zotero] 丛书翻页达到上限 ${MAX_PAGES} 页，停止`,
      "warning",
    );
  }

  if (allLinks.length === 0) {
    return { seriesName, books: [] };
  }

  // 如果实际收集数与标注总数不一致，记录日志
  if (totalCount && allLinks.length !== totalCount) {
    Zotero.log(
      `[Douban-to-Zotero] 丛书标注册数 ${totalCount}，实际收集 ${allLinks.length}`,
      "warning",
    );
  }

  // Step 2: 逐卷抓取详情页
  const books: RawBookData[] = [];
  const total = allLinks.length;

  for (let i = 0; i < allLinks.length; i++) {
    const link = allLinks[i];
    onProgress(
      i + 1,
      total,
      `正在抓取: ${link.title}（${i + 1}/${total}）`,
    );

    try {
      const detailHtml = await source.getText(link.url);
      books.push({ url: link.url, html: detailHtml });
    } catch (e: any) {
      Zotero.log(
        `[Douban-to-Zotero] 丛书卷次抓取失败: ${link.url} - ${e.message}`,
        "warning",
      );
      if (e instanceof RateLimitError) {
        onProgress(i + 1, total, "触发限流，等待 30 秒...");
        await new Promise((resolve) => setTimeout(resolve, 30000));
        // 重试一次
        try {
          const retryHtml = await source.getText(link.url, {
            minDelay: 3000,
            maxDelay: 6000,
          });
          books.push({ url: link.url, html: retryHtml });
        } catch {
          Zotero.log(
            `[Douban-to-Zotero] 重试失败，跳过: ${link.url}`,
            "warning",
          );
        }
      }
    }
  }

  return { seriesName, books };
}
