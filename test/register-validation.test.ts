import { describe, expect, it } from 'vitest';
import { parseAndValidate } from '../src/commands/register.js';
import { RefmeshValidationError } from '../src/util/errors.js';

function validPayload() {
  return {
    reference: { url: 'https://example.com/doc', title: 'Example' },
    concepts: [
      { id: 'A', description: 'desc A' },
      { id: 'B', description: 'desc B', details: 'details B' },
    ],
    relationships: [{ source: 'A', target: 'B', type: 'PART_OF', reason: 'A is part of B' }],
  };
}

describe('parseAndValidate', () => {
  it('accepts a valid payload', () => {
    const input = parseAndValidate(JSON.stringify(validPayload()));
    expect(input.reference.url).toBe('https://example.com/doc');
    expect(input.concepts).toHaveLength(2);
  });

  it('rejects invalid JSON', () => {
    expect(() => parseAndValidate('{not-json')).toThrow(RefmeshValidationError);
  });

  it('rejects unknown edge types', () => {
    const p = validPayload();
    p.relationships[0]!.type = 'NOT_A_REAL_EDGE';
    expect(() => parseAndValidate(JSON.stringify(p))).toThrow(RefmeshValidationError);
  });

  it('rejects DESCRIBES used in public relationships', () => {
    const p = validPayload();
    p.relationships[0]!.type = 'DESCRIBES';
    expect(() => parseAndValidate(JSON.stringify(p))).toThrow(RefmeshValidationError);
  });

  it('rejects missing required fields', () => {
    const p = validPayload() as Partial<ReturnType<typeof validPayload>>;
    delete (p as { reference?: unknown }).reference;
    expect(() => parseAndValidate(JSON.stringify(p))).toThrow(RefmeshValidationError);
  });

  it('rejects empty concepts array', () => {
    const p = validPayload();
    p.concepts = [];
    expect(() => parseAndValidate(JSON.stringify(p))).toThrow(RefmeshValidationError);
  });

  it('rejects duplicate concept ids in input', () => {
    const p = validPayload();
    p.concepts.push({ id: 'A', description: 'dup' });
    expect(() => parseAndValidate(JSON.stringify(p))).toThrow(RefmeshValidationError);
  });

  it('rejects non-uri reference.url', () => {
    const p = validPayload();
    p.reference.url = '';
    expect(() => parseAndValidate(JSON.stringify(p))).toThrow(RefmeshValidationError);
  });

  it('allows relationships array to be empty', () => {
    const p = validPayload();
    p.relationships = [];
    expect(() => parseAndValidate(JSON.stringify(p))).not.toThrow();
  });
});
