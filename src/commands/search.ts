import type { KuzuConnection, RefmeshHybridStores } from '../db/connection.js';
import { cypherIdListLiteral } from '../db/cypher.js';
import { embed } from '../embedding/embedder.js';
import {
  ALL_EDGE_TYPE_NAMES,
  INTERNAL_DESCRIBES_EDGE,
  PUBLIC_EDGE_TYPE_NAMES,
} from '../schema/edge-types.js';
import { RefmeshValidationError } from '../util/errors.js';

export const DEFAULT_SEARCH_THRESHOLD = 0.3;
export const DEFAULT_SEARCH_LIMIT = 5;
export const DEFAULT_SEARCH_DEPTH = 1;
export const DEFAULT_HALF_LIFE_DAYS = 180;
export const DEFAULT_DEMOTE_DEPRECATED = 0.5;

export interface SearchOptions {
  depth: number;
  limit: number;
  threshold?: number;
  freshnessWeight?: number;
  halfLifeDays?: number;
  maxAgeDays?: number;
  demoteDeprecated?: number;
  reinforcementWeight?: number;
  includeArchived?: boolean;
  format: 'text' | 'json';
  // Skip side effects (e.g., reinforcement accessCount increment).
  // Used by the console dashboard to keep the API strictly read-only.
  readOnly?: boolean;
}

export interface SearchConceptNode {
  id: string;
  description: string;
  details?: string;
  score?: number;
  freshness?: number;
  ageDays?: number;
  finalScore?: number;
  demoted?: boolean;
  accessCount?: number;
  reinforcement?: number;
}

export interface SearchReferenceNode {
  url: string;
  title: string;
}

export interface SearchEdge {
  source: string;
  target: string;
  type: string;
  reason?: string;
}

export interface SearchResult {
  query: string;
  matchedConcepts: SearchConceptNode[];
  relatedConcepts: SearchConceptNode[];
  references: SearchReferenceNode[];
  edges: SearchEdge[];
}

// --- Trace types -----------------------------------------------------------
// PBI-16 introduces a debug-only trace channel that records every observable
// step of executeSearch so a console UI can show "how the query was actually
// interpreted". Trace data is *only* assembled when a recorder is attached;
// the non-trace path is byte-for-byte identical to the previous behavior.

export interface SearchTraceVectorHit {
  id: string;
  text: string;
  cosine: number;
  // Cosine distance as reported by LanceDB convention (1 - cosine_similarity)
  // mapped back into our [0, 1] similarity space: distance = 2 * (1 - cosine).
  // Surfaced separately so users can sanity-check threshold tuning.
  distance: number;
  passedThreshold: boolean;
}

export interface SearchTraceGraphQuery {
  label: string;
  cypher: string;
  // First few inputs that were inlined into the cypher list literal, so users
  // can correlate which ids the query actually targeted without dumping the
  // full (potentially huge) cypher text again.
  idsPreview: string[];
}

export type SearchTraceExclusionReason = 'archived' | 'maxAge' | 'demoted-zero' | 'concept-missing';

export interface SearchTraceCandidate {
  id: string;
  cosine: number;
  freshness: number;
  ageDays: number | null;
  accessCount: number;
  reinforcement: number;
  demoted: boolean;
  archived: boolean;
  finalScore: number;
  excluded?: SearchTraceExclusionReason;
}

export interface SearchTraceTraversalLevel {
  level: number;
  frontier: string[];
  edgesAdded: number;
}

export interface SearchTrace {
  queryEmbedding: {
    dim: number;
    l2Norm: number;
    preview: number[];
    full: number[];
  };
  vectorRequest: {
    limit: number;
    oversample: number;
    threshold: number;
  };
  vectorHits: SearchTraceVectorHit[];
  graphQueries: SearchTraceGraphQuery[];
  candidates: SearchTraceCandidate[];
  traversal: {
    depth: number;
    levels: SearchTraceTraversalLevel[];
  };
}

class SearchTraceRecorder {
  private queryEmbedding: SearchTrace['queryEmbedding'] | null = null;
  private vectorRequest: SearchTrace['vectorRequest'] | null = null;
  private vectorHits: SearchTraceVectorHit[] = [];
  private graphQueries: SearchTraceGraphQuery[] = [];
  private candidates: SearchTraceCandidate[] = [];
  private traversalDepth = 0;
  private traversalLevels: SearchTraceTraversalLevel[] = [];

