import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { executeRegister, parseAndValidate } from '../src/commands/register.js';
import { executeSearch, executeSearchWithTrace, tokenize } from '../src/commands/search.js';
import { type RefmeshStore, openStore } from '../src/db/store.js';
import { RefmeshValidationError } from '../src/util/errors.js';

function payload(refUrl: string, concepts: { id: string; description: string }[]) {
  return JSON.stringify({
    reference: { url: refUrl, title: `doc ${refUrl}` },
    concepts,
    relationships: [],
  });
}

describe('tokenize (PBI-17)', () => {
  it('splits on whitespace and id-style separators', () => {
    expect(new Set(tokenize('Google Kubernetes Engine'))).toEqual(
      new Set(['google', 'kubernetes', 'engine']),
    );
    expect(new Set(tokenize('kube_proxy-config.yaml'))).toEqual(
      new Set(['kube', 'proxy', 'config', 'yaml']),
    );
    expect(new Set(tokenize('a/b:c'))).toEqual(new Set(['a', 'b', 'c']));
  });

  it('breaks on camelCase / PascalCase boundaries', () => {
    expect(new Set(tokenize('GoogleKubernetes'))).toEqual(new Set(['google', 'kubernetes']));
    expect(new Set(tokenize('useState'))).toEqual(new Set(['use', 'state']));
    expect(new Set(tokenize('HTTPServer'))).toEqual(new Set(['http', 'server']));
  });

  it('lower-cases every token', () => {
    expect(tokenize('FOO BAR')).toEqual(['foo', 'bar']);
  });

  it('returns an empty array on empty input', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('   ')).toEqual([]);
  });
});

