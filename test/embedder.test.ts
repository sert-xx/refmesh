import { describe, expect, it } from 'vitest';
import {
  EMBEDDING_DIMENSION,
  composeConceptText,
  embed,
  embedBatch,
} from '../src/embedding/embedder.js';

describe('composeConceptText', () => {
  it('joins id, description, details with newlines', () => {
    const text = composeConceptText({
      id: 'useState',
      description: 'state hook',
      details: 'const [s, setS] = useState();',
    });
    expect(text).toBe('useState\nstate hook\nconst [s, setS] = useState();');
  });

  it('omits details when empty or missing', () => {
    expect(composeConceptText({ id: 'A', description: 'a', details: '' })).toBe('A\na');
    expect(composeConceptText({ id: 'A', description: 'a' })).toBe('A\na');
  });

  it('is deterministic for the same input', () => {
    const a = composeConceptText({ id: 'X', description: 'y', details: 'z' });
    const b = composeConceptText({ id: 'X', description: 'y', details: 'z' });
    expect(a).toBe(b);
  });
});

describe('embed / embedBatch', () => {
  it('produces a 384-dim vector for a single text', async () => {
    const vec = await embed('hello world');
    expect(vec).toHaveLength(EMBEDDING_DIMENSION);
    expect(vec.every((x) => typeof x === 'number' && Number.isFinite(x))).toBe(true);
  }, 120_000);

  it('embedBatch returns one vector per input', async () => {
    const vecs = await embedBatch(['foo', 'bar baz']);
    expect(vecs).toHaveLength(2);
    expect(vecs[0]).toHaveLength(EMBEDDING_DIMENSION);
    expect(vecs[1]).toHaveLength(EMBEDDING_DIMENSION);
  }, 120_000);

  it('embedBatch with empty array returns empty array', async () => {
    const vecs = await embedBatch([]);
    expect(vecs).toEqual([]);
  });
});
