/**
 * 抓取缓存模块
 * 保存抓取进度，支持断点续抓
 */

const CACHE_DIR_NAME = "douban-to-zotero-cache";

/** 缓存索引结构 */
export interface CacheIndex {
  uid: string;
  /** 缓存创建时间戳 */
  timestamp: number;
  /** 想读清单总数（来自页面） */
  totalBooks: number;
  /** Phase 1 结果：所有书目链接（null 表示 Phase 1 未完成） */
  allLinks: { url: string; title: string }[] | null;
  /** 已成功抓取详情页的 URL 列表 */
  fetchedUrls: string[];
  /** 收集到的警告信息 */
  warnings: string[];
}

function getCacheDir(): string {
  return PathUtils.join(Zotero.DataDirectory.dir, CACHE_DIR_NAME);
}

export function getCacheDirectory(): string {
  return getCacheDir();
}

function getIndexPath(): string {
  return PathUtils.join(getCacheDir(), "index.json");
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function normalizeCacheUrl(url: string): string {
  const parsed = new URL(url, "https://book.douban.com");
  parsed.hash = "";
  parsed.searchParams.sort();
  return parsed.toString();
}

export function cacheKeyForUrl(url: string): string {
  const normalized = normalizeCacheUrl(url);
  const subjectId = normalized.match(/\/subject\/(\d+)\/?/)?.[1];
  const prefix = subjectId ? `subject-${subjectId}` : "url";
  return `${prefix}-${stableHash(normalized)}`;
}

function getBookCachePath(url: string): string {
  return PathUtils.join(getCacheDir(), `${cacheKeyForUrl(url)}.html`);
}

async function ensureCacheDir(): Promise<void> {
  const dir = getCacheDir();
  if (!(await IOUtils.exists(dir))) {
    await IOUtils.makeDirectory(dir, { createAncestors: true });
  }
}

async function writeUTF8Atomic(path: string, text: string): Promise<void> {
  const tempPath = `${path}.tmp`;
  await IOUtils.writeUTF8(tempPath, text);
  if (await IOUtils.exists(path)) {
    await IOUtils.remove(path);
  }
  await IOUtils.move(tempPath, path);
}

/**
 * 加载缓存索引（仅当 UID 匹配时返回）
 */
export async function loadCacheIndex(uid: string): Promise<CacheIndex | null> {
  try {
    const indexPath = getIndexPath();
    if (!(await IOUtils.exists(indexPath))) return null;
    const text = await IOUtils.readUTF8(indexPath);
    const index: CacheIndex = JSON.parse(text);
    if (index.uid !== uid) return null;
    return index;
  } catch (e) {
    Zotero.log(`[Douban-to-Zotero] Cache index could not be loaded: ${e}`, "warning");
    return null;
  }
}

/**
 * 保存缓存索引
 */
export async function saveCacheIndex(index: CacheIndex): Promise<void> {
  await ensureCacheDir();
  await writeUTF8Atomic(getIndexPath(), JSON.stringify(index));
}

/**
 * 缓存单本书的详情页 HTML
 */
export async function cacheBookHtml(url: string, html: string): Promise<void> {
  await ensureCacheDir();
  await writeUTF8Atomic(getBookCachePath(url), html);
}

export async function cacheBookHtmlWithIndex(
  url: string,
  html: string,
  index: CacheIndex,
): Promise<void> {
  await cacheBookHtml(url, html);
  await saveCacheIndex(index);
}

/**
 * 从缓存读取单本书的详情页 HTML
 */
export async function loadCachedBookHtml(url: string): Promise<string | null> {
  try {
    const path = getBookCachePath(url);
    if (!(await IOUtils.exists(path))) return null;
    return await IOUtils.readUTF8(path);
  } catch (e) {
    Zotero.log(`[Douban-to-Zotero] Cached book HTML could not be loaded for ${url}: ${e}`, "warning");
    return null;
  }
}

/**
 * 清除所有缓存
 */
export async function clearCache(): Promise<boolean> {
  try {
    const dir = getCacheDir();
    if (await IOUtils.exists(dir)) {
      await IOUtils.remove(dir, { recursive: true });
    }
    return true;
  } catch (e) {
    Zotero.log(`[Douban-to-Zotero] 清除缓存失败: ${e}`, "warning");
    return false;
  }
}

/**
 * 格式化缓存时间为可读字符串
 */
export function formatCacheTime(timestamp: number): string {
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
