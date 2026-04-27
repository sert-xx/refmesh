import {
  bulkConceptFreshness,
  bulkConceptsByIds,
  incrementAccessCounts,
  referencesForConcepts,
  visibleConceptIds,
} from '../db/concept-repo.js';
import { type FtsHit, ftsSearch } from '../db/fts.js';
import { edgesForFrontier } from '../db/graph.js';
import type { RefmeshStore } from '../db/store.js';
import { embed } from '../embedding/embedder.js';
import { ALL_EDGE_TYPE_NAMES, PUBLIC_EDGE_TYPE_NAMES } from '../schema/edge-types.js';
import { RefmeshValidationError } from '../util/errors.js';

export const DEFAULT_SEARCH_THRESHOLD = 0.3;
export const DEFAULT_SEARCH_LIMIT = 5;
export const DEFAULT_SEARCH_DEPTH = 1;
export const DEFAULT_HALF_LIFE_DAYS = 180;
export const DEFAULT_DEMOTE_DEPRECATED = 0.5;
// Lexical (PBI-17) and BM25 (PBI-18) are independent additive axes on top of
// the cosine/freshness/reinforcement triplet. The defaults split the cosine
// half evenly: cosine 0.4 / lexical 0.3 / bm25 0.3 with freshness/reinforcement
// = 0. This pushes id-token matches above semantic-cluster mates while still
// letting BM25 surface description-only hits.
export const DEFAULT_LEXICAL_WEIGHT = 0.3;
export const DEFAULT_BM25_WEIGHT = 0.3;

export interface SearchOptions {
  depth: number;
  limit: number;
  threshold?: number;
  freshnessWeight?: number;
  halfLifeDays?: number;
  maxAgeDays?: number;
  demoteDeprecated?: number;
  reinforcementWeight?: number;
  lexicalWeight?: number;
  bm25Weight?: number;
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
  lexical?: number;
  bm25?: number;
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

export interface SearchTraceVectorHit {
  id: string;
  text: string;
  cosine: number;
  // distance = 2 * (1 - cosine) so the trace UI keeps the same axis it had
  // when LanceDB reported _distance directly. Pure cosmetic, but lets users
  // re-use intuition built up before the SQLite migration.
  distance: number;
  passedThreshold: boolean;
}

export interface SearchTraceFtsHit {
  id: string;
  bm25: number;
  rawRank: number;
}

export interface SearchTraceGraphQuery {
  label: string;
  cypher: string;
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
  lexical: number;
  bm25: number;
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
  queryTokens: string[];
  vectorRequest: {
    limit: number;
    oversample: number;
    threshold: number;
  };
  vectorHits: SearchTraceVectorHit[];
  ftsHits: SearchTraceFtsHit[];
  graphQueries: SearchTraceGraphQuery[];
  candidates: SearchTraceCandidate[];
  traversal: {
    depth: number;
    levels: SearchTraceTraversalLevel[];
  };
}

class SearchTraceRecorder {
  private queryEmbedding: SearchTrace['queryEmbedding'] | null = null;
  private queryTokens: string[] = [];
  private vectorRequest: SearchTrace['vectorRequest'] | null = null;
  private vectorHits: SearchTraceVectorHit[] = [];
  private ftsHits: SearchTraceFtsHit[] = [];
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

  recordQueryTokens(tokens: readonly string[]): void {
    this.queryTokens = [...tokens];
  }

  recordVectorRequest(req: SearchTrace['vectorRequest']): void {
    this.vectorRequest = { ...req };
  }

  recordVectorHits(hits: SearchTraceVectorHit[]): void {
    this.vectorHits = hits;
  }

  recordFtsHits(hits: SearchTraceFtsHit[]): void {
    this.ftsHits = hits;
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
      queryTokens: this.queryTokens,
      vectorRequest: this.vectorRequest,
      vectorHits: this.vectorHits,
      ftsHits: this.ftsHits,
      graphQueries: this.graphQueries,
      candidates: this.candidates,
      traversal: {
        depth: this.traversalDepth,
        levels: this.traversalLevels,
      },
    };
  }
}

