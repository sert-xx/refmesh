---
name: refmesh-search
description: Use at the start of any task that touches a topic the user has previously asked you to remember, or whenever you suspect prior knowledge exists in the local refmesh graph. Pulls a connected slice of concepts, relationships, and source references through `refmesh search` so you can answer with grounded context instead of guessing.
---

# refmesh-search

Recall what was previously registered before answering or coding.

## When to use

Run this skill **before** doing real work, not after, in any of the following cases:

- The user mentions a domain term, library, or internal name that might already be a Concept (`useState`, `MyService`, `INGEST pipeline`).
- The task description is itself a goal ("safe state management in React", "how do we authenticate jobs?").
- You are about to write code or design something — pull existing decisions and dependencies first to avoid contradicting prior knowledge.
- The user asks "what do we know about X?" or "remind me of X".

Do not run this skill for trivial questions that have nothing to do with stored knowledge (e.g. "what's 2+2"); it costs an embedding call.

## Querying philosophy

- **Goal-based queries.** Pass the natural-language *task*, not a single keyword. The embedder is multilingual MiniLM-L12-v2 — it handles paraphrases. `refmesh search "Reactで安全な状態管理"` is fine and often better than `refmesh search useState`.
- **Pull a mesh, not a node.** Default `--depth 1` traverses one hop, so you receive related concepts and edges around each match. Increase to 2 only when you need transitive context.
- **Trust the score, but read the reasons.** `score` is cosine similarity to the query; `final` is the score after freshness/reinforcement/demotion. The `## Relationships` section of the text output explains *why* two concepts are linked — that is the part agents most often skip but most need.

## Default invocation

```bash
refmesh search "<your goal as a sentence>" --depth 1 --limit 5 --threshold 0.3
```

This is the safe baseline. From here, layer in only the flags that match the situation.

## Situational flags

| When you want… | Add… | Why |
|---|---|---|
| Avoid stale advice (year-old framework guidance is risky) | `--freshness-weight 0.4 --half-life 180` | Decays old concepts exponentially; half-life 180d means ~half score after 6 months |
| Hard cutoff on age | `--max-age 365` | Drops anything older than 1 year outright |
| Penalise concepts that have been deprecated by something newer | `--demote-deprecated 0.3` (already on by default at 0.5) | Multiplies final by this when `(other)-[:DEPRECATES\|REPLACES]->(this)` exists; pass `0` to exclude entirely |
| Bias toward concepts the team uses most | `--reinforcement-weight 0.2` | Up-weights nodes with high `accessCount`. Total `freshness + reinforcement` must be ≤ 1 |
| Include nodes that were explicitly archived | `--include-archived` | Default search hides them |
| Machine-readable output for further processing | `--format json` | Returns the full `SearchResult` shape with `score`, `freshness`, `ageDays`, `finalScore`, `demoted`, `accessCount`, `reinforcement` |

## Reading the result

Text output has four sections. Use them in order:

1. **`## Matched Concepts`** — these are the entry points. Read every `description` and any `details:`. The bracketed metadata `[score=…, fresh=…, final=…]` shows what drove the ranking. A high `final` with a low raw `score` means the concept was promoted by freshness/reinforcement; you may want to inspect the next-ranked concept too.
2. **`## Related Concepts`** — concepts reached by graph traversal from the matched set. Often contains the *real* answer to the user's question even when none of them ranked highly on the embedding.
3. **`## Relationships`** — the labelled edges that connect (1) and (2). This is what makes refmesh different from vector-only retrieval. If a concept appears here as the target of `DEPRECATES` / `REPLACES`, prefer the source concept in your answer.
4. **`## References`** — `Reference.url` values for citation. Use these in your reply when grounding claims.

## Tuning loop

If the first search returns nothing useful:

1. **No matched concepts.** Lower `--threshold` (try `0.1`) before changing the query — the embedder may have placed the user's phrase between two known clusters.
2. **Matched concepts are correct but the relationships are missing.** Increase `--depth` to 2.
3. **Matched concepts are stale.** Re-run with `--freshness-weight 0.5 --max-age 365`.
4. **Too many irrelevant hits.** Raise `--threshold` (try `0.5`–`0.7`) and lower `--limit`.

If a second tuned search still returns nothing, the knowledge probably is not in the graph yet — switch to the `refmesh-register` skill after consulting the source, instead of fabricating an answer.

## Anti-patterns

- **Quoting the user's exact wording when it differs from canonical names.** The embedder bridges the gap; you do not need to guess `id`s.
- **Ignoring the relationships section.** Vector similarity surfaces *similar* things; the graph tells you *causal*, *containing*, or *replacing* things.
- **Using `--depth 3` "to be safe".** Each hop multiplies the result size and dilutes the signal. Use depth 2 only when you have a specific transitive question.
- **Searching for a bare ecosystem-ambiguous term when the graph is namespaced.** Per the `refmesh-register` namespacing rule, generic-sounding ids (`Hooks`, `Skills`, `Sub-agents`, `Routines`, `settings.json`) are stored under their owning product (`Claude Code Hooks`, `Claude Agent SDK Built-in Tools`, etc.). The embedder bridges most of the gap, but if you mean a specific ecosystem in your reply, include it in the query (`refmesh search "Claude Code hooks for PreToolUse blocking"`) — and watch the matched ids: hits like `Claude Code Hooks` and `Claude Agent SDK Hooks` are *different concepts* even when the bare word would have collapsed them.
- **Not citing the references.** When you give the user an answer derived from search results, name the `References` URLs so they can verify.
