/**
 * 字符串相似度计算
 * 用于书名 + 出版社的模糊去重匹配
 */

/**
 * 计算两个字符串的编辑距离（Levenshtein Distance）
 */
export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;

  // 使用滚动数组优化空间
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array(n + 1);

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = prev[j - 1];
      } else {
        curr[j] = 1 + Math.min(prev[j - 1], prev[j], curr[j - 1]);
      }
    }
    [prev, curr] = [curr, prev];
  }

  return prev[n];
}

/**
 * 基于编辑距离的归一化相似度 (0-1)
 * 1 = 完全相同, 0 = 完全不同
 */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - editDistance(a, b) / maxLen;
}

/**
 * 去除标点和空白后进行相似度比较
 * 用于书名比对，忽略标点差异
 */
export function normalizedSimilarity(a: string, b: string): number {
  const normalize = (s: string) =>
    s
      .replace(/[\s\u3000]+/g, "") // 去空白
      .replace(/[，。、；：！？（）【】《》""''·—\-,.;:!?()\[\]{}<>"']/g, "") // 去标点
      .toLowerCase();

  return similarity(normalize(a), normalize(b));
}

/**
 * 提取主标题（去掉冒号或破折号之后的副标题部分）
 */
export function extractMainTitle(title: string): string {
  // 按中文冒号、英文冒号、破折号分割，取第一段
  const main = title.split(/[：:—\u2014]/)[0];
  return main.trim();
}
