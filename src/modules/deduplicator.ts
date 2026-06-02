import type { BookMetadata, DeduplicationResult } from "../types";
import { normalizeToISBN13 } from "../utils/isbn";
import {
  extractMainTitle,
  normalizedSimilarity,
} from "../utils/string-similarity";

const FUZZY_DUPLICATE_THRESHOLD = 0.95;
const FUZZY_CANDIDATE_THRESHOLD = 0.8;
const TITLE_WEIGHT = 0.6;
const PUBLISHER_WEIGHT = 0.2;
const YEAR_MATCH_BONUS = 0.2;
const MISSING_YEAR_BONUS = 0.1;
const YEAR_MISMATCH_PENALTY = 0.1;
const STRONG_PUBLISHER_THRESHOLD = 0.8;

export async function checkDuplicates(
  books: BookMetadata[],
): Promise<DeduplicationResult[]> {
  const results: DeduplicationResult[] = [];

  for (const book of books) {
    const isbnMatch = await searchByAnyISBN(book);
    if (isbnMatch) {
      results.push({
        book,
        matchType: "duplicate",
        matchedItemId: isbnMatch.id,
        matchedItemTitle: isbnMatch.title,
        matchConfidence: 1.0,
        matchReason: "ISBN match",
      });
      continue;
    }

    const fuzzyMatch = await searchByTitlePublisher(book);
    if (fuzzyMatch) {
      results.push({
        book,
        matchType: fuzzyMatch.confidence >= FUZZY_DUPLICATE_THRESHOLD
          ? "duplicate"
          : "suspect",
        matchedItemId: fuzzyMatch.id,
        matchedItemTitle: fuzzyMatch.title,
        matchConfidence: fuzzyMatch.confidence,
        matchReason: `${fuzzyMatch.reason} (${(fuzzyMatch.confidence * 100).toFixed(0)}%)`,
      });
      continue;
    }

    results.push({
      book,
      matchType: "new",
    });
  }

  return results;
}

function normalizedIsbnCandidates(
  ...values: Array<string | undefined>
): string[] {
  const candidates = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    const clean = value.replace(/[-\s]/g, "");
    if (clean) candidates.add(clean);
    const isbn13 = normalizeToISBN13(value);
    if (isbn13) candidates.add(isbn13);
  }
  return [...candidates];
}

function hasSharedNormalizedISBN(book: BookMetadata, existingISBN: string): boolean | null {
  const bookCandidates = normalizedIsbnCandidates(book.isbn, book.isbn13);
  const existingCandidates = normalizedIsbnCandidates(existingISBN);
  if (bookCandidates.length === 0 || existingCandidates.length === 0) return null;
  return bookCandidates.some((isbn) => existingCandidates.includes(isbn));
}

async function searchByAnyISBN(
  book: BookMetadata,
): Promise<{ id: number; title: string } | null> {
  for (const isbn of normalizedIsbnCandidates(book.isbn13, book.isbn)) {
    const match = await searchByISBN(isbn);
    if (match) return match;
  }
  return searchByNormalizedISBNScan(book);
}

async function searchByISBN(
  isbn: string,
): Promise<{ id: number; title: string } | null> {
  try {
    const search = new Zotero.Search();
    search.libraryID = Zotero.Libraries.userLibraryID;
    search.addCondition("itemType", "is", "book");
    search.addCondition("ISBN", "is", isbn);
    const ids = await search.search();

    if (ids.length > 0) {
      const item = Zotero.Items.get(ids[0]);
      return {
        id: ids[0],
        title: item.getField("title") as string,
      };
    }
  } catch (e) {
    Zotero.log(`[Douban-to-Zotero] ISBN search failed: ${isbn} - ${e}`, "warning");
  }
  return null;
}

async function searchByNormalizedISBNScan(
  book: BookMetadata,
): Promise<{ id: number; title: string } | null> {
  const bookCandidates = normalizedIsbnCandidates(book.isbn13, book.isbn);
  if (bookCandidates.length === 0) return null;

  try {
    const search = new Zotero.Search();
    search.libraryID = Zotero.Libraries.userLibraryID;
    search.addCondition("itemType", "is", "book");
    const ids = await search.search();

    for (const id of ids) {
      const item = Zotero.Items.get(id);
      const existingISBN = (item.getField("ISBN") as string) || "";
      if (hasSharedNormalizedISBN(book, existingISBN) === true) {
        return {
          id,
          title: item.getField("title") as string,
        };
      }
    }
  } catch (e) {
    Zotero.log(
      `[Douban-to-Zotero] normalized ISBN duplicate scan failed: ${book.title} - ${e}`,
      "warning",
    );
  }
  return null;
}

async function searchByTitlePublisher(
  book: BookMetadata,
): Promise<{ id: number; title: string; confidence: number; reason: string } | null> {
  try {
    const mainTitle = extractMainTitle(book.title);
    if (!mainTitle) return null;

    const search = new Zotero.Search();
    search.libraryID = Zotero.Libraries.userLibraryID;
    search.addCondition("itemType", "is", "book");
    search.addCondition("title", "contains", mainTitle.slice(0, 10));
    const ids = await search.search();

    if (ids.length === 0) return null;

    let bestMatch: { id: number; title: string; confidence: number; reason: string } | null =
      null;

    for (const id of ids) {
      const item = Zotero.Items.get(id);
      const existingTitle = item.getField("title") as string;
      const existingPublisher = item.getField("publisher") as string;
      const existingISBN = (item.getField("ISBN") as string) || "";
      const existingDate = (item.getField("date") as string) || "";

      const isbnComparison = hasSharedNormalizedISBN(book, existingISBN);
      if (isbnComparison === false) continue;

      const titleSimilarity = normalizedSimilarity(book.title, existingTitle);
      let combined = titleSimilarity;
      const matchParts: string[] = ["title"];

      if (book.publisher && existingPublisher) {
        const publisherSimilarity = normalizedSimilarity(
          book.publisher,
          existingPublisher,
        );
        combined = titleSimilarity * TITLE_WEIGHT +
          publisherSimilarity * PUBLISHER_WEIGHT;
        if (publisherSimilarity > STRONG_PUBLISHER_THRESHOLD) {
          matchParts.push("publisher");
        }

        if (book.publishDate && existingDate) {
          const bookYear = book.publishDate.slice(0, 4);
          const existingYear = existingDate.slice(0, 4);
          if (bookYear === existingYear) {
            combined += YEAR_MATCH_BONUS;
            matchParts.push("year");
          } else {
            combined -= YEAR_MISMATCH_PENALTY;
          }
        } else {
          combined += MISSING_YEAR_BONUS;
        }
      }

      if (
        combined > FUZZY_CANDIDATE_THRESHOLD &&
        (!bestMatch || combined > bestMatch.confidence)
      ) {
        bestMatch = {
          id,
          title: existingTitle,
          confidence: combined,
          reason: `${matchParts.join("+")} fuzzy match`,
        };
      }
    }

    return bestMatch;
  } catch (e) {
    Zotero.log(`[Douban-to-Zotero] fuzzy duplicate search failed: ${book.title} - ${e}`, "warning");
  }
  return null;
}
