import type Database from 'better-sqlite3';
import {
  ALL_EDGE_TYPE_NAMES,
  INTERNAL_DESCRIBES_EDGE,
  PUBLIC_EDGE_TYPE_NAMES,
} from '../schema/edge-types.js';

export interface ConceptRow {
  id: string;
  description: string;
  details: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  touchCount: number;
  accessCount: number;
  archivedAt: string | null;
  archiveReason: string | null;
}

export interface ConceptInput {
  id: string;
  description: string;
  details?: string;
}

export interface ReferenceInput {
  url: string;
  title: string;
  publishedAt?: Date;
  fetchedAt?: Date;
}

// Bulk-load minimal concept attrs for an id list. SQLite has no array binding,
// so we generate a placeholder list inline. The id list is bounded by the
// vector top-K (typically <= 50) so the SQL stays small.
export function bulkConceptsByIds(
  db: Database.Database,
  ids: readonly string[],
): Map<string, ConceptRow> {
  const map = new Map<string, ConceptRow>();
  if (ids.length === 0) return map;
  const placeholders = ids.map(() => '?').join(', ');
  const rows = db
    .prepare<string[]>(
      `SELECT id, description, details, first_seen_at, last_seen_at,
              touch_count, access_count, archived_at, archive_reason
         FROM concepts
        WHERE id IN (${placeholders})`,
    )
    .all(...ids) as Array<{
    id: string;
    description: string;
    details: string | null;
    first_seen_at: string;
    last_seen_at: string;
    touch_count: number;
    access_count: number;
    archived_at: string | null;
    archive_reason: string | null;
  }>;
  for (const r of rows) {
    map.set(r.id, {
      id: r.id,
      description: r.description,
      details: r.details && r.details.length > 0 ? r.details : null,
      firstSeenAt: r.first_seen_at,
      lastSeenAt: r.last_seen_at,
      touchCount: r.touch_count,
      accessCount: r.access_count,
      archivedAt: r.archived_at,
      archiveReason: r.archive_reason && r.archive_reason.length > 0 ? r.archive_reason : null,
    });
  }
  return map;
}

export interface FreshnessRow {
  archivedAt: string | null;
  lastSeenAt: string;
  accessCount: number;
  newestPublishedAt: string | null;
  isDeprecated: boolean;
}

// Bulk freshness: archived_at / last_seen_at / access_count, the newest
// references.published_at for any DESCRIBES-attached reference, and whether
// any other concept points at this one with DEPRECATES or REPLACES.
// Mirrors the four parallel Kùzu queries we used to issue, but as a single
// SQLite hit since we no longer pay round-trip cost per query.
export function bulkConceptFreshness(
  db: Database.Database,
  ids: readonly string[],
): Map<string, FreshnessRow> {
  const map = new Map<string, FreshnessRow>();
  if (ids.length === 0) return map;
  const placeholders = ids.map(() => '?').join(', ');

  const baseRows = db
    .prepare<string[]>(
      `SELECT id, archived_at, last_seen_at, access_count
         FROM concepts WHERE id IN (${placeholders})`,
    )
    .all(...ids) as Array<{
    id: string;
    archived_at: string | null;
    last_seen_at: string;
    access_count: number;
  }>;

  const refRows = db
    .prepare<string[]>(
      `SELECT d.concept_id AS id, MAX(r.published_at) AS newest
         FROM describes d
         JOIN refs r ON r.url = d.ref_url
        WHERE d.concept_id IN (${placeholders})
        GROUP BY d.concept_id`,
    )
    .all(...ids) as Array<{ id: string; newest: string | null }>;

  const deprRows = db
    .prepare<string[]>(
      `SELECT DISTINCT target_id AS id
         FROM edges
        WHERE target_id IN (${placeholders})
          AND edge_type IN ('DEPRECATES','REPLACES')
          AND source_id <> target_id`,
    )
    .all(...ids) as Array<{ id: string }>;

  const newestById = new Map<string, string>();
  for (const r of refRows) {
    if (r.newest) newestById.set(r.id, r.newest);
  }
  const deprecated = new Set<string>();
  for (const r of deprRows) deprecated.add(r.id);

  for (const r of baseRows) {
    map.set(r.id, {
      archivedAt: r.archived_at,
      lastSeenAt: r.last_seen_at,
      accessCount: r.access_count,
      newestPublishedAt: newestById.get(r.id) ?? null,
      isDeprecated: deprecated.has(r.id),
    });
  }
  return map;
}

