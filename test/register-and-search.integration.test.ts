import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { executeRegister, parseAndValidate } from '../src/commands/register.js';
import { executeSearch } from '../src/commands/search.js';
import { type RefmeshStore, openStore } from '../src/db/store.js';
import { RefmeshValidationError } from '../src/util/errors.js';

function payload(
  refUrl: string,
  concepts: { id: string; description: string; details?: string }[],
  rels: { source: string; target: string; type: string; reason: string }[],
) {
  return JSON.stringify({
    reference: { url: refUrl, title: `doc at ${refUrl}` },
    concepts,
    relationships: rels,
  });
}

describe('register + search integration', () => {
  let tempDir: string;
  let store: RefmeshStore;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'refmesh-test-'));
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
    // FK CASCADE flushes describes/edges/concept_vectors as concepts go.
    // refs is a separate root, so wipe it explicitly.
    store.db.exec('DELETE FROM concepts; DELETE FROM refs;');
    store.vectors.clearAll();
  });

  it('registers concepts and finds them by keyword', async () => {
    const input = parseAndValidate(
      payload(
        'https://example.com/hooks',
        [
          { id: 'useState', description: 'state hook', details: 'const [s, setS] = useState();' },
          { id: 'React Hooks', description: 'hooks umbrella' },
        ],
        [{ source: 'useState', target: 'React Hooks', type: 'PART_OF', reason: 'one of' }],
      ),
    );
    const summary = await executeRegister(store, input);
    expect(summary.conceptsUpserted).toBe(2);
    expect(summary.relationshipsByType.PART_OF).toBe(1);

    const result = await executeSearch(store, 'useState', {
      depth: 1,
      limit: 20,
      format: 'json',
    });
    const reachedIds = [
      ...result.matchedConcepts.map((c) => c.id),
      ...result.relatedConcepts.map((c) => c.id),
    ];
    expect(result.matchedConcepts.map((c) => c.id)).toContain('useState');
    expect(reachedIds).toContain('React Hooks');
    expect(result.edges.some((e) => e.type === 'PART_OF' && e.source === 'useState')).toBe(true);
    expect(result.references.some((r) => r.url === 'https://example.com/hooks')).toBe(true);
  });

  it('is idempotent on duplicate register (upsert semantics)', async () => {
    const raw = payload('https://example.com/a', [{ id: 'X', description: 'v1' }], []);
    await executeRegister(store, parseAndValidate(raw));
    const updatedRaw = payload(
      'https://example.com/a',
      [{ id: 'X', description: 'v2-updated' }],
      [],
    );
    await executeRegister(store, parseAndValidate(updatedRaw));

    const result = await executeSearch(store, 'X', { depth: 0, limit: 20, format: 'json' });
    const hit = result.matchedConcepts.find((c) => c.id === 'X');
    expect(hit?.description).toBe('v2-updated');
  });

  it('resolves external references to existing DB nodes', async () => {
    await executeRegister(
      store,
      parseAndValidate(
        payload(
          'https://example.com/existing',
          [{ id: 'Existing', description: 'pre-existing concept' }],
          [],
        ),
      ),
    );

    const input = parseAndValidate(
      payload(
        'https://example.com/new',
        [{ id: 'NewThing', description: 'new one' }],
        [{ source: 'NewThing', target: 'Existing', type: 'DEPENDS_ON', reason: 'needs it' }],
      ),
    );
    const summary = await executeRegister(store, input);
    expect(summary.relationshipsByType.DEPENDS_ON).toBe(1);

    const result = await executeSearch(store, 'NewThing', {
      depth: 1,
      limit: 20,
      format: 'json',
    });
    const reachedIds = [
      ...result.matchedConcepts.map((c) => c.id),
      ...result.relatedConcepts.map((c) => c.id),
    ];
    expect(reachedIds).toContain('Existing');
    expect(result.edges.some((e) => e.type === 'DEPENDS_ON' && e.target === 'Existing')).toBe(true);
  });

  it('rejects unresolved references that are neither in concepts[] nor in DB', async () => {
    const input = parseAndValidate(
      payload(
        'https://example.com/bad',
        [{ id: 'Solo', description: 'alone' }],
        [{ source: 'Solo', target: 'Ghost', type: 'RELATED_TO', reason: 'oops' }],
      ),
    );
    await expect(executeRegister(store, input)).rejects.toBeInstanceOf(RefmeshValidationError);
  });

  it('returns no results without error when keyword misses', async () => {
    const result = await executeSearch(store, 'definitely-not-present', {
      depth: 1,
      limit: 20,
      format: 'json',
    });
    expect(result.matchedConcepts).toHaveLength(0);
    expect(result.relatedConcepts).toHaveLength(0);
  });

  it('respects --depth 0 (no traversal)', async () => {
    await executeRegister(
      store,
      parseAndValidate(
        payload(
          'https://example.com/d',
          [
            { id: 'Root', description: 'root' },
            { id: 'Leaf', description: 'leaf' },
          ],
          [{ source: 'Root', target: 'Leaf', type: 'CONTAINS', reason: 'test' }],
        ),
      ),
    );
    const result = await executeSearch(store, 'Root', {
      depth: 0,
      limit: 20,
      format: 'json',
    });
    expect(result.matchedConcepts.map((c) => c.id)).toContain('Root');
    expect(result.relatedConcepts).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
  });

  it('rejects negative depth', async () => {
    await expect(
      executeSearch(store, 'x', { depth: -1, limit: 20, format: 'json' }),
    ).rejects.toBeInstanceOf(RefmeshValidationError);
  });

  it('rejects threshold outside [0, 1]', async () => {
    await expect(
      executeSearch(store, 'x', { depth: 1, limit: 5, threshold: 1.5, format: 'json' }),
    ).rejects.toBeInstanceOf(RefmeshValidationError);
    await expect(
      executeSearch(store, 'x', { depth: 1, limit: 5, threshold: -0.1, format: 'json' }),
    ).rejects.toBeInstanceOf(RefmeshValidationError);
  });

  it('applies --limit as vector-search top-K', async () => {
    await executeRegister(
      store,
      parseAndValidate(
        payload(
          'https://example.com/many',
          [
            { id: 'N1', description: 'apple banana cherry' },
            { id: 'N2', description: 'apple banana date' },
            { id: 'N3', description: 'apple banana fig' },
            { id: 'N4', description: 'apple banana grape' },
          ],
          [],
        ),
      ),
    );
    const result = await executeSearch(store, 'apple banana', {
      depth: 0,
      limit: 2,
      threshold: 0.0,
      format: 'json',
    });
    expect(result.matchedConcepts.length).toBeLessThanOrEqual(2);
  });

  it('returns empty matched when threshold is near 1', async () => {
    await executeRegister(
      store,
      parseAndValidate(
        payload(
          'https://example.com/t',
          [{ id: 'Only', description: 'completely unrelated topic' }],
          [],
        ),
      ),
    );
    const result = await executeSearch(store, 'something entirely different', {
      depth: 1,
      limit: 5,
      threshold: 0.999,
      format: 'json',
    });
    expect(result.matchedConcepts).toHaveLength(0);
    expect(result.relatedConcepts).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
  });

  it('matchedConcepts carry score and are sorted descending', async () => {
    await executeRegister(
      store,
      parseAndValidate(
        payload(
          'https://example.com/score',
          [
            { id: 'UseState', description: 'React state hook for function components' },
            { id: 'UseEffect', description: 'React effect hook for side effects' },
          ],
          [],
        ),
      ),
    );
    const result = await executeSearch(store, 'React state hook', {
      depth: 0,
      limit: 5,
      threshold: 0.0,
      format: 'json',
    });
    expect(result.matchedConcepts.length).toBeGreaterThan(0);
    for (const c of result.matchedConcepts) {
      expect(c.score).toBeGreaterThanOrEqual(0);
      expect(c.score).toBeLessThanOrEqual(1);
    }
    for (let i = 1; i < result.matchedConcepts.length; i += 1) {
      expect(result.matchedConcepts[i - 1]!.score!).toBeGreaterThanOrEqual(
        result.matchedConcepts[i]!.score!,
      );
    }
  });

  it('multi-origin BFS deduplicates edges reached from multiple roots', async () => {
    await executeRegister(
      store,
      parseAndValidate(
        payload(
          'https://example.com/multi',
          [
            { id: 'AlphaMulti', description: 'first origin' },
            { id: 'BetaMulti', description: 'second origin' },
            { id: 'Hub', description: 'shared neighbor' },
          ],
          [
            { source: 'AlphaMulti', target: 'Hub', type: 'RELATED_TO', reason: 'a-h' },
            { source: 'BetaMulti', target: 'Hub', type: 'RELATED_TO', reason: 'b-h' },
          ],
        ),
      ),
    );
    const result = await executeSearch(store, 'origin', {
      depth: 1,
      limit: 5,
      threshold: 0.0,
      format: 'json',
    });
    const keys = result.edges.map((e) => `${e.source}|${e.type}|${e.target}`);
    const unique = new Set(keys);
    expect(keys.length).toBe(unique.size);
  });

  it('writes one vector row per concept and reflects updated description after re-register', async () => {
    await executeRegister(
      store,
      parseAndValidate(
        payload(
          'https://example.com/v',
          [
            { id: 'Alpha', description: 'alpha one' },
            { id: 'Beta', description: 'beta two' },
          ],
          [],
        ),
      ),
    );
    expect(store.vectors.countAll()).toBe(2);

    await executeRegister(
      store,
      parseAndValidate(
        payload('https://example.com/v', [{ id: 'Alpha', description: 'alpha rewritten' }], []),
      ),
    );
    expect(store.vectors.countAll()).toBe(2);
  });

  it('emits similarWarnings for near-duplicate new concepts', async () => {
    await executeRegister(
      store,
      parseAndValidate(
        payload(
          'https://example.com/sim-base',
          [{ id: 'useState', description: 'React state hook for functional components' }],
          [],
        ),
      ),
    );

    const summary = await executeRegister(
      store,
      parseAndValidate(
        payload(
          'https://example.com/sim-dup',
          [{ id: 'UseStateHook', description: 'React state hook for functional components' }],
          [],
        ),
      ),
    );

    expect(summary.similarWarnings.length).toBeGreaterThan(0);
    const warn = summary.similarWarnings[0];
    expect(warn?.newId).toBe('UseStateHook');
    expect(warn?.existingId).toBe('useState');
    expect(warn?.score).toBeGreaterThanOrEqual(0.95);
  });

  it('does not write vectors when validation fails (unresolved reference)', async () => {
    const input = parseAndValidate(
      payload(
        'https://example.com/bad2',
        [{ id: 'SoloX', description: 'alone' }],
        [{ source: 'SoloX', target: 'PhantomY', type: 'RELATED_TO', reason: 'oops' }],
      ),
    );
    await expect(executeRegister(store, input)).rejects.toBeInstanceOf(RefmeshValidationError);
    expect(store.vectors.countAll()).toBe(0);
  });
});
