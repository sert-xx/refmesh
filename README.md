# refmesh

自律型コーディングエージェント（Claude Code 等）向けの **ハイブリッド・ナレッジグラフ構築CLI**。
公式ドキュメントやリファレンスから抽出した「概念（ノード）」と「関係性（エッジ）」を、
1 ファイルの [SQLite](https://www.sqlite.org/) DB に保存し、
ベクトル意味検索 + BM25 全文検索 + グラフ探索を同時に行える。

- **Storage:** `better-sqlite3` 単一 DB ファイル (`~/.refmesh/refmesh.db`)。`PRAGMA journal_mode=WAL` + 外部キー有効。
- **Vector index:** インメモリ Float32Array + 正規化済みコサイン類似度（起動時に SQLite から読み出し）。
- **Full-text:** SQLite **FTS5** (Okapi BM25, 多言語 `unicode61 remove_diacritics 2` トークナイザ)。
- **Graph traversal:** edges テーブルへの BFS（公開エッジ種別ごとに depth 階層展開）。
- **Embedding:** `@xenova/transformers` + `Xenova/paraphrase-multilingual-MiniLM-L12-v2`（多言語384次元）。
  Python 依存なしで Node.js プロセス内でベクトルを生成。

## インストール

### 利用者向け（CLI として使う）

npm から直接グローバルインストールする:

```bash
npm install -g refmesh
refmesh --help
refmesh types          # 動作確認
```

> [!IMPORTANT]
> **既存ユーザーへの注意 (PBI-18 で SQLite に統合):** 旧バージョン (Kùzu + LanceDB) のローカル DB (`~/.refmesh/graph.kuzu` および `~/.refmesh/vectors.lance`) との互換性はありません。アップグレード後は両ディレクトリを削除し、`refmesh register` で再投入してください。新 DB は `~/.refmesh/refmesh.db` 1 ファイルにまとまります。
>
> `better-sqlite3` はネイティブビルドが必要ですが、メジャー OS / Node.js バージョン向けにプリビルトが配布されているため通常は `npm install` だけで完了します。
>
> 初回 `refmesh search` 実行時に Hugging Face Hub から多言語埋め込みモデル（約 80 MB）を `~/.refmesh/models/` に取得する。以降はオフライン動作。
>
> **書き込み権限が制限された環境（Codex 等のサンドボックス CLI）から refmesh を呼び出す場合**、当該環境では `~/.refmesh/models/` への書き込みに失敗してモデル読み込みが詰まる。事前に書き込み権限のあるユーザで `refmesh prefetch` を実行してモデルを配置しておけば、以降の `refmesh search` / `register` は読み取りのみで動作する。配置先を変更したい場合は環境変数 `REFMESH_MODEL_DIR` で上書きできる（事前 DL とランタイムの双方で同じ値を渡すこと）。

### 開発者向け（このリポジトリで作業する）

```bash
mise install      # mise.toml にピンされた Node.js 22 (arm64) を取得
npm install
npm run build
npm run dev -- types          # tsx で直接実行
# あるいはローカルビルドをグローバルに公開
npm link && refmesh --help
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
- `--lexical-weight <0..1>`: クエリ語と id/description/details のトークン一致による語彙ブースト（デフォルト: 0.3、cosine と独立した加点軸）
- `--bm25-weight <0..1>`: SQLite FTS5 (BM25) による全文検索ブースト（デフォルト: 0.3、cosine と独立した加点軸）
- `--include-archived`: アーカイブ済みノードも結果に含める
- `--format <text|json>`: 出力形式（デフォルト: text）

最終スコアは `final = max(0, 1 - w_f - w_r - w_l - w_b) · cosine + w_f · freshness + w_r · reinforcement + w_l · lexical + w_b · bm25`（`demoted` のときは更に `demoteDeprecated` 倍）。
候補集合はベクトル top-K と FTS5 top-K の **和集合** で取り、両方の score を Concept 単位でマージしてから再ランクするので、片方の retriever にしかヒットしない概念も拾えます。
`freshness = exp(-ln2 · age / halfLife)` で、`age` は `Reference.publishedAt` の最新値（無ければ `Concept.lastSeenAt`）から算出。

#### 登録時の重複検知

`register` は新規 Concept の embedding を既存 Vector Store と照合し、類似度 ≥ 0.95 の既存ノードがあれば
サマリに `⚠ Similar existing concepts` として警告する。エージェントはこれを受けて、新規ノード作成を止めて
既存 id を再利用するか、`SAME_AS` エッジで接続するか判断する。

### 4. グラフDBの状態をブラウザで確認（console）

`refmesh console` でローカル Web ダッシュボードを起動し、ブラウザでグラフを視覚的に点検できる。
**読み取り専用**で、ループバック (`127.0.0.1`) のみ受け付ける。Python 依存はゼロ。

```bash
refmesh console                # 空きポートに自動バインドし、既定ブラウザで開く
refmesh console --port 8765    # ポートを固定
refmesh console --no-open      # ブラウザを開かず URL だけ表示
```

ダッシュボードのタブ構成:

- **Overview**: Concept / Reference / Edge 件数、Edge type 別の分布、Kùzu / LanceDB のパスとサイズ。
- **Concepts**: 一覧 + ページング + ソート (lastSeenAt / touchCount / id)。`archived` も任意で表示。
- **Search**: 自然言語クエリで `refmesh search` 相当のスコアリング検索を実行。
- **Search Debug**: 検索パイプラインを段階別に可視化。クエリ埋め込みの形状 (dim / L2ノルム / 全次元プレビュー)、LanceDB に投げた `oversample` と `threshold` 前の全ベクトルヒット (棄却分含む)、Kùzu に発行された Cypher 一覧、各候補のスコア内訳 (cosine / freshness / reinforcement / final と除外理由)、近傍展開の各 level のフロンティア・追加 edge 数を表示する。`accessCount` を更新しない読み取り専用。
- **Graph**: 起点 Concept を指定するとグラフを描画。**ノードクリックで近傍を増分展開**でき、Edge type ごとに色分けされる。

`Ctrl+C` で停止し、Kùzu / LanceDB のコネクションをクリーンに閉じる。

### 5. 古い知識の整理（archive / prune）

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

## エージェントから自動運用する（スキル同梱）

`example/skills/` に **Claude Code と OpenAI Codex CLI 両対応**のスキルを 3 つ同梱している。
シーン別にトリガーが分かれており、フォルダごと `~/.claude/skills/` または `~/.codex/skills/` にコピーするだけで利用できる。

| スキル | 起動シーン | 中身 |
|---|---|---|
| `refmesh-register` | 「この URL を分析して知識を蓄えて」「remember this doc」 | URL を fetch → 概念抽出 → 既存グラフを `refmesh search` で discovery → 既存ノードに edge で接続して `refmesh register` |
| `refmesh-search` | タスク開始時、固有名詞・目的が登場した瞬間 | 自然言語クエリで意味検索 + マルチ起点 BFS。鮮度・demote・reinforcement 等の状況別フラグ表を提供 |
| `refmesh-curate` | `⚠ Similar existing concepts` 警告、世代交代、古い情報の整理 | SAME_AS マージ / REPLACES / DEPRECATES / archive / prune の判断ツリー |

各スキルは `SKILL.md`（Claude / Codex 共通）と `agents/openai.yaml`（Codex の UI メタデータ）の組み合わせ。

### 取り込み方法

```bash
# Claude Code（プロジェクト固有）
mkdir -p .claude/skills && cp -r example/skills/refmesh-* .claude/skills/

# Claude Code（ユーザー全体）
mkdir -p ~/.claude/skills && cp -r example/skills/refmesh-* ~/.claude/skills/

# OpenAI Codex CLI
mkdir -p ~/.codex/skills && cp -r example/skills/refmesh-* ~/.codex/skills/
```

取り込み後、エージェントに「この URL を読んで知識を蓄えて」「先ほど登録した React Hooks について教えて」のように話しかけると、`description` のトリガーキーワードに反応して該当スキルが呼び出され、内部で `refmesh` CLI が実行される。

## データ格納先

- DB (SQLite) デフォルト: `~/.refmesh/refmesh.db` / 上書き: `REFMESH_DB_PATH`
- 埋め込みモデルキャッシュ デフォルト: `~/.refmesh/models/` / 上書き: `REFMESH_MODEL_DIR`

埋め込みモデルキャッシュは初回 `refmesh search` / `register` 実行時に自動で作られるが、
`refmesh prefetch` で明示的に事前 DL することもできる（権限制限された実行環境向け）。

```bash
refmesh prefetch                      # ~/.refmesh/models/ に配置（既配置ならスキップ）
refmesh prefetch --format json        # 機械可読出力
REFMESH_MODEL_DIR=/opt/refmesh/models refmesh prefetch   # 配置先を上書き
```

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
│   ├── archive.ts         # refmesh archive / unarchive / prune
│   ├── console.ts         # refmesh console (ローカル Web ダッシュボード)
│   └── prefetch.ts        # refmesh prefetch (埋め込みモデルの事前 DL / 配置)
├── console/
│   ├── handlers.ts        # 読み取り専用 API (stats / concepts / neighbors / search)
│   └── server.ts          # loopback 限定の HTTP サーバ + 静的アセット配信
├── db/
│   ├── connection.ts      # Kùzu + LanceDB のハイブリッド接続層
│   ├── schema.ts          # ノード/エッジテーブル DDL
│   ├── vector-store.ts    # LanceDB ラッパ (upsert/query/delete/clear)
│   └── paths.ts           # DB パス解決
├── embedding/
│   ├── embedder.ts        # @xenova/transformers で埋め込み生成 / prefetchEmbeddingModel()
│   └── paths.ts           # モデルキャッシュパス解決 (~/.refmesh/models/, REFMESH_MODEL_DIR)
├── schema/
│   ├── edge-types.ts      # エッジ Enum と説明 (単一ソース)
│   └── register-schema.ts # JSON Schema (Ajv 用)
└── util/
    ├── errors.ts
    └── logger.ts
```

## ライセンス

MIT
