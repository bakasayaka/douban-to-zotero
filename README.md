# Douban to Zotero

Zotero 9 add-on for importing books from a Douban wish list into Zotero with parser diagnostics, duplicate review, and a dry-run SQLite audit pipeline.

The current first-version candidate scope is intentionally narrow:

- build a production Zotero 9 `.xpi` with `npm run build`
- import Douban UID-based wish lists through the Tools menu
- parse Douban book metadata with deterministic rules and public synthetic fixture coverage
- block normal imports that miss the minimum metadata gate: title, author/editor, date, publisher, and language
- review duplicates before writing to Zotero
- run dry-run SQLite/export validation and Unit 4 Zotero-hosted non-UI smokes
- optionally run OpenAI-compatible cleaning through a live PowerShell wrapper whose endpoint, model, and API key are editable plaintext values at the top of the script

Out of first-version scope:

- series/manual multi-volume import as a product feature
- visible Zotero desktop UI automation as a release gate
- unreviewed bulk import of OpenAI-cleaned metadata
- CI/firewall-level network blocking for dry-run tests

## Build

```powershell
npm install
npm run typecheck
npm run test:dry
npm run db:dry
npm run db:validate:dry
npm run smoke:ui:dry
npm run build
```

The production add-on is written to:

```text
build/doubantozoter-0.1.0.xpi
```

The manifest targets Zotero `9.0` through `9.*`.

## Install For Testing

In Zotero 9, open Add-ons, choose Install Add-on From File, and select the generated `.xpi`.

The main tested user flow is:

1. Open the add-on from Zotero's Tools menu.
2. Enter a Douban user ID for a wish-list import.
3. Review incomplete, duplicate, suspect, and new rows before writing.
4. Import only eligible selected records.

OpenAI-compatible cleaning is optional and separate from normal import. Edit the configuration header in `scripts/run-openai-compatible-cleaning.ps1`:

```powershell
$BaseUrl = "PASTE_YOUR_OPENAI_COMPATIBLE_BASE_URL_HERE"
$Model = "PASTE_YOUR_MODEL_HERE"
$ApiKey = "PASTE_YOUR_API_KEY_HERE"
```

This plaintext wrapper is intentional for lightweight users. The core worker must still keep API keys out of SQLite, summaries, request logs, and artifacts. Model-cleaned rows are candidates; they become Zotero-ready only after reviewed promotion.

## Publication Boundary

This public source tree intentionally excludes local audit notes, internal development docs, browser-captured Douban pages, parser-golden raw HTML, full readlist-study manifests, SQLite databases, internal Hyper-V/Zotero VM E2E harness scripts, VM artifacts, logs, API keys, and packaged `.xpi` outputs. Those files are local development evidence, not first-version GitHub source.
