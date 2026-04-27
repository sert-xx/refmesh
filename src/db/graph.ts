import type Database from 'better-sqlite3';
import { PUBLIC_EDGE_TYPE_NAMES } from '../schema/edge-types.js';

export interface EdgeRow {
  source: string;
  target: string;
  type: string;
  reason: string | null;
}

// Single SELECT that fetches every public edge touching a frontier id list.
// Used by both search-traversal (per-level) and the console graph view.
export function edgesForFrontier(
  db: Database.Database,
  edgeType: string,
  ids: readonly string[],
): EdgeRow[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(', ');
  const rows = db
    .prepare<string[]>(
      `SELECT source_id AS src, target_id AS tgt, edge_type AS et, reason AS reason
         FROM edges
        WHERE edge_type = ?
          AND (source_id IN (${placeholders}) OR target_id IN (${placeholders}))`,
    )
    .all(edgeType, ...ids, ...ids) as Array<{
    src: string;
    tgt: string;
    et: string;
    reason: string | null;
  }>;
  return rows.map((r) => ({
    source: r.src,
    target: r.tgt,
    type: r.et,
    reason: r.reason,
  }));
}

export interface TraversalLevel {
  level: number;
  frontier: string[];
  edgesAdded: number;
}

export interface TraversalResult {
  edges: EdgeRow[];
  reachedIds: Set<string>;
  levels: TraversalLevel[];
}

export interface TraversalOptions {
  rootIds: readonly string[];
  depth: number;
}

// BFS traversal layered over the public edge types. Identical semantics to
// the pre-SQLite Kùzu loop in src/commands/search.ts: per-level we issue one
// query per edge type covering the whole frontier (not per-id), so the
// query count grows with edge_types × depth, never with frontier size.
//
// Note: we purposely do NOT use a `WITH RECURSIVE` CTE here — the per-level
// frontier snapshots are needed by the trace recorder (PBI-16), and a flat
// per-level loop produces them naturally without complicating the SQL.
export function traverse(db: Database.Database, options: TraversalOptions): TraversalResult {
  const reached = new Set<string>(options.rootIds);
  const edges: EdgeRow[] = [];
  const levels: TraversalLevel[] = [];
  if (options.depth === 0 || options.rootIds.length === 0) {
    return { edges, reachedIds: reached, levels };
  }

  let frontier: string[] = [...options.rootIds];
  for (let level = 0; level < options.depth; level += 1) {
    if (frontier.length === 0) break;
    const frontierSnapshot = [...frontier];
    let edgesAddedThisLevel = 0;
    const nextFrontier = new Set<string>();
    for (const edgeType of PUBLIC_EDGE_TYPE_NAMES) {
      const batch = edgesForFrontier(db, edgeType, frontier);
      for (const edge of batch) {
        edges.push(edge);
        edgesAddedThisLevel += 1;
        if (!reached.has(edge.target)) {
          reached.add(edge.target);
          nextFrontier.add(edge.target);
        }
        if (!reached.has(edge.source)) {
          reached.add(edge.source);
          nextFrontier.add(edge.source);
        }
      }
    }
    levels.push({
      level,
      frontier: frontierSnapshot,
      edgesAdded: edgesAddedThisLevel,
    });
    frontier = [...nextFrontier];
  }

  // Dedupe identical (source, type, target) triples reached via multiple
  // paths so callers can rely on edges[] being a clean set.
  const dedup = new Map<string, EdgeRow>();
  for (const e of edges) {
    const key = `${e.source}|${e.type}|${e.target}`;
    if (!dedup.has(key)) dedup.set(key, e);
  }
  return { edges: [...dedup.values()], reachedIds: reached, levels };
}
