import { type PrefetchResult, prefetchEmbeddingModel } from '../embedding/embedder.js';

export interface PrefetchCommandOptions {
  format: 'text' | 'json';
}

export async function executePrefetch(): Promise<PrefetchResult> {
  return prefetchEmbeddingModel();
}

export function renderPrefetchText(result: PrefetchResult): string {
  if (result.downloaded) {
    return [
      `Embedding model "${result.modelId}" downloaded.`,
      `  cache dir: ${result.modelDir}`,
    ].join('\n');
  }
  return [
    `Embedding model "${result.modelId}" already cached.`,
    `  cache dir: ${result.modelDir}`,
  ].join('\n');
}

export function renderPrefetchJson(result: PrefetchResult): string {
  return JSON.stringify(
    {
      modelId: result.modelId,
      modelDir: result.modelDir,
      downloaded: result.downloaded,
    },
    null,
    2,
  );
}
