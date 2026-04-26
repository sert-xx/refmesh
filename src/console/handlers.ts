import { statSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { type SearchOptions, type SearchResult, executeSearch } from '../commands/search.js';
import type { KuzuConnection, RefmeshHybridStores } from '../db/connection.js';
import { cypherIdListLiteral } from '../db/cypher.js';
import {
  ALL_EDGE_TYPE_NAMES,
  INTERNAL_DESCRIBES_EDGE,
  PUBLIC_EDGE_TYPE_NAMES,
} from '../schema/edge-types.js';
import { RefmeshValidationError } from '../util/errors.js';

export interface StatsResponse {
  graph: { path: string; sizeBytes: number };
  vector: { path: string; sizeBytes: number; rowCount: number };
  counts: {
    concepts: number;
    archivedConcepts: number;
    references: number;
    edgesTotal: number;
    edgesByType: Record<string, number>;
  };
  lastSeenAt: string | null;
}

export interface ConceptListItem {
  id: string;
  description: string;
  details: string | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  touchCount: number;
  accessCount: number;
  archived: boolean;
  archivedAt: string | null;
  archiveReason: string | null;
}

export interface ConceptListResponse {
  total: number;
  limit: number;
  offset: number;
  items: ConceptListItem[];
}

export interface ConceptDetailResponse extends ConceptListItem {
  references: { url: string; title: string }[];
}

export interface NeighborNode {
  id: string;
  description: string;
  details: string | null;
  archived: boolean;
  isRoot: boolean;
}

export interface NeighborEdge {
  source: string;
  target: string;
  type: string;
  reason: string | null;
}

export interface NeighborsResponse {
  rootId: string;
  depth: number;
  nodes: NeighborNode[];
  edges: NeighborEdge[];
  references: { url: string; title: string; conceptId: string }[];
}

async function dirSize(path: string): Promise<number> {
  let total = 0;
  let names: string[];
  try {
    names = await readdir(path);
  } catch {
    return 0;
  }
  for (const name of names) {
    const child = join(path, name);
    try {
      const st = await stat(child);
      if (st.isDirectory()) {
        total += await dirSize(child);
      } else if (st.isFile()) {
        total += st.size;
      }
    } catch {
      // ignore unreadable entries
    }
  }
  return total;
}

async function pathSize(path: string): Promise<number> {
  try {
    const st = statSync(path);
    if (st.isDirectory()) return await dirSize(path);
    return st.size;
  } catch {
    return 0;
  }
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

function asIsoString(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  // Future-proof: if Kùzu ever returns timestamps as ISO strings, pass them
  // through verbatim instead of silently dropping the value.
  if (typeof value === 'string' && value.length > 0) return value;
  return null;
}

function rowToConceptItem(row: Record<string, unknown>): ConceptListItem {
  const archivedAt = row['archivedAt'] instanceof Date ? (row['archivedAt'] as Date) : null;
  const archiveReasonRaw = row['archiveReason'];
  return {
    id: String(row['id'] ?? ''),
    description: String(row['description'] ?? ''),
    details: row['details'] == null || row['details'] === '' ? null : String(row['details']),
    firstSeenAt: asIsoString(row['firstSeenAt']),
    lastSeenAt: asIsoString(row['lastSeenAt']),
    touchCount: Number(row['touchCount'] ?? 0),
    accessCount: Number(row['accessCount'] ?? 0),
    archived: archivedAt !== null,
    archivedAt: archivedAt ? archivedAt.toISOString() : null,
    archiveReason:
      archiveReasonRaw == null || archiveReasonRaw === '' ? null : String(archiveReasonRaw),
  };
}

export async function getStats(stores: RefmeshHybridStores): Promise<StatsResponse> {
  const conn = stores.graph.connection;

  const [conceptsRow] = await queryAll(conn, 'MATCH (c:Concept) RETURN count(c) AS n');
  const conceptsTotal = Number(conceptsRow?.['n'] ?? 0);

  const [archivedRow] = await queryAll(
    conn,
    'MATCH (c:Concept) WHERE c.archivedAt IS NOT NULL RETURN count(c) AS n',
  );
  const archivedTotal = Number(archivedRow?.['n'] ?? 0);

  const [refsRow] = await queryAll(conn, 'MATCH (r:Reference) RETURN count(r) AS n');
  const referencesTotal = Number(refsRow?.['n'] ?? 0);

  const edgeCounts = await Promise.all(
    ALL_EDGE_TYPE_NAMES.map(async (edgeType) => {
      const [row] = await queryAll(conn, `MATCH ()-[e:${edgeType}]->() RETURN count(e) AS n`);
      return [edgeType, Number(row?.['n'] ?? 0)] as const;
    }),
  );
  const edgesByType: Record<string, number> = {};
  let edgesTotal = 0;
  for (const [edgeType, n] of edgeCounts) {
    edgesByType[edgeType] = n;
    edgesTotal += n;
  }

  const [latestRow] = await queryAll(conn, 'MATCH (c:Concept) RETURN max(c.lastSeenAt) AS latest');
  const latest = latestRow?.['latest'] instanceof Date ? (latestRow['latest'] as Date) : null;

  const vectorCount = await stores.vector.countAll();
  const [graphSize, vectorSize] = await Promise.all([
    pathSize(stores.graph.path),
    pathSize(stores.vector.path),
  ]);

  return {
    graph: { path: stores.graph.path, sizeBytes: graphSize },
    vector: { path: stores.vector.path, sizeBytes: vectorSize, rowCount: vectorCount },
    counts: {
      concepts: conceptsTotal,
      archivedConcepts: archivedTotal,
      references: referencesTotal,
      edgesTotal,
      edgesByType,
    },
    lastSeenAt: latest ? latest.toISOString() : null,
  };
}

export interface ListConceptsOptions {
  limit: number;
  offset: number;
  includeArchived: boolean;
  sort: 'lastSeenAt' | 'touchCount' | 'id';
}

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;

export function parseListConceptsOptions(query: URLSearchParams): ListConceptsOptions {
  const limitRaw = query.get('limit');
  const offsetRaw = query.get('offset');
  const sortRaw = query.get('sort');
  const includeArchivedRaw = query.get('includeArchived');

  let limit = DEFAULT_LIST_LIMIT;
  if (limitRaw !== null) {
    const v = Number.parseInt(limitRaw, 10);
    if (!Number.isInteger(v) || v <= 0) {
      throw new RefmeshValidationError(`limit must be a positive integer (got: ${limitRaw}).`);
    }
    limit = Math.min(v, MAX_LIST_LIMIT);
  }

  let offset = 0;
  if (offsetRaw !== null) {
    const v = Number.parseInt(offsetRaw, 10);
    if (!Number.isInteger(v) || v < 0) {
      throw new RefmeshValidationError(
        `offset must be a non-negative integer (got: ${offsetRaw}).`,
      );
    }
    offset = v;
  }

  const sort: ListConceptsOptions['sort'] =
    sortRaw === 'touchCount' ? 'touchCount' : sortRaw === 'id' ? 'id' : 'lastSeenAt';
  const includeArchived = includeArchivedRaw === 'true' || includeArchivedRaw === '1';

  return { limit, offset, includeArchived, sort };
}

export async function listConcepts(
  stores: RefmeshHybridStores,
  options: ListConceptsOptions,
): Promise<ConceptListResponse> {
  const conn = stores.graph.connection;
  const where = options.includeArchived ? '' : 'WHERE c.archivedAt IS NULL';

  const [totalRow] = await queryAll(conn, `MATCH (c:Concept) ${where} RETURN count(c) AS n`);
  const total = Number(totalRow?.['n'] ?? 0);

  const orderClause =
    options.sort === 'touchCount'
      ? 'ORDER BY c.touchCount DESC, c.id ASC'
      : options.sort === 'id'
        ? 'ORDER BY c.id ASC'
        : 'ORDER BY c.lastSeenAt DESC, c.id ASC';

  const rows = await queryAll(
    conn,
    `MATCH (c:Concept) ${where}
     RETURN c.id AS id, c.description AS description, c.details AS details,
            c.firstSeenAt AS firstSeenAt, c.lastSeenAt AS lastSeenAt,
            c.touchCount AS touchCount, c.accessCount AS accessCount,
            c.archivedAt AS archivedAt, c.archiveReason AS archiveReason
     ${orderClause}
     SKIP ${options.offset} LIMIT ${options.limit}`,
  );

  return {
    total,
    limit: options.limit,
    offset: options.offset,
    items: rows.map(rowToConceptItem),
  };
}

export async function getConcept(
  stores: RefmeshHybridStores,
  id: string,
): Promise<ConceptDetailResponse | null> {
  if (id.length === 0) {
    throw new RefmeshValidationError('concept id must not be empty.');
  }
  const conn = stores.graph.connection;
  const rows = await queryAll(
    conn,
    `MATCH (c:Concept) WHERE c.id = $id
     RETURN c.id AS id, c.description AS description, c.details AS details,
            c.firstSeenAt AS firstSeenAt, c.lastSeenAt AS lastSeenAt,
            c.touchCount AS touchCount, c.accessCount AS accessCount,
            c.archivedAt AS archivedAt, c.archiveReason AS archiveReason`,
    { id },
  );
  const row = rows[0];
  if (!row) return null;

  const refs = await queryAll(
    conn,
    `MATCH (r:Reference)-[:${INTERNAL_DESCRIBES_EDGE}]->(c:Concept)
     WHERE c.id = $id
     RETURN r.url AS url, r.title AS title`,
    { id },
  );

  return {
    ...rowToConceptItem(row),
    references: refs.map((r) => ({ url: String(r['url'] ?? ''), title: String(r['title'] ?? '') })),
  };
}

export interface NeighborsOptions {
  depth: number;
  includeArchived: boolean;
}

export const DEFAULT_NEIGHBOR_DEPTH = 1;
export const MAX_NEIGHBOR_DEPTH = 4;

export function parseNeighborsOptions(query: URLSearchParams): NeighborsOptions {
  const depthRaw = query.get('depth');
  const includeArchivedRaw = query.get('includeArchived');

  let depth = DEFAULT_NEIGHBOR_DEPTH;
  if (depthRaw !== null) {
    const v = Number.parseInt(depthRaw, 10);
    if (!Number.isInteger(v) || v < 0) {
      throw new RefmeshValidationError(`depth must be a non-negative integer (got: ${depthRaw}).`);
    }
    if (v > MAX_NEIGHBOR_DEPTH) {
      throw new RefmeshValidationError(
        `depth must be <= ${MAX_NEIGHBOR_DEPTH} (got: ${v}). Expand step-by-step instead.`,
      );
    }
    depth = v;
  }

  const includeArchived = includeArchivedRaw === 'true' || includeArchivedRaw === '1';
  return { depth, includeArchived };
}

interface MinimalConceptRow {
  id: string;
  description: string;
  details: string | null;
  archived: boolean;
}

async function bulkMinimalConcepts(
  conn: KuzuConnection,
  ids: readonly string[],
): Promise<Map<string, MinimalConceptRow>> {
  const result = new Map<string, MinimalConceptRow>();
  if (ids.length === 0) return result;
  const rows = await queryAll(
    conn,
    `MATCH (c:Concept) WHERE c.id IN ${cypherIdListLiteral(ids)}
     RETURN c.id AS id, c.description AS description, c.details AS details,
            c.archivedAt AS archivedAt`,
  );
  for (const row of rows) {
    const id = String(row['id'] ?? '');
    result.set(id, {
      id,
      description: String(row['description'] ?? ''),
      details: row['details'] == null || row['details'] === '' ? null : String(row['details']),
      archived: row['archivedAt'] instanceof Date,
    });
  }
  return result;
}

async function bulkEdgesForFrontier(
  conn: KuzuConnection,
  edgeType: string,
  ids: readonly string[],
): Promise<NeighborEdge[]> {
  if (ids.length === 0) return [];
  const inList = cypherIdListLiteral(ids);
  const rows = await queryAll(
    conn,
    `MATCH (a:Concept)-[e:${edgeType}]->(b:Concept)
     WHERE a.id IN ${inList} OR b.id IN ${inList}
     RETURN a.id AS source, b.id AS target, e.reason AS reason`,
  );
  return rows.map((row) => ({
    source: String(row['source']),
    target: String(row['target']),
    type: edgeType,
    reason: row['reason'] == null ? null : String(row['reason']),
  }));
}

async function bulkReferencesForConcepts(
  conn: KuzuConnection,
  ids: readonly string[],
): Promise<{ url: string; title: string; conceptId: string }[]> {
  if (ids.length === 0) return [];
  const rows = await queryAll(
    conn,
    `MATCH (r:Reference)-[:${INTERNAL_DESCRIBES_EDGE}]->(c:Concept)
     WHERE c.id IN ${cypherIdListLiteral(ids)}
     RETURN r.url AS url, r.title AS title, c.id AS conceptId`,
  );
  return rows.map((row) => ({
    url: String(row['url'] ?? ''),
    title: String(row['title'] ?? ''),
    conceptId: String(row['conceptId'] ?? ''),
  }));
}

export async function getNeighbors(
  stores: RefmeshHybridStores,
  id: string,
  options: NeighborsOptions,
): Promise<NeighborsResponse | null> {
  if (id.length === 0) {
    throw new RefmeshValidationError('concept id must not be empty.');
  }
  const conn = stores.graph.connection;

  const rootMap = await bulkMinimalConcepts(conn, [id]);
  const root = rootMap.get(id);
  if (!root) return null;

  const nodes = new Map<string, NeighborNode>();
  nodes.set(root.id, { ...root, isRoot: true });

  const edgeKeys = new Set<string>();
  const edges: NeighborEdge[] = [];

  let frontier: string[] = [root.id];
  for (let level = 0; level < options.depth; level += 1) {
    if (frontier.length === 0) break;

    // One query per public edge type for the entire frontier (out + in
    // collapsed into a single OR), instead of frontier × type × direction.
    const edgeBatches = await Promise.all(
      PUBLIC_EDGE_TYPE_NAMES.map((edgeType) => bulkEdgesForFrontier(conn, edgeType, frontier)),
    );
    const newIds = new Set<string>();
    const collected: NeighborEdge[] = [];
    for (const batch of edgeBatches) {
      for (const edge of batch) {
        collected.push(edge);
        if (!nodes.has(edge.source)) newIds.add(edge.source);
        if (!nodes.has(edge.target)) newIds.add(edge.target);
      }
    }

    // Single batched fetch for the new endpoints' minimal info.
    const minimalMap = await bulkMinimalConcepts(conn, [...newIds]);
    const next: string[] = [];
    for (const [nid, minimal] of minimalMap) {
      if (!options.includeArchived && minimal.archived) continue;
      nodes.set(nid, { ...minimal, isRoot: false });
      next.push(nid);
    }

    for (const edge of collected) {
      if (!nodes.has(edge.source) || !nodes.has(edge.target)) continue;
      const key = `${edge.source}|${edge.type}|${edge.target}`;
      if (edgeKeys.has(key)) continue;
      edgeKeys.add(key);
      edges.push(edge);
    }

    frontier = next;
  }

  const refRows = await bulkReferencesForConcepts(conn, [...nodes.keys()]);
  const references: { url: string; title: string; conceptId: string }[] = [];
  const refKeys = new Set<string>();
  for (const ref of refRows) {
    const key = `${ref.conceptId}|${ref.url}`;
    if (refKeys.has(key)) continue;
    refKeys.add(key);
    references.push(ref);
  }

  return {
    rootId: root.id,
    depth: options.depth,
    nodes: [...nodes.values()],
    edges,
    references,
  };
}

export interface ConsoleSearchOptions {
  query: string;
  limit: number;
  depth: number;
  threshold: number;
  includeArchived: boolean;
}

export const DEFAULT_CONSOLE_SEARCH_LIMIT = 10;

export function parseConsoleSearchOptions(query: URLSearchParams): ConsoleSearchOptions {
  const q = (query.get('q') ?? '').trim();
  if (q.length === 0) {
    throw new RefmeshValidationError('search query (q) must not be empty.');
  }
  const limitRaw = query.get('limit');
  const depthRaw = query.get('depth');
  const thresholdRaw = query.get('threshold');
  const includeArchivedRaw = query.get('includeArchived');

  let limit = DEFAULT_CONSOLE_SEARCH_LIMIT;
  if (limitRaw !== null) {
    const v = Number.parseInt(limitRaw, 10);
    if (!Number.isInteger(v) || v <= 0 || v > 100) {
      throw new RefmeshValidationError(`limit must be an integer in [1, 100] (got: ${limitRaw}).`);
    }
    limit = v;
  }

  let depth = 1;
  if (depthRaw !== null) {
    const v = Number.parseInt(depthRaw, 10);
    if (!Number.isInteger(v) || v < 0 || v > MAX_NEIGHBOR_DEPTH) {
      throw new RefmeshValidationError(
        `depth must be an integer in [0, ${MAX_NEIGHBOR_DEPTH}] (got: ${depthRaw}).`,
      );
    }
    depth = v;
  }

  let threshold = 0.3;
  if (thresholdRaw !== null) {
    const v = Number.parseFloat(thresholdRaw);
    if (!Number.isFinite(v) || v < 0 || v > 1) {
      throw new RefmeshValidationError(
        `threshold must be a number in [0, 1] (got: ${thresholdRaw}).`,
      );
    }
    threshold = v;
  }

  const includeArchived = includeArchivedRaw === 'true' || includeArchivedRaw === '1';
  return { query: q, limit, depth, threshold, includeArchived };
}

export async function runConsoleSearch(
  stores: RefmeshHybridStores,
  options: ConsoleSearchOptions,
): Promise<SearchResult> {
  const searchOptions: SearchOptions = {
    depth: options.depth,
    limit: options.limit,
    threshold: options.threshold,
    includeArchived: options.includeArchived,
    format: 'json',
    readOnly: true,
  };
  return await executeSearch(stores, options.query, searchOptions);
}
