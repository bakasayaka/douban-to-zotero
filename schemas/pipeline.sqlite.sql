PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

INSERT OR IGNORE INTO schema_migrations (version, name, applied_at)
VALUES (1, 'initial-pipeline-schema', '1970-01-01T00:00:00.000Z');

CREATE TABLE IF NOT EXISTS pipeline_runs (
  run_id TEXT PRIMARY KEY,
  execution_mode TEXT NOT NULL CHECK (execution_mode IN ('dry-run', 'live')),
  status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'failed')),
  source TEXT NOT NULL,
  input_manifest_path TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  notes_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS scrape_runs (
  scrape_run_id TEXT PRIMARY KEY,
  pipeline_run_id TEXT NOT NULL REFERENCES pipeline_runs(run_id) ON DELETE CASCADE,
  execution_mode TEXT NOT NULL CHECK (execution_mode IN ('dry-run', 'live')),
  source_kind TEXT NOT NULL,
  fixture_manifest_path TEXT,
  request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  provenance_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS raw_scraped_records (
  raw_record_id TEXT PRIMARY KEY,
  scrape_run_id TEXT NOT NULL REFERENCES scrape_runs(scrape_run_id) ON DELETE CASCADE,
  internal_id TEXT NOT NULL UNIQUE,
  source_url TEXT NOT NULL,
  douban_subject_id TEXT,
  wishlist_owner_id TEXT,
  source_kind TEXT NOT NULL,
  raw_html TEXT NOT NULL,
  raw_html_sha256 TEXT NOT NULL,
  list_context_json TEXT NOT NULL DEFAULT '{}',
  extracted_metadata_json TEXT NOT NULL DEFAULT '{}',
  extraction_warnings_json TEXT NOT NULL DEFAULT '[]',
  provenance_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_raw_scraped_records_douban_subject_id
ON raw_scraped_records(douban_subject_id);

CREATE TABLE IF NOT EXISTS cleaning_runs (
  cleaning_run_id TEXT PRIMARY KEY,
  pipeline_run_id TEXT NOT NULL REFERENCES pipeline_runs(run_id) ON DELETE CASCADE,
  execution_mode TEXT NOT NULL CHECK (execution_mode IN ('dry-run', 'live')),
  cleaner_kind TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  prompt_template_hash TEXT,
  settings_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS cleaned_records (
  cleaned_record_id TEXT PRIMARY KEY,
  cleaning_run_id TEXT NOT NULL REFERENCES cleaning_runs(cleaning_run_id) ON DELETE CASCADE,
  raw_record_id TEXT NOT NULL REFERENCES raw_scraped_records(raw_record_id) ON DELETE CASCADE,
  internal_id TEXT NOT NULL UNIQUE,
  cleaned_json TEXT NOT NULL,
  validation_status TEXT NOT NULL CHECK (validation_status IN ('valid', 'warning', 'invalid')),
  validation_warnings_json TEXT NOT NULL DEFAULT '[]',
  field_provenance_json TEXT NOT NULL DEFAULT '{}',
  confidence_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS export_runs (
  export_run_id TEXT PRIMARY KEY,
  pipeline_run_id TEXT NOT NULL REFERENCES pipeline_runs(run_id) ON DELETE CASCADE,
  format TEXT NOT NULL,
  target TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  settings_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS export_records (
  export_record_id TEXT PRIMARY KEY,
  export_run_id TEXT NOT NULL REFERENCES export_runs(export_run_id) ON DELETE CASCADE,
  cleaned_record_id TEXT NOT NULL REFERENCES cleaned_records(cleaned_record_id) ON DELETE CASCADE,
  internal_id TEXT NOT NULL,
  format TEXT NOT NULL,
  payload_text TEXT,
  payload_json TEXT,
  validation_status TEXT NOT NULL CHECK (validation_status IN ('valid', 'warning', 'invalid')),
  validation_warnings_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  UNIQUE (export_run_id, cleaned_record_id, format)
);

CREATE TABLE IF NOT EXISTS import_runs (
  import_run_id TEXT PRIMARY KEY,
  pipeline_run_id TEXT NOT NULL REFERENCES pipeline_runs(run_id) ON DELETE CASCADE,
  execution_mode TEXT NOT NULL CHECK (execution_mode IN ('dry-run', 'live')),
  target TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('prepared', 'started', 'completed', 'failed')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  settings_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS import_records (
  import_record_id TEXT PRIMARY KEY,
  import_run_id TEXT NOT NULL REFERENCES import_runs(import_run_id) ON DELETE CASCADE,
  cleaned_record_id TEXT NOT NULL REFERENCES cleaned_records(cleaned_record_id) ON DELETE CASCADE,
  export_record_id TEXT REFERENCES export_records(export_record_id) ON DELETE SET NULL,
  internal_id TEXT NOT NULL,
  zotero_item_id TEXT,
  item_payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('prepared', 'created', 'skipped', 'failed')),
  validation_warnings_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  UNIQUE (import_run_id, cleaned_record_id)
);
