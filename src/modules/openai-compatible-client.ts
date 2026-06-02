import type { BookMetadata } from "../types";
import type { PipelineExecutionMode } from "../types/pipeline";
import {
  normalizeSupportedBookLanguage,
  SUPPORTED_BOOK_LANGUAGE_CODES,
} from "./ingest-validator";
import {
  type OpenAICompatibleTransport,
  ZoteroOpenAICompatibleTransport,
} from "./openai-compatible-transport";

export interface OpenAICompatibleCleanerConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature?: number;
  timeoutMs?: number;
}

export const OPENAI_COMPATIBLE_CLEANER_PROMPT_TEMPLATE_VERSION =
  "openai-compatible-cleaner-v2";

export const OPENAI_COMPATIBLE_LANGUAGE_COMPLETION_POLICY = {
  supportedLanguageCodes: SUPPORTED_BOOK_LANGUAGE_CODES,
  rule: [
    "If ruleMetadata.language is missing and the supplied page evidence strongly supports one edition language, fill language.",
    "Use only the supported ISO 639-1 language codes.",
    "For translated editions, language means the language of this edition's text, not the original work.",
    "Chinese title, Chinese publisher, Chinese #info/intro text, or Chinese translator evidence may support zh even when the original author is foreign.",
    "Do not infer language from author nationality or original title alone.",
    "Leave language empty when evidence is mixed or ambiguous.",
  ],
} as const;

export const OPENAI_COMPATIBLE_CLEANER_SYSTEM_PROMPT = [
  "Clean Douban book metadata for a Zotero importer.",
  "Return one JSON object matching the existing metadata shape.",
  "Preserve uncertainty instead of inventing unsupported facts.",
  "Low-risk language completion is allowed and expected:",
  "if ruleMetadata.language is missing and the supplied page evidence strongly supports one edition language, fill language.",
  `Use only these ISO 639-1 language codes: ${SUPPORTED_BOOK_LANGUAGE_CODES.join(", ")}.`,
  "For translated editions, language means the language of this edition's text, not the original work.",
  "Chinese title, Chinese publisher, Chinese #info/intro text, or Chinese translator evidence may support zh even when the original author is foreign.",
  "Do not infer language from author nationality or original title alone.",
  "Leave language empty when evidence is mixed or ambiguous.",
].join(" ");

export const OPENAI_COMPATIBLE_REDACTED_API_KEY = "[redacted-api-key]";

export function redactOpenAICompatibleApiKey(text: string, apiKey?: string): string {
  if (!apiKey) return text;
  return text.split(apiKey).join(OPENAI_COMPATIBLE_REDACTED_API_KEY);
}

export interface ModelRequestLogEntry {
  url: string;
  startedAt: string;
  finishedAt?: string;
  ok: boolean;
  statusCode?: number;
  errorName?: string;
  errorMessage?: string;
}

export class ModelNetworkAccessDeniedError extends Error {
  constructor() {
    super("Metadata-cleaning model calls are not allowed outside explicit live mode");
    this.name = "ModelNetworkAccessDeniedError";
  }
}

export class ModelConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelConfigurationError";
  }
}

export class ModelHttpError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly responseText: string,
  ) {
    super(message);
    this.name = "ModelHttpError";
  }
}

export class ModelRateLimitError extends ModelHttpError {
  constructor(statusCode: number, responseText: string) {
    super(`OpenAI-compatible request was rate-limited or blocked: HTTP ${statusCode}`, statusCode, responseText);
    this.name = "ModelRateLimitError";
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  const parsed = new URL(baseUrl);
  const isLocalhost = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(isLocalhost && parsed.protocol === "http:")) {
    throw new ModelConfigurationError(
      "OpenAI-compatible base URL must be HTTPS unless it targets localhost",
    );
  }
  return parsed.toString().replace(/\/+$/, "");
}

function parseJsonObject(text: string): BookMetadata {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error("Model response did not contain a JSON object");
  }
  const book = JSON.parse(text.slice(start, end + 1)) as BookMetadata;
  if (book.language !== undefined) {
    const language = normalizeSupportedBookLanguage(book.language);
    if (language) book.language = language;
    else delete book.language;
  }
  return book;
}

export class OpenAICompatibleMetadataCleaner {
  readonly requestLog: ModelRequestLogEntry[] = [];

  constructor(
    private readonly config: OpenAICompatibleCleanerConfig,
    private readonly mode: PipelineExecutionMode,
    private readonly transport: OpenAICompatibleTransport =
      new ZoteroOpenAICompatibleTransport(),
  ) {
    if (!config.apiKey) {
      throw new ModelConfigurationError("OpenAI-compatible cleaner requires an API key");
    }
    if (!config.model) {
      throw new ModelConfigurationError("OpenAI-compatible cleaner requires a model name");
    }
  }

  async clean(rawText: string, ruleMetadata: BookMetadata): Promise<BookMetadata> {
    if (this.mode !== "live") {
      throw new ModelNetworkAccessDeniedError();
    }

    const baseUrl = normalizeBaseUrl(this.config.baseUrl);
    const url = `${baseUrl}/chat/completions`;
    const entry: ModelRequestLogEntry = {
      url: redactOpenAICompatibleApiKey(url, this.config.apiKey),
      startedAt: new Date().toISOString(),
      ok: false,
    };
    this.requestLog.push(entry);

    try {
      const response = await this.transport.postJson(
        url,
        this.config.apiKey,
        {
          model: this.config.model,
          temperature: this.config.temperature ?? 0,
          messages: [
            {
              role: "system",
              content: OPENAI_COMPATIBLE_CLEANER_SYSTEM_PROMPT,
            },
            {
              role: "user",
              content: JSON.stringify({
                ruleMetadata,
                rawText,
                cleaningPolicy: {
                  language: OPENAI_COMPATIBLE_LANGUAGE_COMPLETION_POLICY,
                },
              }),
            },
          ],
        },
        this.config.timeoutMs,
      );

      entry.statusCode = response.statusCode;
      if ([403, 418, 429].includes(response.statusCode)) {
        throw new ModelRateLimitError(response.statusCode, response.responseText);
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new ModelHttpError(
          `OpenAI-compatible request failed: HTTP ${response.statusCode}`,
          response.statusCode,
          response.responseText,
        );
      }

      const body = JSON.parse(response.responseText);
      const content = body?.choices?.[0]?.message?.content;
      if (typeof content !== "string") {
        throw new Error("OpenAI-compatible response did not contain message content");
      }

      entry.ok = true;
      entry.finishedAt = new Date().toISOString();
      return parseJsonObject(content);
    } catch (e: any) {
      entry.finishedAt = new Date().toISOString();
      entry.errorName = e.name || "Error";
      entry.errorMessage = redactOpenAICompatibleApiKey(
        e.message || String(e),
        this.config.apiKey,
      );
      throw e;
    }
  }
}
