/**
 * 人名处理工具
 * CJK 检测、姓名拆分、国籍标注去除
 */

import type { Creator } from "../types";

/**
 * CJKV 文字及相关字符的正则范围。
 * 包含：CJK 表意文字、假名、谚文、间隔号、连字号、空格。
 */
const CJKV_ONLY = /^[\u4E00-\u9FFF\u3400-\u4DBF\u{20000}-\u{2A6DF}\u{2A700}-\u{2B73F}\u{2B740}-\u{2B81F}\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F\u00B7\u2022\u2027\u30FB\u002E\uFF0E\u002D\u2010-\u2015\u2018\u2019\u201C\u201D\u3000\s]+$/u;

/**
 * 判断人名是否为 CJKV 人名（中日韩越汉字圈及假名/谚文）
 * CJKV 人名使用 fieldMode: 1，不拆分姓名
 */
export function isCJKName(name: string): boolean {
  return CJKV_ONLY.test(name.trim());
}

/**
 * 去除人名前的国籍标注
 * 如「[法] 米歇尔·福柯」→「米歇尔·福柯」
 * 如「（美）米尔斯海默」→「米尔斯海默」
 * 支持 [xx] 和 （xx）两种格式，内容限 1-4 字符（国籍标注的典型长度）
 */
export function removeNationality(name: string): string {
  const withoutBracketNationality = name
    .replace(/^\s*\[[\u4E00-\u9FFF\u3400-\u4DBF\s/／,，、.\-]{1,24}\]\s*/u, "")
    .trim();
  if (withoutBracketNationality !== name.trim()) return withoutBracketNationality;

  return name
    .replace(/^\s*\[[\u4E00-\u9FFF]{1,4}\]\s*/, "")  // [美] 格式（限 CJK 1-4 字符）
    .replace(/^\s*[（(][\u4E00-\u9FFF]{1,4}[）)]\s*/, "")  // （美） 格式
    .trim();
}

/**
 * 规范化间隔号周围的空格
 * 「大卫 · 布莱克本」→「大卫·布莱克本」
 */
export function normalizeInterpunct(name: string): string {
  name = name.replace(/\s*\uFF0E\s*/g, ".");
  return name.replace(/\s*[·\u00B7\u2022\u2027\u30FB]\s*/g, "·");
}

/**
 * 已知的角色后缀词及其对应的 Zotero creatorType
 */
const ROLE_SUFFIXES: Record<string, Creator["creatorType"]> = {
  著: "author",
  作: "author",
  撰: "author",
  译: "translator",
  翻译: "translator",
  编: "editor",
  主编: "editor",
  副主编: "editor",
  执行主编: "editor",
  编辑: "editor",
  编著: "editor",
  辑校: "editor",
  校: "contributor",
  校对: "contributor",
  校注: "contributor",
  点校: "contributor",
  选注: "contributor",
  录: "contributor",
  注: "contributor",
  注释: "contributor",
  "ed.": "editor",
  "eds.": "editor",
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 构建角色后缀正则：匹配末尾的角色词 */
const ROLE_SUFFIX_PATTERN = new RegExp(
  `\\s*[（(]?(${Object.keys(ROLE_SUFFIXES)
    .sort((a, b) => b.length - a.length) // 长词优先
    .map(escapeRegExp)
    .join("|")})[）)]?\\s*$`,
  "i",
);

const NEUTRAL_CREATOR_DESCRIPTOR_SUFFIXES = ["编绘", "供图", "等"];

const NEUTRAL_CREATOR_DESCRIPTOR_SUFFIX_PATTERN = new RegExp(
  `\\s*(${NEUTRAL_CREATOR_DESCRIPTOR_SUFFIXES.map(escapeRegExp).join("|")})\\s*$`,
);

function stripNeutralCreatorDescriptorSuffixes(name: string): string {
  let current = name.trim();
  while (current) {
    const next = current.replace(NEUTRAL_CREATOR_DESCRIPTOR_SUFFIX_PATTERN, "").trim();
    if (next === current) break;
    current = next;
  }
  return current || name.trim();
}

/**
 * 从人名中提取并剥离角色后缀
 * 返回清理后的人名和检测到的角色类型
 */
export function extractRoleSuffix(name: string): {
  cleanName: string;
  role: Creator["creatorType"] | null;
} {
  name = stripNeutralCreatorDescriptorSuffixes(name);
  const match = name.match(ROLE_SUFFIX_PATTERN);
  if (match) {
    return {
      cleanName: stripNeutralCreatorDescriptorSuffixes(name.slice(0, match.index ?? 0)),
      role: ROLE_SUFFIXES[match[1].toLowerCase()] || ROLE_SUFFIXES[match[1]] || null,
    };
  }
  return { cleanName: name, role: null };
}

/**
 * 检查角色词是否在已知映射表中
 * 不在表中的角色标记为 needsReview
 */
const KNOWN_FIELD_ROLES: Record<string, Creator["creatorType"]> = {
  作者: "author",
  著者: "author",
  译者: "translator",
  编者: "editor",
  编辑: "editor",
  辑校: "editor",
  校对: "contributor",
};

export function fieldNameToRole(
  fieldName: string,
): Creator["creatorType"] | null {
  return KNOWN_FIELD_ROLES[fieldName.replace(/[:：\s]/g, "")] || null;
}

/**
 * 提取并去除人名中的括号原名
 * 如「约翰·朗本（John H.Langbein）」→ cleanName: 「约翰·朗本」, originalName: 「John H.Langbein」
 */
export function extractOriginalName(name: string): {
  cleanName: string;
  originalName: string | undefined;
} {
  const match = name.match(/\s*[（(]([^）)]+)[）)]\s*/);
  if (match) {
    return {
      cleanName: name.replace(match[0], "").trim(),
      originalName: match[1].trim(),
    };
  }
  return { cleanName: name, originalName: undefined };
}