  recordEmbedding(vec: number[]): void {
    let sumSq = 0;
    for (const v of vec) sumSq += v * v;
    this.queryEmbedding = {
      dim: vec.length,
      l2Norm: Math.sqrt(sumSq),
      preview: vec.slice(0, 8),
      full: vec.slice(),
    };
  }

  recordVectorRequest(req: SearchTrace['vectorRequest']): void {
    this.vectorRequest = { ...req };
  }

  recordVectorHits(hits: SearchTraceVectorHit[]): void {
    this.vectorHits = hits;
  }

  recordGraphQuery(q: SearchTraceGraphQuery): void {
    this.graphQueries.push(q);
  }

  recordCandidate(c: SearchTraceCandidate): void {
    this.candidates.push(c);
  }

  setTraversalDepth(depth: number): void {
    this.traversalDepth = depth;
  }

  recordTraversalLevel(level: SearchTraceTraversalLevel): void {
    this.traversalLevels.push(level);
  }

  build(): SearchTrace {
    if (!this.queryEmbedding) {
      throw new Error('SearchTrace incomplete: queryEmbedding missing');
    }
    if (!this.vectorRequest) {
      throw new Error('SearchTrace incomplete: vectorRequest missing');
    }
    return {
      queryEmbedding: this.queryEmbedding,
      vectorRequest: this.vectorRequest,
      vectorHits: this.vectorHits,
      graphQueries: this.graphQueries,
      candidates: this.candidates,
      traversal: {
        depth: this.traversalDepth,
        levels: this.traversalLevels,
      },
    };
  }
}

function idsPreview(ids: readonly string[]): string[] {
  return ids.slice(0, 5).map((s) => String(s));
}