describe('search lexical boost integration (PBI-17)', () => {
  let tempDir: string;
  let store: RefmeshStore;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'refmesh-lex-'));
    store = openStore({ dbPath: join(tempDir, 'refmesh.db') });
  });

  afterAll(async () => {
    try {
      store.close();
    } catch {
      // ignore
    }
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  beforeEach(async () => {
    await store.db.exec('DELETE FROM concepts; DELETE FROM refs;');
    store.vectors.clearAll();
  });

  // Case A from PBI-17: the failing real-world example.
  it('keeps "Google Block Storage" out of the top results when searching "Kubernetes"', async () => {
    await executeRegister(
      store,
      parseAndValidate(
        payload('https://example.com/gcp', [
          {
            id: 'Google Kubernetes Engine',
            description: 'managed Kubernetes service on Google Cloud',
          },
          {
            id: 'Google Kubernetes Engine Network',
            description: 'networking layer for managed Kubernetes service on Google Cloud',
          },
          {
            id: 'Google Block Storage',
            description: 'persistent block storage for virtual machines on Google Cloud',
          },
        ]),
      ),
    );

    const result = await executeSearch(store, 'Kubernetes', {
      depth: 0,
      limit: 3,
      threshold: 0,
      format: 'json',
    });
    const top2 = result.matchedConcepts.slice(0, 2).map((c) => c.id);
    expect(top2).not.toContain('Google Block Storage');
    expect(top2).toContain('Google Kubernetes Engine');
    // Both Kubernetes-bearing concepts should be among the top 2 hits.
    expect(top2).toContain('Google Kubernetes Engine Network');
  });

  // Case B: lexicalWeight=0 must restore the pre-PBI behaviour byte-for-byte
  // for the lexical contribution. We verify this by checking that
  // finalScore == cosineWeight*cosine for a freshness/reinforcement-free
  // search (with lexicalWeight=0 forcing cosineWeight back to 1).
  it('lexicalWeight=0 disables the lexical contribution to finalScore', async () => {
    await executeRegister(
      store,
      parseAndValidate(
        payload('https://example.com/zero', [
          { id: 'Foo', description: 'totally unrelated subject' },
          { id: 'Bar', description: 'another unrelated subject' },
        ]),
      ),
    );

    const result = await executeSearch(store, 'subject', {
      depth: 0,
      limit: 5,
      threshold: 0,
      lexicalWeight: 0,
      bm25Weight: 0,
      format: 'json',
    });
    for (const hit of result.matchedConcepts) {
      // With every boost axis at 0, cosineWeight collapses to 1, so finalScore
      // must equal cosine (a.k.a. score) within float tolerance.
      expect(Math.abs((hit.finalScore ?? 0) - (hit.score ?? 0))).toBeLessThan(1e-9);
    }
  });

  // Case C: a concept that shares no token with the query gets lexical=0.
  it('lexical score is zero when no query token appears in id/description/details', async () => {
    await executeRegister(
      store,
      parseAndValidate(
        payload('https://example.com/disjoint', [
          { id: 'Foo', description: 'volcano basalt magma lithography' },
        ]),
      ),
    );
    const { result } = await executeSearchWithTrace(store, 'kubernetes', {
      depth: 0,
      limit: 5,
      threshold: 0,
      format: 'json',
    });
    const foo = result.matchedConcepts.find((c) => c.id === 'Foo');
    expect(foo?.lexical ?? 0).toBe(0);
  });

  // Case D: lexicalWeight=1 zeroes finalScore for any concept missing the
  // query token entirely (cosineWeight collapses to 0 and lexical itself is 0).
  it('lexicalWeight=1 makes finalScore=0 for concepts without any token overlap', async () => {
    await executeRegister(
      store,
      parseAndValidate(
        payload('https://example.com/lex1', [
          { id: 'Hit', description: 'kubernetes pod scheduler' },
          { id: 'Miss', description: 'volcano basalt magma' },
        ]),
      ),
    );
    const result = await executeSearch(store, 'kubernetes', {
      depth: 0,
      limit: 5,
      threshold: 0,
      lexicalWeight: 1,
      format: 'json',
    });
    const miss = result.matchedConcepts.find((c) => c.id === 'Miss');
    if (miss) {
      expect(miss.finalScore).toBeCloseTo(0, 9);
    }
    const hit = result.matchedConcepts.find((c) => c.id === 'Hit');
    expect(hit).toBeDefined();
    expect((hit?.finalScore ?? 0) > 0).toBe(true);
  });

  it('rejects --lexical-weight outside [0, 1]', async () => {
    await expect(
      executeSearch(store, 'q', {
        depth: 0,
        limit: 5,
        lexicalWeight: -0.1,
        format: 'json',
      }),
    ).rejects.toBeInstanceOf(RefmeshValidationError);
    await expect(
      executeSearch(store, 'q', {
        depth: 0,
        limit: 5,
        lexicalWeight: 1.5,
        format: 'json',
      }),
    ).rejects.toBeInstanceOf(RefmeshValidationError);
  });

  it('trace surfaces queryTokens and per-candidate lexical', async () => {
    await executeRegister(
      store,
      parseAndValidate(
        payload('https://example.com/trace', [
          { id: 'Google Kubernetes Engine', description: 'managed kubernetes service' },
          { id: 'Google Block Storage', description: 'persistent block storage' },
        ]),
      ),
    );
    const { trace } = await executeSearchWithTrace(store, 'Kubernetes', {
      depth: 0,
      limit: 5,
      threshold: 0,
      format: 'json',
    });
    expect(trace.queryTokens).toContain('kubernetes');
    const gke = trace.candidates.find((c) => c.id === 'Google Kubernetes Engine');
    const gbs = trace.candidates.find((c) => c.id === 'Google Block Storage');
    expect(gke?.lexical).toBeGreaterThan(0);
    expect(gbs?.lexical ?? 0).toBe(0);
  });

  // PBI-18 Phase 6: BM25 must surface concepts that the vector retriever
  // would otherwise rank below noise. We pin a long, distinctive descriptor
  // word ("Crystallographic") that the embedding model treats as semantic
  // noise but FTS5 picks up exactly.
  it('FTS5 BM25 promotes description-only matches that vector search misses', async () => {
    await executeRegister(
      store,
      parseAndValidate(
        payload('https://example.com/bm25', [
          {
            id: 'AlphaUnrelated',
            description: 'shopping cart checkout flow',
          },
          {
            id: 'BetaUnrelated',
            description: 'kitchen recipe ingredient list',
          },
          {
            id: 'GammaTarget',
            description: 'Crystallographic symmetry analysis pipeline',
          },
        ]),
      ),
    );
    const { trace } = await executeSearchWithTrace(store, 'Crystallographic', {
      depth: 0,
      limit: 5,
      threshold: 0,
      // Lean entirely on bm25 so we know the win comes from FTS5, not cosine.
      lexicalWeight: 0,
      bm25Weight: 1,
      format: 'json',
    });
    const gamma = trace.candidates.find((c) => c.id === 'GammaTarget');
    expect(gamma?.bm25).toBeGreaterThan(0);
    expect(gamma?.finalScore).toBeGreaterThan(0);
    // Concepts without the term must register zero BM25.
    const alpha = trace.candidates.find((c) => c.id === 'AlphaUnrelated');
    expect(alpha?.bm25 ?? 0).toBe(0);
  });

  // PBI-18 Phase 6: candidate set is the union of vector and FTS hits, so
  // a concept that only one retriever finds still gets evaluated. We force
  // the situation by inflating oversample (limit large enough that both
  // retrievers reach all rows) and check that a concept missing from one
  // side still shows up in the trace's candidate list.
  it('hybrid candidate set includes ids reached by either retriever alone', async () => {
    await executeRegister(
      store,
      parseAndValidate(
        payload('https://example.com/union', [
          {
            id: 'TextOnlyMatch',
            description: 'Crystallographic symmetry detail buried in description',
          },
          {
            id: 'VectorOnlyNeighbour',
            description: 'shopping cart checkout flow',
          },
        ]),
      ),
    );
    const { trace } = await executeSearchWithTrace(store, 'Crystallographic', {
      depth: 0,
      limit: 10,
      threshold: 0,
      format: 'json',
    });
    const ids = new Set(trace.candidates.map((c) => c.id));
    expect(ids.has('TextOnlyMatch')).toBe(true);
    expect(ids.has('VectorOnlyNeighbour')).toBe(true);
  });

  // PBI-18 Phase 6: WAL mode must be active so concurrent reads don't
  // block on the writer. PRAGMA journal_mode returns the active mode as
  // its result row.
  it('opens the database in WAL journal mode', () => {
    const mode = store.db.pragma('journal_mode', { simple: true });
    expect(String(mode).toLowerCase()).toBe('wal');
  });

  // PBI-18 Phase 6: a register that throws mid-flight must roll back
  // concepts/refs/edges *and* leave the in-memory vector index untouched.
  // We trigger a CHECK violation by smuggling an invalid edge_type past the
  // schema validator (which only blocks public-edge types, not the schema
  // CHECK list — so we pre-validate, then mutate the input post-validation
  // to simulate a class of bug we want never to leak partial state).
  it('rolls back register on transactional failure (no orphan rows or vectors)', async () => {
    // Pre-condition: empty store.
    expect(store.vectors.countAll()).toBe(0);

    const valid = parseAndValidate(
      JSON.stringify({
        reference: { url: 'https://example.com/rollback', title: 'rollback test' },
        concepts: [{ id: 'WillFail', description: 'rollback target' }],
        relationships: [],
      }),
    );
    // Bypass the upfront validateRelationshipTypes by injecting after the
    // fact. The CHECK constraint on edges.edge_type fires inside the
    // transaction, and better-sqlite3 then rolls everything back.
    (
      valid.relationships as { source: string; target: string; type: string; reason: string }[]
    ).push({
      source: 'WillFail',
      target: 'WillFail',
      type: 'NOT_A_REAL_EDGE_TYPE',
      reason: 'oops',
    });

    await expect(executeRegister(store, valid)).rejects.toThrow();

    // No row should have made it into any table.
    const conceptRow = store.db
      .prepare<[string]>('SELECT 1 AS one FROM concepts WHERE id = ?')
      .get('WillFail');
    expect(conceptRow).toBeUndefined();
    const refRow = store.db
      .prepare<[string]>('SELECT 1 AS one FROM refs WHERE url = ?')
      .get('https://example.com/rollback');
    expect(refRow).toBeUndefined();
    // And the in-memory vector index must NOT carry a phantom entry.
    expect(store.vectors.countAll()).toBe(0);
  });
});
