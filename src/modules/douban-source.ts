/**
 * Douban page source boundary.
 *
 * Live mode is the only place that may call the guarded HTTP client.
 * Dry-run mode is fixture-backed and has no network capability.
 */

import { fetchWithDelay } from "../utils/http";

export type ExecutionMode = "dry-run" | "live";

export interface DoubanRequestOptions {
  minDelay?: number;
  maxDelay?: number;
  retries?: number;
}

export interface DoubanSource {
  readonly mode: ExecutionMode;
  getText(url: string, options?: DoubanRequestOptions): Promise<string>;
}

export interface LiveRequestLogEntry {
  url: string;
  hostname: string;
  startedAt: string;
  finishedAt?: string;
  ok: boolean;
  statusCode?: number;
  errorName?: string;
  errorMessage?: string;
}

export class DryRunNetworkBlockedError extends Error {
  constructor(url: string) {
    super(`Dry-run source has no fixture for URL and cannot request network: ${url}`);
    this.name = "DryRunNetworkBlockedError";
  }
}

export class LiveNetworkAccessDeniedError extends Error {
  constructor(url: string) {
    super(`Live Douban source rejected URL outside allowed hosts: ${url}`);
    this.name = "LiveNetworkAccessDeniedError";
  }
}

function getHostname(url: string): string {
  return new URL(url).hostname.toLowerCase();
}

function normalizeUrlKey(url: string): string {
  const parsed = new URL(url);
  parsed.hash = "";
  return parsed.toString();
}

export class LiveDoubanSource implements DoubanSource {
  readonly mode = "live" as const;
  readonly requestLog: LiveRequestLogEntry[] = [];

  constructor(
    private readonly allowedHosts: string[] = ["book.douban.com"],
  ) {}

  async getText(url: string, options?: DoubanRequestOptions): Promise<string> {
    const hostname = getHostname(url);
    if (!this.allowedHosts.includes(hostname)) {
      throw new LiveNetworkAccessDeniedError(url);
    }

    const entry: LiveRequestLogEntry = {
      url,
      hostname,
      startedAt: new Date().toISOString(),
      ok: false,
    };
    this.requestLog.push(entry);

    try {
      const text = await fetchWithDelay(url, options);
      entry.ok = true;
      entry.finishedAt = new Date().toISOString();
      return text;
    } catch (e: any) {
      entry.finishedAt = new Date().toISOString();
      entry.statusCode = typeof e.statusCode === "number" ? e.statusCode : undefined;
      entry.errorName = e.name || "Error";
      entry.errorMessage = e.message || String(e);
      throw e;
    }
  }
}

export class FixtureDoubanSource implements DoubanSource {
  readonly mode = "dry-run" as const;
  private readonly fixtures = new Map<string, string>();

  constructor(fixtures: Record<string, string> | Array<[string, string]>) {
    const entries = Array.isArray(fixtures)
      ? fixtures
      : Object.entries(fixtures);
    for (const [url, html] of entries) {
      this.fixtures.set(normalizeUrlKey(url), html);
    }
  }

  async getText(url: string): Promise<string> {
    const key = normalizeUrlKey(url);
    const html = this.fixtures.get(key);
    if (html === undefined) {
      throw new DryRunNetworkBlockedError(url);
    }
    return html;
  }
}

export function createLiveDoubanSource(): LiveDoubanSource {
  return new LiveDoubanSource();
}
