import type { ZoteroBookPayload } from "../types/pipeline";
import { normalizeToISBN13 } from "../utils/isbn";
import { createZoteroBookItemFromPayload } from "./writer";

const WRITE_SMOKE_ENABLED_PREF = "__prefsPrefix__.writeSmokeEnabled";
const WRITE_SMOKE_PAYLOAD_PATH_PREF = "__prefsPrefix__.writeSmokePayloadPath";
const WRITE_SMOKE_RESULT_PATH_PREF = "__prefsPrefix__.writeSmokeResultPath";
const WRITE_SMOKE_COLLECTION_NAME_PATTERN =
  /^douban-to-zotero \S+ \S+ \d{8}-\d{6}$/;

interface ZoteroWriteSmokeRecord {
  importRecordId: string;
  internalId: string;
  status: "prepared" | "inspection";
  payload: ZoteroBookPayload;
  validationWarnings: string[];
  extractionWarnings?: string[];
  validationStatus?: "valid" | "warning" | "invalid";
  sourceUrl?: string;
}

interface ZoteroWriteSmokePayloadFile {
  schemaVersion: 1;
  mode: "zotero-write-dry-payload" | "reference-sample-write-inspection-payload";
  executionMode: "dry-run";
  targetCollectionName: string;
  sourceDbPath: string;
  summaryPath: string;
  exportedAt: string;
  records: ZoteroWriteSmokeRecord[];
}

interface NetworkGuard {
  readonly requests: Array<{ primitive: string; detail: string }>;
  restore(): void;
}

function readStringPref(pref: string): string {
  const value = Zotero.Prefs.get(pref, true);
  return typeof value === "string" ? value.trim() : "";
}

function readBooleanPref(pref: string): boolean {
  return Zotero.Prefs.get(pref, true) === true;
}

function hasWriteSmokeRequest(): boolean {
  return (
    readBooleanPref(WRITE_SMOKE_ENABLED_PREF) &&
    readStringPref(WRITE_SMOKE_PAYLOAD_PATH_PREF).length > 0
  );
}

function disableWriteSmokeRequest(): boolean {
  try {
    Zotero.Prefs.set(WRITE_SMOKE_ENABLED_PREF, false, true);
    Zotero.Prefs.set(WRITE_SMOKE_PAYLOAD_PATH_PREF, "", true);
    Zotero.Prefs.set(WRITE_SMOKE_RESULT_PATH_PREF, "", true);
    return (
      !readBooleanPref(WRITE_SMOKE_ENABLED_PREF) &&
      readStringPref(WRITE_SMOKE_PAYLOAD_PATH_PREF) === "" &&
      readStringPref(WRITE_SMOKE_RESULT_PATH_PREF) === ""
    );
  } catch (error: any) {
    Zotero.log(
      `[Douban-to-Zotero] write smoke one-shot cleanup failed: ${error?.message || String(error)}`,
      "warning",
    );
    return false;
  }
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await IOUtils.writeUTF8(path, `${JSON.stringify(value, null, 2)}\n`);
}

function installNetworkGuard(): NetworkGuard {
  const requests: Array<{ primitive: string; detail: string }> = [];
  const originalHttpRequest = (Zotero.HTTP as any).request;
  const globalObject = globalThis as any;
  const originalFetch = globalObject.fetch;

  (Zotero.HTTP as any).request = async (...args: any[]) => {
    requests.push({
      primitive: "zotero-http-request",
      detail: `${String(args[0] ?? "")} ${String(args[1] ?? "")}`.trim(),
    });
    throw new Error("Unit 4 dry-run write smoke blocked Zotero HTTP request");
  };

  if (typeof originalFetch === "function") {
    globalObject.fetch = async (...args: any[]) => {
      requests.push({
        primitive: "fetch",
        detail: String(args[0] ?? ""),
      });
      throw new Error("Unit 4 dry-run write smoke blocked fetch");
    };
  }

  return {
    requests,
    restore() {
      (Zotero.HTTP as any).request = originalHttpRequest;
      if (typeof originalFetch === "function") {
        globalObject.fetch = originalFetch;
      }
    },
  };
}

