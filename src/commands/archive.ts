import type { KuzuConnection, RefmeshHybridStores } from '../db/connection.js';
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

async function queryAll(
  conn: KuzuConnection,
  stmt: string,
  params: Record<string, unknown> = {},
): Promise<Record<string, unknown>[]> {
  if (Object.keys(params).length === 0) {
    const res = await conn.query(stmt);
    return res.getAll();
  }
  const prepared = await conn.prepare(stmt);
  const res = await conn.execute(prepared, params);
  return res.getAll();
}

async function conceptExists(conn: KuzuConnection, id: string): Promise<boolean> {
  const rows = await queryAll(conn, 'MATCH (c:Concept) WHERE c.id = $id RETURN c.id AS id', {
    id,
  });
  return rows.length > 0;
}

export async function executeArchive(
  stores: RefmeshHybridStores,
  id: string,
  options: ArchiveOptions = {},
): Promise<ArchiveResult> {
  const conn = stores.graph.connection;
  if (!(await conceptExists(conn, id))) {
    throw new RefmeshValidationError(`Concept not found: ${id}`);
  }
  const now = new Date();
  const reason = options.reason ?? '';
  await queryAll(
    conn,
    `MATCH (c:Concept) WHERE c.id = $id
     SET c.archivedAt = $now, c.archiveReason = $reason`,
    { id, now, reason },
  );
  return { id, archivedAt: now, reason };
}

export async function executeUnarchive(
  stores: RefmeshHybridStores,
  id: string,
): Promise<UnarchiveResult> {
  const conn = stores.graph.connection;
  if (!(await conceptExists(conn, id))) {
    throw new RefmeshValidationError(`Concept not found: ${id}`);
  }
  await queryAll(
    conn,
    `MATCH (c:Concept) WHERE c.id = $id
     SET c.archivedAt = NULL, c.archiveReason = ''`,
    { id },
  );
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
  stores: RefmeshHybridStores,
  options: PruneOptions,
): Promise<PruneResult> {
  validatePruneOptions(options);
  const conn = stores.graph.connection;
  const now = new Date();
  const cutoff = new Date(now.getTime() - options.olderThanDays * 24 * 60 * 60 * 1000);

  const archivedClause = options.includeArchived ? '' : ' AND c.archivedAt IS NULL';
  const rows = await queryAll(
    conn,
    `MATCH (c:Concept)
     WHERE c.lastSeenAt IS NOT NULL AND c.lastSeenAt < $cutoff
       AND c.touchCount <= $maxTouches${archivedClause}
     RETURN c.id AS id, c.lastSeenAt AS lastSeenAt, c.touchCount AS touchCount,
            c.archivedAt AS archivedAt`,
    { cutoff, maxTouches: options.maxTouches },
  );

  const candidates: PruneCandidate[] = rows.map((r) => ({
    id: String(r['id'] ?? ''),
    lastSeenAt: r['lastSeenAt'] instanceof Date ? (r['lastSeenAt'] as Date) : null,
    touchCount: Number(r['touchCount'] ?? 0),
    archivedAt: r['archivedAt'] instanceof Date ? (r['archivedAt'] as Date) : null,
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

  let deleted = 0;
  let vectorsDeleted = 0;
  for (const c of candidates) {
    await queryAll(conn, 'MATCH (c:Concept) WHERE c.id = $id DETACH DELETE c', { id: c.id });
    deleted += 1;
    try {
      await stores.vector.deleteById(c.id);
      vectorsDeleted += 1;
    } catch {
      // ignore individual vector delete failures; CLI will surface aggregate count.
    }
  }

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
