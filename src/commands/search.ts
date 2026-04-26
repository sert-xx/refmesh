import type { KuzuConnection, RefmeshHybridStores } from '../db/connection.js';
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

async function fetchConceptById(
  conn: KuzuConnection,
  id: string,
): Promise<SearchConceptNode | null> {
  const rows = await queryAll(
    conn,
    `MATCH (c:Concept) WHERE c.id = $id
     RETURN c.id AS id, c.description AS description, c.details AS details`,
    { id },
  );
  const r = rows[0];
  return r ? rowToConcept(r) : null;
}

interface ConceptFreshnessRow {
  archivedAt: Date | null;
  lastSeenAt: Date | null;
  accessCount: number;
  newestPublishedAt: Date | null;
  isDeprecated: boolean;
}

async function fetchConceptFreshness(
  conn: KuzuConnection,
  id: string,
): Promise<ConceptFreshnessRow | null> {
  const baseRows = await queryAll(
    conn,
    `MATCH (c:Concept) WHERE c.id = $id
     RETURN c.archivedAt AS archivedAt, c.lastSeenAt AS lastSeenAt,
            c.accessCount AS accessCount`,
    { id },
  );
  const base = baseRows[0];
  if (!base) return null;

  const refRows = await queryAll(
    conn,
    `MATCH (r:Reference)-[:${INTERNAL_DESCRIBES_EDGE}]->(c:Concept)
     WHERE c.id = $id
     RETURN r.publishedAt AS publishedAt`,
    { id },
  );
  let newestPublishedAt: Date | null = null;
  for (const row of refRows) {
    const v = row['publishedAt'];
    if (v instanceof Date && (!newestPublishedAt || v.getTime() > newestPublishedAt.getTime())) {
      newestPublishedAt = v;
    }
  }

  let isDeprecated = false;
  for (const edgeType of ['DEPRECATES', 'REPLACES']) {
    const rows = await queryAll(
      conn,
      `MATCH (other:Concept)-[e:${edgeType}]->(c:Concept)
       WHERE c.id = $id AND other.id <> $id
       RETURN other.id AS otherId LIMIT 1`,
      { id },
    );
    if (rows.length > 0) {
      isDeprecated = true;
      break;
    }
  }

  return {
    archivedAt: base['archivedAt'] instanceof Date ? (base['archivedAt'] as Date) : null,
    lastSeenAt: base['lastSeenAt'] instanceof Date ? (base['lastSeenAt'] as Date) : null,
    accessCount: Number(base['accessCount'] ?? 0),
    newestPublishedAt,
    isDeprecated,
  };
}

