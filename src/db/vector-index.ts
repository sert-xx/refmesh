import type Database from 'better-sqlite3';
import { EMBEDDING_DIMENSION } from '../embedding/embedder.js';
import { RefmeshRuntimeError } from '../util/errors.js';

export interface VectorRecord {
  id: string;
  vector: number[];
}

export interface VectorQueryHit {
  id: string;
  score: number;
}

export interface VectorQueryOptions {
  limit: number;
  threshold: number;
}

// All concept vectors live in memory as Float32Array entries keyed by
// concept_id. The store re-hydrates this map at open() by scanning the
// concept_vectors table once. Inserts go through both the SQLite table
// (durability) and this map (query latency). For the size refmesh targets
// (≤ 10⁵ concepts × 384 dims × 4 bytes ≈ 150 MB worst case), an in-memory
// Float32Array map is roughly an order of magnitude faster than any
// extension-based vector index would be at this scale, with zero deps.
//
// All vectors stored here are L2-normalized (the embedder is configured with
// `normalize: true`), which means cosine_similarity == dot_product. Skipping
// the per-query norm computation is what makes the brute-force search fast.
export class VectorIndex {
  private readonly map = new Map<string, Float32Array>();

  constructor(
    private readonly db: Database.Database,
    private readonly dim = EMBEDDING_DIMENSION,
  ) {}

  // Pull every concept vector out of SQLite and into the live map. Run once
  // at store open. Each row's BLOB is wrapped without copying so subsequent
  // queries hit the same backing buffer node-buffer allocated.
  loadAll(): void {
    this.map.clear();
    const stmt = this.db.prepare<[]>('SELECT concept_id, vec FROM concept_vectors');
    for (const row of stmt.iterate() as IterableIterator<{ concept_id: string; vec: Buffer }>) {
      const buf = row.vec;
      const view = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
      // Detach from the underlying Buffer so a later GC of the row object
      // doesn't pull the bytes out from under us.
      this.map.set(row.concept_id, new Float32Array(view));
    }
  }

  size(): number {
    return this.map.size;
  }

  // Persist + index. Always uses upsert semantics so re-registration of the
  // same concept replaces the old vector cleanly.
  upsert(records: readonly VectorRecord[]): void {
    if (records.length === 0) return;
    for (const r of records) {
      if (r.vector.length !== this.dim) {
        throw new RefmeshRuntimeError(
          `Vector dimension mismatch for id=${r.id}: expected ${this.dim}, got ${r.vector.length}`,
        );
      }
    }
    const stmt = this.db.prepare(
      `INSERT INTO concept_vectors (concept_id, dim, vec) VALUES (?, ?, ?)
         ON CONFLICT(concept_id) DO UPDATE SET dim = excluded.dim, vec = excluded.vec`,
    );
    for (const r of records) {
      const f32 = new Float32Array(r.vector);
      const buf = Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
      stmt.run(r.id, this.dim, buf);
      this.map.set(r.id, f32);
    }
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM concept_vectors WHERE concept_id = ?').run(id);
    this.map.delete(id);
  }

  clearAll(): void {
    this.db.prepare('DELETE FROM concept_vectors').run();
    this.map.clear();
  }

  // Brute-force cosine similarity over the in-memory map. The map size is
  // bounded by concept count, not by the threshold/limit, so this is
  // O(N · dim) — acceptable for refmesh's target scale and trivially
  // parallel-friendly if we ever need to grow it.
  query(vector: readonly number[], options: VectorQueryOptions): VectorQueryHit[] {
    if (vector.length !== this.dim) {
      throw new RefmeshRuntimeError(
        `Query vector dimension mismatch: expected ${this.dim}, got ${vector.length}`,
      );
    }
    if (this.map.size === 0) return [];
    const limit = Math.max(1, Math.floor(options.limit));
    const threshold = options.threshold;
    const q = vector;
    const hits: VectorQueryHit[] = [];
    for (const [id, vec] of this.map) {
      let dot = 0;
      for (let i = 0; i < this.dim; i += 1) {
        dot += (q[i] ?? 0) * (vec[i] ?? 0);
      }
      // Normalised vectors → dot ∈ [-1, 1] is the cosine similarity.
      // Map to [0, 1] via (1 + cos) / 2 to preserve the public score range
      // (and the implied `distance = 2 * (1 - score)` mapping) that the
      // LanceDB-era trace UI and SAME_AS threshold (0.95) were calibrated
      // against. Without this rescale, a cosine-equivalent threshold of
      // 0.95 would silently raise the bar to 0.95 cosine ≈ 0.975 LanceDB.
      const score = Math.max(0, Math.min(1, (1 + dot) / 2));
      if (score >= threshold) {
        hits.push({ id, score });
      }
    }
    hits.sort((a, b) => b.score - a.score);
    if (hits.length > limit) hits.length = limit;
    return hits;
  }

  countAll(): number {
    return this.map.size;
  }
}
