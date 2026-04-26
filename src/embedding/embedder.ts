import { pipeline } from '@xenova/transformers';
import { RefmeshRuntimeError } from '../util/errors.js';

export const EMBEDDING_MODEL_ID = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
export const EMBEDDING_DIMENSION = 384;

type FeatureExtractor = (
  text: string | string[],
  options: { pooling: 'mean' | 'cls'; normalize: boolean },
) => Promise<{ data: Float32Array; dims: number[] }>;

let cachedExtractor: FeatureExtractor | null = null;
let loadPromise: Promise<FeatureExtractor> | null = null;

async function loadExtractor(): Promise<FeatureExtractor> {
  if (cachedExtractor) return cachedExtractor;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    try {
      const extractor = (await pipeline(
        'feature-extraction',
        EMBEDDING_MODEL_ID,
      )) as unknown as FeatureExtractor;
      cachedExtractor = extractor;
      return extractor;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new RefmeshRuntimeError(`Failed to load embedding model ${EMBEDDING_MODEL_ID}: ${msg}`);
    } finally {
      loadPromise = null;
    }
  })();
  return loadPromise;
}

export async function embed(text: string): Promise<number[]> {
  const extractor = await loadExtractor();
  const out = await extractor(text, { pooling: 'mean', normalize: true });
  return Array.from(out.data);
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const extractor = await loadExtractor();
  const out = await extractor(texts, { pooling: 'mean', normalize: true });
  const dim = EMBEDDING_DIMENSION;
  const flat = out.data;
  const result: number[][] = [];
  for (let i = 0; i < texts.length; i += 1) {
    const row = new Array<number>(dim);
    for (let j = 0; j < dim; j += 1) {
      row[j] = flat[i * dim + j] ?? 0;
    }
    result.push(row);
  }
  return result;
}

export interface ConceptTextSource {
  id: string;
  description: string;
  details?: string;
}

export function composeConceptText(concept: ConceptTextSource): string {
  const parts: string[] = [concept.id, concept.description];
  if (concept.details && concept.details.length > 0) {
    parts.push(concept.details);
  }
  return parts.join('\n');
}
