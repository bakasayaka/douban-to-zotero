import type { ZoteroBookPayload } from "../types/pipeline";
import { STANDARD_ZOTERO_BOOK_FIELD_NAMES } from "./zotero-book-payload";

export interface ZoteroPayloadValidationResult {
  valid: boolean;
  warnings: string[];
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function validateZoteroBookPayload(
  payload: unknown,
): ZoteroPayloadValidationResult {
  const warnings: string[] = [];
  const candidate = payload as Partial<ZoteroBookPayload>;

  if (!candidate || typeof candidate !== "object") {
    return { valid: false, warnings: ["payload-not-object"] };
  }
  if (candidate.itemType !== "book") warnings.push("itemType-not-book");
  if (!candidate.fields || typeof candidate.fields !== "object") {
    warnings.push("missing-fields");
  } else {
    for (const fieldName of STANDARD_ZOTERO_BOOK_FIELD_NAMES) {
      if (!(fieldName in candidate.fields)) {
        warnings.push(`missing-standard-field-${fieldName}`);
      }
    }
    if (!isString(candidate.fields.title)) warnings.push("missing-title");
    if (!isString(candidate.fields.url)) warnings.push("missing-url");
    if (candidate.fields.libraryCatalog !== "Douban") {
      warnings.push("libraryCatalog-not-douban");
    }
  }
  if (!Array.isArray(candidate.creators)) {
    warnings.push("creators-not-array");
  } else {
    for (const [index, creator] of candidate.creators.entries()) {
      if (!creator || typeof creator !== "object") {
        warnings.push(`creator-${index}-not-object`);
        continue;
      }
      if (!isString(creator.creatorType)) warnings.push(`creator-${index}-missing-type`);
      if (creator.fieldMode !== 0 && creator.fieldMode !== 1) {
        warnings.push(`creator-${index}-invalid-field-mode`);
      }
      if (!isString(creator.lastName) && !isString(creator.firstName)) {
        warnings.push(`creator-${index}-missing-name`);
      }
    }
  }
  if (!Array.isArray(candidate.notes)) warnings.push("notes-not-array");
  if (!Array.isArray(candidate.attachments)) warnings.push("attachments-not-array");

  return { valid: warnings.length === 0, warnings };
}
