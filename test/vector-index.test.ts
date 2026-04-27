import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type RefmeshStore, openStore } from '../src/db/store.js';
import { EMBEDDING_DIMENSION } from '../src/embedding/embedder.js';

function makeUnitVector(nonzero: number, value = 1): number[] {
  const v = new Array<number>(EMBEDDING_DIMENSION).fill(0);
  v[nonzero % EMBEDDING_DIMENSION] = value;
  return v;
}

// We need real Concept rows for the FK on concept_vectors. Insert minimal
// stubs straight through the DB so the vector-index tests stay focused on
// the index itself rather than dragging the whole register pipeline in.
function seedConcept(store: RefmeshStore, id: string): void {
  const now = new Date().toISOString();
  store.db
    .prepare<[string, string, string, string]>(
      `INSERT OR REPLACE INTO concepts
        (id, description, details, first_seen_at, last_seen_at, touch_count, access_count)
        VALUES (?, ?, '', ?, ?, 1, 0)`,
    )
    .run(id, `desc ${id}`, now, now);
}

describe('vector-index (in-memory + SQLite-backed)', () => {
  let tempDir: string;
  let store: RefmeshStore;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'refmesh-vec-'));
    store = openStore({ dbPath: join(tempDir, 'refmesh.db') });
  });

  afterAll(() => {
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

  beforeEach(() => {
    store.db.exec('DELETE FROM concepts;');
    store.vectors.clearAll();
  });

  it('round-trips upsert -> query -> delete -> count', () => {
    seedConcept(store, 'a');
    seedConcept(store, 'b');
    store.vectors.upsert([
      { id: 'a', vector: makeUnitVector(0) },
      { id: 'b', vector: makeUnitVector(1) },
    ]);
    expect(store.vectors.countAll()).toBe(2);

    const hits = store.vectors.query(makeUnitVector(0), { limit: 5, threshold: 0.0 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.id).toBe('a');
    expect(hits[0]?.score).toBeGreaterThan(0.9);

    for (let i = 1; i < hits.length; i += 1) {
      expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score);
    }

    store.vectors.delete('a');
    expect(store.vectors.countAll()).toBe(1);
  });

  it('upsert replaces existing rows (id PK on concept_vectors)', () => {
    seedConcept(store, 'x');
    store.vectors.upsert([{ id: 'x', vector: makeUnitVector(0) }]);
    expect(store.vectors.countAll()).toBe(1);

    store.vectors.upsert([{ id: 'x', vector: makeUnitVector(3) }]);
    expect(store.vectors.countAll()).toBe(1);

    const hits = store.vectors.query(makeUnitVector(3), { limit: 5, threshold: 0.0 });
    expect(hits[0]?.id).toBe('x');
    expect(hits[0]?.score).toBeGreaterThan(0.9);
  });

  it('applies threshold to filter low-similarity hits', () => {
    seedConcept(store, 'a');
    seedConcept(store, 'b');
    store.vectors.upsert([
      { id: 'a', vector: makeUnitVector(0) },
      { id: 'b', vector: makeUnitVector(1) },
    ]);
    // basis-0 vs basis-1 → orthogonal → cosine = 0 → filtered by threshold > 0.
    const hits = store.vectors.query(makeUnitVector(0), { limit: 5, threshold: 0.99 });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.id).toBe('a');
  });

  it('empty index returns no hits without error', () => {
    const hits = store.vectors.query(makeUnitVector(0), { limit: 5, threshold: 0.0 });
    expect(hits).toEqual([]);
  });

  it('rejects vectors with wrong dimension', () => {
    seedConcept(store, 'bad');
    expect(() => store.vectors.upsert([{ id: 'bad', vector: [0.1, 0.2, 0.3] }])).toThrow();
  });

  it('reloads vectors from SQLite on store re-open', () => {
    seedConcept(store, 'persist');
    store.vectors.upsert([{ id: 'persist', vector: makeUnitVector(0) }]);
    expect(store.vectors.countAll()).toBe(1);
    // Re-opening the same DB file must re-hydrate the in-memory map.
    store.close();
    const reopened = openStore({ dbPath: store.path });
    expect(reopened.vectors.countAll()).toBe(1);
    const hits = reopened.vectors.query(makeUnitVector(0), { limit: 1, threshold: 0 });
    expect(hits[0]?.id).toBe('persist');
    reopened.close();
    // Re-open once more so afterAll's close() targets a live handle.
    store = openStore({ dbPath: join(tempDir, 'refmesh.db') });
  });
});
