import type { BookMetadata, Creator } from "../types";

export const SUPPORTED_BOOK_LANGUAGE_CODES = [
  "zh",
  "ja",
  "en",
  "fr",
  "es",
  "de",
  "ru",
  "ar",
  "sv",
] as const;

export type SupportedBookLanguageCode =
  (typeof SUPPORTED_BOOK_LANGUAGE_CODES)[number];

export const REQUIRED_BOOK_CREATOR_TYPES = ["author", "editor"] as const;

export interface MinimumBookIngestValidationResult {
  eligible: boolean;
  warnings: string[];
  missingFields: string[];
}

function hasText(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function creatorHasName(creator: Creator): boolean {
  return hasText(creator.firstName) || hasText(creator.lastName);
}

function hasRequiredCreator(creators: Creator[] | undefined): boolean {
  return Boolean(
    creators?.some(
      (creator) =>
        REQUIRED_BOOK_CREATOR_TYPES.includes(
          creator.creatorType as (typeof REQUIRED_BOOK_CREATOR_TYPES)[number],
        ) && creatorHasName(creator),
    ),
  );
}

export function normalizeSupportedBookLanguage(
  value: string | undefined,
): SupportedBookLanguageCode | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase() as SupportedBookLanguageCode;
  return SUPPORTED_BOOK_LANGUAGE_CODES.includes(normalized)
    ? normalized
    : undefined;
}

export function isSupportedBookLanguage(
  value: string | undefined,
): value is SupportedBookLanguageCode {
  return normalizeSupportedBookLanguage(value) !== undefined;
}

export function validateMinimumBookIngest(
  book: BookMetadata,
): MinimumBookIngestValidationResult {
  const warnings: string[] = [];
  const missingFields: string[] = [];

  if (!hasText(book.title)) {
    missingFields.push("title");
    warnings.push("minimum-ingest-missing-title");
  }

  if (!hasRequiredCreator(book.creators)) {
    missingFields.push("creator");
    warnings.push("minimum-ingest-missing-author-or-editor");
  }

  if (!hasText(book.publishDate)) {
    missingFields.push("date");
    warnings.push("minimum-ingest-missing-date");
  }

  if (!hasText(book.publisher)) {
    missingFields.push("publisher");
    warnings.push("minimum-ingest-missing-publisher");
  }

  const language = book.language;
  if (!hasText(language)) {
    missingFields.push("language");
    warnings.push("minimum-ingest-missing-language");
  } else if (!isSupportedBookLanguage(language)) {
    warnings.push(`minimum-ingest-unsupported-language-${language.trim()}`);
  }

  return {
    eligible: warnings.length === 0,
    warnings,
    missingFields,
  };
}
