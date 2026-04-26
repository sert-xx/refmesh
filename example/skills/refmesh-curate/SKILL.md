---
name: refmesh-curate
description: Use whenever a `refmesh register` summary surfaces a `⚠ Similar existing concepts` warning, when search results show clearly outdated or duplicated knowledge, or when the user asks to clean up / forget / merge concepts. Covers the four lifecycle moves — SAME_AS merging, REPLACES/DEPRECATES tagging, archive (logical hide), and prune (physical delete).
---

# refmesh-curate

Keep the graph honest as the world (and your understanding) changes.

## When to use

Branch into this skill from any of these triggers:

- A `refmesh register` summary printed `⚠ Similar existing concepts: A ≈ B (score=…)`.
- A `refmesh search` result contains two concepts that mean the same thing under different ids.
- A new technology obsoletes an existing concept (React class lifecycle → hooks, callback APIs → promises, etc.).
- The user explicitly says "this is wrong / outdated / never use this anymore".
- Periodic maintenance (e.g. quarterly) to prune cold knowledge.

## Decision tree

```
Are A and B the same concept under different ids?
├─ YES → MERGE (SAME_AS edge, optionally re-register canonical id)
└─ NO
   Is A a newer version that should be preferred over B?
   ├─ YES, A fully replaces B → REPLACES edge from A to B
   ├─ YES, B is discouraged but still functional → DEPRECATES edge from A to B
   └─ NO
      Should the concept still appear in default searches?
      ├─ NO, but keep it for history → archive
      └─ NO, and it's truly garbage → prune
```

The four moves are described below with exact commands.

---

## Move 1 — Merge duplicates (SAME_AS)

When two concepts denote the same idea (`useState` and `UseStateHook`, `Postgres` and `PostgreSQL`):

1. Pick the **canonical** id — the official, public, most-searched form.
2. Re-register the canonical id with full description/details/relationships if its content is incomplete.
3. Add a `SAME_AS` edge between the two so future searches surface both:

   ```bash
   cat > /tmp/same-as.json <<'JSON'
   {
     "reference": {
       "url": "https://example.com/canonical-source",
       "title": "Canonical reference for the merged concept"
     },
     "concepts": [
       {"id": "useState", "description": "React state hook (canonical)."},
       {"id": "UseStateHook", "description": "Alias used by older agent runs."}
     ],
     "relationships": [
       {
         "source": "UseStateHook",
         "target": "useState",
         "type": "SAME_AS",
         "reason": "Different surface ids for the same React API."
       }
     ]
   }
   JSON
   refmesh register -f /tmp/same-as.json
   ```

4. (Optional) Archive the non-canonical id once you're confident downstream callers use the canonical one — see Move 3.

`SAME_AS` is bidirectional in meaning but unidirectional in the graph. Convention: `SAME_AS` from the *non-canonical* to the *canonical* node, so traversals from a search hit to canonical knowledge are one hop.

---

## Move 2 — Mark version transitions (REPLACES / DEPRECATES)

When the underlying technology evolved:

- Use **REPLACES** when the new concept is a strict, recommended successor (`React.createElement` → `JSX`, `Promise.then chains` → `async/await`).
- Use **DEPRECATES** when the old concept is officially discouraged but still present in many codebases (`componentWillMount` deprecated by newer lifecycle guidance).

Both edges automatically demote the old concept in `refmesh search` results (default `--demote-deprecated 0.5`, `0` to exclude entirely).

```bash
cat > /tmp/replaces.json <<'JSON'
{
  "reference": {
    "url": "https://react.dev/blog/2024/04/25/react-19",
    "title": "React 19 release notes",
    "publishedAt": "2026-04-25T00:00:00Z"
  },
  "concepts": [
    {"id": "useState", "description": "Modern React state hook."},
    {"id": "this.setState", "description": "Class component state mutation API."}
  ],
  "relationships": [
    {
      "source": "useState",
      "target": "this.setState",
      "type": "REPLACES",
      "reason": "Function components with hooks are the recommended state mechanism."
    }
  ]
}
JSON
refmesh register -f /tmp/replaces.json
```

The `reference.publishedAt` matters: it anchors the freshness score so the new concept ranks above the old one even before the demote multiplier kicks in.

---

## Move 3 — Hide from default searches (archive)

When a concept should not surface in normal recall but you want to keep its history:

```bash
refmesh archive <id> --reason "<short why>"
```

After this, `refmesh search` excludes the concept from `matchedConcepts` and even from BFS traversal results. Re-include with:

```bash
refmesh search "<query>" --include-archived
```

Reverse the decision:

```bash
refmesh unarchive <id>
```

Use archive — not prune — when:

- The concept is wrong but its existence is part of the project's history (failed experiments, rejected proposals).
- You're not sure yet. Archive is reversible, prune is not.

---

## Move 4 — Physically delete (prune)

When a concept is genuinely garbage (test data, mistaken registers, cold-storage cleanup):

1. **Always start with dry-run.** The default omits `--apply`, so the command only previews.

   ```bash
   refmesh prune --older-than 365 --max-touches 1
   ```

   Read the output:
   - `cutoff` — the timestamp threshold (`now - olderThanDays`).
   - `Filter: lastSeenAt < cutoff AND touchCount <= N` — the rule.
   - `Candidates: N` and the first 10 ids — sanity-check that none of them are concepts the user still cares about.

2. If the candidate list is what you expect, re-run with `--apply`:

   ```bash
   refmesh prune --older-than 365 --max-touches 1 --apply
   ```

   This `DETACH DELETE`s from the graph and removes the matching rows from the LanceDB vector store.

3. To prune archived concepts as well, add `--include-archived`. Without that flag, archived nodes are protected from prune (they're already hidden, no need to delete).

Tuning knobs:

- `--older-than 30` for aggressive cleanup of very recent additions (rare).
- `--max-touches 0` to delete only concepts that were registered exactly once and never re-touched.
- `--max-touches 5` if you want to allow some re-registrations and still consider the concept cold.

## Curation cadence

You do not need to curate every session. Reasonable rhythm:

- **Inline (every register call):** Always handle `⚠ Similar existing concepts` warnings — at minimum, decide between SAME_AS, reuse, or accept-as-different.
- **Per topic shift:** When a major version of a technology lands (React 19, Node 22 LTS, etc.), add REPLACES/DEPRECATES edges so old guidance demotes itself automatically.
- **Quarterly / on-demand:** Run `refmesh prune --older-than 365 --max-touches 1` dry-run, review, and selectively apply.

## Don't

- **Don't `--apply` prune without reading the dry-run output.** Deletes are irreversible; archive first if you're unsure.
- **Don't archive a concept that is still the target of active relationships.** Either remove the relationships first, or use REPLACES/DEPRECATES to mark it as outdated while keeping it visible.
- **Don't create a SAME_AS chain (A SAME_AS B SAME_AS C).** Always point to the single canonical id.
- **Don't substitute curate for register.** If the source has *new* information, register first; curate is for relationships between things that already exist.
