**English | [日本語](./README.ja.md)**

# refmesh

A **hybrid knowledge-graph CLI** for autonomous coding agents (Claude Code, OpenAI Codex CLI, etc.).
Extracts "concepts (nodes)" and "relationships (edges)" from official docs and references, stores
them in a single-file [SQLite](https://www.sqlite.org/) database, and serves
vector semantic search + BM25 full-text search + graph traversal — all from one process.

- **Storage:** `better-sqlite3` single DB file (`~/.refmesh/refmesh.db`), with `PRAGMA journal_mode=WAL` and foreign keys enabled.
- **Vector index:** In-memory `Float32Array` with normalized cosine similarity, hydrated from SQLite at startup.
- **Full-text:** SQLite **FTS5** (Okapi BM25) with the multilingual `unicode61 remove_diacritics 2` tokenizer.
- **Graph traversal:** BFS over the `edges` table, expanded `depth` levels per public edge type.
- **Embeddings:** `@xenova/transformers` + `Xenova/paraphrase-multilingual-MiniLM-L12-v2` (multilingual, 384-dim).
  Vectors are generated inside the Node.js process — no Python dependency.

## Installation

### For users (use as a CLI)

Install globally from npm:

```bash
npm install -g refmesh
refmesh --help
refmesh types          # smoke test
```

> [!IMPORTANT]
> **Note for existing users (storage unified to SQLite in PBI-18):** Older versions used Kùzu + LanceDB at `~/.refmesh/graph.kuzu` and `~/.refmesh/vectors.lance`. There is **no compatibility** with that data — after upgrading, delete both directories and re-run `refmesh register`. The new database lives in a single file at `~/.refmesh/refmesh.db`.
>
> `better-sqlite3` requires a native build, but prebuilt binaries are published for major OS / Node.js combinations, so plain `npm install` usually works without a toolchain.
>
> On the first `refmesh search`, the multilingual embedding model (~80 MB) is downloaded from the Hugging Face Hub to `~/.refmesh/models/`. After that, refmesh runs offline.
>
> **When invoking refmesh from a sandboxed CLI with restricted write access (e.g., Codex CLI),** writes to `~/.refmesh/models/` will fail and the model loader will hang. Pre-populate the cache with `refmesh prefetch` from a user that *can* write — subsequent `refmesh search` / `register` will then run read-only against the cache. Override the location with the `REFMESH_MODEL_DIR` environment variable (pass the same value at prefetch time and at runtime).

### For developers (working in this repo)

```bash
mise install      # fetch the Node.js 22 (arm64) version pinned in mise.toml
npm install
npm run build
npm run dev -- types          # run directly via tsx
# or expose your local build globally
npm link && refmesh --help
```

## Usage

### 1. Inspect the schema and edge types

```bash
refmesh types
# or as machine-readable JSON
refmesh types --format json
```

### 2. Register knowledge

Pipe JSON in:

```bash
cat knowledge.json | refmesh register
```

Or pass a file path:

```bash
refmesh register -f knowledge.json
```

Example payload (`publishedAt` / `fetchedAt` are optional, but strongly recommended if you plan to use freshness scoring):

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
      "description": "A Hook that lets you add a state variable to a component.",
      "details": "const [state, setState] = useState(initialState);"
    },
    { "id": "React Hooks", "description": "Built-in hooks for React state and lifecycle features." }
  ],
  "relationships": [
    {
      "source": "useState",
      "target": "React Hooks",
      "type": "PART_OF",
      "reason": "useState is one of the standard hooks shipped by React."
    }
  ]
}
```

Re-running `register` updates the concept's `lastSeenAt` and increments `touchCount` automatically (`firstSeenAt` is preserved).

### 3. Search

Queries are natural language. They are embedded, used to pick seed concepts, then expanded `--depth` levels through the graph to return a related cluster of knowledge.

```bash
refmesh search "Safe state management in React"           # natural-language query → semantic search → depth=1 expansion
refmesh search "React Hooks" --depth 2 --limit 10         # walk 2 hops, take up to 10 vector candidates
refmesh search "useState" --threshold 0.7 --format json   # only similarity ≥ 0.7, JSON output
```

Options:

- `--depth <n>`: graph traversal depth (default: `1`)
- `--limit <n>`: maximum number of seed candidates from vector search (default: `5`)
- `--threshold <value>`: minimum similarity threshold, `[0, 1]` (default: `0.3`)
- `--freshness-weight <0..1>`: weight of freshness in the final score (default: `0` — freshness ignored)
- `--half-life <days>`: freshness half-life (default: `180`)
- `--max-age <days>`: drop nodes older than this from results (default: unlimited)
- `--demote-deprecated <0..1>`: multiplier applied to targets of `DEPRECATES` / `REPLACES` (default: `0.5`; use `0` to exclude)
- `--reinforcement-weight <0..1>`: weight of access-count reinforcement (default: `0`; freshness + reinforcement ≤ 1)
- `--lexical-weight <0..1>`: lexical boost from token overlap against `id` / `description` / `details` (default: `0.3`; independent of cosine)
- `--bm25-weight <0..1>`: full-text boost from SQLite FTS5 / BM25 (default: `0.3`; independent of cosine)
- `--include-archived`: include archived nodes in results
- `--format <text|json>`: output format (default: `text`)

The final score is `final = max(0, 1 − w_f − w_r − w_l − w_b) · cosine + w_f · freshness + w_r · reinforcement + w_l · lexical + w_b · bm25` (multiplied additionally by `demoteDeprecated` when the candidate is `demoted`).
The candidate set is the **union** of vector top-K and FTS5 top-K, merged per concept and re-ranked, so concepts that only one retriever surfaces are still picked up.
`freshness = exp(−ln2 · age / halfLife)`, where `age` is computed from the latest `Reference.publishedAt` (falling back to `Concept.lastSeenAt`).

#### Duplicate detection at registration

`register` compares each new concept's embedding against the existing vector index. If any existing node has similarity ≥ 0.95, the run prints `⚠ Similar existing concepts` in the summary. Agents should treat this as a signal to stop creating a new node and instead reuse the existing id, or connect the two with a `SAME_AS` edge.

### 4. Inspect the graph in the browser (`refmesh console`)

`refmesh console` starts a local web dashboard so you can visually inspect the graph. It is **read-only** and accepts loopback (`127.0.0.1`) connections only. There are no Python dependencies.

```bash
refmesh console                # bind to a free port and open the default browser
refmesh console --port 8765    # pin a port
refmesh console --no-open      # just print the URL, don't launch a browser
```

Dashboard tabs:

- **Overview**: counts of Concepts / References / Edges, edge-type distribution, plus the SQLite DB path, file size, and vector row count.
- **Concepts**: paginated list with sorting (`lastSeenAt` / `touchCount` / `id`); archived rows can be toggled in.
- **Search**: run the same scored search as `refmesh search` against natural-language queries.
- **Search Debug**: stage-by-stage view of the search pipeline — query embedding shape (dim / L2 norm / full-vector preview), the `oversample` / `threshold` settings sent to the vector index along with **all** vector hits before threshold filtering (including rejected ones), the SQL queries issued to the graph during traversal, the per-candidate score breakdown (`cosine` / `freshness` / `reinforcement` / `lexical` / `bm25` / `final` and any exclusion reason), and per-level frontier and added-edge counts. Read-only — does not bump `accessCount`.
- **Graph**: pick a seed concept and render the graph. **Click a node to expand its neighborhood incrementally**; edges are color-coded by edge type.

`Ctrl+C` stops the server and cleanly closes the SQLite handle (statement cache + db).

### 5. Curate stale knowledge (archive / prune)

```bash
# Logical archive — excluded from search, recoverable
refmesh archive OldUseState --reason "replaced by hooks"
refmesh unarchive OldUseState

