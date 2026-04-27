import type { RefmeshStore } from '../db/store.js';
import { RefmeshValidationError } from '../util/errors.js';

export interface ArchiveOptions {
  reason?: string;
}

export interface ArchiveResult {
  id: string;
  archivedAt: Date;
  reason: string;
}

export interface UnarchiveResult {
  id: string;
}

export interface PruneOptions {
  olderThanDays: number;
  maxTouches: number;
  includeArchived: boolean;
  apply: boolean;
}

export interface PruneCandidate {
  id: string;
  lastSeenAt: Date | null;
  touchCount: number;
  archivedAt: Date | null;
}

export interface PruneResult {
  options: PruneOptions;
  cutoff: Date;
  candidates: PruneCandidate[];
  deleted: number;
  vectorsDeleted: number;
  applied: boolean;
}

function conceptExists(store: RefmeshStore, id: string): boolean {
  const row = store.db.prepare<[string]>('SELECT 1 AS one FROM concepts WHERE id = ?').get(id);
  return row !== undefined;
}

function parseIso(value: string | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function executeArchive(
  store: RefmeshStore,
  id: string,
  options: ArchiveOptions = {},
): Promise<ArchiveResult> {
  if (!conceptExists(store, id)) {
    throw new RefmeshValidationError(`Concept not found: ${id}`);
  }
  const now = new Date();
  const reason = options.reason ?? '';
  store.db
    .prepare<[string, string, string]>(
      'UPDATE concepts SET archived_at = ?, archive_reason = ? WHERE id = ?',
    )
    .run(now.toISOString(), reason, id);
  return { id, archivedAt: now, reason };
}

export async function executeUnarchive(store: RefmeshStore, id: string): Promise<UnarchiveResult> {
  if (!conceptExists(store, id)) {
    throw new RefmeshValidationError(`Concept not found: ${id}`);
  }
  store.db
    .prepare<[string]>('UPDATE concepts SET archived_at = NULL, archive_reason = NULL WHERE id = ?')
    .run(id);
  return { id };
}

export function validatePruneOptions(opts: PruneOptions): void {
  if (!Number.isFinite(opts.olderThanDays) || opts.olderThanDays < 0) {
    throw new RefmeshValidationError(
      `--older-than must be a non-negative number of days (got: ${opts.olderThanDays}).`,
    );
  }
  if (!Number.isInteger(opts.maxTouches) || opts.maxTouches < 0) {
    throw new RefmeshValidationError(
      `--max-touches must be a non-negative integer (got: ${opts.maxTouches}).`,
    );
  }
}

export async function executePrune(
  store: RefmeshStore,
  options: PruneOptions,
): Promise<PruneResult> {
  validatePruneOptions(options);
  const now = new Date();
  const cutoff = new Date(now.getTime() - options.olderThanDays * 24 * 60 * 60 * 1000);
  const archivedClause = options.includeArchived ? '' : ' AND archived_at IS NULL';

  const rows = store.db
    .prepare<[string, number]>(
      `SELECT id, last_seen_at, touch_count, archived_at
         FROM concepts
        WHERE last_seen_at IS NOT NULL
          AND last_seen_at < ?
          AND touch_count <= ?${archivedClause}`,
    )
    .all(cutoff.toISOString(), options.maxTouches) as Array<{
    id: string;
    last_seen_at: string | null;
    touch_count: number;
    archived_at: string | null;
  }>;

  const candidates: PruneCandidate[] = rows.map((r) => ({
    id: r.id,
    lastSeenAt: parseIso(r.last_seen_at),
    touchCount: r.touch_count,
    archivedAt: parseIso(r.archived_at),
  }));

  if (!options.apply) {
    return {
      options,
      cutoff,
      candidates,
      deleted: 0,
      vectorsDeleted: 0,
      applied: false,
    };
  }

  // Delete inside a transaction so the FK CASCADE on edges/describes/vectors
  // can't leave orphans if a row mid-way through fails to delete.
  let deleted = 0;
  let vectorsDeleted = 0;
  store.transaction(() => {
    const stmt = store.db.prepare<[string]>('DELETE FROM concepts WHERE id = ?');
    for (const c of candidates) {
      const result = stmt.run(c.id);
      if (result.changes > 0) {
        deleted += 1;
        // The in-memory vector index doesn't auto-react to ON DELETE CASCADE
        // on the SQLite side, so mirror the removal explicitly.
        store.vectors.delete(c.id);
        vectorsDeleted += 1;
      }
    }
  });

  return {
    options,
    cutoff,
    candidates,
    deleted,
    vectorsDeleted,
    applied: true,
  };
}

export function renderArchiveResult(result: ArchiveResult): string {
  const reason = result.reason ? ` (reason: ${result.reason})` : '';
  return `Archived: ${result.id}${reason} at ${result.archivedAt.toISOString()}`;
}

export function renderUnarchiveResult(result: UnarchiveResult): string {
  return `Unarchived: ${result.id}`;
}

export function renderPruneResult(result: PruneResult): string {
  const lines: string[] = [];
  const action = result.applied ? 'APPLY' : 'DRY-RUN';
  lines.push(`Prune (${action}) — cutoff: ${result.cutoff.toISOString()}`);
  const archivedNote = result.options.includeArchived ? ' (incl. archived)' : '';
  lines.push(
    `Filter: lastSeenAt < cutoff AND touchCount <= ${result.options.maxTouches}${archivedNote}`,
  );
  lines.push(`Candidates: ${result.candidates.length}`);
  for (const c of result.candidates.slice(0, 10)) {
    const flags = c.archivedAt ? ' [archived]' : '';
    lines.push(
      `  - ${c.id} (touch=${c.touchCount}, lastSeenAt=${c.lastSeenAt?.toISOString() ?? '?'})${flags}`,
    );
  }
  if (result.candidates.length > 10) {
    lines.push(`  ... and ${result.candidates.length - 10} more`);
  }
  if (result.applied) {
    lines.push(`Deleted: ${result.deleted} (vector rows: ${result.vectorsDeleted})`);
  } else {
    lines.push('Re-run with --apply to delete.');
  }
  return lines.join('\n');
}
