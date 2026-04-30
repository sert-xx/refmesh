---
name: refmesh-register
description: Use when the user asks you to fetch / open / analyze / summarize a URL, documentation page, blog post, paper, RFC, or codebase fragment and remember / store / shelve / 蓄積 / 覚えて its concepts. Fetches the source if a URL is given, extracts concepts and typed relationships, links them to concepts that already exist in the local refmesh graph, and persists everything through `refmesh register` so later sessions can recall it through `refmesh search`.
---

# refmesh-register

Persist what you just read into the local knowledge graph so future sessions can find it.

## When to use

Trigger this skill whenever the user wants you to absorb a source into long-term knowledge, including:

- A bare URL with instructions like "analyze and remember", "URLを分析して知識を蓄えて", "shelve this"
- Official docs / API references / RFCs
- Long-form articles or papers
- Internal design documents and meeting notes
- Code modules whose architecture is worth describing in prose
- Anything the user explicitly says "remember this" or "store this for later"

Skip this skill if the source has no durable value (e.g. one-off log output, ephemeral chat).

## Step 0 — Fetch the source if only a URL was given

If the user supplied a URL (and not the rendered text), retrieve the content first:

- **Claude Code**: use the `WebFetch` tool with the URL.
- **Codex CLI**: shell out, e.g. `curl -sSL "$URL" | sed 's/<[^>]*>//g' | head -c 200000` (or use a richer fetcher available in the environment).
- **Either**: if the source is a private or auth-gated resource the agent cannot reach, ask the user to paste the relevant text.

Read the fetched body end-to-end before extracting concepts. Do not extract while still streaming through the document — cross-references are easy to miss otherwise.

## Pre-flight

Run once per source:

```bash
refmesh types --format json
```

Read back the `edgeTypes` array and the `registerInputSchema`. **Never invent edge types** — the schema enforces the enum. The 15 public edges fall into 6 categories: structure (IS_A / PART_OF / CONTAINS), dependency (DEPENDS_ON / IMPLEMENTS / EXTENDS), dataflow (CONSUMES / PRODUCES / MUTATES), comparison (ALTERNATIVE_TO / INTEGRATES_WITH / RELATED_TO), identity (SAME_AS), lifecycle (REPLACES / DEPRECATES).

## Authoring rules

1. **Extract the subject matter, not the document.** A `Concept` represents a *thing the source talks about* (an API, an algorithm, a protocol, a design pattern, a system component) — **not the source itself**. The document/page/article is captured by `reference` (url, title, publishedAt); never duplicate it as a `Concept`. Ask "what would a future reader search for?" — they will search for `useEffect`, not for "the React useEffect documentation page".
   - ❌ Bad: `{ "id": "useEffect docs", "description": "This page explains the useEffect hook." }` — describes the document.
   - ✅ Good: `{ "id": "useEffect", "description": "React Hook that synchronizes a function component with an external system." }` — describes the subject.
   - If a source genuinely *is* the artifact worth remembering (e.g. a specific RFC that is itself referenced by name like "RFC 7519"), the canonical id is the artifact's name (`RFC 7519`, `JWT`), not a meta-label like "RFC 7519 specification document".
2. **Descriptions state facts about the subject, not about the source.** Write `description` as if defining the concept in a glossary. Avoid phrases like "This document describes…", "The article explains…", "This page covers…" — they are signals you are describing the source instead of the subject.
3. **Canonical ids.** Use the official, public name as `Concept.id` (`useState`, not `useStateHook` or `the useState hook`). This makes future agents reach the same node.
4. **Namespace ambiguous names with the owning vendor / product.** When the canonical name of a concept could plausibly exist in multiple ecosystems — `Hooks`, `Skills`, `Sub-agents`, `Slash Commands`, `Agent Tool`, `settings.json`, `Routines` — prefix the id with the owning vendor / product (`Claude Code Hooks`, not bare `Hooks`; `Claude Agent SDK Built-in Tools`, not bare `Built-in Tools`). This keeps a future ecosystem (Codex, Cursor, etc.) from colliding with the existing ones. Skip the prefix when **any** of the following holds:
   - The canonical name already contains the owning vendor / product (`Claude Agent SDK`, `CLAUDE.md`, `Claude Code Desktop App`).
   - The id is a fully-qualified file path or package identifier that is unambiguous on its own (`~/.claude/settings.json`, `.mcp.json`, `SKILL.md`, `@anthropic-ai/claude-agent-sdk`).
   - The concept is a cross-ecosystem standard owned by a separate body (`MCP`, `OAuth 2.0`, `HTTP Transport`, `JWT`, `RFC 7519`).
   - The id is itself a vendor name or third-party product (`Anthropic API`, `Amazon Bedrock`, `Google Vertex AI`, `useState`).

   | Bare canonical | Prefix needed? | Final id |
   |---|---|---|
   | `Hooks` (Claude Code feature) | yes | `Claude Code Hooks` |
   | `/init` (slash command) | yes | `Claude Code /init` |
   | `Built-in Tools` (Agent SDK) | yes | `Claude Agent SDK Built-in Tools` |
   | `useState` (React) | no — 3rd-party canonical | `useState` |
   | `MCP` | no — cross-ecosystem standard | `MCP` |
   | `.mcp.json` | no — file path | `.mcp.json` |
   | `Anthropic API` | no — vendor name | `Anthropic API` |