async function incrementAccessCounts(conn: KuzuConnection, ids: string[]): Promise<void> {
  for (const id of ids) {
    await queryAll(
      conn,
      `MATCH (c:Concept) WHERE c.id = $id
       SET c.accessCount = c.accessCount + 1`,
      { id },
    );
  }
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

async function getConceptsByIds(conn: KuzuConnection, ids: string[]): Promise<SearchConceptNode[]> {
  if (ids.length === 0) return [];
  const result: SearchConceptNode[] = [];
  for (const id of ids) {
    const rows = await queryAll(
      conn,
      `MATCH (c:Concept) WHERE c.id = $id
       RETURN c.id AS id, c.description AS description, c.details AS details`,
      { id },
    );
    if (rows.length > 0) {
      const r = rows[0];
      if (r) result.push(rowToConcept(r));
    }
  }
  return result;
}

async function collectRelatedEdges(
  conn: KuzuConnection,
  rootIds: string[],
  depth: number,
): Promise<{ edges: SearchEdge[]; reachedIds: Set<string> }> {
  const reached = new Set<string>(rootIds);
  const edges: SearchEdge[] = [];
  if (depth === 0 || rootIds.length === 0) {
    return { edges, reachedIds: reached };
  }

  let frontier = new Set<string>(rootIds);
  for (let level = 0; level < depth; level += 1) {
    const nextFrontier = new Set<string>();
    for (const id of frontier) {
      for (const edgeType of PUBLIC_EDGE_TYPE_NAMES) {
        const outgoing = await queryAll(
          conn,
          `MATCH (a:Concept)-[e:${edgeType}]->(b:Concept)
           WHERE a.id = $id
           RETURN a.id AS source, b.id AS target, e.reason AS reason`,
          { id },
        );
        for (const row of outgoing) {
          const edge: SearchEdge = {
            source: String(row['source']),
            target: String(row['target']),
            type: edgeType,
            reason: row['reason'] == null ? undefined : String(row['reason']),
          };
          edges.push(edge);
          if (!reached.has(edge.target)) {
            reached.add(edge.target);
            nextFrontier.add(edge.target);
          }
        }

        const incoming = await queryAll(
          conn,
          `MATCH (a:Concept)-[e:${edgeType}]->(b:Concept)
           WHERE b.id = $id
           RETURN a.id AS source, b.id AS target, e.reason AS reason`,
          { id },
        );
        for (const row of incoming) {
          const edge: SearchEdge = {
            source: String(row['source']),
            target: String(row['target']),
            type: edgeType,
            reason: row['reason'] == null ? undefined : String(row['reason']),
          };
          edges.push(edge);
          if (!reached.has(edge.source)) {
            reached.add(edge.source);
            nextFrontier.add(edge.source);
          }
        }
      }
    }
    frontier = nextFrontier;
    if (frontier.size === 0) break;
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
): Promise<SearchReferenceNode[]> {
  if (ids.length === 0) return [];
  const seen = new Map<string, SearchReferenceNode>();
  for (const id of ids) {
    const rows = await queryAll(
      conn,
      `MATCH (r:Reference)-[:${INTERNAL_DESCRIBES_EDGE}]->(c:Concept)
       WHERE c.id = $id
       RETURN r.url AS url, r.title AS title`,
      { id },
    );
    for (const row of rows) {
      const url = String(row['url']);
      if (!seen.has(url)) {
        seen.set(url, { url, title: String(row['title']) });
      }
    }
  }
  return [...seen.values()];
}

export async function executeSearch(
  stores: RefmeshHybridStores,
  query: string,
  options: SearchOptions,
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
  // Over-fetch to absorb post-filtering by archive/maxAge/demote, then trim to limit.
  const oversample = Math.max(options.limit * 4, options.limit + 5);
  const hits = await stores.vector.queryByVector(queryVector, {
    limit: oversample,
    threshold,
  });

  interface PartialCandidate extends SearchConceptNode {
    rawCosine: number;
    rawFreshness: number;
    rawAccess: number;
  }
  const partials: PartialCandidate[] = [];
  for (const hit of hits) {
    const concept = await fetchConceptById(conn, hit.id);
    if (!concept) continue;
    const fresh = await fetchConceptFreshness(conn, hit.id);
    if (!fresh) continue;
    if (!includeArchived && fresh.archivedAt) continue;

    const anchor = fresh.newestPublishedAt ?? fresh.lastSeenAt;
    const age = ageInDays(now, anchor);
    if (maxAgeDays !== undefined && age > maxAgeDays) continue;
    const demoted = fresh.isDeprecated;
    if (demoteDeprecated === 0 && demoted) continue;

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

  candidates.sort((a, b) => (b.finalScore ?? 0) - (a.finalScore ?? 0));
  const matched = candidates.slice(0, options.limit);

  const matchedIds = matched.map((c) => c.id);
  const { edges, reachedIds } = await collectRelatedEdges(conn, matchedIds, options.depth);
  let relatedIds = [...reachedIds].filter((id) => !matchedIds.includes(id));
  if (!includeArchived && relatedIds.length > 0) {
    const filteredRelated: string[] = [];
    for (const id of relatedIds) {
      const fresh = await fetchConceptFreshness(conn, id);
      if (fresh && !fresh.archivedAt) filteredRelated.push(id);
    }
    relatedIds = filteredRelated;
  }
  const relatedConcepts = await getConceptsByIds(conn, relatedIds);

  const allIds = [...matchedIds, ...relatedIds];
  const references = await getReferencesForConcepts(conn, allIds);

  if (matchedIds.length > 0) {
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
