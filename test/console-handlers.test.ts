import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { executeArchive } from '../src/commands/archive.js';
import { executeRegister, parseAndValidate } from '../src/commands/register.js';
import {
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  MAX_NEIGHBOR_DEPTH,
  getConcept,
  getNeighbors,
  getStats,
  listConcepts,
  parseConsoleSearchOptions,
  parseListConceptsOptions,
  parseNeighborsOptions,
  runConsoleSearch,
} from '../src/console/handlers.js';
import { type RefmeshHybridStores, openHybridStores } from '../src/db/connection.js';
import { RefmeshValidationError } from '../src/util/errors.js';

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

describe('console handlers', () => {
  let tempDir: string;
  let stores: RefmeshHybridStores;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'refmesh-console-'));
    stores = await openHybridStores({
      graphPath: join(tempDir, 'graph.kuzu'),
      vectorPath: join(tempDir, 'vectors.lance'),
    });
  });

  afterAll(async () => {
    try {
      await stores.close();
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
    await stores.graph.connection.query('MATCH (n) DETACH DELETE n');
    await stores.vector.clearAll();
  });

  describe('parseListConceptsOptions', () => {
    it('returns defaults when no params are supplied', () => {
      const opts = parseListConceptsOptions(new URLSearchParams());
      expect(opts.limit).toBe(DEFAULT_LIST_LIMIT);
      expect(opts.offset).toBe(0);
      expect(opts.includeArchived).toBe(false);
      expect(opts.sort).toBe('lastSeenAt');
    });

    it('rejects non-positive limits', () => {
      expect(() => parseListConceptsOptions(new URLSearchParams('limit=0'))).toThrow(
        RefmeshValidationError,
      );
      expect(() => parseListConceptsOptions(new URLSearchParams('limit=-1'))).toThrow(
        RefmeshValidationError,
      );
      expect(() => parseListConceptsOptions(new URLSearchParams('limit=abc'))).toThrow(
        RefmeshValidationError,
      );
    });

    it('caps limit at MAX_LIST_LIMIT', () => {
      const opts = parseListConceptsOptions(new URLSearchParams(`limit=${MAX_LIST_LIMIT + 100}`));
      expect(opts.limit).toBe(MAX_LIST_LIMIT);
    });

    it('rejects negative offsets', () => {
      expect(() => parseListConceptsOptions(new URLSearchParams('offset=-1'))).toThrow(
        RefmeshValidationError,
      );
    });

    it('selects sort variants', () => {
      expect(parseListConceptsOptions(new URLSearchParams('sort=touchCount')).sort).toBe(
        'touchCount',
      );
      expect(parseListConceptsOptions(new URLSearchParams('sort=id')).sort).toBe('id');
      expect(parseListConceptsOptions(new URLSearchParams('sort=bogus')).sort).toBe('lastSeenAt');
    });
  });

  describe('parseNeighborsOptions', () => {
    it('defaults to depth 1', () => {
      expect(parseNeighborsOptions(new URLSearchParams()).depth).toBe(1);
    });
    it('rejects negative depth', () => {
      expect(() => parseNeighborsOptions(new URLSearchParams('depth=-1'))).toThrow(
        RefmeshValidationError,
      );
    });
    it('rejects depth above MAX_NEIGHBOR_DEPTH', () => {
      expect(() =>
        parseNeighborsOptions(new URLSearchParams(`depth=${MAX_NEIGHBOR_DEPTH + 1}`)),
      ).toThrow(RefmeshValidationError);
    });
  });

  describe('parseConsoleSearchOptions', () => {
    it('rejects empty query', () => {
      expect(() => parseConsoleSearchOptions(new URLSearchParams())).toThrow(
        RefmeshValidationError,
      );
      expect(() => parseConsoleSearchOptions(new URLSearchParams('q=%20'))).toThrow(
        RefmeshValidationError,
      );
    });
    it('parses defaults around a non-empty query', () => {
      const opts = parseConsoleSearchOptions(new URLSearchParams('q=hello'));
      expect(opts.query).toBe('hello');
      expect(opts.depth).toBe(1);
      expect(opts.limit).toBeGreaterThan(0);
    });
    it('rejects out-of-range numeric params', () => {
      expect(() => parseConsoleSearchOptions(new URLSearchParams('q=x&limit=0'))).toThrow(
        RefmeshValidationError,
      );
      expect(() => parseConsoleSearchOptions(new URLSearchParams('q=x&threshold=2'))).toThrow(
        RefmeshValidationError,
      );
      expect(() =>
        parseConsoleSearchOptions(new URLSearchParams(`q=x&depth=${MAX_NEIGHBOR_DEPTH + 1}`)),
      ).toThrow(RefmeshValidationError);
    });
  });

  describe('getStats', () => {
    it('returns zero counts on an empty DB', async () => {
      const stats = await getStats(stores);
      expect(stats.counts.concepts).toBe(0);
      expect(stats.counts.references).toBe(0);
      expect(stats.counts.edgesTotal).toBe(0);
      expect(stats.counts.archivedConcepts).toBe(0);
      expect(stats.lastSeenAt).toBeNull();
      expect(stats.vector.rowCount).toBe(0);
      // every public + internal edge type should be present in the breakdown.
      expect(Object.keys(stats.counts.edgesByType).length).toBeGreaterThanOrEqual(15);
      for (const v of Object.values(stats.counts.edgesByType)) {
        expect(v).toBe(0);
      }
    });

    it('reflects registered concepts, references and edges', async () => {
      await executeRegister(
        stores,
        parseAndValidate(
          payload(
            'https://example.com/stats',
            [
              { id: 'A', description: 'first' },
              { id: 'B', description: 'second' },
            ],
            [{ source: 'A', target: 'B', type: 'PART_OF', reason: 'rel' }],
          ),
        ),
      );
      const stats = await getStats(stores);
      expect(stats.counts.concepts).toBe(2);
      expect(stats.counts.references).toBe(1);
      expect(stats.counts.edgesByType['PART_OF']).toBe(1);
      // DESCRIBES is auto-attached: Reference -> Concept (one per concept).
      expect(stats.counts.edgesByType['DESCRIBES']).toBeGreaterThan(0);
      expect(stats.counts.edgesTotal).toBeGreaterThanOrEqual(1);
      expect(stats.lastSeenAt).not.toBeNull();
      expect(stats.vector.rowCount).toBe(2);
    });
  });

  describe('listConcepts / getConcept', () => {
    beforeEach(async () => {
      await executeRegister(
        stores,
        parseAndValidate(
          payload(
            'https://example.com/list',
            [
              { id: 'Alpha', description: 'a' },
              { id: 'Beta', description: 'b' },
              { id: 'Gamma', description: 'g' },
            ],
            [],
          ),
        ),
      );
    });

    it('paginates with limit and offset', async () => {
      const first = await listConcepts(stores, {
        limit: 2,
        offset: 0,
        includeArchived: false,
        sort: 'id',
      });
      expect(first.total).toBe(3);
      expect(first.items).toHaveLength(2);

      const second = await listConcepts(stores, {
        limit: 2,
        offset: 2,
        includeArchived: false,
        sort: 'id',
      });
      expect(second.items).toHaveLength(1);
      const seenIds = [...first.items.map((i) => i.id), ...second.items.map((i) => i.id)];
      expect(new Set(seenIds).size).toBe(3);
    });

    it('hides archived items by default and exposes them with includeArchived=true', async () => {
      await executeArchive(stores, 'Alpha', { reason: 'old' });
      const visible = await listConcepts(stores, {
        limit: 50,
        offset: 0,
        includeArchived: false,
        sort: 'id',
      });
      expect(visible.items.find((i) => i.id === 'Alpha')).toBeUndefined();
      expect(visible.total).toBe(2);

      const all = await listConcepts(stores, {
        limit: 50,
        offset: 0,
        includeArchived: true,
        sort: 'id',
      });
      const alpha = all.items.find((i) => i.id === 'Alpha');
      expect(alpha?.archived).toBe(true);
      expect(alpha?.archiveReason).toBe('old');
      expect(all.total).toBe(3);
    });

    it('returns concept with references', async () => {
      const detail = await getConcept(stores, 'Alpha');
      expect(detail).not.toBeNull();
      expect(detail?.references.length).toBeGreaterThan(0);
      expect(detail?.references[0]?.url).toBe('https://example.com/list');
    });

    it('returns null for missing id', async () => {
      const detail = await getConcept(stores, 'Missing');
      expect(detail).toBeNull();
    });

    it('rejects empty id', async () => {
      await expect(getConcept(stores, '')).rejects.toBeInstanceOf(RefmeshValidationError);
    });
  });

  describe('getNeighbors', () => {
    beforeEach(async () => {
      await executeRegister(
        stores,
        parseAndValidate(
          payload(
            'https://example.com/n',
            [
              { id: 'Root', description: 'root' },
              { id: 'Mid', description: 'mid' },
              { id: 'Leaf', description: 'leaf' },
            ],
            [
              { source: 'Root', target: 'Mid', type: 'CONTAINS', reason: 'r-m' },
              { source: 'Mid', target: 'Leaf', type: 'CONTAINS', reason: 'm-l' },
            ],
          ),
        ),
      );
    });

    it('returns just the root at depth=0', async () => {
      const result = await getNeighbors(stores, 'Root', { depth: 0, includeArchived: false });
      expect(result?.nodes).toHaveLength(1);
      expect(result?.edges).toHaveLength(0);
      expect(result?.nodes[0]?.isRoot).toBe(true);
    });

    it('expands one level by default', async () => {
      const result = await getNeighbors(stores, 'Root', { depth: 1, includeArchived: false });
      const ids = result?.nodes.map((n) => n.id) ?? [];
      expect(ids).toContain('Root');
      expect(ids).toContain('Mid');
      expect(ids).not.toContain('Leaf');
      expect(result?.edges.some((e) => e.source === 'Root' && e.target === 'Mid')).toBe(true);
    });

    it('returns null for missing concept', async () => {
      const result = await getNeighbors(stores, 'Ghost', { depth: 1, includeArchived: false });
      expect(result).toBeNull();
    });

    it('hides archived neighbors by default', async () => {
      await executeArchive(stores, 'Mid');
      const visible = await getNeighbors(stores, 'Root', { depth: 1, includeArchived: false });
      const ids = visible?.nodes.map((n) => n.id) ?? [];
      expect(ids).not.toContain('Mid');

      const all = await getNeighbors(stores, 'Root', { depth: 1, includeArchived: true });
      expect(all?.nodes.some((n) => n.id === 'Mid' && n.archived)).toBe(true);
    });

    it('safely handles concept ids containing single quotes and backslashes', async () => {
      // Cypher list literals are spliced as strings (Kùzu does not accept
      // array bindings); the escape in handlers.ts must defuse both ' and \.
      // Without it, ids like O'Brien would either crash or be vulnerable to
      // injection.
      const trickyIds = ["O'Brien", 'C\\Path', "He said \\'hi\\'"];
      await executeRegister(
        stores,
        parseAndValidate(
          payload(
            'https://example.com/quoted',
            [
              { id: 'QuoteRoot', description: 'root for quote tests' },
              ...trickyIds.map((id) => ({ id, description: `desc for ${id}` })),
            ],
            trickyIds.map((id) => ({
              source: 'QuoteRoot',
              target: id,
              type: 'RELATED_TO',
              reason: 'quote',
            })),
          ),
        ),
      );
      const result = await getNeighbors(stores, 'QuoteRoot', {
        depth: 1,
        includeArchived: false,
      });
      const ids = result?.nodes.map((n) => n.id) ?? [];
      for (const id of trickyIds) {
        expect(ids).toContain(id);
      }
    });
  });

  describe('runConsoleSearch', () => {
    it('returns a SearchResult shape', async () => {
      await executeRegister(
        stores,
        parseAndValidate(
          payload('https://example.com/s', [{ id: 'Lookup', description: 'find me' }]),
        ),
      );
      const result = await runConsoleSearch(stores, {
        query: 'find',
        limit: 5,
        depth: 0,
        threshold: 0,
        includeArchived: false,
      });
      expect(result.matchedConcepts.map((c) => c.id)).toContain('Lookup');
    });

    it('ignores debug-only scoring params on /api/search to preserve the legacy contract', async () => {
      // PBI-16 explicitly forbids changing /api/search behavior. Even when a
      // caller passes freshnessWeight=1 (which would normally collapse cosine
      // ranking entirely), runConsoleSearch must behave exactly as if the
      // param was absent.
      await executeRegister(
        stores,
        parseAndValidate(
          payload('https://example.com/legacy', [
            { id: 'LegacyHit', description: 'legacy contract target' },
          ]),
        ),
      );
      const baseline = await runConsoleSearch(stores, {
        query: 'legacy contract target',
        limit: 5,
        depth: 0,
        threshold: 0,
        includeArchived: false,
      });
      const withDebugParams = await runConsoleSearch(stores, {
        query: 'legacy contract target',
        limit: 5,
        depth: 0,
        threshold: 0,
        includeArchived: false,
        // These should be silently dropped by /api/search.
        freshnessWeight: 1,
        halfLifeDays: 1,
        maxAgeDays: 0,
        demoteDeprecated: 0,
        reinforcementWeight: 1,
      });
      expect(withDebugParams.matchedConcepts.map((c) => c.id)).toEqual(
        baseline.matchedConcepts.map((c) => c.id),
      );
    });
  });
});
