import type Database from 'better-sqlite3';

export interface FtsHit {
  id: string;
  // bm25() returns a *negative* score (the more negative, the better). We
  // expose the raw value here so callers (Search Debug trace) can show it
  // verbatim.
  rawRank: number;
  // Same hit normalised into [0, 1] using min/max across the candidate set
  // so it slots into the cosine-shaped scoring axis. Computed once after
  // collecting all hits.
  bm25: number;
}

export interface FtsQueryOptions {
  limit: number;
}

// FTS5 MATCH treats double-quoted strings as phrase tokens with all the
// special syntax (NEAR, OR, parentheses, AND, NOT, column filters) disabled.
// We always wrap each whitespace-split term in double quotes so user input
// like `kuzu OR sqlite` is searched literally rather than parsed as the
// FTS5 OR operator. Internal `"` becomes `""` per FTS5 quoting rules.
export function buildFtsMatchQuery(rawQuery: string): string {
  const terms = rawQuery
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (terms.length === 0) return '';
  return terms.map((t) => `"${t.replaceAll('"', '""')}"`).join(' OR ');
}

// Run an FTS5 MATCH and return [0, 1]-normalised BM25 scores. Column weights
// favour `id` first, then `description`, then `details`, mirroring how a
// human would prioritise these fields when skimming a graph.
export function ftsSearch(
  db: Database.Database,
  rawQuery: string,
  options: FtsQueryOptions,
): FtsHit[] {
  const match = buildFtsMatchQuery(rawQuery);
  if (match.length === 0) return [];
  const rows = db
    .prepare<[string, number]>(
      `SELECT c.id AS id, bm25(concepts_fts, 3.0, 1.0, 0.5) AS rank
         FROM concepts_fts
         JOIN concepts c ON c.rowid = concepts_fts.rowid
        WHERE concepts_fts MATCH ?
        ORDER BY rank
        LIMIT ?`,
    )
    .all(match, Math.max(1, Math.floor(options.limit))) as Array<{
    id: string;
    rank: number;
  }>;
  if (rows.length === 0) return [];

  // bm25(): more negative = better. Negate to get a positive "goodness", then
  // min-max normalise into [0, 1]. With a single hit we map it to 1.0.
  const goodness = rows.map((r) => -r.rank);
  let min = goodness[0] ?? 0;
  let max = goodness[0] ?? 0;
  for (const g of goodness) {
    if (g < min) min = g;
    if (g > max) max = g;
  }
  const range = max - min;
  return rows.map((r, i) => {
    const g = goodness[i] ?? 0;
    const bm25 = range > 0 ? (g - min) / range : 1;
    return { id: r.id, rawRank: r.rank, bm25 };
  });
}