/**
 * 提取人名中的国籍标注
 * 如「[美]约翰·朗本」→「美」
 * 如「（美）约翰·朗本」→「美」
 */
export function extractNationality(name: string): string | undefined {
  const bracketMatch = name.match(/^\s*\[([^\]]+)\]\s*/);
  if (bracketMatch) return bracketMatch[1];
  const parenMatch = name.match(/^\s*[（(]([\u4E00-\u9FFF]{1,4})[）)]\s*/);
  if (parenMatch) return parenMatch[1];
  return undefined;
}

/**
 * CJK 字符范围（不含间隔号等符号）
 */
const CJK_CHAR = /[\u4E00-\u9FFF\u3400-\u4DBF\u{20000}-\u{2A6DF}]/u;
const CJKV_CHAR =
  /[\u4E00-\u9FFF\u3400-\u4DBF\u{20000}-\u{2A6DF}\u{2A700}-\u{2B73F}\u{2B740}-\u{2B81F}\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/u;
const LATIN_CHAR = /[A-Za-z\u00C0-\u024F]/u;

function stripTrailingLatinAlias(name: string): string {
  if (!CJK_CHAR.test(name) || !LATIN_CHAR.test(name)) return name;

  let lastCjkIndex = -1;
  for (let i = 0; i < name.length; i++) {
    if (CJK_CHAR.test(name[i])) lastCjkIndex = i;
  }

  const trailing = name.slice(lastCjkIndex + 1).trim();
  if (!trailing || !LATIN_CHAR.test(trailing)) return name;

  return name.slice(0, lastCjkIndex + 1).trim();
}

function cleanAliasProbeName(rawName: string): string {
  const nameWithoutNat = removeNationality(rawName);
  const { cleanName: nameWithoutRole } = extractRoleSuffix(
    normalizeInterpunct(nameWithoutNat),
  );
  const { cleanName: nameWithoutOriginal } = extractOriginalName(nameWithoutRole);
  return normalizeCJKVNameWhitespace(stripTrailingLatinAlias(nameWithoutOriginal));
}

function isLikelyLocalizedAliasPair(left: string, right: string): boolean {
  const leftName = cleanAliasProbeName(left);
  const rightName = cleanAliasProbeName(right);
  const leftHasCjk = CJK_CHAR.test(leftName);
  const rightHasCjk = CJK_CHAR.test(rightName);
  if (leftHasCjk === rightHasCjk) return false;

  const leftHasLatin = LATIN_CHAR.test(leftName);
  const rightHasLatin = LATIN_CHAR.test(rightName);
  return leftHasLatin || rightHasLatin;
}

function splitCreatorNames(raw: string): string[] {
  raw = removeNationality(raw);
  const names = raw
    .split(/[/、，,]/)
    .map((n) => n.trim())
    .filter(Boolean);

  if (names.length === 2 && isLikelyLocalizedAliasPair(names[0], names[1])) {
    const leftName = cleanAliasProbeName(names[0]);
    const rightName = cleanAliasProbeName(names[1]);
    return [CJK_CHAR.test(leftName) ? names[0] : names[1]];
  }

  return names;
}

const CJK_CREATOR_EQUIVALENCE: Record<string, string> = {
  "\u6811": "\u6A39",
};

function normalizeCreatorVariantKey(value: string): string {
  let normalized = normalizeInterpunct(value);
  for (const [from, to] of Object.entries(CJK_CREATOR_EQUIVALENCE)) {
    normalized = normalized.split(from).join(to);
  }
  return normalized.toLowerCase();
}

function creatorDedupeKey(creator: Creator): string {
  return `${creator.creatorType}:${normalizeCreatorVariantKey(
    `${creator.firstName} ${creator.lastName}`.trim(),
  )}`;
}

function creatorNameOnlyKey(creator: Creator): string {
  return normalizeCreatorVariantKey(`${creator.firstName} ${creator.lastName}`.trim());
}

function creatorVariantPreferenceScore(creator: Creator): number {
  const name = `${creator.firstName} ${creator.lastName}`.trim();
  let score = 0;
  for (const [from, to] of Object.entries(CJK_CREATOR_EQUIVALENCE)) {
    if (name.includes(to)) score += 2;
    if (name.includes(from)) score -= 1;
  }
  return score;
}

function dedupeCreatorsByVariant(creators: Creator[]): Creator[] {
  const result: Creator[] = [];
  const seen = new Map<string, number>();

  for (const creator of creators) {
    const key = creatorDedupeKey(creator);
    const existingIndex = seen.get(key);
    if (existingIndex !== undefined) {
      if (
        creatorVariantPreferenceScore(creator) >
        creatorVariantPreferenceScore(result[existingIndex])
      ) {
        result[existingIndex] = creator;
      }
      continue;
    }

    seen.set(key, result.length);
    result.push(creator);
  }

  return result;
}

export function dedupeCreatorRoleAliases(creators: Creator[]): Creator[] {
  const authorNameKeys = new Set(
    creators
      .filter((creator) => creator.creatorType === "author")
      .map(creatorNameOnlyKey),
  );

  if (authorNameKeys.size === 0) return creators;

  return creators.filter((creator) => {
    if (creator.creatorType !== "editor" && creator.creatorType !== "contributor") {
      return true;
    }
    return !authorNameKeys.has(creatorNameOnlyKey(creator));
  });
}

const CJK_ORGANIZATION_MARKER_PATTERN =
  /(\u7CFB\u7EDF|\u5E72\u6821|\u7FFB\u8BD1\u7EC4|\u7F16\u8F91\u90E8|\u59D4\u5458\u4F1A|\u51FA\u7248\u793E|\u535A\u7269\u9986|\u7814\u7A76\u6240|\u5C0F\u7EC4|\u5DE5\u4F5C\u5BA4)/u;

function isLikelyCJKOrganizationName(name: string): boolean {
  return CJK_CHAR.test(name) && CJK_ORGANIZATION_MARKER_PATTERN.test(name);
}

function normalizeQuotedCJKOrdinal(name: string): string {
  return name.replace(
    /([\u201C\u2018])([\u4E00-\u9FFF0-9]+)[\u00B7\u2022\u2027\u30FB\uFF0E.]([\u4E00-\u9FFF0-9]+)([\u201D\u2019])/gu,
    "$1$2$3$4",
  );
}

function normalizeCJKVNameWhitespace(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || LATIN_CHAR.test(trimmed)) return trimmed;
  if (!CJKV_CHAR.test(trimmed) || !CJKV_ONLY.test(trimmed)) return trimmed;
  return trimmed.replace(/\s+/g, "");
}

