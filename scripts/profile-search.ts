// Run with: npx tsx scripts/profile-search.ts
//
// Measures the three search phases independently so we can tell whether the
// felt-slowness is dominated by:
//   1) embedding generation (Node WASM ONNX runtime),
//   2) LanceDB vector search (Rust native), or
//   3) Kùzu post-processing (per-hit fetches + traversal + references).
//
// Uses an isolated tempdir DB so it does not touch the user's ~/.refmesh data.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeRegister, parseAndValidate } from '../src/commands/register.js';
import { executeSearch } from '../src/commands/search.js';
import { openHybridStores } from '../src/db/connection.js';
import { embed } from '../src/embedding/embedder.js';

const QUERIES: readonly string[] = [
  'React で安全に状態管理する方法',
  'useEffect の依存配列の落とし穴',
  'サーバコンポーネントとクライアントコンポーネントの違い',
  'Suspense と非同期データ取得',
  '型安全な API クライアントの設計',
];

const ITERATIONS = 5;

function ms(ns: bigint): number {
  return Number(ns) / 1_000_000;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function summary(label: string, values: number[]): string {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const med = median(values);
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  return `${label.padEnd(28)} median=${med.toFixed(1)}ms  avg=${avg.toFixed(1)}ms  min=${min.toFixed(1)}  max=${max.toFixed(1)}`;
}

interface ConceptSpec {
  id: string;
  description: string;
  details?: string;
}

const REACT_CONCEPTS: ConceptSpec[] = [
  { id: 'useState', description: 'React で状態を持たせるフック', details: 'const [v, setV] = useState(initial);' },
  { id: 'useEffect', description: '副作用を実行するフック', details: '依存配列により再実行を制御する' },
  { id: 'useMemo', description: '計算結果をメモ化するフック' },
  { id: 'useCallback', description: '関数参照をメモ化するフック' },
  { id: 'useRef', description: 'DOM 参照や可変値を保持するフック' },
  { id: 'useContext', description: 'Context 値を購読するフック' },
  { id: 'useReducer', description: 'リデューサーで状態遷移するフック' },
  { id: 'Server Components', description: 'サーバ側でレンダリングされる React コンポーネント' },
  { id: 'Client Components', description: 'ブラウザで実行される React コンポーネント' },
  { id: 'Suspense', description: '非同期境界を宣言するコンポーネント' },
  { id: 'React Hooks', description: 'React の関数コンポーネントで状態やライフサイクルを扱う仕組み' },
  { id: 'Concurrent Rendering', description: '優先度ベースのレンダリングモデル' },
  { id: 'React 19', description: 'React の最新メジャーバージョン' },
];

const RELS: { source: string; target: string; type: string; reason: string }[] = [
  { source: 'useState', target: 'React Hooks', type: 'PART_OF', reason: 'state hook' },
  { source: 'useEffect', target: 'React Hooks', type: 'PART_OF', reason: 'effect hook' },
  { source: 'useMemo', target: 'React Hooks', type: 'PART_OF', reason: 'memo hook' },
  { source: 'useCallback', target: 'React Hooks', type: 'PART_OF', reason: 'callback hook' },
  { source: 'useRef', target: 'React Hooks', type: 'PART_OF', reason: 'ref hook' },
  { source: 'useContext', target: 'React Hooks', type: 'PART_OF', reason: 'context hook' },
  { source: 'useReducer', target: 'React Hooks', type: 'PART_OF', reason: 'reducer hook' },
  { source: 'useMemo', target: 'useCallback', type: 'RELATED_TO', reason: 'memoization siblings' },
  { source: 'Server Components', target: 'React 19', type: 'PART_OF', reason: 'shipped feature' },
  { source: 'Client Components', target: 'React 19', type: 'PART_OF', reason: 'shipped feature' },
  { source: 'Server Components', target: 'Client Components', type: 'ALTERNATIVE_TO', reason: 'execution boundary' },
  { source: 'Suspense', target: 'Concurrent Rendering', type: 'DEPENDS_ON', reason: 'requires concurrent renderer' },
  { source: 'Concurrent Rendering', target: 'React 19', type: 'PART_OF', reason: 'shipped feature' },
];

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'refmesh-profile-'));
  const stores = await openHybridStores({
    graphPath: join(dir, 'graph.kuzu'),
    vectorPath: join(dir, 'vectors.lance'),
  });

  try {
    console.log(`tempdir: ${dir}`);

    // --- Setup -----------------------------------------------------------
    const setupStart = process.hrtime.bigint();
    await executeRegister(
      stores,
      parseAndValidate(
        JSON.stringify({
          reference: { url: 'https://react.dev/reference/react', title: 'React Reference' },
          concepts: REACT_CONCEPTS,
          relationships: RELS,
        }),
      ),
    );
    const setupMs = ms(process.hrtime.bigint() - setupStart);
    console.log(`registered ${REACT_CONCEPTS.length} concepts + ${RELS.length} edges in ${setupMs.toFixed(0)}ms`);

    // --- Warm up the embedding model (first call loads ~80MB) ------------
    const warmStart = process.hrtime.bigint();
    await embed('warmup');
    const warmMs = ms(process.hrtime.bigint() - warmStart);
    console.log(`embedding model warmup: ${warmMs.toFixed(0)}ms (cold load)`);
    console.log('');

    // --- Per-phase timing ------------------------------------------------
    const embedTimes: number[] = [];
    const vectorTimes: number[] = [];
    const totalTimes: number[] = [];
    const postTimes: number[] = [];

    for (let i = 0; i < ITERATIONS; i += 1) {
      for (const q of QUERIES) {
        // (1) embedding only
        const e0 = process.hrtime.bigint();
        const vec = await embed(q);
        const eMs = ms(process.hrtime.bigint() - e0);
        embedTimes.push(eMs);

        // (2) vector search alone
        const v0 = process.hrtime.bigint();
        await stores.vector.queryByVector(vec, { limit: 5, threshold: 0 });
        const vMs = ms(process.hrtime.bigint() - v0);
        vectorTimes.push(vMs);

        // (3) full executeSearch (embed + vector + Kùzu post + reinforcement)
        const s0 = process.hrtime.bigint();
        await executeSearch(stores, q, {
          depth: 1,
          limit: 5,
          threshold: 0,
          format: 'json',
          readOnly: true, // skip the accessCount UPDATE so timing reflects reads
        });
        const sMs = ms(process.hrtime.bigint() - s0);
        totalTimes.push(sMs);

        // Post-processing isolated by subtraction (informative, not exact —
        // executeSearch internally calls embed and queryByVector again).
        postTimes.push(sMs - eMs - vMs);
      }
    }

    console.log('--- per-phase timings (5 queries × 5 iterations = 25 samples each) ---');
    console.log(summary('embed(query)', embedTimes));
    console.log(summary('vector queryByVector', vectorTimes));
    console.log(summary('executeSearch (total)', totalTimes));
    console.log(summary('Kùzu post (total - e - v)', postTimes));
    console.log('');
    const eMed = median(embedTimes);
    const vMed = median(vectorTimes);
    const tMed = median(totalTimes);
    const pMed = median(postTimes);
    const denom = tMed > 0 ? tMed : 1;
    console.log('--- contribution to executeSearch median ---');
    console.log(
      `embed:      ${eMed.toFixed(1)}ms  (${((eMed / denom) * 100).toFixed(1)}%)`,
    );
    console.log(
      `vector:     ${vMed.toFixed(1)}ms  (${((vMed / denom) * 100).toFixed(1)}%)`,
    );
    console.log(
      `Kùzu post:  ${pMed.toFixed(1)}ms  (${((pMed / denom) * 100).toFixed(1)}%)`,
    );
  } finally {
    try {
      await stores.close();
    } catch {
      /* ignore */
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
