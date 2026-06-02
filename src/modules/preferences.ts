const PREF_PREFIX = "__prefsPrefix__";

export interface ReadlistConfig {
  uid: string;
  url: string;
  label?: string;
}

export interface OpenAICompatibleSettings {
  baseUrl: string;
  model: string;
  apiKey: string;
}

const READLISTS_PREF = `${PREF_PREFIX}.readlistsJson`;
const LEGACY_DOUBAN_UID_PREF = `${PREF_PREFIX}.doubanUid`;
const OPENAI_BASE_URL_PREF = `${PREF_PREFIX}.openaiCompatible.baseUrl`;
const OPENAI_MODEL_PREF = `${PREF_PREFIX}.openaiCompatible.model`;
const OPENAI_API_KEY_PREF = `${PREF_PREFIX}.openaiCompatible.apiKey`;
const UID_PATTERN = /^[A-Za-z0-9_-]+$/;

function getPrefString(pref: string): string {
  const value = Zotero.Prefs.get(pref, true);
  return typeof value === "string" ? value.trim() : "";
}

function setPrefString(pref: string, value: string): void {
  Zotero.Prefs.set(pref, value, true);
}

function canonicalReadlistUrl(uid: string): string {
  return `https://book.douban.com/people/${encodeURIComponent(uid)}/wish`;
}

function isValidUid(uid: string): boolean {
  return UID_PATTERN.test(uid);
}

function readlistFromUid(uid: string, label?: string): ReadlistConfig | null {
  const cleanUid = uid.trim();
  if (!isValidUid(cleanUid)) return null;
  return {
    uid: cleanUid,
    url: canonicalReadlistUrl(cleanUid),
    ...(label?.trim() ? { label: label.trim() } : {}),
  };
}

export function normalizeReadlistInput(input: string): ReadlistConfig | null {
  const value = input.trim();
  if (!value) return null;

  if (isValidUid(value)) {
    return readlistFromUid(value);
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (url.hostname !== "book.douban.com") return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 3 || parts[0] !== "people" || parts[2] !== "wish") {
    return null;
  }

  const uid = decodeURIComponent(parts[1] ?? "").trim();
  return readlistFromUid(uid);
}

function coerceReadlist(value: unknown): ReadlistConfig | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const input =
    typeof record.url === "string"
      ? record.url
      : typeof record.uid === "string"
        ? record.uid
        : "";
  const normalized = normalizeReadlistInput(input);
  if (!normalized) return null;
  const label = typeof record.label === "string" ? record.label.trim() : "";
  return label ? { ...normalized, label } : normalized;
}

function dedupeReadlists(readlists: ReadlistConfig[]): ReadlistConfig[] {
  const byUid = new Map<string, ReadlistConfig>();
  for (const readlist of readlists) {
    const normalized = coerceReadlist(readlist);
    if (normalized) byUid.set(normalized.uid, normalized);
  }
  return [...byUid.values()];
}

export function getReadlists(): ReadlistConfig[] {
  const text = getPrefString(READLISTS_PREF);
  if (text) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (Array.isArray(parsed)) {
        const readlists = dedupeReadlists(parsed.map(coerceReadlist).filter(Boolean) as ReadlistConfig[]);
        if (readlists.length > 0) return readlists;
      }
    } catch (e: any) {
      Zotero.log(
        `[Douban-to-Zotero] Readlist preferences could not be parsed: ${e?.message || String(e)}`,
        "warning",
      );
    }
  }

  const legacyUid = getDoubanUid();
  const legacyReadlist = legacyUid ? normalizeReadlistInput(legacyUid) : null;
  return legacyReadlist ? [legacyReadlist] : [];
}

export function saveReadlists(readlists: ReadlistConfig[]): void {
  const normalized = dedupeReadlists(readlists);
  setPrefString(READLISTS_PREF, JSON.stringify(normalized));
  setDoubanUid(normalized[0]?.uid ?? "");
}

export function addOrUpdateReadlist(readlist: ReadlistConfig): ReadlistConfig[] {
  const normalized = coerceReadlist(readlist);
  if (!normalized) return getReadlists();
  const next = getReadlists().filter((existing) => existing.uid !== normalized.uid);
  next.push(normalized);
  saveReadlists(next);
  return next;
}

export function deleteReadlist(uid: string): ReadlistConfig[] {
  const next = getReadlists().filter((readlist) => readlist.uid !== uid);
  saveReadlists(next);
  return next;
}

export function getDoubanUid(): string {
  return getPrefString(LEGACY_DOUBAN_UID_PREF);
}

export function setDoubanUid(uid: string): void {
  setPrefString(LEGACY_DOUBAN_UID_PREF, uid.trim());
}

export function getOpenAICompatibleSettings(): OpenAICompatibleSettings {
  return {
    baseUrl: getPrefString(OPENAI_BASE_URL_PREF),
    model: getPrefString(OPENAI_MODEL_PREF),
    apiKey: getPrefString(OPENAI_API_KEY_PREF),
  };
}

export function setOpenAICompatibleSettings(
  settings: OpenAICompatibleSettings,
): void {
  setPrefString(OPENAI_BASE_URL_PREF, settings.baseUrl.trim());
  setPrefString(OPENAI_MODEL_PREF, settings.model.trim());
  setPrefString(OPENAI_API_KEY_PREF, settings.apiKey.trim());
}

export function clearOpenAICompatibleApiKey(): void {
  setPrefString(OPENAI_API_KEY_PREF, "");
}