export function incrementAccessCounts(db: Database.Database, ids: readonly string[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(', ');
  db.prepare(
    `UPDATE concepts SET access_count = access_count + 1 WHERE id IN (${placeholders})`,
  ).run(...ids);
}

// Single-statement upsert that also bumps touchCount on duplicates and
// initialises {first,last}_seen_at correctly. Returns whether the row was
// newly inserted (inserted=true) so the caller can keep the existing
// "concept upserted vs created" stat surface.
export function upsertConcept(db: Database.Database, c: ConceptInput, now: string): void {
  db.prepare(
    `INSERT INTO concepts (id, description, details, first_seen_at, last_seen_at, touch_count, access_count)
       VALUES (?, ?, ?, ?, ?, 1, 0)
       ON CONFLICT(id) DO UPDATE SET
         description = excluded.description,
         details     = excluded.details,
         last_seen_at = excluded.last_seen_at,
         touch_count = concepts.touch_count + 1`,
  ).run(c.id, c.description, c.details ?? null, now, now);
}

export interface UpsertReferenceResult {
  created: boolean;
}

export function upsertReference(
  db: Database.Database,
  ref: ReferenceInput,
  now: string,
): UpsertReferenceResult {
  const existing = db.prepare<[string]>('SELECT 1 FROM refs WHERE url = ?').get(ref.url) as
    | { 1?: number }
    | undefined;
  const fetchedAt = (ref.fetchedAt ?? new Date(now)).toISOString();
  const publishedAt = ref.publishedAt ? ref.publishedAt.toISOString() : null;
  if (existing) {
    if (publishedAt !== null) {
      db.prepare(
        `UPDATE refs SET title = ?, last_seen_at = ?, fetched_at = ?, published_at = ?
           WHERE url = ?`,
      ).run(ref.title, now, fetchedAt, publishedAt, ref.url);
    } else {
      db.prepare('UPDATE refs SET title = ?, last_seen_at = ?, fetched_at = ? WHERE url = ?').run(
        ref.title,
        now,
        fetchedAt,
        ref.url,
      );
    }
    return { created: false };
  }
  db.prepare(
    `INSERT INTO refs (url, title, first_seen_at, last_seen_at, fetched_at, published_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(ref.url, ref.title, now, now, fetchedAt, publishedAt);
  return { created: true };
}

export function ensureDescribes(db: Database.Database, refUrl: string, conceptId: string): void {
  db.prepare('INSERT OR IGNORE INTO describes (ref_url, concept_id) VALUES (?, ?)').run(
    refUrl,
    conceptId,
  );
}

export function ensureEdge(
  db: Database.Database,
  source: string,
  edgeType: string,
  target: string,
  reason: string | null,
): void {
  db.prepare(
    `INSERT INTO edges (source_id, target_id, edge_type, reason)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(source_id, edge_type, target_id) DO UPDATE SET reason = excluded.reason`,
  ).run(source, target, edgeType, reason);
}

export function existingConceptIds(db: Database.Database, ids: readonly string[]): Set<string> {
  if (ids.length === 0) return new Set();
  const placeholders = ids.map(() => '?').join(', ');
  const rows = db
    .prepare<string[]>(`SELECT id FROM concepts WHERE id IN (${placeholders})`)
    .all(...ids) as Array<{ id: string }>;
  return new Set(rows.map((r) => r.id));
}

export interface ReferenceRecord {
  url: string;
  title: string;
}

export function referencesForConcepts(
  db: Database.Database,
  ids: readonly string[],
): ReferenceRecord[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(', ');
  const rows = db
    .prepare<string[]>(
      `SELECT DISTINCT r.url AS url, r.title AS title
         FROM refs r
         JOIN describes d ON d.ref_url = r.url
        WHERE d.concept_id IN (${placeholders})`,
    )
    .all(...ids) as Array<{ url: string; title: string }>;
  return rows;
}

export function referencesByConceptIds(
  db: Database.Database,
  ids: readonly string[],
): Array<{ url: string; title: string; conceptId: string }> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(', ');
  const rows = db
    .prepare<string[]>(
      `SELECT r.url AS url, r.title AS title, d.concept_id AS conceptId
         FROM refs r
         JOIN describes d ON d.ref_url = r.url
        WHERE d.concept_id IN (${placeholders})`,
    )
    .all(...ids) as Array<{ url: string; title: string; conceptId: string }>;
  return rows;
}

// Visibility filter for related-concept post-processing — used by search()
// when includeArchived=false. A single SELECT id is cheaper than the full
// freshness payload here because we only need the archived bit.
export function visibleConceptIds(db: Database.Database, ids: readonly string[]): Set<string> {
  if (ids.length === 0) return new Set();
  const placeholders = ids.map(() => '?').join(', ');
  const rows = db
    .prepare<string[]>(
      `SELECT id FROM concepts
        WHERE id IN (${placeholders}) AND archived_at IS NULL`,
    )
    .all(...ids) as Array<{ id: string }>;
  return new Set(rows.map((r) => r.id));
}

// Centralised list of edge types the search/console traversal honours.
// Re-exported so callers don't pull from two places.
export { ALL_EDGE_TYPE_NAMES, PUBLIC_EDGE_TYPE_NAMES, INTERNAL_DESCRIBES_EDGE };
