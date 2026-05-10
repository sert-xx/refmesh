---
name: refmesh-investigation-orchestrator
description: Used to proceed with simple investigations in a refmesh-first manner. Standardizes the process of executing `refmesh-search` first, determining hit status, falling back to primary sources, deciding between `refmesh-register` / `refmesh-curate`, and escalating when the task cannot be closed by investigation alone.
---

# Refmesh Investigation Orchestrator

## Objective
To consistently start simple investigations with a refmesh-first approach and return reusable knowledge to the graph.

## When to Use
- When starting an investigation.
- When you want to carve out a brief fact-checking phase before implementation.
- When you want to fix refmesh as the primary entry point for a simple investigation, rather than starting with a standard search.

## When Not to Use
- When the primary purpose is implementation, design changes, or test fixes.
- When the primary purpose is creating or updating design artifacts.
- For one-off casual conversations or self-evident questions.

## Standard Flow
1. Execute `refmesh-search` using a natural language query.
2. Read the `Matched Concepts`, `Related Concepts`, `Relationships`, and `References`.
3. Determine if it is a `sufficient hit`.
4. If insufficient, investigate primary sources.
5. If the additionally obtained information is stable knowledge, register it using `refmesh-register`.
6. If duplicates or outdated concepts are interfering, use `refmesh-curate`.
7. Escalate if the task cannot be closed purely as an investigation.
8. If closing the task as an investigation, explicitly state `sources` / `freshness` / `confidence` / `need_more_research` / `human_confirmation_needed` in the response.

## Criteria
### `sufficient hit`
- The refmesh concepts alone can directly answer the question.
- It is not retrieving deprecated or replaced concepts.
- The accuracy of the source references is sufficient for the question.

### `refmesh-register` Required
- Refmesh lacks a sufficient answer.
- The information obtained from additional investigation is stable knowledge with reusable value.
    - Examples: Internal operational rules, architecture, terminology definitions, continuously used external specifications.

### `refmesh-register` Optional
- One-off, context-dependent information.
- Short-lived outage/incident information.
- Individual consultations with low reusability.

### When `refmesh-register` Fails
- Briefly record the failure.
- You may continue the work based on the primary sources.
- Note in the response or handoff that the information has not been reflected in refmesh.

### Response Contract
- `sources`: List the refmesh references or primary sources used as evidence.
- `freshness`: Indicate the point in time, update date, or any caveats regarding the freshness of the information.
- `confidence`: Provide a self-assessment of `high` / `medium` / `low`.
- `need_more_research`: `yes` if additional source verification is needed; `no` if current information is sufficient for decision-making.
- `human_confirmation_needed`: `yes` if human decision-making (e.g., operational or authorization decisions) is required; `no` if sharing the findings is sufficient.

#### `confidence`
- `high`: Refmesh or primary sources directly answer the question, with minimal contradictions or freshness concerns.
- `medium`: There is strong evidence, but there are remaining gaps in scope, time discrepancies, or dependent assumptions.
- `low`: Includes speculation, or is difficult to assert without additional verification.

#### `need_more_research`
- `yes`: Accuracy will improve with additional source verification, or evidence needed for a conclusion is lacking.
- `no`: The current information is sufficient for decision-making.

#### `human_confirmation_needed`
- `yes`: Human decision-making is required (e.g., operational decisions, authorization judgments, specification interpretation, exceptional operations).
- `no`: Simply sharing the investigation results is sufficient.

## Supplementary Notes
- If a broad query cannot answer a wide-ranging question, suspect a lack of parent concepts or answer-bearing concepts.
- Do not evade the issue by using an alias; first, review the concept split and description.
- Starting with a normal search without consulting refmesh is considered a deviation from this skill.
