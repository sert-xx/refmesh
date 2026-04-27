import { statSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type SearchOptions,
  type SearchResult,
  type SearchTrace,
  executeSearch,
  executeSearchWithTrace,
} from '../commands/search.js';
import {
  ALL_EDGE_TYPE_NAMES,
  PUBLIC_EDGE_TYPE_NAMES,
  referencesByConceptIds,
} from '../db/concept-repo.js';
import { edgesForFrontier } from '../db/graph.js';
import type { RefmeshStore } from '../db/store.js';
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

function asIso(value: string | null): string | null {
  if (!value) return null;
  return value;
}

function rowToConceptItem(row: ConceptItemRow): ConceptListItem {
  return {
    id: row.id,
    description: row.description,
    details: row.details && row.details.length > 0 ? row.details : null,
    firstSeenAt: asIso(row.first_seen_at),
    lastSeenAt: asIso(row.last_seen_at),
    touchCount: row.touch_count,
    accessCount: row.access_count,
    archived: row.archived_at !== null,
    archivedAt: row.archived_at,
    archiveReason: row.archive_reason && row.archive_reason.length > 0 ? row.archive_reason : null,
  };
}

interface ConceptItemRow {
  id: string;
  description: string;
  details: string | null;
  first_seen_at: string;
  last_seen_at: string;
  touch_count: number;
  access_count: number;
  archived_at: string | null;
  archive_reason: string | null;
}

