import type { BookMetadata, Creator } from "./index";

export type PipelineExecutionMode = "dry-run" | "live";
export type PipelineStatus = "started" | "completed" | "failed";
export type ValidationStatus = "valid" | "warning" | "invalid";
export type FieldProvenanceKind =
  | "scraped"
  | "rule-cleaned"
  | "llm-cleaned"
  | "manual"
  | "zotero-derived";

export interface PipelineRunRecord {
  runId: string;
  executionMode: PipelineExecutionMode;
  status: PipelineStatus;
  source: string;
  inputManifestPath?: string;
  startedAt: string;
  completedAt?: string;
  notes: string[];
}

export interface RawScrapedRecord {
  internalId: string;
  scrapeRunId: string;
  sourceUrl: string;
  doubanSubjectId?: string;
  wishlistOwnerId?: string;
  sourceKind: "douban-subject-page" | "douban-wishlist-entry" | "synthetic";
  rawHtml: string;
  rawHtmlSha256: string;
  listContext?: {
    wishlistUrl?: string;
    wishlistTitle?: string;
    position?: number;
  };
  extractedMetadata?: Partial<BookMetadata>;
  extractionWarnings: string[];
  provenance: {
    fixtureId?: string;
    fixturePath?: string;
    capturedAt?: string | null;
    capturedByMode: "synthetic" | "live-fixture-refresh" | "manual";
    redactions: string[];
    notes?: string;
  };
  createdAt: string;
}

export interface CleaningRunRecord {
  cleaningRunId: string;
  executionMode: PipelineExecutionMode;
  cleanerKind: "rule-parser" | "openai-compatible" | "manual" | "replay";
  provider?: "openai-compatible" | "anthropic-compatible" | "local" | "none";
  model?: string;
  promptTemplateHash?: string;
  settings: Record<string, unknown>;
  startedAt: string;
  completedAt?: string;
}

export interface CleanedBookRecord {
  internalId: string;
  rawRecordId: string;
  cleaned: BookMetadata;
  validationStatus: ValidationStatus;
  validationWarnings: string[];
  fieldProvenance: Partial<Record<keyof BookMetadata | "creators", FieldProvenanceKind>>;
  confidence: Partial<Record<keyof BookMetadata | "creators", number>>;
  createdAt: string;
}

export interface ZoteroBookPayload {
  itemType: "book";
  fields: {
    title: string;
    abstractNote: string;
    series: string;
    seriesNumber: string;
    volume: string;
    numberOfVolumes: string;
    edition: string;
    date: string;
    publisher: string;
    place: string;
    originalDate: string;
    originalPublisher: string;
    originalPlace: string;
    format: string;
    numPages: string;
    ISBN: string;
    DOI: string;
    citationKey: string;
    url: string;
    accessDate: string;
    ISSN: string;
    archive: string;
    archiveLocation: string;
    shortTitle: string;
    language: string;
    libraryCatalog: "Douban";
    callNumber: string;
    rights: string;
    extra: string;
  };
  creators: Creator[];
  notes: Array<{
    note: string;
    source: "original-title" | "creator-note" | "validation";
  }>;
  attachments: Array<{
    title: string;
    path?: string;
    url?: string;
  }>;
}

export interface ExchangeExportRecord {
  internalId: string;
  cleanedRecordId: string;
  format: "zotero-json" | "bibtex" | "biblatex";
  payloadText?: string;
  payloadJson?: ZoteroBookPayload | Record<string, unknown>;
  validationStatus: ValidationStatus;
  validationWarnings: string[];
  createdAt: string;
}
