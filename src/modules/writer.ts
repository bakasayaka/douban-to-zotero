import type { BookMetadata, VolumeEntry, WriteResult } from "../types";
import type { ZoteroBookPayload } from "../types/pipeline";
import { validateMinimumBookIngest } from "./ingest-validator";
import {
  bookToZoteroBookPayload,
  STANDARD_ZOTERO_BOOK_FIELD_NAMES,
} from "./zotero-book-payload";
import { validateZoteroBookPayload } from "./zotero-payload-validator";

export async function writeBooks(
  books: BookMetadata[],
  collectionId?: number,
): Promise<WriteResult> {
  let created = 0;
  const errors: string[] = [];

  for (const book of books) {
    try {
      const payload = createPayloadForIngestEligibleBook(book);
      await createZoteroBookItemFromPayload(payload, collectionId);
      created++;
    } catch (e: any) {
      errors.push(`"${book.title}": ${e.message || String(e)}`);
    }
  }

  return { created, errors };
}

export async function writeBooksWithAttachments(
  volumes: VolumeEntry[],
  collectionId?: number,
): Promise<WriteResult> {
  let created = 0;
  const errors: string[] = [];

  for (const volume of volumes) {
    try {
      const payload = createPayloadForIngestEligibleBook(volume.metadata);
      const item = await createZoteroBookItemFromPayload(payload, collectionId);
      if (volume.localFilePath) {
        await Zotero.Attachments.importFromFile({
          file: volume.localFilePath,
          parentItemID: item.id,
        });
      }
      created++;
    } catch (e: any) {
      errors.push(`"${volume.metadata.title}": ${e.message || String(e)}`);
    }
  }

  return { created, errors };
}

export async function createZoteroBookItemFromPayload(
  payload: ZoteroBookPayload,
  collectionId?: number,
): Promise<any> {
  const payloadValidation = validateZoteroBookPayload(payload);
  if (!payloadValidation.valid) {
    throw new Error(
      `Invalid Zotero book payload: ${payloadValidation.warnings.join(", ")}`,
    );
  }

  const item = new Zotero.Item("book");
  item.libraryID = Zotero.Libraries.userLibraryID;

  for (const fieldName of STANDARD_ZOTERO_BOOK_FIELD_NAMES) {
    const value = payload.fields[fieldName];
    if (value || fieldName === "title" || fieldName === "libraryCatalog") {
      item.setField(fieldName, value);
    }
  }

  if (collectionId) {
    item.addToCollection(collectionId);
  }

  if (payload.creators.length > 0) {
    item.setCreators(
      payload.creators.map((creator) => ({
        firstName: creator.firstName,
        lastName: creator.lastName,
        creatorType: creator.creatorType,
        fieldMode: creator.fieldMode,
      })),
    );
  }

  await item.saveTx();

  for (const notePayload of payload.notes) {
    const noteText = notePayload.note.trim();
    if (!noteText) continue;

    const note = new Zotero.Item("note");
    note.libraryID = Zotero.Libraries.userLibraryID;
    note.parentID = item.id;
    note.setNote(noteText);
    await note.saveTx();
  }

  return item;
}

function createPayloadForIngestEligibleBook(book: BookMetadata): ZoteroBookPayload {
  const ingestValidation = validateMinimumBookIngest(book);
  if (!ingestValidation.eligible) {
    throw new Error(
      `Incomplete metadata: ${ingestValidation.warnings.join(", ")}`,
    );
  }

  return bookToZoteroBookPayload(book);
}
