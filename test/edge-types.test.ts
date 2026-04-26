import { describe, expect, it } from 'vitest';
import {
  ALL_EDGE_TYPE_NAMES,
  EDGE_TYPES,
  INTERNAL_DESCRIBES_EDGE,
  PUBLIC_EDGE_TYPE_NAMES,
  isPublicEdgeType,
} from '../src/schema/edge-types.js';

describe('edge-types', () => {
  it('exposes exactly 15 public edge types (matches PRD2)', () => {
    expect(PUBLIC_EDGE_TYPE_NAMES).toHaveLength(15);
  });

  it('contains all PRD2-defined edge types including SAME_AS', () => {
    const expected = [
      'IS_A',
      'PART_OF',
      'CONTAINS',
      'DEPENDS_ON',
      'IMPLEMENTS',
      'EXTENDS',
      'CONSUMES',
      'PRODUCES',
      'MUTATES',
      'ALTERNATIVE_TO',
      'INTEGRATES_WITH',
      'RELATED_TO',
      'SAME_AS',
      'REPLACES',
      'DEPRECATES',
    ];
    for (const t of expected) {
      expect(PUBLIC_EDGE_TYPE_NAMES).toContain(t);
    }
  });

  it('SAME_AS belongs to identity category', () => {
    const def = EDGE_TYPES.find((e) => e.type === 'SAME_AS');
    expect(def).toBeDefined();
    expect(def?.category).toBe('identity');
  });

  it('keeps DESCRIBES as internal-only', () => {
    expect(PUBLIC_EDGE_TYPE_NAMES).not.toContain(INTERNAL_DESCRIBES_EDGE);
    expect(ALL_EDGE_TYPE_NAMES).toContain(INTERNAL_DESCRIBES_EDGE);
    expect(isPublicEdgeType(INTERNAL_DESCRIBES_EDGE)).toBe(false);
  });

  it('each edge has a non-empty description', () => {
    for (const e of EDGE_TYPES) {
      expect(e.description.length).toBeGreaterThan(0);
    }
  });

  it('public edge type names are unique', () => {
    const set = new Set(PUBLIC_EDGE_TYPE_NAMES);
    expect(set.size).toBe(PUBLIC_EDGE_TYPE_NAMES.length);
  });
});