# Physical delete — dry-run by default
refmesh prune --older-than 365 --max-touches 1
refmesh prune --older-than 365 --max-touches 1 --apply
```

`prune` deletes concepts whose `lastSeenAt` is older than the cutoff and whose `touchCount` is `<= --max-touches`, removing them from both the concept tables and the vector index.
By default archived concepts are excluded; pass `--include-archived` to include them. Nothing is changed unless `--apply` is given.

## Driving refmesh from agents (bundled skills)

`example/skills/` ships three skills that work for **both Claude Code and OpenAI Codex CLI**.
Each is triggered by a different scenario; copy the folder into `~/.claude/skills/` or `~/.codex/skills/` to start using them.

| Skill | Trigger | What it does |
|---|---|---|
| `refmesh-register` | "Analyze this URL and remember it", "remember this doc" | Fetch URL → extract concepts → discover existing graph via `refmesh search` → connect to existing nodes with edges and call `refmesh register` |
| `refmesh-search` | At task start, the moment a proper noun or goal appears | Natural-language semantic search + multi-seed BFS, with a situational flag table for freshness / demote / reinforcement |
| `refmesh-curate` | On a `⚠ Similar existing concepts` warning, generational handoff, stale-knowledge cleanup | Decision tree for `SAME_AS` merge / `REPLACES` / `DEPRECATES` / archive / prune |

Each skill is a `SKILL.md` (shared by Claude and Codex) plus `agents/openai.yaml` (Codex UI metadata).

### Installation

```bash
# Claude Code (project-scoped)
mkdir -p .claude/skills && cp -r example/skills/refmesh-* .claude/skills/