function assertPayloadFile(value: unknown): asserts value is ZoteroWriteSmokePayloadFile {
  const candidate = value as Partial<ZoteroWriteSmokePayloadFile>;
  if (!candidate || typeof candidate !== "object") {
    throw new Error("write smoke payload is not an object");
  }
  if (candidate.schemaVersion !== 1) {
    throw new Error("write smoke payload schemaVersion must be 1");
  }
  if (
    candidate.mode !== "zotero-write-dry-payload" &&
    candidate.mode !== "reference-sample-write-inspection-payload"
  ) {
    throw new Error("write smoke payload mode mismatch");
  }
  if (candidate.executionMode !== "dry-run") {
    throw new Error("write smoke payload executionMode must be dry-run");
  }
  if (
    !candidate.targetCollectionName ||
    !WRITE_SMOKE_COLLECTION_NAME_PATTERN.test(candidate.targetCollectionName)
  ) {
    throw new Error("write smoke target collection name is not run-scoped");
  }
  if (!Array.isArray(candidate.records) || candidate.records.length === 0) {
    throw new Error("write smoke payload has no records");
  }
  const expectedStatus =
    candidate.mode === "reference-sample-write-inspection-payload"
      ? "inspection"
      : "prepared";
  for (const record of candidate.records) {
    if (record.status !== expectedStatus) {
      throw new Error(`write smoke record has unexpected status: ${record.importRecordId}`);
    }
    if (!record.payload || record.payload.itemType !== "book") {
      throw new Error(`write smoke record is not a Zotero book payload: ${record.importRecordId}`);
    }
  }
}

function collectionName(collection: any): string {
  if (typeof collection?.name === "string") return collection.name;
  if (typeof collection?.getName === "function") return String(collection.getName());
  return "";
}

function findCollectionByName(name: string): any | null {
  const collections = Zotero.Collections.getByLibrary(Zotero.Libraries.userLibraryID);
  return collections.find((collection) => collectionName(collection) === name) ?? null;
}

async function createRunCollection(name: string): Promise<number> {
  if (findCollectionByName(name)) {
    throw new Error(`target collection already exists: ${name}`);
  }

  const collection = new (Zotero as any).Collection();
  collection.libraryID = Zotero.Libraries.userLibraryID;
  collection.name = name;
  const savedId = await collection.saveTx();
  const collectionId = typeof savedId === "number" ? savedId : collection.id;
  if (typeof collectionId !== "number") {
    throw new Error("created collection did not expose a numeric id");
  }
  return collectionId;
}

function getItemField(item: any, field: string): string {
  const value = item.getField(field);
  return value == null ? "" : String(value);
}

function getCreatorTypeName(creator: any): string {
  if (typeof creator?.creatorType === "string") return creator.creatorType;
  if (
    typeof creator?.creatorTypeID === "number" &&
    typeof (Zotero as any).CreatorTypes?.getName === "function"
  ) {
    return String((Zotero as any).CreatorTypes.getName(creator.creatorTypeID));
  }
  return "";
}

function creatorsMatch(item: any, payload: ZoteroBookPayload): boolean {
  if (typeof item.getCreators !== "function") return false;
  const creators = item.getCreators();
  if (!Array.isArray(creators) || creators.length !== payload.creators.length) {
    return false;
  }
  return payload.creators.every((expected, index) => {
    const actual = creators[index];
    return (
      String(actual.firstName ?? "") === expected.firstName &&
      String(actual.lastName ?? "") === expected.lastName &&
      getCreatorTypeName(actual) === expected.creatorType &&
      Number(actual.fieldMode ?? 0) === expected.fieldMode
    );
  });
}

function collectionMembershipMatches(item: any, collectionId: number): boolean {
  if (typeof item.inCollection === "function") {
    return Boolean(item.inCollection(collectionId));
  }
  if (typeof item.getCollections === "function") {
    return item.getCollections().includes(collectionId);
  }
  return false;
}

function noteTextsForItem(item: any): string[] | null {
  const sourceItem = Zotero.Items.get(Number(item.id)) ?? item;
  if (typeof sourceItem.getNotes !== "function") return null;
  const noteIds = sourceItem.getNotes();
  if (!Array.isArray(noteIds)) return null;

  return noteIds.map((noteId) => {
    const note = Zotero.Items.get(Number(noteId));
    return typeof note?.getNote === "function" ? String(note.getNote()) : "";
  });
}

function notesMatch(item: any, payload: ZoteroBookPayload): boolean {
  const actualNotes = noteTextsForItem(item);
  if (!actualNotes) return false;
  const expectedNotes = payload.notes.map((note) => note.note.trim()).filter(Boolean);
  return (
    actualNotes.length === expectedNotes.length &&
    expectedNotes.every((expected) => actualNotes.includes(expected))
  );
}

function validateCreatedItem(
  item: any,
  payload: ZoteroBookPayload,
  collectionId: number,
): Record<string, boolean> {
  const actualISBN = getItemField(item, "ISBN");
  const expectedISBN = payload.fields.ISBN;
  const actualISBN13 = normalizeToISBN13(actualISBN);
  const expectedISBN13 = normalizeToISBN13(expectedISBN);
  return {
    title: getItemField(item, "title") === payload.fields.title,
    creators: creatorsMatch(item, payload),
    publisher: getItemField(item, "publisher") === payload.fields.publisher,
    date: getItemField(item, "date") === payload.fields.date,
    language: getItemField(item, "language") === payload.fields.language,
    ISBN: actualISBN === expectedISBN ||
      (actualISBN13 != null && expectedISBN13 != null && actualISBN13 === expectedISBN13),
    notes: notesMatch(item, payload),
    collectionMembership: collectionMembershipMatches(item, collectionId),
  };
}

