import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type VectorStore, openVectorStore } from '../src/db/vector-store.js';
import { EMBEDDING_DIMENSION } from '../src/embedding/embedder.js';

function makeUnitVector(nonzero: number, value = 1): number[] {
  const v = new Array<number>(EMBEDDING_DIMENSION).fill(0);
  v[nonzero % EMBEDDING_DIMENSION] = value;
  return v;
}

describe('vector-store (LanceDB)', () => {
  let tempDir: string;
  let store: VectorStore;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'refmesh-vec-'));
    store = await openVectorStore(join(tempDir, 'vectors.lance'));
  });

  afterAll(async () => {
    try {
      await store.close();
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
    await store.clearAll();
  });

  it('round-trips upsert -> query -> delete -> count', async () => {
    const a = { id: 'a', text: 'alpha', vector: makeUnitVector(0) };
    const b = { id: 'b', text: 'beta', vector: makeUnitVector(1) };
    await store.upsert([a, b]);
    expect(await store.countAll()).toBe(2);

    const hits = await store.queryByVector(makeUnitVector(0), { limit: 5, threshold: 0.0 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.id).toBe('a');
    expect(hits[0]?.score).toBeGreaterThan(0.9);

    // scores are sorted descending.
    for (let i = 1; i < hits.length; i += 1) {
      expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score);
    }

    await store.deleteById('a');
    expect(await store.countAll()).toBe(1);
  });

  it('upsert updates existing rows (mergeInsert on id)', async () => {
    await store.upsert([{ id: 'x', text: 'v1', vector: makeUnitVector(0) }]);
    expect(await store.countAll()).toBe(1);

    await store.upsert([{ id: 'x', text: 'v2', vector: makeUnitVector(3) }]);
    expect(await store.countAll()).toBe(1);

    const hits = await store.queryByVector(makeUnitVector(3), { limit: 5, threshold: 0.0 });
    expect(hits[0]?.id).toBe('x');
    expect(hits[0]?.text).toBe('v2');
  });

  it('applies threshold to filter low-similarity hits', async () => {
    await store.upsert([
      { id: 'a', text: 'alpha', vector: makeUnitVector(0) },
      { id: 'b', text: 'beta', vector: makeUnitVector(1) },
    ]);
    // Query vector points along basis 0 → identical to 'a', orthogonal to 'b'.
    // Orthogonal cosine distance = 1 → similarity = 0.5 (after [0,1] mapping).
    const hits = await store.queryByVector(makeUnitVector(0), { limit: 5, threshold: 0.99 });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.id).toBe('a');
  });

  it('empty store returns no hits without error', async () => {
    const hits = await store.queryByVector(makeUnitVector(0), { limit: 5, threshold: 0.0 });
    expect(hits).toEqual([]);
  });

  it('rejects vectors with wrong dimension', async () => {
    await expect(
      store.upsert([{ id: 'bad', text: 't', vector: [0.1, 0.2, 0.3] }]),
    ).rejects.toThrow();
  });
});