5. **One sentence description, code in details.** `description` is what the embedder sees most strongly — keep it specific and self-contained. Put runnable snippets, signatures, or long quotes in `details`.
6. **Build a mesh, not a list.** Every concept must connect to at least one other concept via a relationship if such a connection exists in the source. Isolated nodes are nearly useless to retrieve.
7. **Reuse existing nodes (see "Connect to existing knowledge" below).** Always probe the graph before inventing a new id; reuse the canonical one whenever it already exists.
8. **Date the source.** Set `reference.publishedAt` to the document's published date if known (ISO 8601). This unlocks freshness scoring later.

## Connect to existing knowledge

Brand-new concepts are useful, but the real value of refmesh is the **edges** between what you just read and what was registered before. Always run this discovery loop before writing the payload.

1. **List the candidate ids you might extract** from the source (canonical names: `useEffect`, `Server Components`, …).

2. **Probe each candidate** against the existing graph:

   ```bash
   refmesh search "useEffect React effect hook" --depth 0 --limit 3 --threshold 0.5
   ```

   Use the natural-language description, not just the bare id, so semantic matches surface even with different wording.

3. **Classify each result**:

   | Result | Action |
   |---|---|
   | Exact same concept already exists with the canonical id you intended | **Drop it from `concepts[]`** in the new payload, but keep the id usable as `relationships.target` (see step 4). |
   | Closely related concept exists (e.g. you're registering `useEffect`, the graph has `React Hooks`) | **Keep your new concept, and add a relationship pointing at the existing id.** |
   | Near-duplicate with a different id (`useState` vs `UseStateHook`) | **Reuse the existing canonical id.** If the user truly needs both surfaces, register only the new one and add a `SAME_AS` edge. |
   | No hit | The concept is genuinely new — register it. |

4. **A relationship target does not need to be in `concepts[]`.** `executeRegister` resolves every `source` and `target` against (a) the new `concepts` array first, then (b) the existing graph. So an edge like

   ```json
   { "source": "useEffect", "target": "React Hooks", "type": "PART_OF", "reason": "useEffect is one of the built-in hooks." }
   ```

   is valid even if `React Hooks` is not in the new `concepts` array, **as long as `React Hooks` already exists in the graph**. If neither holds, validation fails with exit 2 (`Unresolved concept references`).

5. **Read the `⚠ Similar existing concepts` warnings in the register output** the same way as discovery results — they are the system's last-line check that you did not accidentally re-create something. See the [Procedure](#procedure) section step 6.

## Procedure

1. **Fetch** the source if only a URL was given (Step 0).
2. **Read the whole source** before extracting. Do not extract incrementally — you will miss cross-references.
3. **List candidate concepts** (3–15 per source is typical). Extract the *subjects the source talks about* — APIs, components, algorithms, protocols, patterns — **not the source itself**. If your candidate list contains an entry like "this article", "the documentation", or "<title> page", strike it: that belongs in `reference`, not `concepts[]`. Drop anything that is just an example, a typo, or already covered by an existing concept.
4. **Run the discovery loop in [Connect to existing knowledge](#connect-to-existing-knowledge)** to find which candidates are already in the graph and which existing nodes the new ones should link to.
5. **For every ordered pair** (new ↔ new, and new ↔ existing), ask "is there a labelled relationship from the schema that holds in the source?" If yes, record it with a one-sentence `reason`. Edges to existing nodes are just as valuable as edges between new nodes — they are what turns the graph into a *mesh*.
6. **Write the JSON payload** to a temp file. The example below registers a *new* concept (`useEffect`) and links it to two ids: one new (`Side Effects`) and one already-known (`React Hooks`, present in the graph from a prior session, **not** repeated in `concepts[]`):

   ```bash
   cat > /tmp/refmesh-payload.json <<'JSON'
   {
     "reference": {
       "url": "https://react.dev/reference/react/useEffect",
       "title": "useEffect — React",
       "publishedAt": "2026-03-15T00:00:00Z"
     },
     "concepts": [
       {
         "id": "useEffect",
         "description": "React Hook that synchronizes a function component with an external system.",
         "details": "useEffect(setup, dependencies?)"
       },
       {
         "id": "Side Effects",
         "description": "Operations that affect something outside the rendered output (subscriptions, network, DOM)."
       }
     ],
     "relationships": [
       {
         "source": "useEffect",
         "target": "React Hooks",
         "type": "PART_OF",
         "reason": "useEffect is one of the built-in React hooks."
       },
       {
         "source": "useEffect",
         "target": "Side Effects",
         "type": "PRODUCES",
         "reason": "useEffect runs side-effectful setup/teardown."
       }
     ]
   }
   JSON
   ```

   `React Hooks` is **resolved against the existing graph** at register time, so you do not need to redeclare it. If it does not exist yet, `executeRegister` will exit 2 with `Unresolved concept references`; in that case, add it to `concepts[]` (with a description from your source) and re-submit.

7. **Submit**:

   ```bash
   refmesh register -f /tmp/refmesh-payload.json
   ```

8. **Read the summary** — treat the following as actionable, not informational:
   - **`⚠ Similar existing concepts`** — open the suggested existing id and decide: (a) reuse it instead and re-register without the duplicate, or (b) keep both and add a `SAME_AS` edge so future searches find them together. See the `refmesh-curate` skill for the merge workflow.
   - **`Vectors upserted: N`** mismatched with `Concepts upserted` — investigate the warning above the summary.

9. **Verify** with one targeted search before declaring done:

   ```bash
   refmesh search "<a phrase from one of the descriptions>" --depth 1 --limit 3
   ```

   The new concepts should appear in `matchedConcepts` or `relatedConcepts`, ideally connected via your new edges to the previously-existing nodes you targeted.

## Common mistakes

- **Registering the document itself as a concept.** Symptoms: a `Concept.id` like `"useEffect docs"` / `"the React tutorial"`, or a `description` starting with "This document…", "This page explains…", "The article covers…". The source is captured by `reference`; `concepts[]` must hold the *subjects discussed in* the source. Future searches like `refmesh search "useEffect"` will not match a node whose description is about a documentation page.
- **Registering an ecosystem-specific feature with a bare generic id (`Hooks`, `Skills`, `Agent Tool`, `Routines`).** When the same name could plausibly belong to a different ecosystem in the future, prefix it (`Claude Code Hooks`, `Claude Agent SDK Built-in Tools`); see [Authoring rule 4](#authoring-rules). If you find a bare-id duplicate after the fact, hand off to `refmesh-curate`.
- **Inventing edge types.** Anything outside the 15 public types fails validation with exit 2.
- **Empty `relationships`.** If the source actually contains relationships, registering an island of disconnected concepts wastes registration budget.
- **Skipping the discovery loop.** Failing to probe with `refmesh search` before authoring the payload causes duplicates and orphan islands. The graph stays a list instead of a mesh.
- **Re-declaring an existing concept in `concepts[]`** just so the relationship resolves. Existing ids are resolvable as `relationships.target` directly; redeclaring them only causes spurious `touchCount` increments and noisy similarity warnings.
- **Per-paragraph register calls.** Embedding cost and similarity warnings only make sense when the concepts are submitted together. Batch one source into one call.
- **Re-register with a different id for the same concept.** Always re-use existing canonical ids; otherwise `refmesh-curate` will have to clean up duplicates.

## Exit codes

- `0` — registered successfully (warnings still possible in stdout).
- `2` — input validation failed (bad JSON, unknown edge type, unresolved relationship target). Re-read the stderr `- ` bullets and fix the payload.
- `1` — runtime failure (DB or vector store unreachable). Surface the error to the user; do not retry blindly.
