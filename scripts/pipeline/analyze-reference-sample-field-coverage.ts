import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { JSDOM } from "jsdom";

import { validateMinimumBookIngest } from "../../src/modules/ingest-validator";
import { parseBookDetailWithDiagnostics } from "../../src/modules/parser";
import type { BookMetadata, Creator } from "../../src/types";

interface CliOptions {
  samplesDir: string;
  outPath: string;
  markdownPath: string;
  newBatch: string;
  parserGoldenManifest: string;
}

interface ReferenceSample {
  batch: string;
  subjectId: string;
  sourceUrl: string;
  metadataPath: string;
  htmlPath: string;
  htmlKind: "sourceHtml" | "domHtml";
  html: string;
}

interface InfoEntry {
  label: string;
  value: string;
}

interface ParsedSample {
  batch: string;
  cohort: "old50" | "new50";
  subjectId: string;
  sourceUrl: string;
  title: string;
  labels: InfoEntry[];
  labelNames: string[];
  surfaces: Record<string, boolean>;
  book: BookMetadata;
  creatorTypes: Record<string, number>;
  validation: ReturnType<typeof validateMinimumBookIngest>;
  extractionWarnings: string[];
  metadataPath: string;
  htmlPath: string;
  htmlKind: "sourceHtml" | "domHtml";
}

interface Candidate {
  subjectId: string;
  sourceUrl: string;
  batch: string;
  score: number;
  reasons: string[];
  labels: string[];
  validationWarnings: string[];
  extractionWarnings: string[];
}