export function validateSearchOptions(opts: SearchOptions): void {
  if (!Number.isInteger(opts.depth) || opts.depth < 0) {
    throw new RefmeshValidationError(
      `--depth must be a non-negative integer (got: ${opts.depth}).`,
    );
  }
  if (!Number.isInteger(opts.limit) || opts.limit <= 0) {
    throw new RefmeshValidationError(`--limit must be a positive integer (got: ${opts.limit}).`);
  }
  if (opts.threshold !== undefined) {
    if (!Number.isFinite(opts.threshold) || opts.threshold < 0 || opts.threshold > 1) {
      throw new RefmeshValidationError(
        `--threshold must be a number in [0, 1] (got: ${opts.threshold}).`,
      );
    }
  }
  if (opts.freshnessWeight !== undefined) {
    if (
      !Number.isFinite(opts.freshnessWeight) ||
      opts.freshnessWeight < 0 ||
      opts.freshnessWeight > 1
    ) {
      throw new RefmeshValidationError(
        `--freshness-weight must be a number in [0, 1] (got: ${opts.freshnessWeight}).`,
      );
    }
  }
  if (opts.halfLifeDays !== undefined) {
    if (!Number.isFinite(opts.halfLifeDays) || opts.halfLifeDays <= 0) {
      throw new RefmeshValidationError(
        `--half-life must be a positive number of days (got: ${opts.halfLifeDays}).`,
      );
    }
  }
  if (opts.maxAgeDays !== undefined) {
    if (!Number.isFinite(opts.maxAgeDays) || opts.maxAgeDays < 0) {
      throw new RefmeshValidationError(
        `--max-age must be a non-negative number of days (got: ${opts.maxAgeDays}).`,
      );
    }
  }
  if (opts.demoteDeprecated !== undefined) {
    if (
      !Number.isFinite(opts.demoteDeprecated) ||
      opts.demoteDeprecated < 0 ||
      opts.demoteDeprecated > 1
    ) {
      throw new RefmeshValidationError(
        `--demote-deprecated must be a number in [0, 1] (got: ${opts.demoteDeprecated}).`,
      );
    }
  }
  if (opts.reinforcementWeight !== undefined) {
    if (
      !Number.isFinite(opts.reinforcementWeight) ||
      opts.reinforcementWeight < 0 ||
      opts.reinforcementWeight > 1
    ) {
      throw new RefmeshValidationError(
        `--reinforcement-weight must be a number in [0, 1] (got: ${opts.reinforcementWeight}).`,
      );
    }
  }
  const w = opts.freshnessWeight ?? 0;
  const r = opts.reinforcementWeight ?? 0;
  if (w + r > 1 + 1e-9) {
    throw new RefmeshValidationError(
      `--freshness-weight + --reinforcement-weight must be <= 1 (got: ${w + r}).`,
    );
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

function rowToConcept(row: Record<string, unknown>): SearchConceptNode {
  const id = String(row['id'] ?? '');
  const description = String(row['description'] ?? '');
  const details =
    row['details'] == null || row['details'] === '' ? undefined : String(row['details']);
  return { id, description, details };
}

interface ConceptFreshnessRow {
  archivedAt: Date | null;
  lastSeenAt: Date | null;
  accessCount: number;
  newestPublishedAt: Date | null;
  isDeprecated: boolean;
}

// Bulk-load minimal concept attrs for an entire id list in one query.
// Replaces the old per-hit fetchConceptById loop that dominated executeSearch
// latency (PBI-13).
async function bulkConceptsByIds(
  conn: KuzuConnection,
  ids: readonly string[],
  recorder: SearchTraceRecorder | null,
  label = 'concepts.byIds',
): Promise<Map<string, SearchConceptNode>> {
  const map = new Map<string, SearchConceptNode>();
  if (ids.length === 0) return map;
  const cypher = `MATCH (c:Concept) WHERE c.id IN ${cypherIdListLiteral(ids)}
     RETURN c.id AS id, c.description AS description, c.details AS details`;
  recorder?.recordGraphQuery({ label, cypher, idsPreview: idsPreview(ids) });
  const rows = await queryAll(conn, cypher);
  for (const r of rows) {
    const id = String(r['id'] ?? '');
    map.set(id, rowToConcept(r));
  }
  return map;
}

// Bulk-load freshness signals (archivedAt / lastSeenAt / accessCount,
// newest publishedAt of any attached Reference, and "is deprecated" via
// DEPRECATES/REPLACES inbound edges) for an entire id list, using only 4
// queries that run in parallel regardless of |ids|.
async function bulkConceptFreshness(
  conn: KuzuConnection,
  ids: readonly string[],
  recorder: SearchTraceRecorder | null,
): Promise<Map<string, ConceptFreshnessRow>> {
  const map = new Map<string, ConceptFreshnessRow>();
  if (ids.length === 0) return map;
  const inList = cypherIdListLiteral(ids);

  const baseCypher = `MATCH (c:Concept) WHERE c.id IN ${inList}
       RETURN c.id AS id, c.archivedAt AS archivedAt,
              c.lastSeenAt AS lastSeenAt, c.accessCount AS accessCount`;
  const refCypher = `MATCH (r:Reference)-[:${INTERNAL_DESCRIBES_EDGE}]->(c:Concept)
       WHERE c.id IN ${inList}
       RETURN c.id AS id, r.publishedAt AS publishedAt`;
  const deprCypher = `MATCH (other:Concept)-[:DEPRECATES]->(c:Concept)
       WHERE c.id IN ${inList} AND other.id <> c.id
       RETURN c.id AS id`;
  const replCypher = `MATCH (other:Concept)-[:REPLACES]->(c:Concept)
       WHERE c.id IN ${inList} AND other.id <> c.id
       RETURN c.id AS id`;

  if (recorder) {
    const preview = idsPreview(ids);
    recorder.recordGraphQuery({ label: 'freshness.base', cypher: baseCypher, idsPreview: preview });
    recorder.recordGraphQuery({ label: 'freshness.refs', cypher: refCypher, idsPreview: preview });
    recorder.recordGraphQuery({
      label: 'freshness.deprecates',
      cypher: deprCypher,
      idsPreview: preview,
    });
    recorder.recordGraphQuery({
      label: 'freshness.replaces',
      cypher: replCypher,
      idsPreview: preview,
    });
  }

  const [baseRows, refRows, deprRows, replRows] = await Promise.all([
    queryAll(conn, baseCypher),
    queryAll(conn, refCypher),
    queryAll(conn, deprCypher),
    queryAll(conn, replCypher),
  ]);

  const newestByConcept = new Map<string, Date>();
  for (const row of refRows) {
    const id = String(row['id'] ?? '');
    const v = row['publishedAt'];
    if (v instanceof Date) {
      const cur = newestByConcept.get(id);
      if (!cur || v.getTime() > cur.getTime()) {
        newestByConcept.set(id, v);
      }
    }
  }

  const deprecated = new Set<string>();
  for (const row of deprRows) deprecated.add(String(row['id'] ?? ''));
  for (const row of replRows) deprecated.add(String(row['id'] ?? ''));

  for (const row of baseRows) {
    const id = String(row['id'] ?? '');
    map.set(id, {
      archivedAt: row['archivedAt'] instanceof Date ? (row['archivedAt'] as Date) : null,
      lastSeenAt: row['lastSeenAt'] instanceof Date ? (row['lastSeenAt'] as Date) : null,
      accessCount: Number(row['accessCount'] ?? 0),
      newestPublishedAt: newestByConcept.get(id) ?? null,
      isDeprecated: deprecated.has(id),
    });
  }
  return map;
}

async function incrementAccessCounts(conn: KuzuConnection, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await queryAll(
    conn,
    `MATCH (c:Concept) WHERE c.id IN ${cypherIdListLiteral(ids)}
     SET c.accessCount = c.accessCount + 1`,
  );
}

function ageInDays(now: Date, anchor: Date | null): number {
  if (!anchor) return Number.POSITIVE_INFINITY;
  const ms = now.getTime() - anchor.getTime();
  return Math.max(0, ms / (1000 * 60 * 60 * 24));
}

function freshnessScore(ageDays: number, halfLifeDays: number): number {
  if (!Number.isFinite(ageDays)) return 0;
  return Math.exp(-Math.LN2 * (ageDays / halfLifeDays));
}

// Single-query out+in edge fetch for a frontier slice. Replaces the inner
// 2 × |frontier| × |edge_types| loop with one query per edge type.
async function bulkEdgesForFrontier(
  conn: KuzuConnection,
  edgeType: string,
  ids: readonly string[],
  recorder: SearchTraceRecorder | null,
  level: number,
): Promise<SearchEdge[]> {
  if (ids.length === 0) return [];
  const inList = cypherIdListLiteral(ids);
  const cypher = `MATCH (a:Concept)-[e:${edgeType}]->(b:Concept)
     WHERE a.id IN ${inList} OR b.id IN ${inList}
     RETURN a.id AS source, b.id AS target, e.reason AS reason`;
  recorder?.recordGraphQuery({
    label: `edges.frontier.${edgeType}.level${level}`,
    cypher,
    idsPreview: idsPreview(ids),
  });
  const rows = await queryAll(conn, cypher);
  return rows.map((row) => ({
    source: String(row['source']),
    target: String(row['target']),
    type: edgeType,
    reason: row['reason'] == null ? undefined : String(row['reason']),
  }));
}

async function collectRelatedEdges(
  conn: KuzuConnection,
  rootIds: string[],
  depth: number,
  recorder: SearchTraceRecorder | null,
): Promise<{ edges: SearchEdge[]; reachedIds: Set<string> }> {
  const reached = new Set<string>(rootIds);
  const edges: SearchEdge[] = [];
  recorder?.setTraversalDepth(depth);
  if (depth === 0 || rootIds.length === 0) {
    return { edges, reachedIds: reached };
  }

  let frontier: string[] = [...rootIds];
  for (let level = 0; level < depth; level += 1) {
    if (frontier.length === 0) break;
    const frontierSnapshot = [...frontier];

    // |edge_types| queries (parallel) for the entire frontier, instead of
    // |frontier| × |edge_types| × 2-direction sequential.
    const batches = await Promise.all(
      PUBLIC_EDGE_TYPE_NAMES.map((edgeType) =>
        bulkEdgesForFrontier(conn, edgeType, frontier, recorder, level),
      ),
    );

    let edgesAddedThisLevel = 0;
    const nextFrontier = new Set<string>();
    for (const batch of batches) {
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
    recorder?.recordTraversalLevel({
      level,
      frontier: frontierSnapshot,
      edgesAdded: edgesAddedThisLevel,
    });
    frontier = [...nextFrontier];
  }

  const dedup = new Map<string, SearchEdge>();
  for (const e of edges) {
    const key = `${e.source}|${e.type}|${e.target}`;
    if (!dedup.has(key)) dedup.set(key, e);
  }
  return { edges: [...dedup.values()], reachedIds: reached };
}

async function getReferencesForConcepts(
  conn: KuzuConnection,
  ids: string[],
  recorder: SearchTraceRecorder | null,
): Promise<SearchReferenceNode[]> {
  if (ids.length === 0) return [];
  const cypher = `MATCH (r:Reference)-[:${INTERNAL_DESCRIBES_EDGE}]->(c:Concept)
     WHERE c.id IN ${cypherIdListLiteral(ids)}
     RETURN r.url AS url, r.title AS title`;
  recorder?.recordGraphQuery({
    label: 'references.byConceptIds',
    cypher,
    idsPreview: idsPreview(ids),
  });
  const rows = await queryAll(conn, cypher);
  const seen = new Map<string, SearchReferenceNode>();
  for (const row of rows) {
    const url = String(row['url']);
    if (!seen.has(url)) {
      seen.set(url, { url, title: String(row['title']) });
    }
  }
  return [...seen.values()];
}

async function executeSearchCore(
  stores: RefmeshHybridStores,
  query: string,
  options: SearchOptions,
  recorder: SearchTraceRecorder | null,
): Promise<SearchResult> {
  validateSearchOptions(options);
  if (query.length === 0) {
    throw new RefmeshValidationError('Search query must not be empty.');
  }

  const threshold = options.threshold ?? DEFAULT_SEARCH_THRESHOLD;
  const freshnessWeight = options.freshnessWeight ?? 0;
  const reinforcementWeight = options.reinforcementWeight ?? 0;
  const cosineWeight = Math.max(0, 1 - freshnessWeight - reinforcementWeight);
  const halfLifeDays = options.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS;
  const maxAgeDays = options.maxAgeDays;
  const demoteDeprecated = options.demoteDeprecated ?? DEFAULT_DEMOTE_DEPRECATED;
  const includeArchived = options.includeArchived ?? false;
  const conn = stores.graph.connection;
  const now = new Date();

  const queryVector = await embed(query);
  recorder?.recordEmbedding(queryVector);

  // Over-fetch to absorb post-filtering by archive/maxAge/demote, then trim to limit.
  const oversample = Math.max(options.limit * 4, options.limit + 5);
  recorder?.recordVectorRequest({ limit: oversample, oversample, threshold });

  // In trace mode, we re-issue the lance query with threshold=0 so the trace
  // can show every nearest hit (including those that were rejected). The
  // downstream pipeline still only sees rows that meet the user-supplied
  // threshold, so non-trace behavior is preserved.
  let hits: Awaited<ReturnType<typeof stores.vector.queryByVector>>;
  if (recorder) {
    const allHits = await stores.vector.queryByVector(queryVector, {
      limit: oversample,
      threshold: 0,
    });
    recorder.recordVectorHits(
      allHits.map((h) => ({
        id: h.id,
        text: h.text,
        cosine: h.score,
        distance: 2 * (1 - h.score),
        passedThreshold: h.score >= threshold,
      })),
    );
    hits = allHits.filter((h) => h.score >= threshold);
  } else {
    hits = await stores.vector.queryByVector(queryVector, {
      limit: oversample,
      threshold,
    });
  }

  interface PartialCandidate extends SearchConceptNode {
    rawCosine: number;
    rawFreshness: number;
    rawAccess: number;
  }
  // One bulk fetch + one bulk freshness call covers every vector hit, instead
  // of N individual round-trips (PBI-13).
  const hitIds = hits.map((h) => h.id);
  const [conceptMap, freshnessMap] = await Promise.all([
    bulkConceptsByIds(conn, hitIds, recorder),
    bulkConceptFreshness(conn, hitIds, recorder),
  ]);
  const partials: PartialCandidate[] = [];
  // Recorder-only side data so we can report excluded candidates without
  // double-classifying them.
  const excludedTrace: SearchTraceCandidate[] = [];
  for (const hit of hits) {
    const concept = conceptMap.get(hit.id);
    if (!concept) {
      if (recorder) {
        excludedTrace.push({
          id: hit.id,
          cosine: hit.score,
          freshness: 0,
          ageDays: null,
          accessCount: 0,
          reinforcement: 0,
          demoted: false,
          archived: false,
          finalScore: 0,
          excluded: 'concept-missing',
        });
      }
      continue;
    }
    const fresh = freshnessMap.get(hit.id);
    if (!fresh) {
      if (recorder) {
        excludedTrace.push({
          id: hit.id,
          cosine: hit.score,
          freshness: 0,
          ageDays: null,
          accessCount: 0,
          reinforcement: 0,
          demoted: false,
          archived: false,
          finalScore: 0,
          excluded: 'concept-missing',
        });
      }
      continue;
    }
    const archived = fresh.archivedAt !== null;
    if (!includeArchived && archived) {
      if (recorder) {
        excludedTrace.push({
          id: hit.id,
          cosine: hit.score,
          freshness: 0,
          ageDays: null,
          accessCount: fresh.accessCount,
          reinforcement: 0,
          demoted: fresh.isDeprecated,
          archived: true,
          finalScore: 0,
          excluded: 'archived',
        });
      }
      continue;
    }

    const anchor = fresh.newestPublishedAt ?? fresh.lastSeenAt;
    const age = ageInDays(now, anchor);
    if (maxAgeDays !== undefined && age > maxAgeDays) {
      if (recorder) {
        excludedTrace.push({
          id: hit.id,
          cosine: hit.score,
          freshness: freshnessScore(age, halfLifeDays),
          ageDays: Number.isFinite(age) ? age : null,
          accessCount: fresh.accessCount,
          reinforcement: 0,
          demoted: fresh.isDeprecated,
          archived,
          finalScore: 0,
          excluded: 'maxAge',
        });
      }
      continue;
    }
    const demoted = fresh.isDeprecated;
    if (demoteDeprecated === 0 && demoted) {
      if (recorder) {
        excludedTrace.push({
          id: hit.id,
          cosine: hit.score,
          freshness: freshnessScore(age, halfLifeDays),
          ageDays: Number.isFinite(age) ? age : null,
          accessCount: fresh.accessCount,
          reinforcement: 0,
          demoted: true,
          archived,
          finalScore: 0,
          excluded: 'demoted-zero',
        });
      }
      continue;
    }

    const freshness = freshnessScore(age, halfLifeDays);
    partials.push({
      ...concept,
      score: hit.score,
      freshness,
      ageDays: Number.isFinite(age) ? age : undefined,
      demoted,
      accessCount: fresh.accessCount,
      rawCosine: hit.score,
      rawFreshness: freshness,
      rawAccess: fresh.accessCount,
    });
  }

  const maxAccess = partials.reduce((m, p) => Math.max(m, p.rawAccess), 0);
  const accessNorm = maxAccess > 0 ? Math.log1p(maxAccess + 1) : 0; // denominator; avoid divide-by-zero

  const candidates: SearchConceptNode[] = partials.map((p) => {
    const reinforcement = accessNorm > 0 ? Math.log1p(p.rawAccess) / accessNorm : 0;
    let final =
      cosineWeight * p.rawCosine +
      freshnessWeight * p.rawFreshness +
      reinforcementWeight * reinforcement;
    if (p.demoted) final *= demoteDeprecated;
    return {
      id: p.id,
      description: p.description,
      details: p.details,
      score: p.score,
      freshness: p.freshness,
      ageDays: p.ageDays,
      finalScore: final,
      demoted: p.demoted,
      accessCount: p.accessCount,
      reinforcement,
    };
  });

  if (recorder) {
    for (const c of candidates) {
      recorder.recordCandidate({
        id: c.id,
        cosine: c.score ?? 0,
        freshness: c.freshness ?? 0,
        ageDays: c.ageDays ?? null,
        accessCount: c.accessCount ?? 0,
        reinforcement: c.reinforcement ?? 0,
        demoted: c.demoted ?? false,
        archived: false,
        finalScore: c.finalScore ?? 0,
      });
    }
    for (const ex of excludedTrace) {
      recorder.recordCandidate(ex);
    }
  }

  candidates.sort((a, b) => (b.finalScore ?? 0) - (a.finalScore ?? 0));
  const matched = candidates.slice(0, options.limit);

  const matchedIds = matched.map((c) => c.id);
  const { edges, reachedIds } = await collectRelatedEdges(
    conn,
    matchedIds,
    options.depth,
    recorder,
  );
  let relatedIds = [...reachedIds].filter((id) => !matchedIds.includes(id));
  if (!includeArchived && relatedIds.length > 0) {
    // We only need the archived bit here, not the full freshness payload —
    // a single MATCH avoids 4 unrelated queries that bulkConceptFreshness
    // would have run for newest publishedAt / DEPRECATES / REPLACES.
    const visibleCypher = `MATCH (c:Concept) WHERE c.id IN ${cypherIdListLiteral(relatedIds)}
         AND c.archivedAt IS NULL
       RETURN c.id AS id`;
    recorder?.recordGraphQuery({
      label: 'related.visible',
      cypher: visibleCypher,
      idsPreview: idsPreview(relatedIds),
    });
    const visibleRows = await queryAll(conn, visibleCypher);
    const visible = new Set(visibleRows.map((r) => String(r['id'] ?? '')));
    relatedIds = relatedIds.filter((id) => visible.has(id));
  }
  const relatedConceptMap = await bulkConceptsByIds(conn, relatedIds, recorder, 'concepts.related');
  const relatedConcepts: SearchConceptNode[] = relatedIds
    .map((id) => relatedConceptMap.get(id))
    .filter((c): c is SearchConceptNode => c !== undefined);

  const allIds = [...matchedIds, ...relatedIds];
  const references = await getReferencesForConcepts(conn, allIds, recorder);

  if (matchedIds.length > 0 && !options.readOnly) {
    await incrementAccessCounts(conn, matchedIds);
  }

  return {
    query,
    matchedConcepts: matched,
    relatedConcepts,
    references,
    edges,
  };
}

export async function executeSearch(
  stores: RefmeshHybridStores,
  query: string,
  options: SearchOptions,
): Promise<SearchResult> {
  return executeSearchCore(stores, query, options, null);
}

export async function executeSearchWithTrace(
  stores: RefmeshHybridStores,
  query: string,
  options: SearchOptions,
): Promise<{ result: SearchResult; trace: SearchTrace }> {
  const recorder = new SearchTraceRecorder();
  // Trace mode is observation-only — never bump accessCount even if a caller
  // forgets to set readOnly. This keeps the debug UI side-effect free.
  const result = await executeSearchCore(stores, query, { ...options, readOnly: true }, recorder);
  return { result, trace: recorder.build() };
}

export function renderSearchText(result: SearchResult): string {
  const lines: string[] = [];
  lines.push(`# Search: "${result.query}"`);
  lines.push('');
  if (result.matchedConcepts.length === 0) {
    lines.push('no results');
    return lines.join('\n');
  }

  lines.push(`## Matched Concepts (${result.matchedConcepts.length})`);
  for (const c of result.matchedConcepts) {
    const parts: string[] = [];
    if (c.score !== undefined) parts.push(`score=${c.score.toFixed(3)}`);
    if (c.freshness !== undefined) parts.push(`fresh=${c.freshness.toFixed(3)}`);
    if (c.reinforcement !== undefined && c.reinforcement > 0)
      parts.push(`reinf=${c.reinforcement.toFixed(3)}`);
    if (c.accessCount !== undefined && c.accessCount > 0) parts.push(`access=${c.accessCount}`);
    if (c.ageDays !== undefined) parts.push(`age=${c.ageDays.toFixed(1)}d`);
    if (c.finalScore !== undefined) parts.push(`final=${c.finalScore.toFixed(3)}`);
    if (c.demoted) parts.push('demoted');
    const tag = parts.length > 0 ? ` [${parts.join(', ')}]` : '';
    lines.push(`- ${c.id}${tag}: ${c.description}`);
    if (c.details) lines.push(`    details: ${c.details}`);
  }
  lines.push('');

  if (result.relatedConcepts.length > 0) {
    lines.push(`## Related Concepts (${result.relatedConcepts.length})`);
    for (const c of result.relatedConcepts) {
      lines.push(`- ${c.id}: ${c.description}`);
    }
    lines.push('');
  }

  if (result.edges.length > 0) {
    lines.push(`## Relationships (${result.edges.length})`);
    for (const e of result.edges) {
      const reason = e.reason ? ` — ${e.reason}` : '';
      lines.push(`- ${e.source} -[${e.type}]-> ${e.target}${reason}`);
    }
    lines.push('');
  }

  if (result.references.length > 0) {
    lines.push(`## References (${result.references.length})`);
    for (const r of result.references) {
      lines.push(`- ${r.title} (${r.url})`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function renderSearchJson(result: SearchResult): string {
  return JSON.stringify(result, null, 2);
}

// Re-exported for external utilities/tests.
export const _internal = { ALL_EDGE_TYPE_NAMES };