# Claude Code (user-wide)
mkdir -p ~/.claude/skills && cp -r example/skills/refmesh-* ~/.claude/skills/

# OpenAI Codex CLI
mkdir -p ~/.codex/skills && cp -r example/skills/refmesh-* ~/.codex/skills/
```

Once installed, prompts like "Read this URL and remember it" or "Tell me about the React Hooks I just registered" will match the skill's `description` triggers and invoke the corresponding skill, which in turn calls the `refmesh` CLI.

## Storage paths

- DB (SQLite) — default: `~/.refmesh/refmesh.db` / override: `REFMESH_DB_PATH`
- Embedding model cache — default: `~/.refmesh/models/` / override: `REFMESH_MODEL_DIR`

The embedding model cache is created automatically on the first `refmesh search` / `register`,
or can be populated explicitly via `refmesh prefetch` (useful for permission-restricted runtimes):

```bash
refmesh prefetch                      # populate ~/.refmesh/models/ (skipped if already present)
refmesh prefetch --format json        # machine-readable output
REFMESH_MODEL_DIR=/opt/refmesh/models refmesh prefetch   # override the cache location
```

## Edge types

15 public edge types are exposed (list them with `refmesh types`).
Categories: structural / dependency / data flow / comparison / identity resolution / lifecycle.

`SAME_AS` (identity-resolution) connects two concepts that ended up as separate nodes due to naming variation but really refer to the same thing.
`DESCRIBES` is reserved for the CLI's own `Reference → Concept` linking and is never written by users directly.

## Development

```bash
npm run typecheck   # type checking
npm run lint        # static analysis with biome
npm run format      # format with biome
npm test            # run tests with vitest
npm run build       # compile to dist/
```

## Architecture

```
src/
├── cli.ts                 # entry point (commander)
├── index.ts               # library exports
├── commands/
│   ├── types.ts           # refmesh types
│   ├── register.ts        # refmesh register (synchronized Concept + Vector + FTS updates)
│   ├── search.ts          # refmesh search (composite cosine + freshness + reinforcement + lexical + bm25 score)
│   ├── archive.ts         # refmesh archive / unarchive / prune
│   ├── console.ts         # refmesh console (local web dashboard)
│   └── prefetch.ts        # refmesh prefetch (embedding model pre-download / placement)
├── console/
│   ├── handlers.ts        # read-only API (stats / concepts / neighbors / search / search-debug)
│   ├── server.ts          # loopback-only HTTP server + static asset serving
│   └── index.ts
├── db/
│   ├── store.ts           # SQLite connection layer (better-sqlite3 + statement cache + WAL)
│   ├── migrations.ts      # schema DDL and migrations
│   ├── concept-repo.ts    # CRUD for Concept / Reference / Edge
│   ├── graph.ts           # BFS / frontier expansion over the edges table
│   ├── fts.ts             # FTS5 virtual table build + queries
│   ├── vector-index.ts    # in-memory Float32Array vector index
│   ├── statement-cache.ts # prepared-statement cache
│   └── paths.ts           # DB path resolution (~/.refmesh/refmesh.db, REFMESH_DB_PATH)
├── embedding/
│   ├── embedder.ts        # embedding generation via @xenova/transformers / prefetchEmbeddingModel()
│   └── paths.ts           # model cache path resolution (~/.refmesh/models/, REFMESH_MODEL_DIR)
├── schema/
│   ├── edge-types.ts      # edge enum + descriptions (single source of truth)
│   └── register-schema.ts # JSON Schema (for Ajv)
└── util/
    ├── errors.ts
    └── logger.ts
```

## License

MIT
