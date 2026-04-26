import { describe, expect, it } from 'vitest';
import { runTypesCommand } from '../src/commands/types.js';
import { PUBLIC_EDGE_TYPE_NAMES } from '../src/schema/edge-types.js';

describe('types command', () => {
  it('text output lists every public edge type', () => {
    const out = runTypesCommand({ format: 'text' });
    for (const t of PUBLIC_EDGE_TYPE_NAMES) {
      expect(out).toContain(t);
    }
    expect(out).toContain('refmesh register: Input JSON Schema');
  });

  it('text output does not expose DESCRIBES as a public edge (it appears only in the internal section footer or schema, not as a listed edge)', () => {
    const out = runTypesCommand({ format: 'text' });
    // The public sections should not include DESCRIBES as a user-facing edge.
    const publicSections = out.split('# refmesh register')[0] ?? '';
    expect(publicSections).not.toContain('- DESCRIBES:');
  });

  it('json output is valid JSON with required keys', () => {
    const out = runTypesCommand({ format: 'json' });
    const parsed = JSON.parse(out);
    expect(parsed).toHaveProperty('edgeTypes');
    expect(parsed).toHaveProperty('categories');
    expect(parsed).toHaveProperty('registerInputSchema');
    expect(parsed.edgeTypes).toHaveLength(PUBLIC_EDGE_TYPE_NAMES.length);
    expect(parsed.edgeTypes.find((e: { type: string }) => e.type === 'SAME_AS')).toBeDefined();
    expect(parsed.categories).toHaveProperty('identity');
  });

  it('text output surfaces SAME_AS under the identity category', () => {
    const out = runTypesCommand({ format: 'text' });
    expect(out).toContain('同一性解決');
    expect(out).toContain('SAME_AS');
  });
});