function checkAllValues(value: Record<string, boolean>): boolean {
  return Object.values(value).every(Boolean);
}

export async function runDevZoteroWriteSmokeIfRequested(): Promise<void> {
  if (!__DEV__ || !hasWriteSmokeRequest()) return;

  const payloadPath = readStringPref(WRITE_SMOKE_PAYLOAD_PATH_PREF);
  const resultPath = readStringPref(WRITE_SMOKE_RESULT_PATH_PREF);
  const startedAt = new Date().toISOString();
  if (!resultPath) {
    disableWriteSmokeRequest();
    Zotero.log(
      "[Douban-to-Zotero] write smoke requested but result path pref is empty",
      "warning",
    );
    return;
  }

  const networkGuard = installNetworkGuard();
  const errors: string[] = [];
  const createdRecords: Array<{
    importRecordId: string;
    internalId: string;
    itemId: number;
    checks: Record<string, boolean>;
  }> = [];

  try {
    const payloadText = await IOUtils.readUTF8(payloadPath);
    const payloadFile = JSON.parse(payloadText);
    assertPayloadFile(payloadFile);

    const dataDirectory = Zotero.DataDirectory.dir;
    const dataDirectoryLower = dataDirectory.toLowerCase();
    const disposableDataDirectory =
      (
        dataDirectoryLower.includes("zotero-write-dry-") ||
        dataDirectoryLower.includes("reference-sample-write-inspection-")
      ) &&
      dataDirectoryLower.includes("\\data");
    if (!disposableDataDirectory) {
      throw new Error(`Zotero data directory is not a write-smoke run directory: ${dataDirectory}`);
    }

    const collectionId = await createRunCollection(payloadFile.targetCollectionName);
    for (const record of payloadFile.records) {
      if (record.payload.attachments.length > 0) {
        throw new Error(`write smoke does not import attachments: ${record.importRecordId}`);
      }
      const item = await createZoteroBookItemFromPayload(record.payload, collectionId);
      const checks = validateCreatedItem(item, record.payload, collectionId);
      if (!checkAllValues(checks)) {
        errors.push(`created item failed validation: ${record.importRecordId}`);
      }
      createdRecords.push({
        importRecordId: record.importRecordId,
        internalId: record.internalId,
        itemId: item.id,
        checks,
      });
    }

    const oneShotPrefsCleared = disableWriteSmokeRequest();
    const checks = {
      payloadFileRead: true,
      dryRunMode: payloadFile.executionMode === "dry-run",
      targetCollectionNameSafe: WRITE_SMOKE_COLLECTION_NAME_PATTERN.test(
        payloadFile.targetCollectionName,
      ),
      disposableDataDirectory,
      collectionCreated: typeof collectionId === "number",
      expectedRecordStatus: payloadFile.mode === "reference-sample-write-inspection-payload"
        ? payloadFile.records.every((record) => record.status === "inspection")
        : payloadFile.records.every((record) => record.status === "prepared"),
      itemCountMatches: createdRecords.length === payloadFile.records.length,
      createdItemChecksPass: createdRecords.every((record) => checkAllValues(record.checks)),
      noNetworkRequests: networkGuard.requests.length === 0,
      oneShotPrefsCleared,
    };
    const passed = checkAllValues(checks) && errors.length === 0;

    await writeJsonFile(resultPath, {
      schemaVersion: 1,
      mode: payloadFile.mode === "reference-sample-write-inspection-payload"
        ? "zotero-reference-sample-inspection-addon"
        : "zotero-write-dry-addon",
      timestamp: new Date().toISOString(),
      startedAt,
      completedAt: new Date().toISOString(),
      passed,
      executionMode: payloadFile.executionMode,
      targetCollectionName: payloadFile.targetCollectionName,
      collectionId,
      zoteroDataDirectory: dataDirectory,
      payloadPath,
      sourceDbPath: payloadFile.sourceDbPath,
      summaryPath: payloadFile.summaryPath,
      checks,
      createdRecords,
      errors,
      networkRequests: networkGuard.requests,
    });
  } catch (error: any) {
    const oneShotPrefsCleared = disableWriteSmokeRequest();
    await writeJsonFile(resultPath, {
      schemaVersion: 1,
      mode: "zotero-write-dry-addon",
      timestamp: new Date().toISOString(),
      startedAt,
      completedAt: new Date().toISOString(),
      passed: false,
      executionMode: "dry-run",
      payloadPath,
      checks: {
        noNetworkRequests: networkGuard.requests.length === 0,
        oneShotPrefsCleared,
      },
      createdRecords,
      errors: [error?.message || String(error), ...errors],
      networkRequests: networkGuard.requests,
    });
  } finally {
    networkGuard.restore();
  }
}