/**
 * 将原始人名字符串格式化为 Zotero Creator 对象
 *
 * CJK 音译外文人名的拆分规则：
 * - 以最后一个「隔断符号（· 或 .）后紧跟 CJK 字符」的位置为拆分点
 * - 拆分点之后的连续文段为姓（lastName），之前的为名（firstName）
 * - 短连接号（- – —）前后视为整体，如「列维-斯特劳斯」不拆
 * - 无隔断符号的纯 CJK 名：全部填入 lastName，fieldMode: 1
 * - 纯外文名：按空格拆分，最后一个词为 lastName
 *
 * @param rawName 原始人名（可能包含国籍标注、原名括号和角色后缀）
 * @param defaultRole 默认角色类型（从字段名推断的角色）
 */
export function formatCreator(
  rawName: string,
  defaultRole: Creator["creatorType"],
): Creator {
  // 1. 去除国籍标注
  let name = removeNationality(rawName);
  if (isLikelyCJKOrganizationName(name)) {
    name = normalizeQuotedCJKOrdinal(name);
  }

  // 2.5. 规范化间隔号空格（「大卫 · 布莱克本」→「大卫·布莱克本」）
  name = normalizeInterpunct(name);

  // 3. 提取角色后缀。必须早于原名提取，否则 "(ed.)" 和 "（编著）" 会被误认为原名。
  const { cleanName, role: suffixRole } = extractRoleSuffix(name);
  name = cleanName;
  const finalRole = suffixRole || defaultRole;

  // 4. 提取并移除括号中的原名（原名信息由 parseCreatorListWithNotes 收集）
  const { cleanName: nameWithoutOriginal } = extractOriginalName(name);
  name = normalizeCJKVNameWhitespace(stripTrailingLatinAlias(nameWithoutOriginal));
  if (isLikelyCJKOrganizationName(name)) {
    return {
      firstName: "",
      lastName: name,
      creatorType: finalRole,
      fieldMode: 1,
    };
  }

  // 5. 尝试 CJK 音译名拆分：在最后一个「隔断符号后紧跟 CJK」的位置拆分
  const splitResult = splitCJKTransliteratedName(name);
  if (splitResult) {
    return {
      firstName: splitResult.firstName,
      lastName: splitResult.lastName,
      creatorType: finalRole,
      fieldMode: 0,
    };
  }

  // 6. 纯 CJK 人名（无间隔号）→ 全名填入 lastName，fieldMode: 1
  if (isCJKName(name)) {
    return {
      firstName: "",
      lastName: name,
      creatorType: finalRole,
      fieldMode: 1,
    };
  }

  // 7. 纯外文人名拆分：最后一个词为 lastName
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length <= 1) {
    return {
      firstName: "",
      lastName: name,
      creatorType: finalRole,
      fieldMode: 1,
    };
  }

  const lastName = parts.pop()!;
  const firstName = parts.join(" ");
  return {
    firstName,
    lastName,
    creatorType: finalRole,
    fieldMode: 0,
  };
}

