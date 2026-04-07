# Architect Improvement Playbook

This document is a reusable task context for improving OpenDungeon Architect quality, with a focus on correctness, architecture-awareness, and safe evolution.

## 1) What Architect is

Architect has two runtime modes:

- `Worldbuilder` (interactive developer chat via `od architect`)
  - Goal: propose `pendingOperations` for game-content authoring.
  - Typical ops: `write_file`, `set_world_fact`, `upsert_lore`.
- `Chronicler` (background runtime in gateway)
  - Goal: extract durable world/lore knowledge from recent events.
  - Typical ops: `set_world_fact`, `upsert_lore`, archives, milestones.

Key files:

- `packages/architect/src/architect.ts`
- `packages/architect/src/prompts/worldbuilder.ts`
- `packages/architect/src/prompts/chronicler.ts`
- `packages/architect/src/executor.ts`
- `packages/devtools/src/architect-cli.ts`

## 2) End-to-end flow (Worldbuilder)

1. User asks in `od architect` REPL.
2. CLI loads module/campaign context (existing files, world facts, lore).
3. `ArchitectRuntime.runWorldbuilderTurn` sends request to LLM.
4. Reviewer pass critiques candidate JSON and returns safer output.
5. Runtime validates operations schema and drops malformed ops.
6. CLI runs pre-apply linter for state-model consistency.
7. User sees:
   - assistant message,
   - reviewer summary,
   - operation confidence,
   - pre-apply issues.
8. In `--strict-ops`, high-severity issues block apply.
9. If accepted, `ArchitectOperationExecutor` applies ops.

## 3) State model contract (must preserve)

OpenDungeon uses two state domains:

- World state (campaign-shared): world facts (`WorldFact` table), keyed like `merchant.reputation`.
- Character state (session-scoped): `Session.characterState`, reflected by indicators with `source: "characterState"`.

Context module references:

- `world:<key>` -> shared world key.
- `character:<key>` -> character semantics.
- `module:<id>` / `resource:<id>` -> routing/prompt context semantics.

Important rule:

- Avoid nested wrappers in `initial-state.json` like `{ "world": { ... } }` unless explicitly required by project conventions.

## 4) Current guardrails already in place

- Two-pass generation (`Worldbuilder` + reviewer critique).
- Operation schema validation + malformed op dropping.
- World-fact key format validation for `set_world_fact`.
- Pre-apply lint checks in CLI:
  - frontmatter/reference consistency,
  - missing defaults for world references,
  - indicator-to-reference mismatch,
  - ambiguous `character:*` + `initial-state.json` write.
- `--strict-ops` blocking on high-severity findings.

## 5) Quality criteria (definition of success)

Primary goals:

1. Structural correctness
   - Proposed files pass schema/format validation without manual repair.
2. Architecture correctness
   - No domain confusion (`characterState` vs world facts).
   - Reference integrity across modules, indicators, and initial-state.

Secondary goals:

- Fewer dropped ops.
- Fewer user edits after first proposal.
- Better clarity in reviewer rationale and confidence.

Suggested KPIs:

- `% proposals with zero high-severity lint issues`
- `% proposals accepted without manual edits`
- `avg droppedOperationCount`
- `avg high/medium issues per turn`

## 6) Known failure patterns to target

- Flat vs nested state shape confusion in `initial-state.json`.
- Character references proposed with only world-state persistence assumptions.
- Missing file slices (module created but indicator/defaults omitted).
- Inconsistent naming (`stamina` vs `character.stamina` vs `world:stamina`).
- Overconfident reviewer output masking subtle domain errors.

## 7) Improvement loop for agents

Use this iterative loop for any Architect-improvement task:

1. Reproduce
   - Capture real prompts and generated operations.
2. Diagnose
   - Map issue to one layer:
     - prompt contract,
     - runtime validation,
     - pre-apply lint,
     - executor behavior.
3. Patch minimally
   - Prefer deterministic guardrails first.
   - Then refine prompts.
4. Verify
   - Build impacted packages.
   - Run at least one real `od architect` scenario.
5. Measure
   - Record issue counts before/after.
6. Document
   - Update this playbook with new anti-pattern + mitigation.

## 8) Safe change strategy

Order of preference:

1. Add/strengthen deterministic checks.
2. Improve reviewer prompt with explicit constraints.
3. Improve generator prompt.
4. Change executor semantics only if absolutely required.

Avoid:

- Silent auto-fixes that can alter user intent.
- Hard-failing low-confidence heuristic checks in default mode.
- Introducing new mandatory files unless runtime truly requires them.

## 9) Test matrix for contributors

Minimum test matrix per change:

1. Build
   - `pnpm --filter @opendungeon/architect --filter @opendungeon/devtools --filter @opendungeon/gateway build`
2. Worldbuilder manual scenarios
   - Ambiguous state ownership prompt (expect clarifying behavior or strict block).
   - Clean declarative feature prompt (expect coherent module+state+indicator outputs).
3. Chronicler regression
   - Verify chronicler can still emit and persist world facts/lore safely.

Optional:

- Run `pnpm --filter @opendungeon/gateway mvp:chronicler-check` with DB configured.

## 10) Task template for improvement agents

Use this template when assigning work to another agent:

```text
Goal:
Improve Architect proposal correctness for <specific failure pattern>.

Current behavior:
<copy real prompt + resulting operations + lint output>

Expected behavior:
<clear, testable expected output>

Constraints:
- Preserve md+json-first architecture.
- Keep Balanced UX.
- Do not remove existing safeguards.

Required changes:
- Prompt changes: <yes/no + file>
- Runtime validation: <yes/no + file>
- CLI pre-apply checks: <yes/no + file>
- Docs update: <yes/no + file>

Validation:
- Build architect/devtools/gateway.
- Re-run reproduction prompt.
- Show before/after outputs.
```

## 11) Fast orientation map for new contributors

- Start in `packages/architect/src/architect.ts` to understand generation + validation.
- Read `packages/devtools/src/architect-cli.ts` for REPL UX, pre-apply lint, strict blocking.
- Read `packages/architect/src/prompts/worldbuilder.ts` for behavior constraints.
- Read `docs/architecture.md` for state model and routing context.

---

If you improve Architect behavior, update this playbook with:

- the failure pattern,
- the implemented mitigation,
- and the verification evidence.
