import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { executeArchive } from '../src/commands/archive.js';
import { executeRegister, parseAndValidate } from '../src/commands/register.js';
import { executeSearchWithTrace } from '../src/commands/search.js';
import { type RefmeshStore, openStore } from '../src/db/store.js';
import { EMBEDDING_DIMENSION } from '../src/embedding/embedder.js';

function payload(
  refUrl: string,
  concepts: { id: string; description: string; details?: string }[],
  rels: { source: string; target: string; type: string; reason: string }[] = [],
) {
  return JSON.stringify({
    reference: { url: refUrl, title: `doc at ${refUrl}` },
    concepts,
    relationships: rels,
  });
}

describe('executeSearchWithTrace', () => {
  let tempDir: string;
  let store: RefmeshStore;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'refmesh-trace-'));
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

  it('captures the query embedding shape', async () => {
    await executeRegister(
      store,
      parseAndValidate(
        payload('https://example.com/embed', [{ id: 'Alpha', description: 'first concept' }]),
      ),
    );
    const { trace } = await executeSearchWithTrace(store, 'first concept', {
      depth: 0,
      limit: 5,
      threshold: 0,
      format: 'json',
    });
    expect(trace.queryEmbedding.dim).toBe(EMBEDDING_DIMENSION);
    expect(trace.queryEmbedding.preview).toHaveLength(8);
    expect(trace.queryEmbedding.full).toHaveLength(EMBEDDING_DIMENSION);
    // mean-pooled, normalize: true → unit vector → L2 norm ≈ 1.
    expect(trace.queryEmbedding.l2Norm).toBeGreaterThan(0.99);
    expect(trace.queryEmbedding.l2Norm).toBeLessThan(1.01);
  });

  it('records vectorHits including rejected entries that fall below threshold', async () => {
    await executeRegister(
      store,
      parseAndValidate(
        payload('https://example.com/threshold', [
          { id: 'CloseMatch', description: 'a wonderful unique sample concept' },
          { id: 'NoiseOne', description: 'gear ratio bicycle pedal cadence' },
          { id: 'NoiseTwo', description: 'volcano basalt magma lithography' },
        ]),
      ),
    );
    // Pin the threshold so the unrelated concepts are returned by lance but
    // rejected by the cosine cut. The trace must still surface them.
    const { trace } = await executeSearchWithTrace(store, 'a wonderful unique sample concept', {
      depth: 0,
      limit: 5,
      threshold: 0.6,
      format: 'json',
    });

    expect(trace.vectorRequest.threshold).toBe(0.6);
    expect(trace.vectorHits.length).toBeGreaterThanOrEqual(2);
    const rejected = trace.vectorHits.filter((h) => !h.passedThreshold);
    const passed = trace.vectorHits.filter((h) => h.passedThreshold);
    expect(rejected.length).toBeGreaterThan(0);
    expect(passed.length).toBeGreaterThan(0);
    // distance and cosine must be self-consistent: distance = 2 * (1 - cosine).
    for (const hit of trace.vectorHits) {
      expect(hit.distance).toBeCloseTo(2 * (1 - hit.cosine), 5);
    }
    // The most-related concept must score higher than any rejected hit.
    const closest = trace.vectorHits.find((h) => h.id === 'CloseMatch');
    expect(closest).toBeDefined();
    for (const r of rejected) {
      expect(closest!.cosine).toBeGreaterThan(r.cosine);
    }
  });

  it('includes concept / freshness / edge cyphers in graphQueries', async () => {
    await executeRegister(
      store,
      parseAndValidate(
        payload(
          'https://example.com/cypher',
          [
            { id: 'Root', description: 'root' },
            { id: 'Child', description: 'child' },
          ],
          [{ source: 'Root', target: 'Child', type: 'CONTAINS', reason: 'r-c' }],
        ),
      ),
    );
    const { trace } = await executeSearchWithTrace(store, 'root', {
      depth: 1,
      limit: 5,
      threshold: 0,
      format: 'json',
    });

    const labels = trace.graphQueries.map((q) => q.label);
    expect(labels).toContain('concepts.byIds');
    expect(labels).toContain('freshness.base');
    expect(labels).toContain('freshness.refs');
    expect(labels).toContain('freshness.deprecates');
    expect(labels).toContain('freshness.replaces');
    expect(labels.some((l) => l.startsWith('edges.frontier.CONTAINS.level'))).toBe(true);

    const conceptsCypher = trace.graphQueries.find((q) => q.label === 'concepts.byIds')?.cypher;
    // The trace now records SQL strings (PBI-18 migration). Labels stay
    // identical so the rest of the trace UI keeps working; the body just
    // mentions concepts/SELECT instead of MATCH/Cypher.
    expect(conceptsCypher).toContain('FROM concepts');
  });

  it('reports excluded candidates with their reason', async () => {
    await executeRegister(
      store,
      parseAndValidate(
        payload('https://example.com/excluded', [
          { id: 'KeepMe', description: 'visible target' },
          { id: 'GoneSoon', description: 'visible target' },
        ]),
      ),
    );
    await executeArchive(store, 'GoneSoon', { reason: 'old' });

    const { trace } = await executeSearchWithTrace(store, 'visible target', {
      depth: 0,
      limit: 5,
      threshold: 0,
      includeArchived: false,
      format: 'json',
    });

    const archivedCandidate = trace.candidates.find((c) => c.id === 'GoneSoon');
    expect(archivedCandidate).toBeDefined();
    expect(archivedCandidate?.excluded).toBe('archived');
    expect(archivedCandidate?.archived).toBe(true);

    const keptCandidate = trace.candidates.find((c) => c.id === 'KeepMe');
    expect(keptCandidate).toBeDefined();
    expect(keptCandidate?.excluded).toBeUndefined();
  });

  it('reports demoted-zero exclusions when demoteDeprecated=0 and a hit is deprecated', async () => {
    await executeRegister(
      store,
      parseAndValidate(
        payload(
          'https://example.com/depr',
          [
            { id: 'NewWay', description: 'forward-looking item' },
            { id: 'OldWay', description: 'forward-looking item' },
          ],
          [{ source: 'NewWay', target: 'OldWay', type: 'REPLACES', reason: 'replaced' }],
        ),
      ),
    );
    const { trace } = await executeSearchWithTrace(store, 'forward-looking item', {
      depth: 0,
      limit: 5,
      threshold: 0,
      demoteDeprecated: 0,
      format: 'json',
    });
    const old = trace.candidates.find((c) => c.id === 'OldWay');
    expect(old?.excluded).toBe('demoted-zero');
    expect(old?.demoted).toBe(true);
  });

  it('reports maxAge exclusion when the hit is older than the cutoff', async () => {
    // publishedAt 5 years ago — guaranteed older than 30 days.
    const oldIso = new Date(Date.now() - 1000 * 60 * 60 * 24 * 365 * 5).toISOString();
    await executeRegister(
      store,
      parseAndValidate(
        JSON.stringify({
          reference: {
            url: 'https://example.com/old',
            title: 'old',
            publishedAt: oldIso,
          },
          concepts: [{ id: 'StaleHit', description: 'aging knowledge' }],
          relationships: [],
        }),
      ),
    );
    const { trace } = await executeSearchWithTrace(store, 'aging knowledge', {
      depth: 0,
      limit: 5,
      threshold: 0,
      maxAgeDays: 30,
      format: 'json',
    });
    const stale = trace.candidates.find((c) => c.id === 'StaleHit');
    expect(stale?.excluded).toBe('maxAge');
  });

  it('produces traversal levels matching the requested depth', async () => {
    await executeRegister(
      store,
      parseAndValidate(
        payload(
          'https://example.com/depth',
          [
            { id: 'D0', description: 'origin' },
            { id: 'D1', description: 'level1' },
            { id: 'D2', description: 'level2' },
          ],
          [
            { source: 'D0', target: 'D1', type: 'CONTAINS', reason: '1' },
            { source: 'D1', target: 'D2', type: 'CONTAINS', reason: '2' },
          ],
        ),
      ),
    );

    const zero = await executeSearchWithTrace(store, 'origin', {
      depth: 0,
      limit: 5,
      threshold: 0,
      format: 'json',
    });
    expect(zero.trace.traversal.depth).toBe(0);
    expect(zero.trace.traversal.levels).toHaveLength(0);

    const two = await executeSearchWithTrace(store, 'origin', {
      depth: 2,
      limit: 5,
      threshold: 0,
      format: 'json',
    });
    expect(two.trace.traversal.depth).toBe(2);
    expect(two.trace.traversal.levels.length).toBeGreaterThan(0);
    expect(two.trace.traversal.levels.length).toBeLessThanOrEqual(2);
    for (const lvl of two.trace.traversal.levels) {
      expect(lvl.frontier.length).toBeGreaterThan(0);
    }
  });

  it('does not increment accessCount even when readOnly is left unset', async () => {
    await executeRegister(
      store,
      parseAndValidate(
        payload('https://example.com/ro-trace', [{ id: 'TraceTarget', description: 'noop side' }]),
      ),
    );
    await executeSearchWithTrace(store, 'noop side', {
      depth: 0,
      limit: 5,
      threshold: 0,
      format: 'json',
      // readOnly intentionally omitted; trace must still suppress the write.
    });
    const row = store.db
      .prepare("SELECT access_count AS n FROM concepts WHERE id = 'TraceTarget'")
      .get() as { n: number } | undefined;
    expect(row?.n ?? 0).toBe(0);
  });
});
