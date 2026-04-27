import { mkdir } from 'node:fs/promises';
import { env, pipeline } from '@xenova/transformers';
import { RefmeshRuntimeError } from '../util/errors.js';
import { resolveModelDir } from './paths.js';

export const EMBEDDING_MODEL_ID = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
export const EMBEDDING_DIMENSION = 384;

// Point @xenova/transformers' filesystem cache at refmesh's managed directory
// so cached weights live under ~/.refmesh/models/ (or REFMESH_MODEL_DIR) instead
// of the package-relative default. Resolving lazily lets tests override the
// REFMESH_MODEL_DIR env var without having to reload the module.
async function applyModelCacheDir(): Promise<string> {
  const modelDir = resolveModelDir();
  env.cacheDir = modelDir;
  await mkdir(modelDir, { recursive: true });
  return modelDir;
}

type FeatureExtractor = (
  text: string | string[],
  options: { pooling: 'mean' | 'cls'; normalize: boolean },
) => Promise<{ data: Float32Array; dims: number[] }>;

let cachedExtractor: FeatureExtractor | null = null;
let loadPromise: Promise<FeatureExtractor> | null = null;

// xenova/transformers progress events. Status is one of:
//   - 'initiate' / 'download' : a remote fetch is starting (cache miss)
//   - 'progress'              : bytes-loaded update for a single file
//   - 'done'                  : a single file finished downloading
//   - 'ready'                 : the whole pipeline is loaded
// When every file is satisfied from disk cache no event is emitted at all,
// which is exactly how we keep the cached path silent.
interface ProgressEvent {
  status: string;
  name?: string;
  file?: string;
  progress?: number;
  loaded?: number;
  total?: number;
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export interface DownloadReporter {
  onEvent(event: ProgressEvent): void;
  // Triggered by an external grace timer so the user is not left in silence
  // while small metadata files (which arrive 100%-in-one-shot even on a real
  // miss) are being fetched before the big model file produces partial
  // progress events.
  announceIfStillLoading(): void;
  // True iff a real download (partial-progress event or grace-timer fallback)
  // happened during this reporter's lifetime. Used by `refmesh prefetch` to
  // tell the caller whether the cache was already populated.
  wasDownloaded(): boolean;
}

// Build a stderr-only reporter. We deliberately keep stdout untouched so
// machine-readable command output (e.g. `refmesh search --format json`) is
// never polluted by progress lines.
//
// xenova/transformers fires 'initiate' / 'download' / 'progress' / 'done' /
// 'ready' even on a cold cache hit (progress arrives once at 100% with
// loaded === total). The only signal that distinguishes a real download
// from a disk-load is a 'progress' event whose loaded < total. We use that
// as the trigger for the user-facing announcement so cached runs stay
// completely silent.
export function createStderrDownloadReporter(
  stream: NodeJS.WriteStream = process.stderr,
): DownloadReporter {
  const isTty = stream.isTTY === true;
  let announced = false;
  let lastLineLength = 0;

  const clearProgressLine = () => {
    if (!isTty || lastLineLength === 0) return;
    stream.write(`\r${' '.repeat(lastLineLength)}\r`);
    lastLineLength = 0;
  };

  const announce = () => {
    if (announced) return;
    announced = true;
    stream.write(
      `Downloading embedding model "${EMBEDDING_MODEL_ID}" (~80 MB, first time only — cached for future runs)...\n`,
    );
  };

  return {
    announceIfStillLoading() {
      announce();
    },
    wasDownloaded() {
      return announced;
    },
    onEvent(event) {
      if (event.status === 'progress') {
        const loaded = event.loaded ?? 0;
        const total = event.total ?? 0;
        const isPartial = total > 0 && loaded < total;
        if (!isPartial) return; // cache-hit "100% in one shot" — stay silent

        announce();
        if (!isTty) return;
        const file = event.file ?? event.name ?? '';
        const pct = Math.floor((loaded / total) * 100);
        const line = `  ${file}: ${pct}% (${formatBytes(loaded)} / ${formatBytes(total)})`;
        // Always start with \r so the progress row is owned by us and the
        // first paint cleanly returns the cursor to column 0.
        clearProgressLine();
        stream.write(`\r${line}`);
        lastLineLength = line.length;
        return;
      }
      if (event.status === 'ready') {
        clearProgressLine();
        if (announced) {
          stream.write('Embedding model ready.\n');
        }
      }
      // 'initiate' / 'download' / 'done' fire on every load (cache hit too)
      // and carry no signal we can act on, so we ignore them.
    },
  };
}

// Grace period before falling back to a "still loading…" announcement when
// no partial progress event has arrived. A cache hit completes the entire
// load in well under 600 ms on this hardware, so 800 ms is a safe lower
// bound that avoids false positives but still reacts before the user thinks
// the CLI has frozen.
const LOAD_GRACE_MS = 800;

async function loadExtractor(): Promise<FeatureExtractor> {
  if (cachedExtractor) return cachedExtractor;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    await applyModelCacheDir();
    const reporter = createStderrDownloadReporter();
    const graceTimer = setTimeout(() => reporter.announceIfStillLoading(), LOAD_GRACE_MS);
    try {
      const extractor = (await pipeline('feature-extraction', EMBEDDING_MODEL_ID, {
        progress_callback: (event: ProgressEvent) => reporter.onEvent(event),
      })) as unknown as FeatureExtractor;
      cachedExtractor = extractor;
      return extractor;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new RefmeshRuntimeError(`Failed to load embedding model ${EMBEDDING_MODEL_ID}: ${msg}`);
    } finally {
      clearTimeout(graceTimer);
      // Only release loadPromise after a failure so a retry can re-enter
      // loadExtractor; on success, cachedExtractor short-circuits future
      // calls and loadPromise can stay pinned (kept null in finally for
      // simplicity, but cachedExtractor has already been set above).
      loadPromise = null;
    }
  })();
  return loadPromise;
}

export interface PrefetchResult {
  modelId: string;
  modelDir: string;
  downloaded: boolean;
}

// Eagerly populate the FS cache for the embedding model so subsequent invocations
// (including those running under read-only HOME / sandboxed agents) can load the
// model without any network access or writes to a foreign cache directory.
//
// Idempotent: if every required file is already on disk, `pipeline()` returns
// without ever hitting the remote host and `wasDownloaded()` stays false.
export async function prefetchEmbeddingModel(): Promise<PrefetchResult> {
  const modelDir = await applyModelCacheDir();
  const reporter = createStderrDownloadReporter();
  const graceTimer = setTimeout(() => reporter.announceIfStillLoading(), LOAD_GRACE_MS);
  try {
    await pipeline('feature-extraction', EMBEDDING_MODEL_ID, {
      progress_callback: (event: ProgressEvent) => reporter.onEvent(event),
    });
    return {
      modelId: EMBEDDING_MODEL_ID,
      modelDir,
      downloaded: reporter.wasDownloaded(),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new RefmeshRuntimeError(
      `Failed to prefetch embedding model ${EMBEDDING_MODEL_ID}: ${msg}`,
    );
  } finally {
    clearTimeout(graceTimer);
  }
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