export async function getStats(store: RefmeshStore): Promise<StatsResponse> {
  const conceptsRow = store.db.prepare('SELECT COUNT(*) AS n FROM concepts').get() as {
    n: number;
  };
  const archivedRow = store.db
    .prepare('SELECT COUNT(*) AS n FROM concepts WHERE archived_at IS NOT NULL')
    .get() as { n: number };
  const refsRow = store.db.prepare('SELECT COUNT(*) AS n FROM refs').get() as { n: number };

  const edgesByType: Record<string, number> = {};
  let edgesTotal = 0;
  const stmtEdgeCount = store.db.prepare<[string]>(
    'SELECT COUNT(*) AS n FROM edges WHERE edge_type = ?',
  );
  for (const t of ALL_EDGE_TYPE_NAMES) {
    if (t === 'DESCRIBES') {
      const dRow = store.db.prepare('SELECT COUNT(*) AS n FROM describes').get() as {
        n: number;
      };
      edgesByType[t] = dRow.n;
      edgesTotal += dRow.n;
      continue;
    }
    const row = stmtEdgeCount.get(t) as { n: number } | undefined;
    const n = row?.n ?? 0;
    edgesByType[t] = n;
    edgesTotal += n;
  }

  const latestRow = store.db.prepare('SELECT MAX(last_seen_at) AS latest FROM concepts').get() as {
    latest: string | null;
  };

  const dbSize = await pathSize(store.path);
  // Vector storage now lives inside the same SQLite file. Surface row count
  // and re-use the DB file size so the Overview tab still has both numbers
  // even though there is no separate vector store directory anymore.
  const vectorCount = store.vectors.countAll();

  return {
    graph: { path: store.path, sizeBytes: dbSize },
    vector: { path: store.path, sizeBytes: dbSize, rowCount: vectorCount },
    counts: {
      concepts: conceptsRow.n,
      archivedConcepts: archivedRow.n,
      references: refsRow.n,
      edgesTotal,
      edgesByType,
    },
    lastSeenAt: latestRow.latest,
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
  store: RefmeshStore,
  options: ListConceptsOptions,
): Promise<ConceptListResponse> {
  const where = options.includeArchived ? '' : 'WHERE archived_at IS NULL';

  const totalRow = store.db.prepare(`SELECT COUNT(*) AS n FROM concepts ${where}`).get() as {
    n: number;
  };
  const total = totalRow.n;

  const orderClause =
    options.sort === 'touchCount'
      ? 'ORDER BY touch_count DESC, id ASC'
      : options.sort === 'id'
        ? 'ORDER BY id ASC'
        : 'ORDER BY last_seen_at DESC, id ASC';

  const rows = store.db
    .prepare<[number, number]>(
      `SELECT id, description, details, first_seen_at, last_seen_at,
              touch_count, access_count, archived_at, archive_reason
         FROM concepts ${where}
         ${orderClause}
         LIMIT ? OFFSET ?`,
    )
    .all(options.limit, options.offset) as ConceptItemRow[];

  return {
    total,
    limit: options.limit,
    offset: options.offset,
    items: rows.map(rowToConceptItem),
  };
}

export async function getConcept(
  store: RefmeshStore,
  id: string,
): Promise<ConceptDetailResponse | null> {
  if (id.length === 0) {
    throw new RefmeshValidationError('concept id must not be empty.');
  }
  const row = store.db
    .prepare<[string]>(
      `SELECT id, description, details, first_seen_at, last_seen_at,
              touch_count, access_count, archived_at, archive_reason
         FROM concepts WHERE id = ?`,
    )
    .get(id) as ConceptItemRow | undefined;
  if (!row) return null;

  const refs = store.db
    .prepare<[string]>(
      `SELECT r.url AS url, r.title AS title
         FROM refs r JOIN describes d ON d.ref_url = r.url
        WHERE d.concept_id = ?`,
    )
    .all(id) as Array<{ url: string; title: string }>;

  return {
    ...rowToConceptItem(row),
    references: refs,
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

function bulkMinimalConcepts(
  store: RefmeshStore,
  ids: readonly string[],
): Map<string, MinimalConceptRow> {
  const result = new Map<string, MinimalConceptRow>();
  if (ids.length === 0) return result;
  const placeholders = ids.map(() => '?').join(', ');
  const rows = store.db
    .prepare<string[]>(
      `SELECT id, description, details, archived_at
         FROM concepts WHERE id IN (${placeholders})`,
    )
    .all(...ids) as Array<{
    id: string;
    description: string;
    details: string | null;
    archived_at: string | null;
  }>;
  for (const r of rows) {
    result.set(r.id, {
      id: r.id,
      description: r.description,
      details: r.details && r.details.length > 0 ? r.details : null,
      archived: r.archived_at !== null,
    });
  }
  return result;
}

export async function getNeighbors(
  store: RefmeshStore,
  id: string,
  options: NeighborsOptions,
): Promise<NeighborsResponse | null> {
  if (id.length === 0) {
    throw new RefmeshValidationError('concept id must not be empty.');
  }

  const rootMap = bulkMinimalConcepts(store, [id]);
  const root = rootMap.get(id);
  if (!root) return null;

  const nodes = new Map<string, NeighborNode>();
  nodes.set(root.id, { ...root, isRoot: true });

  const edgeKeys = new Set<string>();
  const edges: NeighborEdge[] = [];

  let frontier: string[] = [root.id];
  for (let level = 0; level < options.depth; level += 1) {
    if (frontier.length === 0) break;

    const collected: NeighborEdge[] = [];
    const newIds = new Set<string>();
    for (const edgeType of PUBLIC_EDGE_TYPE_NAMES) {
      const batch = edgesForFrontier(store.db, edgeType, frontier);
      for (const e of batch) {
        collected.push({
          source: e.source,
          target: e.target,
          type: e.type,
          reason: e.reason,
        });
        if (!nodes.has(e.source)) newIds.add(e.source);
        if (!nodes.has(e.target)) newIds.add(e.target);
      }
    }

    const minimalMap = bulkMinimalConcepts(store, [...newIds]);
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

  const refRows = referencesByConceptIds(store.db, [...nodes.keys()]);
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
  freshnessWeight?: number;
  halfLifeDays?: number;
  maxAgeDays?: number;
  demoteDeprecated?: number;
  reinforcementWeight?: number;
  lexicalWeight?: number;
  bm25Weight?: number;
}

export const DEFAULT_CONSOLE_SEARCH_LIMIT = 10;

function parseOptionalUnitFloat(query: URLSearchParams, key: string): number | undefined {
  const raw = query.get(key);
  if (raw === null) return undefined;
  const v = Number.parseFloat(raw);
  if (!Number.isFinite(v) || v < 0 || v > 1) {
    throw new RefmeshValidationError(`${key} must be a number in [0, 1] (got: ${raw}).`);
  }
  return v;
}

function parseOptionalPositiveFloat(
  query: URLSearchParams,
  key: string,
  options: { allowZero?: boolean } = {},
): number | undefined {
  const raw = query.get(key);
  if (raw === null) return undefined;
  const v = Number.parseFloat(raw);
  const allowZero = options.allowZero ?? false;
  const lowerOk = allowZero ? v >= 0 : v > 0;
  if (!Number.isFinite(v) || !lowerOk) {
    const bound = allowZero ? 'non-negative' : 'positive';
    throw new RefmeshValidationError(`${key} must be a ${bound} number (got: ${raw}).`);
  }
  return v;
}

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
  const freshnessWeight = parseOptionalUnitFloat(query, 'freshnessWeight');
  const halfLifeDays = parseOptionalPositiveFloat(query, 'halfLifeDays');
  const maxAgeDays = parseOptionalPositiveFloat(query, 'maxAgeDays', { allowZero: true });
  const demoteDeprecated = parseOptionalUnitFloat(query, 'demoteDeprecated');
  const reinforcementWeight = parseOptionalUnitFloat(query, 'reinforcementWeight');
  const lexicalWeight = parseOptionalUnitFloat(query, 'lexicalWeight');
  const bm25Weight = parseOptionalUnitFloat(query, 'bm25Weight');

  return {
    query: q,
    limit,
    depth,
    threshold,
    includeArchived,
    freshnessWeight,
    halfLifeDays,
    maxAgeDays,
    demoteDeprecated,
    reinforcementWeight,
    lexicalWeight,
    bm25Weight,
  };
}

// /api/search keeps its pre-PBI-16 contract: only the historical knobs
// (q / limit / depth / threshold / includeArchived) are honored, even if a
// caller adds the newer scoring params to the URL. This preserves the
// "/api/search 挙動も payload も変更しない" guarantee.
export async function runConsoleSearch(
  store: RefmeshStore,
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
  return await executeSearch(store, options.query, searchOptions);
}

export interface ConsoleSearchDebugResponse {
  result: SearchResult;
  trace: SearchTrace;
}

// /api/search/debug accepts the full scoring matrix so users can iterate on
// freshness / reinforcement / demote / lexical / bm25 weights without
// leaving the dashboard.
export async function runConsoleSearchDebug(
  store: RefmeshStore,
  options: ConsoleSearchOptions,
): Promise<ConsoleSearchDebugResponse> {
  const searchOptions: SearchOptions = {
    depth: options.depth,
    limit: options.limit,
    threshold: options.threshold,
    includeArchived: options.includeArchived,
    freshnessWeight: options.freshnessWeight,
    halfLifeDays: options.halfLifeDays,
    maxAgeDays: options.maxAgeDays,
    demoteDeprecated: options.demoteDeprecated,
    reinforcementWeight: options.reinforcementWeight,
    lexicalWeight: options.lexicalWeight,
    bm25Weight: options.bm25Weight,
    format: 'json',
    readOnly: true,
  };
  return await executeSearchWithTrace(store, options.query, searchOptions);
}
