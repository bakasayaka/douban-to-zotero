/**
 * ISBN-10 与 ISBN-13 转换工具
 */

/** 去除 ISBN 中的连字号和空格 */
function cleanISBN(isbn: string): string {
  return isbn.replace(/[-\s]/g, "");
}

/** 计算 ISBN-13 的校验位 */
function calculateISBN13CheckDigit(first12: string): string {
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const digit = parseInt(first12[i], 10);
    sum += i % 2 === 0 ? digit : digit * 3;
  }
  const remainder = sum % 10;
  return remainder === 0 ? "0" : String(10 - remainder);
}

/**
 * 将 ISBN-10 或 ISBN-13 统一转为 ISBN-13
 * 无效输入返回 null
 */
export function normalizeToISBN13(isbn: string): string | null {
  const clean = cleanISBN(isbn);

  if (clean.length === 13) {
    if (/^\d{13}$/.test(clean)) return clean;
    return null;
  }

  if (clean.length === 10) {
    if (!/^\d{9}[\dXx]$/.test(clean)) return null;
    const prefix = "978" + clean.slice(0, 9);
    const checkDigit = calculateISBN13CheckDigit(prefix);
    return prefix + checkDigit;
  }

  return null;
}

/**
 * 验证 ISBN 字符串是否合法（10 位或 13 位）
 */
export function isValidISBN(isbn: string): boolean {
  const clean = cleanISBN(isbn);
  return (
    (/^\d{13}$/.test(clean) && (clean.startsWith("978") || clean.startsWith("979"))) ||
    /^\d{9}[\dXx]$/.test(clean)
  );
}