const rootDir = resolve(import.meta.dirname, "..", "..");
const defaultAnalysisPath = join(rootDir, ".cache", "dry-run", "reference-sample-field-coverage-analysis.json");
const defaultMarkdownPath = join(rootDir, ".cache", "dry-run", "reference-sample-field-coverage-analysis.md");
const defaultNewBatch = "browser-save-20260531025702";

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    samplesDir: join(rootDir, "fixtures", "douban", "reference-samples"),
    outPath: defaultAnalysisPath,
    markdownPath: defaultMarkdownPath,
    newBatch: defaultNewBatch,
    parserGoldenManifest: join(rootDir, "fixtures", "douban", "parser-golden", "manifest.json"),
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--samples-dir") options.samplesDir = resolve(rootDir, argv[++i]);
    else if (arg === "--out") options.outPath = resolve(rootDir, argv[++i]);
    else if (arg === "--markdown") options.markdownPath = resolve(rootDir, argv[++i]);
    else if (arg === "--new-batch") options.newBatch = argv[++i];
    else if (arg === "--parser-golden-manifest") options.parserGoldenManifest = resolve(rootDir, argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function readText(path: string): string {
  let text = readFileSync(path, "utf-8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

function readJson<T>(path: string): T {
  return JSON.parse(readText(path)) as T;
}

function relativePath(path: string): string {
  return relative(rootDir, path).replace(/\\/g, "/");
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

function resolveFixturePath(pathValue: unknown): string | null {
  const rawPath = cleanString(pathValue);
  if (!rawPath) return null;
  const path = resolve(rootDir, rawPath);
  if (!existsSync(path)) return null;
  return statSync(path).isFile() ? path : null;
}

function walk(dir: string): string[] {
  const paths: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) paths.push(...walk(path));
    else paths.push(path);
  }
  return paths;
}

function loadSamples(samplesDir: string): ReferenceSample[] {
  return walk(samplesDir)
    .filter((path) => path.endsWith("metadata.json"))
    .map((metadataPath) => {
      const metadata = readJson<any>(metadataPath);
      const sourceHtmlPath = resolveFixturePath(metadata.files?.sourceHtml);
      const domHtmlPath = resolveFixturePath(metadata.files?.domHtml);
      const htmlPath = sourceHtmlPath ?? domHtmlPath;
      if (!htmlPath) {
        throw new Error(`Reference sample ${metadata.subjectId} has no readable sourceHtml/domHtml`);
      }

      const relativeMetadata = relativePath(metadataPath);
      const parts = relativeMetadata.split("/");
      const batch = parts[parts.indexOf("reference-samples") + 1] ?? "unknown";

      return {
        batch,
        subjectId: String(metadata.subjectId),
        sourceUrl: String(metadata.sourceUrl),
        metadataPath,
        htmlPath,
        htmlKind: sourceHtmlPath ? "sourceHtml" : "domHtml",
        html: readText(htmlPath),
      } satisfies ReferenceSample;
    })
    .sort((a, b) => Number(a.subjectId) - Number(b.subjectId) || a.subjectId.localeCompare(b.subjectId));
}

function normalizeLabel(text: string): string {
  return text.replace(/[\s:\uFF1A]+/g, "").trim();
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function extractInfoEntries(doc: Document): InfoEntry[] {
  const info = doc.querySelector("#info");
  if (!info) return [];

  return info.innerHTML
    .split(/<br\s*\/?>/i)
    .map((lineHtml) => {
      const holder = doc.createElement("div");
      holder.innerHTML = lineHtml;
      const labelElement = holder.querySelector("span.pl");
      const label = normalizeLabel(labelElement?.textContent ?? "");
      if (!label || !labelElement) return null;
      labelElement.remove();
      const value = normalizeWhitespace(holder.textContent ?? "");
      return value ? { label, value } : null;
    })
    .filter((entry): entry is InfoEntry => entry !== null);
}

function extractSurfaces(doc: Document): Record<string, boolean> {
  const title = normalizeWhitespace(doc.querySelector("h1 span")?.textContent ?? "");
  const abstract =
    normalizeWhitespace(doc.querySelector("#link-report .hidden .intro, #link-report .all .intro")?.textContent ?? "") ||
    normalizeWhitespace(doc.querySelector("#link-report .intro")?.textContent ?? "");
  return {
    h1Title: title.length > 0,
    abstractBlock: abstract.length > 0,
    jsonLd: doc.querySelector('script[type="application/ld+json"]') !== null,
    openGraphTitle: doc.querySelector('meta[property="og:title"], meta[name="og:title"]') !== null,
    openGraphDescription: doc.querySelector('meta[property="og:description"], meta[name="og:description"]') !== null,
  };
}

function creatorTypeCounts(creators: Creator[]): Record<string, number> {
  return creators.reduce<Record<string, number>>((counts, creator) => {
    counts[creator.creatorType] = (counts[creator.creatorType] ?? 0) + 1;
    return counts;
  }, {});
}

function parseSamples(samples: ReferenceSample[], newBatch: string): ParsedSample[] {
  const dom = new JSDOM("<!doctype html>");
  (globalThis as any).DOMParser = dom.window.DOMParser;

  return samples.map((sample) => {
    const sampleDom = new JSDOM(sample.html);
    const doc = sampleDom.window.document;
    const labels = extractInfoEntries(doc);
    const { book, extractionWarnings } = parseBookDetailWithDiagnostics(sample.html, sample.sourceUrl);

    return {
      batch: sample.batch,
      cohort: sample.batch === newBatch ? "new50" : "old50",
      subjectId: sample.subjectId,
      sourceUrl: sample.sourceUrl,
      title: book.title,
      labels,
      labelNames: Array.from(new Set(labels.map((entry) => entry.label))).sort((a, b) => a.localeCompare(b)),
      surfaces: extractSurfaces(doc),
      book,
      creatorTypes: creatorTypeCounts(book.creators),
      validation: validateMinimumBookIngest(book),
      extractionWarnings,
      metadataPath: relativePath(sample.metadataPath),
      htmlPath: relativePath(sample.htmlPath),
      htmlKind: sample.htmlKind,
    } satisfies ParsedSample;
  });
}

function countBy<T extends string>(values: T[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function increment(counts: Record<string, number>, key: string, amount = 1): void {
  counts[key] = (counts[key] ?? 0) + amount;
}

function summarizeLabels(samples: ParsedSample[]) {
  const all: Record<string, { total: number; old50: number; new50: number; samples: string[] }> = {};
  for (const sample of samples) {
    for (const label of sample.labelNames) {
      all[label] ??= { total: 0, old50: 0, new50: 0, samples: [] };
      all[label].total += 1;
      all[label][sample.cohort] += 1;
      all[label].samples.push(sample.subjectId);
    }
  }

  return Object.fromEntries(
    Object.entries(all).sort((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0])),
  );
}

function summarizeSurfaces(samples: ParsedSample[]) {
  const summary: Record<string, { total: number; old50: number; new50: number }> = {};
  for (const sample of samples) {
    for (const [surface, present] of Object.entries(sample.surfaces)) {
      if (!present) continue;
      summary[surface] ??= { total: 0, old50: 0, new50: 0 };
      summary[surface].total += 1;
      summary[surface][sample.cohort] += 1;
    }
  }
  return summary;
}

function fieldPresent(book: BookMetadata, field: keyof BookMetadata): boolean {
  const value = book[field];
  if (Array.isArray(value)) return value.length > 0;
  return typeof value === "string" ? value.trim().length > 0 : Boolean(value);
}

function summarizeParsedFields(samples: ParsedSample[]) {
  const fields: (keyof BookMetadata)[] = [
    "title",
    "creators",
    "publisher",
    "publishDate",
    "isbn",
    "isbn13",
    "pages",
    "price",
    "series",
    "format",
    "language",
    "originalTitle",
    "abstractNote",
    "creatorNotes",
  ];
  const summary: Record<string, { total: number; old50: number; new50: number }> = {};
  for (const field of fields) {
    summary[field] = { total: 0, old50: 0, new50: 0 };
  }
  for (const sample of samples) {
    for (const field of fields) {
      if (!fieldPresent(sample.book, field)) continue;
      summary[field].total += 1;
      summary[field][sample.cohort] += 1;
    }
  }
  return summary;
}

function summarizeCreatorTypes(samples: ParsedSample[]) {
  const summary: Record<string, { records: number; creators: number; old50Records: number; new50Records: number }> = {};
  for (const sample of samples) {
    for (const [creatorType, count] of Object.entries(sample.creatorTypes)) {
      summary[creatorType] ??= { records: 0, creators: 0, old50Records: 0, new50Records: 0 };
      summary[creatorType].records += 1;
      summary[creatorType].creators += count;
      if (sample.cohort === "old50") summary[creatorType].old50Records += 1;
      else summary[creatorType].new50Records += 1;
    }
  }
  return Object.fromEntries(
    Object.entries(summary).sort((a, b) => b[1].records - a[1].records || a[0].localeCompare(b[0])),
  );
}

function summarizeValidation(samples: ParsedSample[]) {
  const status = { eligible: 0, ineligible: 0, old50Eligible: 0, new50Eligible: 0 };
  const warnings: Record<string, number> = {};
  const extractionWarnings: Record<string, number> = {};
  for (const sample of samples) {
    if (sample.validation.eligible) {
      status.eligible += 1;
      if (sample.cohort === "old50") status.old50Eligible += 1;
      else status.new50Eligible += 1;
    } else {
      status.ineligible += 1;
    }
    for (const warning of sample.validation.warnings) increment(warnings, warning);
    for (const warning of sample.extractionWarnings) increment(extractionWarnings, warning);
  }
  return { status, warnings, extractionWarnings };
}

function sampleForDocs(sample: ParsedSample) {
  return {
    subjectId: sample.subjectId,
    sourceUrl: sample.sourceUrl,
    batch: sample.batch,
    cohort: sample.cohort,
    title: sample.title,
    labels: sample.labelNames,
    creatorTypes: sample.creatorTypes,
    creatorNotes: sample.book.creatorNotes ?? [],
    validationEligible: sample.validation.eligible,
    validationWarnings: sample.validation.warnings,
    extractionWarnings: sample.extractionWarnings,
    parsedFields: {
      publisher: sample.book.publisher || undefined,
      publishDate: sample.book.publishDate || undefined,
      language: sample.book.language || undefined,
      series: sample.book.series || undefined,
      originalTitle: sample.book.originalTitle || undefined,
      pages: sample.book.pages || undefined,
      format: sample.book.format || undefined,
    },
  };
}

function candidateFromSample(sample: ParsedSample, reasons: string[], labelSummary: ReturnType<typeof summarizeLabels>): Candidate {
  const rareLabels = sample.labelNames.filter((label) => (labelSummary[label]?.total ?? 0) <= 2);
  const uniqueReasons = Array.from(new Set(reasons));
  const weightedScore = uniqueReasons.reduce((score, reason) => {
    if (reason.startsWith("new-labels:")) return score + 4;
    if (reason.startsWith("minimum-ingest:")) {
      return score + 1 + sample.validation.warnings.filter((warning) => warning !== "minimum-ingest-missing-language").length;
    }
    if (reason.startsWith("creator-type:editor") || reason.startsWith("creator-type:contributor")) return score + 3;
    if (reason.startsWith("creator-type:translator")) return score + 2;
    if (reason === "creator-notes") return score + 3;
    if (reason === "original-title") return score + 2;
    return score + 1;
  }, 0);
  return {
    subjectId: sample.subjectId,
    sourceUrl: sample.sourceUrl,
    batch: sample.batch,
    score: weightedScore + rareLabels.length,
    reasons: uniqueReasons,
    labels: sample.labelNames,
    validationWarnings: sample.validation.warnings,
    extractionWarnings: sample.extractionWarnings,
  };
}

function selectDiverseCandidates(candidates: Candidate[], samples: ParsedSample[], limit: number): Candidate[] {
  const byId = new Map(candidates.map((candidate) => [candidate.subjectId, candidate]));
  const selected: Candidate[] = [];
  const selectedIds = new Set<string>();

  function add(candidate: Candidate | undefined): void {
    if (!candidate || selectedIds.has(candidate.subjectId) || selected.length >= limit) return;
    selected.push(candidate);
    selectedIds.add(candidate.subjectId);
  }

  function addBySamplePredicate(predicate: (sample: ParsedSample) => boolean): void {
    samples
      .filter(predicate)
      .sort((a, b) => (byId.get(b.subjectId)?.score ?? 0) - (byId.get(a.subjectId)?.score ?? 0) || a.subjectId.localeCompare(b.subjectId))
      .forEach((sample) => add(byId.get(sample.subjectId)));
  }

  addBySamplePredicate((sample) => sample.labelNames.some((label) => candidates.some((candidate) =>
    candidate.subjectId === sample.subjectId && candidate.reasons.some((reason) => reason.startsWith(`new-labels:${label}`)),
  )));
  addBySamplePredicate((sample) => sample.validation.warnings.some((warning) => warning !== "minimum-ingest-missing-language"));
  addBySamplePredicate((sample) => Boolean(sample.creatorTypes.editor || sample.creatorTypes.contributor));
  addBySamplePredicate((sample) => Boolean(sample.book.creatorNotes?.length));
  addBySamplePredicate((sample) => Boolean(sample.book.originalTitle && sample.book.series));

  candidates
    .sort((a, b) => b.score - a.score || a.subjectId.localeCompare(b.subjectId))
    .forEach(add);

  return selected;
}

function buildCandidates(samples: ParsedSample[], labelSummary: ReturnType<typeof summarizeLabels>) {
  const oldLabels = new Set(samples.filter((sample) => sample.cohort === "old50").flatMap((sample) => sample.labelNames));
  const labelsOnlyInNew = new Set(
    samples
      .filter((sample) => sample.cohort === "new50")
      .flatMap((sample) => sample.labelNames)
      .filter((label) => !oldLabels.has(label)),
  );

  const parserGoldenCandidatePool = samples
    .filter((sample) => sample.cohort === "new50")
    .map((sample) => {
      const reasons: string[] = [];
      const sampleNewLabels = sample.labelNames.filter((label) => labelsOnlyInNew.has(label));
      if (sampleNewLabels.length > 0) reasons.push(`new-labels:${sampleNewLabels.join("|")}`);
      for (const [creatorType, count] of Object.entries(sample.creatorTypes)) {
        if (creatorType !== "author") reasons.push(`creator-type:${creatorType}:${count}`);
      }
      if (sample.book.creatorNotes?.length) reasons.push("creator-notes");
      if (sample.book.originalTitle) reasons.push("original-title");
      if (sample.book.series) reasons.push("series");
      if (sample.book.pages && /[^\d\s]/.test(sample.book.pages)) reasons.push("page-count-text-normalization");
      if (!sample.validation.eligible) reasons.push(`minimum-ingest:${sample.validation.warnings.join("|")}`);
      if (sample.extractionWarnings.length > 0) reasons.push(`parser-diagnostics:${sample.extractionWarnings.join("|")}`);
      const rareLabels = sample.labelNames.filter((label) => (labelSummary[label]?.total ?? 0) <= 2);
      if (rareLabels.length > 0) reasons.push(`rare-labels:${rareLabels.join("|")}`);
      return reasons.length > 0 ? candidateFromSample(sample, reasons, labelSummary) : null;
    })
    .filter((candidate): candidate is Candidate => candidate !== null)
    .sort((a, b) => b.score - a.score || a.subjectId.localeCompare(b.subjectId));
  const parserGoldenCandidates = selectDiverseCandidates(
    parserGoldenCandidatePool,
    samples.filter((sample) => sample.cohort === "new50"),
    12,
  );

  const cleaningReviewCandidates = samples
    .map((sample) => {
      const reasons: string[] = [];
      const onlyMissingLanguage =
        sample.validation.warnings.length === 1 &&
        sample.validation.warnings[0] === "minimum-ingest-missing-language";
      if (onlyMissingLanguage) reasons.push("near-prepared-missing-language");
      if (!sample.validation.eligible && !onlyMissingLanguage) {
        reasons.push(`minimum-ingest-review:${sample.validation.warnings.join("|")}`);
      }
      if (sample.book.originalTitle) reasons.push("protect-original-title-note");
      if (sample.book.creatorNotes?.length) reasons.push("protect-creator-note-evidence");
      if (sample.creatorTypes.editor || sample.creatorTypes.contributor) reasons.push("creator-role-review");
      if (sample.book.series) reasons.push("series-field-review");
      if (sample.book.pages && /[^\d\s]/.test(sample.book.pages)) reasons.push("page-count-cleaning");
      return reasons.length > 0 ? candidateFromSample(sample, reasons, labelSummary) : null;
    })
    .filter((candidate): candidate is Candidate => candidate !== null)
    .sort((a, b) => b.score - a.score || a.subjectId.localeCompare(b.subjectId))
    .slice(0, 15);

  return {
    labelsOnlyInNew: Array.from(labelsOnlyInNew).sort((a, b) => a.localeCompare(b)),
    parserGoldenCandidates,
    cleaningReviewCandidates,
  };
}

function loadParserGoldenSubjectIds(manifestPath: string): string[] {
  if (!existsSync(manifestPath)) return [];
  const manifest = readJson<{ fixtures?: Array<{ subjectId?: string }> }>(manifestPath);
  return Array.from(new Set((manifest.fixtures ?? [])
    .map((fixture) => cleanString(fixture.subjectId))
    .filter((subjectId): subjectId is string => Boolean(subjectId))))
    .sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
}

function markdownTable(rows: string[][]): string {
  return rows.map((row) => `| ${row.join(" | ")} |`).join("\n");
}

function formatCount(value: number, total: number): string {
  return `${value}/${total}`;
}

function renderMarkdown(analysis: any): string {
  const total = analysis.sampleCounts.total;
  const oldTotal = analysis.sampleCounts.old50;
  const newTotal = analysis.sampleCounts.new50;
  const labelRows = [
    ["Label", "All", "Old 50", "New 50", "Example subjects"],
    ["---", "---:", "---:", "---:", "---"],
    ...Object.entries(analysis.labelCoverage)
      .slice(0, 24)
      .map(([label, value]: [string, any]) => [
        label,
        formatCount(value.total, total),
        formatCount(value.old50, oldTotal),
        formatCount(value.new50, newTotal),
        value.samples.slice(0, 5).join(", "),
      ]),
  ];
  const fieldRows = [
    ["Parsed field", "All", "Old 50", "New 50"],
    ["---", "---:", "---:", "---:"],
    ...Object.entries(analysis.parsedFieldCoverage).map(([field, value]: [string, any]) => [
      field,
      formatCount(value.total, total),
      formatCount(value.old50, oldTotal),
      formatCount(value.new50, newTotal),
    ]),
  ];
  const creatorRows = [
    ["Creator type", "Records", "Creators", "Old 50 records", "New 50 records"],
    ["---", "---:", "---:", "---:", "---:"],
    ...Object.entries(analysis.creatorTypeCoverage).map(([role, value]: [string, any]) => [
      role,
      String(value.records),
      String(value.creators),
      String(value.old50Records),
      String(value.new50Records),
    ]),
  ];
  const candidateRows = [
    ["Subject", "Batch", "Score", "Reasons"],
    ["---", "---", "---:", "---"],
    ...analysis.parserGoldenCandidates.map((candidate: Candidate) => [
      candidate.subjectId,
      candidate.batch,
      String(candidate.score),
      candidate.reasons.join("; "),
    ]),
  ];
  const cleaningRows = [
    ["Subject", "Batch", "Score", "Reasons"],
    ["---", "---", "---:", "---"],
    ...analysis.cleaningReviewCandidates.map((candidate: Candidate) => [
      candidate.subjectId,
      candidate.batch,
      String(candidate.score),
      candidate.reasons.join("; "),
    ]),
  ];

  return [
    "# Reference Sample Field Coverage Analysis",
    "",
    `Generated: ${analysis.generatedAt}`,
    "",
    "## Sample Counts",
    "",
    `- Total samples: ${analysis.sampleCounts.total}`,
    `- Old reviewed corpus: ${analysis.sampleCounts.old50}`,
    `- 2026-05-31 expansion corpus: ${analysis.sampleCounts.new50}`,
    `- Unique subject IDs: ${analysis.sampleCounts.uniqueSubjectIds}`,
    `- Duplicate subject IDs: ${analysis.sampleCounts.duplicateSubjectIds.length}`,
    `- Parser-golden fixtures already promoted from this corpus: ${analysis.parserGoldenSubjectIds.length}`,
    `- Parser-golden fixtures promoted from the 2026-05-31 expansion: ${analysis.promotedExpansionGoldenSubjectIds.join(", ") || "none"}`,
    "",
    "## Validation Summary",
    "",
    `- Eligible by current minimum ingest gate: ${analysis.validation.status.eligible}/${total}`,
    `- Ineligible by current minimum ingest gate: ${analysis.validation.status.ineligible}/${total}`,
    `- Old eligible: ${analysis.validation.status.old50Eligible}/${oldTotal}`,
    `- New eligible: ${analysis.validation.status.new50Eligible}/${newTotal}`,
    "",
    "Validation warnings:",
    "",
    "```json",
    JSON.stringify(analysis.validation.warnings, null, 2),
    "```",
    "",
    "Extraction warnings:",
    "",
    "```json",
    JSON.stringify(analysis.validation.extractionWarnings, null, 2),
    "```",
    "",
    "## Labels Only Seen In New 50",
    "",
    analysis.labelsOnlyInNew.length > 0
      ? analysis.labelsOnlyInNew.map((label: string) => `- ${label}`).join("\n")
      : "- None.",
    "",
    "## Top Label Coverage",
    "",
    markdownTable(labelRows),
    "",
    "## Parsed Field Coverage",
    "",
    markdownTable(fieldRows),
    "",
    "## Creator Type Coverage",
    "",
    markdownTable(creatorRows),
    "",
    "## Pending Parser-Golden Candidates",
    "",
    markdownTable(candidateRows),
    "",
    "## Cleaning-Review Candidates",
    "",
    markdownTable(cleaningRows),
    "",
  ].join("\n");
}

function run() {
  if (process.env.DOUBAN_TO_ZOTERO_EXECUTION_MODE !== "dry-run") {
    throw new Error("reference sample field coverage analysis requires DOUBAN_TO_ZOTERO_EXECUTION_MODE=dry-run");
  }

  const options = parseArgs(process.argv.slice(2));
  const samples = loadSamples(options.samplesDir);
  const parsed = parseSamples(samples, options.newBatch);
  const subjectIds = parsed.map((sample) => sample.subjectId);
  const duplicateSubjectIds = Array.from(new Set(subjectIds.filter((id, index) => subjectIds.indexOf(id) !== index)));
  const labelCoverage = summarizeLabels(parsed);
  const parserGoldenSubjectIds = loadParserGoldenSubjectIds(options.parserGoldenManifest);
  const parserGoldenSubjectIdSet = new Set(parserGoldenSubjectIds);
  const candidates = buildCandidates(parsed, labelCoverage);
  const pendingParserGoldenCandidates = candidates.parserGoldenCandidates
    .filter((candidate) => !parserGoldenSubjectIdSet.has(candidate.subjectId));

  const analysis = {
    schemaVersion: 1,
    mode: "reference-sample-field-coverage-analysis",
    executionMode: "dry-run",
    remoteFetchAllowed: false,
    generatedAt: new Date().toISOString(),
    samplesDir: relativePath(options.samplesDir),
    newBatch: options.newBatch,
    parserGoldenManifest: relativePath(options.parserGoldenManifest),
    parserGoldenSubjectIds,
    promotedExpansionGoldenSubjectIds: parserGoldenSubjectIds.filter((subjectId) =>
      parsed.some((sample) => sample.subjectId === subjectId && sample.cohort === "new50"),
    ),
    sampleCounts: {
      total: parsed.length,
      old50: parsed.filter((sample) => sample.cohort === "old50").length,
      new50: parsed.filter((sample) => sample.cohort === "new50").length,
      uniqueSubjectIds: new Set(subjectIds).size,
      duplicateSubjectIds,
      byBatch: countBy(parsed.map((sample) => sample.batch)),
    },
    surfaceCoverage: summarizeSurfaces(parsed),
    labelCoverage,
    parsedFieldCoverage: summarizeParsedFields(parsed),
    creatorTypeCoverage: summarizeCreatorTypes(parsed),
    validation: summarizeValidation(parsed),
    labelsOnlyInNew: candidates.labelsOnlyInNew,
    parserGoldenCandidates: pendingParserGoldenCandidates,
    cleaningReviewCandidates: candidates.cleaningReviewCandidates,
    samples: parsed.map(sampleForDocs),
    networkRequests: 0,
  };

  mkdirSync(dirname(options.outPath), { recursive: true });
  writeFileSync(options.outPath, `${JSON.stringify(analysis, null, 2)}\n`, "utf-8");

  mkdirSync(dirname(options.markdownPath), { recursive: true });
  writeFileSync(options.markdownPath, renderMarkdown(analysis), "utf-8");

  process.stdout.write(`${JSON.stringify({
    executionMode: analysis.executionMode,
    outPath: relativePath(options.outPath),
    markdownPath: relativePath(options.markdownPath),
    sampleCounts: analysis.sampleCounts,
    validation: analysis.validation.status,
    labelsOnlyInNew: analysis.labelsOnlyInNew,
    promotedExpansionGoldenSubjectIds: analysis.promotedExpansionGoldenSubjectIds,
    parserGoldenCandidateCount: analysis.parserGoldenCandidates.length,
    cleaningReviewCandidateCount: analysis.cleaningReviewCandidates.length,
    networkRequests: analysis.networkRequests,
  }, null, 2)}\n`);
}

try {
  run();
} catch (error) {
  console.error(error);
  process.exit(1);
}