/**
 * 尝试拆分 CJK 音译外文人名
 * 找到最后一个「隔断符号（·或.）后紧跟 CJK 字符」的位置
 * 返回 null 表示不适用此规则（纯 CJK 或纯外文）
 */
function splitCJKTransliteratedName(
  name: string,
): { firstName: string; lastName: string } | null {
  // 必须同时包含 CJK 字符和隔断符号才适用
  if (!CJK_CHAR.test(name)) return null;
  if (!/[·.]/.test(name)) return null;

  // 从后往前找最后一个「· 或 . 后紧跟 CJK 字符」的位置
  let lastSplitPos = -1;
  for (let i = name.length - 2; i >= 0; i--) {
    const ch = name[i];
    if (ch === "·" || ch === ".") {
      // 检查紧随其后是否有 CJK 字符（可能间隔空格）
      const rest = name.slice(i + 1).trimStart();
      // 使用 slice(0, 2) 以正确匹配 UTF-16 代理对（增补 CJK 字符）
      if (rest.length > 0 && CJK_CHAR.test(rest.slice(0, 2))) {
        lastSplitPos = i;
        break;
      }
    }
  }

  if (lastSplitPos < 0) return null;

  const firstName = name.slice(0, lastSplitPos).trim();
  const lastName = name.slice(lastSplitPos + 1).trim();

  if (!firstName || !lastName) return null;

  return { firstName, lastName };
}

/**
 * 解析一个字段值中的多个人名
 * 豆瓣用 "/" 或 "、" 或 " / " 分隔多人
 */
export function parseCreatorList(
  raw: string,
  defaultRole: Creator["creatorType"],
): Creator[] {
  if (!raw.trim()) return [];

  const names = splitCreatorNames(raw);

  return dedupeCreatorsByVariant(names.map((name) => formatCreator(name, defaultRole)));
}

/**
 * 解析人名列表，同时收集原名信息用于 notes
 * 仅当作者有外文原名时才记入 noteLines
 */
export function parseCreatorListWithNotes(
  raw: string,
  defaultRole: Creator["creatorType"],
): { creators: Creator[]; noteLines: string[] } {
  if (!raw.trim()) return { creators: [], noteLines: [] };

  const names = splitCreatorNames(raw);

  const creators: Creator[] = [];
  const noteLines: string[] = [];
  const seen = new Set<string>();

  for (const rawName of names) {
    const creator = formatCreator(rawName, defaultRole);

    // Deduplicate by normalized name and role; parser-rules handles cross-role aliases.
    const key = creatorDedupeKey(creator);
    if (seen.has(key)) continue;
    seen.add(key);

    creators.push(creator);

    // 收集括号中的原名用于 note（先去除国籍标注，避免国籍泄漏到 note）
    const nameWithoutNat = removeNationality(rawName);
    const { cleanName: nameWithoutRole } = extractRoleSuffix(
      normalizeInterpunct(nameWithoutNat),
    );
    const { originalName } = extractOriginalName(nameWithoutRole);
    if (originalName && !isLikelyNationality(originalName)) {
      noteLines.push(originalName);
    }
  }

  return { creators: dedupeCreatorsByVariant(creators), noteLines };
}

/**
 * 判断提取出的「原名」是否实际上是国籍标注（误匹配）
 * 纯 CJK 且长度 ≤ 4 的大概率是国籍（如「美」「英」「意大利」）
 */
function isLikelyNationality(text: string): boolean {
  return text.length <= 4 && /^[\u4E00-\u9FFF]+$/.test(text);
}
