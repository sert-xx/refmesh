import type Database from 'better-sqlite3';
import { ALL_EDGE_TYPE_NAMES } from '../schema/edge-types.js';

// All DDL statements live here so a single migrate() call brings a brand-new
// database up to the current schema. SQLite will silently no-op on
// IF NOT EXISTS, so the function is idempotent — safe to run on every open.
//
// The CHECK constraint on edges.edge_type is generated from
// ALL_EDGE_TYPE_NAMES so the SQL stays in lockstep with the TypeScript
// source of truth (no chance of CHECK drifting from PUBLIC_EDGE_TYPE_NAMES).
function edgeTypeCheckClause(): string {
  const literals = ALL_EDGE_TYPE_NAMES.map((t) => `'${t}'`).join(', ');
  return `CHECK (edge_type IN (${literals}))`;
}

export function applyMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS concepts (
      id              TEXT PRIMARY KEY,
      description     TEXT NOT NULL,
      details         TEXT,
      first_seen_at   TEXT NOT NULL,
      last_seen_at    TEXT NOT NULL,
      touch_count     INTEGER NOT NULL DEFAULT 0,
      access_count    INTEGER NOT NULL DEFAULT 0,
      archived_at     TEXT,
      archive_reason  TEXT
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_concepts_archived  ON concepts(archived_at);
    CREATE INDEX IF NOT EXISTS idx_concepts_last_seen ON concepts(last_seen_at);

    CREATE TABLE IF NOT EXISTS refs (
      url             TEXT PRIMARY KEY,
      title           TEXT NOT NULL,
      first_seen_at   TEXT NOT NULL,
      last_seen_at    TEXT NOT NULL,
      published_at    TEXT,
      fetched_at      TEXT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS describes (
      ref_url     TEXT NOT NULL REFERENCES refs(url)     ON DELETE CASCADE,
      concept_id  TEXT NOT NULL REFERENCES concepts(id)  ON DELETE CASCADE,
      PRIMARY KEY (ref_url, concept_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_describes_concept ON describes(concept_id);

    CREATE TABLE IF NOT EXISTS edges (
      source_id   TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
      target_id   TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
      edge_type   TEXT NOT NULL,
      reason      TEXT,
      PRIMARY KEY (source_id, edge_type, target_id),
      ${edgeTypeCheckClause()}
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_edges_source       ON edges(source_id, edge_type);
    CREATE INDEX IF NOT EXISTS idx_edges_target       ON edges(target_id, edge_type);
    CREATE INDEX IF NOT EXISTS idx_edges_target_only  ON edges(target_id);

    CREATE TABLE IF NOT EXISTS concept_vectors (
      concept_id  TEXT PRIMARY KEY REFERENCES concepts(id) ON DELETE CASCADE,
      dim         INTEGER NOT NULL,
      vec         BLOB NOT NULL
    ) STRICT;

    CREATE VIRTUAL TABLE IF NOT EXISTS concepts_fts USING fts5(
      id,
      description,
      details,
      content='concepts',
      content_rowid='rowid',
      tokenize='unicode61 remove_diacritics 2'
    );

    CREATE TRIGGER IF NOT EXISTS concepts_ai AFTER INSERT ON concepts BEGIN
      INSERT INTO concepts_fts(rowid, id, description, details)
      VALUES (new.rowid, new.id, new.description, COALESCE(new.details, ''));
    END;

    CREATE TRIGGER IF NOT EXISTS concepts_ad AFTER DELETE ON concepts BEGIN
      INSERT INTO concepts_fts(concepts_fts, rowid, id, description, details)
      VALUES ('delete', old.rowid, old.id, old.description, COALESCE(old.details, ''));
    END;

    CREATE TRIGGER IF NOT EXISTS concepts_au AFTER UPDATE ON concepts BEGIN
      INSERT INTO concepts_fts(concepts_fts, rowid, id, description, details)
      VALUES ('delete', old.rowid, old.id, old.description, COALESCE(old.details, ''));
      INSERT INTO concepts_fts(rowid, id, description, details)
      VALUES (new.rowid, new.id, new.description, COALESCE(new.details, ''));
    END;
  `);
}
