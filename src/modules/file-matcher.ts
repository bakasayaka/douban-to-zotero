/**
 * 文件匹配模块
 * 扫描用户指定目录，从文件名中提取卷号，与元数据卷次建立对应关系
 */

import type { BookMetadata, VolumeEntry } from "../types";

/** 支持的文件格式 */
const SUPPORTED_EXTENSIONS = new Set([
  ".epub",
  ".pdf",
  ".cbz",
  ".cbr",
  ".mobi",
  ".azw3",
]);

/**
 * 从文件名中提取卷号
 * 按优先级匹配语义化卷号标记，末位兜底纯数字
 *
 * 匹配规则：
 * - [Kmoe][浪客行]卷01.epub → 01
 * - 进击的巨人 第3卷.epub → 3
 * - vol.12.cbz → 12
 * - 05.pdf → 05
 */
export function extractVolumeNumber(filename: string): string | null {
  // 去除扩展名
  const nameWithoutExt = filename.replace(/\.[^.]+$/, "");

  // 优先级 1：语义化卷号标记
  const patterns = [
    /卷(\d+)/,                      // 卷01
    /第(\d+)[卷册话集部]/,          // 第3卷
    /vol\.?\s*(\d+)/i,              // vol.12, Vol 12
    /volume\s*(\d+)/i,              // Volume 12
    /\bv(\d+)\b/i,                  // v01
    /[(\[（](\d+)[)\]）]/,          // (01), [01], （01）
  ];

  for (const pattern of patterns) {
    const match = nameWithoutExt.match(pattern);
    if (match) {
      return match[1].padStart(2, "0");
    }
  }

  // 兜底：文件名中最后出现的纯数字序列
  const numberMatches = nameWithoutExt.match(/(\d+)/g);
  if (numberMatches && numberMatches.length > 0) {
    // 取最后一个数字（通常是卷号，前面的可能是年份等）
    const lastNumber = numberMatches[numberMatches.length - 1];
    return lastNumber.padStart(2, "0");
  }

  return null;
}

/**
 * 扫描目录并匹配文件到卷次
 * @param dirPath 本地文件目录路径
 * @param volumes 元数据中的卷次列表（已包含 metadata）
 * @returns 更新后的 VolumeEntry 列表，包含文件匹配结果
 */
export async function matchFiles(
  dirPath: string,
  volumes: VolumeEntry[],
): Promise<VolumeEntry[]> {
  // 扫描目录获取文件列表
  const files = await scanDirectory(dirPath);

  // 按卷号建立文件索引
  const filesByVolume = new Map<string, string>();
  for (const file of files) {
    const volNum = extractVolumeNumber(file.name);
    if (volNum) {
      filesByVolume.set(volNum, file.path);
    }
  }

  // 匹配文件到卷次
  return volumes.map((vol) => {
    const filePath = filesByVolume.get(vol.volumeNumber);
    if (filePath) {
      return {
        ...vol,
        localFilePath: filePath,
        fileMatchStatus: "matched" as const,
      };
    }
    return {
      ...vol,
      fileMatchStatus: "missing" as const,
    };
  });
}

/**
 * 扫描目录获取支持格式的文件列表
 */
async function scanDirectory(
  dirPath: string,
): Promise<{ name: string; path: string }[]> {
  const results: { name: string; path: string }[] = [];

  try {
    const entries = await IOUtils.getChildren(dirPath);
    for (const entryPath of entries) {
      const info = await IOUtils.stat(entryPath);
      if (info.type === "regular") {
        const name = PathUtils.filename(entryPath);
        const ext = "." + name.split(".").pop()?.toLowerCase();
        if (SUPPORTED_EXTENSIONS.has(ext)) {
          results.push({ name, path: entryPath });
        }
      }
    }
  } catch (e) {
    throw new Error(`无法读取目录: ${dirPath} - ${e}`);
  }

  // 按文件名排序
  results.sort((a, b) => a.name.localeCompare(b.name));
  return results;
}

/**
 * 根据文件列表自动生成卷次条目（用于无豆瓣元数据的手动模式）
 * @param dirPath 文件目录
 * @param sharedMetadata 共享元数据（系列名、作者等）
 */
export async function generateVolumesFromFiles(
  dirPath: string,
  sharedMetadata: Partial<BookMetadata>,
): Promise<VolumeEntry[]> {
  const files = await scanDirectory(dirPath);
  const seriesName = sharedMetadata.series || sharedMetadata.title || "";

  return files.map((file, index) => {
    const volNum = extractVolumeNumber(file.name) ||
      String(index + 1).padStart(2, "0");

    return {
      volumeNumber: volNum,
      metadata: {
        doubanUrl: "",
        doubanId: "",
        title: `${seriesName} ${volNum}`,
        creators: sharedMetadata.creators || [],
        publisher: sharedMetadata.publisher || "",
        publishDate: sharedMetadata.publishDate || "",
        series: seriesName,
        seriesNumber: volNum,
        ...sharedMetadata,
      } as BookMetadata,
      localFilePath: file.path,
      fileMatchStatus: "matched",
    };
  });
}
