import type { BookMetadata } from "../types";
import type { ZoteroBookPayload } from "../types/pipeline";

export const STANDARD_ZOTERO_BOOK_FIELD_NAMES = [
  "title",
  "abstractNote",
  "series",
  "seriesNumber",
  "volume",
  "numberOfVolumes",
  "edition",
  "date",
  "publisher",
  "place",
  "originalDate",
  "originalPublisher",
  "originalPlace",
  "format",
  "numPages",
  "ISBN",
  "DOI",
  "citationKey",
  "url",
  "accessDate",
  "ISSN",
  "archive",
  "archiveLocation",
  "shortTitle",
  "language",
  "libraryCatalog",
  "callNumber",
  "rights",
  "extra",
] as const;

export type StandardZoteroBookFieldName =
  (typeof STANDARD_ZOTERO_BOOK_FIELD_NAMES)[number];

function value(value: string | undefined): string {
  return value ?? "";
}

export function bookToZoteroBookPayload(book: BookMetadata): ZoteroBookPayload {
  const notes: ZoteroBookPayload["notes"] = [];
  if (book.originalTitle) {
    notes.push({ note: `Original title: ${book.originalTitle}`, source: "original-title" });
  }
  for (const creatorNote of book.creatorNotes ?? []) {
    notes.push({ note: `Creator note: ${creatorNote}`, source: "creator-note" });
  }

  return {
    itemType: "book",
    fields: {
      title: book.title,
      abstractNote: value(book.abstractNote),
      series: value(book.series),
      seriesNumber: value(book.seriesNumber),
      volume: value(book.volume),
      numberOfVolumes: value(book.numberOfVolumes),
      edition: value(book.edition),
      date: value(book.publishDate),
      publisher: value(book.publisher),
      place: value(book.place),
      originalDate: value(book.originalDate),
      originalPublisher: value(book.originalPublisher),
      originalPlace: value(book.originalPlace),
      format: value(book.format),
      numPages: value(book.pages),
      ISBN: value(book.isbn13 || book.isbn),
      DOI: value(book.doi),
      citationKey: value(book.citationKey),
      url: book.doubanUrl,
      accessDate: value(book.accessed),
      ISSN: value(book.issn),
      archive: value(book.archive),
      archiveLocation: value(book.archiveLocation),
      shortTitle: value(book.shortTitle),
      language: value(book.language),
      libraryCatalog: "Douban",
      callNumber: value(book.callNumber),
      rights: value(book.license),
      extra: value(book.extra),
    },
    creators: book.creators,
    notes,
    attachments: [],
  };
}
