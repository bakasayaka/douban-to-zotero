/** 人物角色信息 */
export interface Creator {
  firstName: string;
  lastName: string;
  creatorType:
    | "author"
    | "translator"
    | "editor"
    | "contributor"
    | "seriesEditor";
  /** 0 = firstName+lastName 分开, 1 = 仅 lastName（CJK 人名） */
  fieldMode: 0 | 1;
  /** 角色映射不确定，需要用户复核 */
  needsReview?: boolean;
}

/** 从豆瓣详情页提取的结构化书目元数据 */
export interface BookMetadata {
  doubanUrl: string;
  doubanId: string;
  title: string;
  subtitle?: string;
  creators: Creator[];
  publisher: string;
  publishDate: string;
  isbn?: string;
  /** 规范化为 ISBN-13 */
  isbn13?: string;
  pages?: string;
  price?: string;
  series?: string;
  seriesNumber?: string;
  volume?: string;
  numberOfVolumes?: string;
  edition?: string;
  place?: string;
  originalDate?: string;
  originalPublisher?: string;
  originalPlace?: string;
  format?: string;
  doi?: string;
  citationKey?: string;
  accessed?: string;
  issn?: string;
  archive?: string;
  archiveLocation?: string;
  shortTitle?: string;
  /** ISO 639-1 code for initial ingest, e.g. zh, ja, en, fr, es, de, ru, ar, sv */
  language?: string;
  callNumber?: string;
  license?: string;
  extra?: string;
  originalTitle?: string;
  abstractNote?: string;
  coverUrl?: string;
  /** 作者原名、国籍等附加信息，写入条目 note */
  creatorNotes?: string[];
}

/** 抓取想读列表时每本书的原始数据 */
export interface RawBookData {
  url: string;
  html: string;
}

/** 想读列表抓取的完整结果（含警告信息） */
export interface FetchResult {
  books: RawBookData[];
  /** 每页的隐形封禁等警告信息 */
  warnings: string[];
}

/** 去重匹配类型 */
export type MatchType = "new" | "duplicate" | "suspect";

/** 去重比对结果 */
export interface DeduplicationResult {
  book: BookMetadata;
  matchType: MatchType;
  /** 匹配到的 Zotero 条目 ID */
  matchedItemId?: number;
  matchedItemTitle?: string;
  /** 模糊匹配置信度 0-1 */
  matchConfidence?: number;
  /** 匹配原因说明 */
  matchReason?: string;
}

/** 多卷导入中的单卷条目 */
export interface VolumeEntry {
  volumeNumber: string;
  metadata: BookMetadata;
  localFilePath?: string;
  fileMatchStatus: "matched" | "missing" | "manual";
}

/** 批量写入结果 */
export interface WriteResult {
  created: number;
  errors: string[];
}