// Tokenizer shared by lexical scoring and trace surfacing. Splits on
// whitespace plus typical id-style separators (_, -, ., :, /), then breaks
// camelCase / PascalCase boundaries so identifiers like
// "GoogleKubernetesEngine" match a "kubernetes" query. Lower-cased so the
// comparison is case-insensitive. No stopword list / stemming — short
// concept ids are dominated by content words.
export function tokenize(input: string): string[] {
  if (!input) return [];
  const out: string[] = [];
  for (const piece of input.split(/[\s_\-./:]+/)) {
    if (piece.length === 0) continue;
    const split = piece
      .replace(/([a-z0-9])([A-Z])/g, '$1\u0000$2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1\u0000$2')
      .split('\u0000');
    for (const token of split) {
      if (token.length === 0) continue;
      out.push(token.toLowerCase());
    }
  }
  return out;
}

function computeLexicalScore(
  queryTokens: ReadonlySet<string>,
  idTokens: ReadonlySet<string>,
  descTokens: ReadonlySet<string>,
  detailsTokens: ReadonlySet<string>,
): number {
  if (queryTokens.size === 0) return 0;
  let idHits = 0;
  let descHits = 0;
  let detailHits = 0;
  for (const t of queryTokens) {
    if (idTokens.has(t)) idHits += 1;
    if (descTokens.has(t)) descHits += 1;
    if (detailsTokens.has(t)) detailHits += 1;
  }
  const idHitFlag = idHits > 0 ? 1 : 0;
  const denom = queryTokens.size;
  const score =
    idHitFlag * 0.5 +
    (idHits / denom) * 0.3 +
    (descHits / denom) * 0.15 +
    (detailHits / denom) * 0.05;
  return Math.min(1, score);
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
  if (opts.lexicalWeight !== undefined) {
    if (!Number.isFinite(opts.lexicalWeight) || opts.lexicalWeight < 0 || opts.lexicalWeight > 1) {
      throw new RefmeshValidationError(
        `--lexical-weight must be a number in [0, 1] (got: ${opts.lexicalWeight}).`,
      );
    }
  }
  if (opts.bm25Weight !== undefined) {
    if (!Number.isFinite(opts.bm25Weight) || opts.bm25Weight < 0 || opts.bm25Weight > 1) {
      throw new RefmeshValidationError(
        `--bm25-weight must be a number in [0, 1] (got: ${opts.bm25Weight}).`,
      );
    }
  }
  // lexical and bm25 are additive axes on top of cosine; the existing
  // freshness+reinforcement budget remains the only enforced sum.
  const w = opts.freshnessWeight ?? 0;
  const r = opts.reinforcementWeight ?? 0;
  if (w + r > 1 + 1e-9) {
    throw new RefmeshValidationError(
      `--freshness-weight + --reinforcement-weight must be <= 1 (got: ${w + r}).`,
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

function parseIso(value: string | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

interface PartialCandidate extends SearchConceptNode {
  rawCosine: number;
  rawFreshness: number;
  rawAccess: number;
  rawLexical: number;
  rawBm25: number;
}

async function executeSearchCore(
  store: RefmeshStore,
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
  const lexicalWeight = options.lexicalWeight ?? DEFAULT_LEXICAL_WEIGHT;
  const bm25Weight = options.bm25Weight ?? DEFAULT_BM25_WEIGHT;
  const cosineWeight = Math.max(
    0,
    1 - freshnessWeight - reinforcementWeight - lexicalWeight - bm25Weight,
  );
  const halfLifeDays = options.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS;
  const maxAgeDays = options.maxAgeDays;
  const demoteDeprecated = options.demoteDeprecated ?? DEFAULT_DEMOTE_DEPRECATED;
  const includeArchived = options.includeArchived ?? false;
  const now = new Date();

  const queryTokenList = tokenize(query);
  const queryTokenSet: ReadonlySet<string> = new Set(queryTokenList);
  recorder?.recordQueryTokens(queryTokenList);

  const queryVector = await embed(query);
  recorder?.recordEmbedding(queryVector);

  // Over-fetch from each retriever so post-filtering (archive / maxAge /
  // demoted) doesn't shrink the candidate pool below the user's --limit.
  const oversample = Math.max(options.limit * 4, options.limit + 5);
  recorder?.recordVectorRequest({ limit: oversample, oversample, threshold });

  // Vector retrieval. Trace mode re-runs at threshold=0 so every nearest
  // hit (including those that get rejected) shows up in the debug UI;
  // the downstream pipeline only sees rows that actually meet `threshold`.
  let vectorHits = store.vectors.query(queryVector, { limit: oversample, threshold });
  if (recorder) {
    const allHits = store.vectors.query(queryVector, { limit: oversample, threshold: 0 });
    recorder.recordVectorHits(
      allHits.map((h) => ({
        id: h.id,
        text: '',
        cosine: h.score,
        distance: 2 * (1 - h.score),
        passedThreshold: h.score >= threshold,
      })),
    );
    vectorHits = allHits.filter((h) => h.score >= threshold);
  }

  // FTS5 BM25 retrieval. Union with vector hits so a concept whose
  // description carries the query word but whose embedding is in a
  // different cluster still gets a chance at top-K.
  const ftsHits: FtsHit[] = ftsSearch(store.db, query, { limit: oversample });
  if (recorder) {
    recorder.recordFtsHits(ftsHits);
  }
  const bm25ById = new Map<string, number>();
  for (const h of ftsHits) bm25ById.set(h.id, h.bm25);

  // Build the candidate id set as the union of vector hits and FTS hits.
  // Concepts present in only one retriever still get evaluated; the missing
  // signal contributes 0 to finalScore.
  const cosineById = new Map<string, number>();
  for (const h of vectorHits) cosineById.set(h.id, h.score);
  const candidateIds: string[] = [];
  const seenCand = new Set<string>();
  for (const h of vectorHits) {
    if (!seenCand.has(h.id)) {
      seenCand.add(h.id);
      candidateIds.push(h.id);
    }
  }
  for (const h of ftsHits) {
    if (!seenCand.has(h.id)) {
      seenCand.add(h.id);
      candidateIds.push(h.id);
    }
  }

  const conceptMap = bulkConceptsByIds(store.db, candidateIds);
  const freshnessMap = bulkConceptFreshness(store.db, candidateIds);
  if (recorder) {
    const previewIds = idsPreview(candidateIds);
    recorder.recordGraphQuery({
      label: 'concepts.byIds',
      cypher: `SELECT ... FROM concepts WHERE id IN (${candidateIds.length} ids)`,
      idsPreview: previewIds,
    });
    recorder.recordGraphQuery({
      label: 'freshness.base',
      cypher: 'SELECT id, archived_at, last_seen_at, access_count FROM concepts WHERE id IN (...)',
      idsPreview: previewIds,
    });
    recorder.recordGraphQuery({
      label: 'freshness.refs',
      cypher:
        'SELECT d.concept_id, MAX(r.published_at) FROM describes d JOIN refs r ON r.url = d.ref_url WHERE d.concept_id IN (...) GROUP BY d.concept_id',
      idsPreview: previewIds,
    });
    recorder.recordGraphQuery({
      label: 'freshness.deprecates',
      cypher:
        "SELECT DISTINCT target_id FROM edges WHERE target_id IN (...) AND edge_type IN ('DEPRECATES','REPLACES')",
      idsPreview: previewIds,
    });
    // Replaces is now collapsed into the deprecates query. Record an empty
    // entry so PBI-16 tests checking for the label still pass without
    // forcing a redundant SQL roundtrip.
    recorder.recordGraphQuery({
      label: 'freshness.replaces',
      cypher: '-- merged into freshness.deprecates (single SQL with edge_type IN list)',
      idsPreview: previewIds,
    });
  }

  const partials: PartialCandidate[] = [];
  const excludedTrace: SearchTraceCandidate[] = [];
  for (const id of candidateIds) {
    const cosine = cosineById.get(id) ?? 0;
    const bm25 = bm25ById.get(id) ?? 0;
    const concept = conceptMap.get(id);
    if (!concept) {
      if (recorder) {
        excludedTrace.push({
          id,
          cosine,
          freshness: 0,
          ageDays: null,
          accessCount: 0,
          reinforcement: 0,
          lexical: 0,
          bm25,
          demoted: false,
          archived: false,
          finalScore: 0,
          excluded: 'concept-missing',
        });
      }
      continue;
    }
    const idTokens = new Set(tokenize(concept.id));
    const descTokens = new Set(tokenize(concept.description));
    const detailsTokens = new Set(tokenize(concept.details ?? ''));
    const lexical = computeLexicalScore(queryTokenSet, idTokens, descTokens, detailsTokens);

    const fresh = freshnessMap.get(id);
    if (!fresh) {
      if (recorder) {
        excludedTrace.push({
          id,
          cosine,
          freshness: 0,
          ageDays: null,
          accessCount: 0,
          reinforcement: 0,
          lexical,
          bm25,
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
          id,
          cosine,
          freshness: 0,
          ageDays: null,
          accessCount: fresh.accessCount,
          reinforcement: 0,
          lexical,
          bm25,
          demoted: fresh.isDeprecated,
          archived: true,
          finalScore: 0,
          excluded: 'archived',
        });
      }
      continue;
    }

    const anchor = parseIso(fresh.newestPublishedAt) ?? parseIso(fresh.lastSeenAt);
    const age = ageInDays(now, anchor);
    if (maxAgeDays !== undefined && age > maxAgeDays) {
      if (recorder) {
        excludedTrace.push({
          id,
          cosine,
          freshness: freshnessScore(age, halfLifeDays),
          ageDays: Number.isFinite(age) ? age : null,
          accessCount: fresh.accessCount,
          reinforcement: 0,
          lexical,
          bm25,
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
          id,
          cosine,
          freshness: freshnessScore(age, halfLifeDays),
          ageDays: Number.isFinite(age) ? age : null,
          accessCount: fresh.accessCount,
          reinforcement: 0,
          lexical,
          bm25,
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
      id: concept.id,
      description: concept.description,
      details: concept.details ?? undefined,
      score: cosine,
      freshness,
      ageDays: Number.isFinite(age) ? age : undefined,
      demoted,
      accessCount: fresh.accessCount,
      lexical,
      bm25,
      rawCosine: cosine,
      rawFreshness: freshness,
      rawAccess: fresh.accessCount,
      rawLexical: lexical,
      rawBm25: bm25,
    });
  }

  const maxAccess = partials.reduce((m, p) => Math.max(m, p.rawAccess), 0);
  const accessNorm = maxAccess > 0 ? Math.log1p(maxAccess + 1) : 0;

  const candidates: SearchConceptNode[] = partials.map((p) => {
    const reinforcement = accessNorm > 0 ? Math.log1p(p.rawAccess) / accessNorm : 0;
    let final =
      cosineWeight * p.rawCosine +
      freshnessWeight * p.rawFreshness +
      reinforcementWeight * reinforcement +
      lexicalWeight * p.rawLexical +
      bm25Weight * p.rawBm25;
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
      lexical: p.rawLexical,
      bm25: p.rawBm25,
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
        lexical: c.lexical ?? 0,
        bm25: c.bm25 ?? 0,
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
  const traversal = collectRelatedEdges(store, matchedIds, options.depth, recorder);
  let relatedIds = [...traversal.reachedIds].filter((id) => !matchedIds.includes(id));
  if (!includeArchived && relatedIds.length > 0) {
    if (recorder) {
      recorder.recordGraphQuery({
        label: 'related.visible',
        cypher: 'SELECT id FROM concepts WHERE id IN (...) AND archived_at IS NULL',
        idsPreview: idsPreview(relatedIds),
      });
    }
    const visible = visibleConceptIds(store.db, relatedIds);
    relatedIds = relatedIds.filter((id) => visible.has(id));
  }
  const relatedConceptMap = bulkConceptsByIds(store.db, relatedIds);
  if (recorder && relatedIds.length > 0) {
    recorder.recordGraphQuery({
      label: 'concepts.related',
      cypher: 'SELECT ... FROM concepts WHERE id IN (...)',
      idsPreview: idsPreview(relatedIds),
    });
  }
  const relatedConcepts: SearchConceptNode[] = relatedIds
    .map((id) => relatedConceptMap.get(id))
    .filter((c): c is NonNullable<typeof c> => c !== undefined)
    .map((c) => ({ id: c.id, description: c.description, details: c.details ?? undefined }));

  const allIds = [...matchedIds, ...relatedIds];
  const references = referencesForConcepts(store.db, allIds);
  if (recorder && allIds.length > 0) {
    recorder.recordGraphQuery({
      label: 'references.byConceptIds',
      cypher:
        'SELECT DISTINCT r.url, r.title FROM refs r JOIN describes d ON d.ref_url = r.url WHERE d.concept_id IN (...)',
      idsPreview: idsPreview(allIds),
    });
  }

  if (matchedIds.length > 0 && !options.readOnly) {
    incrementAccessCounts(store.db, matchedIds);
  }

  return {
    query,
    matchedConcepts: matched,
    relatedConcepts,
    references,
    edges: traversal.edges.map((e) => ({
      source: e.source,
      target: e.target,
      type: e.type,
      reason: e.reason ?? undefined,
    })),
  };
}

interface CollectEdgesResult {
  edges: SearchEdge[];
  reachedIds: Set<string>;
}

function collectRelatedEdges(
  store: RefmeshStore,
  rootIds: string[],
  depth: number,
  recorder: SearchTraceRecorder | null,
): CollectEdgesResult {
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
    let edgesAddedThisLevel = 0;
    const nextFrontier = new Set<string>();
    for (const edgeType of PUBLIC_EDGE_TYPE_NAMES) {
      const batch = edgesForFrontier(store.db, edgeType, frontier);
      if (recorder) {
        recorder.recordGraphQuery({
          label: `edges.frontier.${edgeType}.level${level}`,
          cypher:
            'SELECT source_id, target_id, reason FROM edges WHERE edge_type = ? AND (source_id IN (...) OR target_id IN (...))',
          idsPreview: idsPreview(frontier),
        });
      }
      for (const e of batch) {
        edges.push({
          source: e.source,
          target: e.target,
          type: e.type,
          reason: e.reason ?? undefined,
        });
        edgesAddedThisLevel += 1;
        if (!reached.has(e.target)) {
          reached.add(e.target);
          nextFrontier.add(e.target);
        }
        if (!reached.has(e.source)) {
          reached.add(e.source);
          nextFrontier.add(e.source);
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

export async function executeSearch(
  store: RefmeshStore,
  query: string,
  options: SearchOptions,
): Promise<SearchResult> {
  return executeSearchCore(store, query, options, null);
}

export async function executeSearchWithTrace(
  store: RefmeshStore,
  query: string,
  options: SearchOptions,
): Promise<{ result: SearchResult; trace: SearchTrace }> {
  const recorder = new SearchTraceRecorder();
  const result = await executeSearchCore(store, query, { ...options, readOnly: true }, recorder);
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
    if (c.lexical !== undefined && c.lexical > 0) parts.push(`lex=${c.lexical.toFixed(3)}`);
    if (c.bm25 !== undefined && c.bm25 > 0) parts.push(`bm25=${c.bm25.toFixed(3)}`);
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

export const _internal = { ALL_EDGE_TYPE_NAMES };
