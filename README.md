# refmesh

自律型コーディングエージェント（Claude Code 等）向けの **ハイブリッド・ナレッジグラフ構築CLI**。
公式ドキュメントやリファレンスから抽出した「概念（ノード）」と「関係性（エッジ）」を、
ローカルの [Kùzu](https://kuzudb.com/) グラフDB + [LanceDB](https://lancedb.com/) Vector Store に保存し、
自然言語による意味検索とグラフ探索を同時に行える。

- **Graph Store (Kùzu):** ノードとエッジの構造（依存・構成・比較等）を保持。
- **Vector Store (LanceDB):** Concept のテキストを埋め込みベクトル化し、意味検索の入口を担う。
- **Embedding:** `@xenova/transformers` + `Xenova/paraphrase-multilingual-MiniLM-L12-v2`（多言語384次元）。
  Python 依存なしで Node.js プロセス内でベクトルを生成。

## インストール

> Apple Silicon Mac では **arm64 の Node.js** が必須（LanceDB のネイティブバイナリが arm64 のみ配布）。
> 本リポジトリには `mise.toml` を同梱しているため、`mise install` で適切な Node を自動取得できる。

```bash
mise install   # 推奨: Node.js 22 (arm64) を自動取得
npm install
npm run build
# 開発時
npm run dev -- types
```

グローバルで使う場合:

```bash
npm link
refmesh --help
```

## 使い方

### 1. スキーマとエッジ種別を取得

```bash
refmesh types
# または機械可読な JSON で
refmesh types --format json
```

### 2. 知識を登録

JSON をパイプで流す:

```bash
cat knowledge.json | refmesh register
```

もしくはファイルパスを指定:

```bash
refmesh register -f knowledge.json
```

登録対象 JSON の例（`publishedAt` / `fetchedAt` は optional だが、鮮度スコアリングを使うなら強く推奨）:

```json
{
  "reference": {
    "url": "https://react.dev/reference/react/hooks",
    "title": "Built-in React Hooks",
    "publishedAt": "2026-04-01T00:00:00Z",
    "fetchedAt": "2026-04-26T00:00:00Z"
  },
  "concepts": [
    {
      "id": "useState",
      "description": "コンポーネントに状態変数を追加するためのHook",
      "details": "const [state, setState] = useState(initialState);"
    },
    { "id": "React Hooks", "description": "Reactの状態管理やライフサイクル機能へのフック群" }
  ],
  "relationships": [
    {
      "source": "useState",
      "target": "React Hooks",
      "type": "PART_OF",
      "reason": "useStateはReactが提供する標準Hookの一つであるため"
    }
  ]
}
```

`register` を再実行すると、Concept の `lastSeenAt` 更新と `touchCount += 1` が自動で行われる（`firstSeenAt` は不変）。

### 3. 検索

検索クエリは自然言語でOK。ベクトル化されてコンセプト集合から起点が選ばれ、`--depth` だけグラフを辿った知識の束を返す。

```bash
refmesh search "Reactでの安全な状態管理"                      # 自然言語クエリで意味検索 → depth=1 で関連取得
refmesh search "React Hooks" --depth 2 --limit 10            # 2階層まで辿る、ベクトル候補を最大10件
refmesh search "useState" --threshold 0.7 --format json      # 類似度 0.7 以上のみ、JSON 出力
```

オプション:

- `--depth <n>`: グラフ探索の深さ（デフォルト: 1）
- `--limit <n>`: ベクトル検索で取得する候補ノードの最大数（デフォルト: 5）
- `--threshold <value>`: 類似度の最小しきい値 [0, 1]（デフォルト: 0.3）
- `--freshness-weight <0..1>`: 鮮度の重み（デフォルト: 0 = 鮮度を考慮しない）
- `--half-life <days>`: 鮮度の半減期（デフォルト: 180）
- `--max-age <days>`: ここより古いノードは結果から除外（デフォルト: 制限なし）
- `--demote-deprecated <0..1>`: `DEPRECATES` / `REPLACES` のターゲットに掛ける倍率（デフォルト: 0.5、0 で除外）
- `--reinforcement-weight <0..1>`: アクセス回数による強化の重み（デフォルト: 0、freshness + reinforcement ≤ 1）
- `--include-archived`: アーカイブ済みノードも結果に含める
- `--format <text|json>`: 出力形式（デフォルト: text）

最終スコアは `final = (1 - w_f - w_r) · cosine + w_f · freshness + w_r · reinforcement`（`demoted` のときは更に `demoteDeprecated` 倍）。
`freshness = exp(-ln2 · age / halfLife)` で、`age` は `Reference.publishedAt` の最新値（無ければ `Concept.lastSeenAt`）から算出。

#### 登録時の重複検知

`register` は新規 Concept の embedding を既存 Vector Store と照合し、類似度 ≥ 0.95 の既存ノードがあれば
サマリに `⚠ Similar existing concepts` として警告する。エージェントはこれを受けて、新規ノード作成を止めて
既存 id を再利用するか、`SAME_AS` エッジで接続するか判断する。

### 4. 古い知識の整理（archive / prune）

```bash
# 論理アーカイブ（検索から除外、復活可能）
refmesh archive OldUseState --reason "replaced by hooks"
refmesh unarchive OldUseState

# 物理削除（dry-run がデフォルト）
refmesh prune --older-than 365 --max-touches 1
refmesh prune --older-than 365 --max-touches 1 --apply
```

`prune` は `lastSeenAt` が cutoff より古く `touchCount <= --max-touches` のノードを Graph と Vector の両方から削除する。
デフォルトで archived は対象外（`--include-archived` で含める）。`--apply` を付けない限り変更は加わらない。

## データ格納先

- Graph (Kùzu) デフォルト: `~/.refmesh/graph.kuzu` / 上書き: `REFMESH_DB_PATH`
- Vector (LanceDB) デフォルト: `~/.refmesh/vectors.lance` / 上書き: `REFMESH_VECTOR_PATH`

## エッジ種別

15種類の公開エッジ種別を提供する（`refmesh types` で一覧を取得可能）。
カテゴリ: 構造・分類 / 依存・実装 / データフロー / 比較・関連 / 同一性解決 / ライフサイクル。

同一性解決カテゴリの `SAME_AS` は、表記揺れ等で別ノードになっている2つの Concept を「同一概念」として接続する。
`DESCRIBES` エッジは Reference → Concept の紐づけ専用として CLI が自動で張るため、利用者側で直接扱うことはない。

## 開発

```bash
npm run typecheck   # 型チェック
npm run lint        # biome で静的解析
npm run format      # biome でフォーマット
npm test            # vitest でテスト実行
npm run build       # dist/ にコンパイル
```

## アーキテクチャ

```
src/
├── cli.ts                 # エントリポイント (commander)
├── index.ts               # ライブラリとしてのエクスポート
├── commands/
│   ├── types.ts           # refmesh types
│   ├── register.ts        # refmesh register (Graph + Vector 同期 + メタデータ更新)
│   ├── search.ts          # refmesh search (cosine × freshness × reinforcement の合成スコア)
│   └── archive.ts         # refmesh archive / unarchive / prune
├── db/
│   ├── connection.ts      # Kùzu + LanceDB のハイブリッド接続層
│   ├── schema.ts          # ノード/エッジテーブル DDL
│   ├── vector-store.ts    # LanceDB ラッパ (upsert/query/delete/clear)
│   └── paths.ts           # DB パス解決
├── embedding/
│   └── embedder.ts        # @xenova/transformers で埋め込み生成
├── schema/
│   ├── edge-types.ts      # エッジ Enum と説明 (単一ソース)
│   └── register-schema.ts # JSON Schema (Ajv 用)
└── util/
    ├── errors.ts
    └── logger.ts
```

## ライセンス

MIT
