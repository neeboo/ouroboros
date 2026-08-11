# Continual Harness v1 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Ouroboros activate a versioned Harness revision, freeze it into the next run, attest the components actually loaded, then add a minimal single-candidate resource allocator.

**Architecture:** Reuse immutable `HarnessVariant` records and existing run context/action events. Add a strict `HarnessRevisionV1` parser and a fixed activation action; freeze the active revision into new runs and attempt inputs. Keep runtime process generation separate. After inheritance works, add a deterministic allocation receipt that chooses one already-approved proposal.

**Tech Stack:** Bun, TypeScript, SQLite-backed Harness, existing fixed actions and runner prompt pipeline.

---

### Task 0: Make retired runs permanent execution tombstones

**Files:**
- Modify: `packages/cli/src/main.ts`
- Modify: `packages/runner/src/codex-resumable-runner.ts`
- Modify: `packages/harness/src/actions.ts`
- Modify: `packages/harness/src/harness.ts`
- Test: `tests/cli.test.ts`
- Test: `tests/runner.test.ts`
- Test: `tests/harness-actions.test.ts`

**Step 1: Write failing production-shaped tests**

Cover a retired duplicate that is older than a canonical todo delivery, a direct `prepareRunDrain`, a direct lease, and a normal non-retired blocked recovery.

**Step 2: Run tests and verify RED**

Run focused test names. Expected: the retired run reopens, receives a task or attempt, or occupies the only run slot.

**Step 3: Add the minimal guards**

- Exclude `context.retired === true` in blocked recovery and runnable-run selection.
- Block `prepareRunDrain` for retired runs without mutation.
- Reject leasing and explicit runner starts for retired runs.

**Step 4: Run focused tests and verify GREEN**

Expected: canonical planner starts once; retired task, attempt and action counts remain unchanged.

**Step 5: Commit**

Commit message: `fix: keep retired runs out of execution`

### Task 1: Add the strict HarnessRevisionV1 contract

**Files:**
- Modify: `packages/harness/src/types.ts`
- Create: `packages/harness/src/harness-revision.ts`
- Modify: `packages/harness/src/index.ts`
- Create: `tests/harness-revision.test.ts`

**Step 1: Write failing parser tests**

Cover a valid revision, canonical component order, content hash, missing component, duplicate component, wrong project, invalid ref, invalid SHA, unknown field and non-monotonic version inputs.

**Step 2: Run tests and verify RED**

Run: `bun test tests/harness-revision.test.ts`

Expected: missing module or export failures.

**Step 3: Implement the parser and canonical hash helper**

Accept exactly five component kinds, normalize them into fixed order and calculate `contentSha256` from the revision body.

**Step 4: Run tests and verify GREEN**

Run: `bun test tests/harness-revision.test.ts`

Expected: all pass.

**Step 5: Commit**

Commit message: `feat: define versioned harness revisions`

### Task 2: Add the fixed activation action

**Files:**
- Modify: `packages/harness/src/actions.ts`
- Test: `tests/harness-actions.test.ts`

**Step 1: Write failing action tests**

Cover first activation, sequential reused retry, stale parent, skipped version, wrong project, missing variant receipt, hash mismatch and frozen-context mutation attempts.

**Step 2: Run tests and verify RED**

Run focused `activateHarnessRevision` tests. Expected: unknown action type.

**Step 3: Implement minimal activation**

Read the immutable `HarnessVariant`, verify its trusted action receipt and evidence, atomically update the long-lived root `activeHarnessRevision`, and write a minimal redacted action event.

**Step 4: Run focused actions and typecheck**

Run `bun test tests/harness-actions.test.ts -t activateHarnessRevision` and `bun run typecheck`.

**Step 5: Commit**

Commit message: `feat: activate harness revisions safely`

### Task 3: Freeze revisions into descendant runs

**Files:**
- Modify: `packages/cli/src/main.ts`
- Modify: `packages/runner/src/hooks/apply-design-actions.ts`
- Modify: `packages/harness/src/actions.ts`
- Test: `tests/cli.test.ts`
- Test: `tests/design-actions-adversarial.test.ts`

**Step 1: Write failing inheritance tests**

Prove cycle N+1 receives the active revision, design child runs preserve it, replay drift is blocked, and an already-running cycle keeps its original revision.

**Step 2: Run tests and verify RED**

Expected: child contexts do not contain `harnessRevision` and generic mutation can overwrite it.

**Step 3: Implement frozen inheritance**

Add `harnessRevision` to the self-improvement and design-child control-context allowlists and to the protected context keys. Copy only from the project or root active revision at run creation.

**Step 4: Run focused tests and verify GREEN**

Run the new CLI and design-action test names plus `bun run typecheck`.

**Step 5: Commit**

Commit message: `feat: inherit active harness revisions`

### Task 4: Attest actual component loading

**Files:**
- Modify: `packages/runner/src/prompt.ts`
- Modify: `packages/runner/src/runner.ts`
- Modify: `packages/runner/src/codex-resumable-runner.ts`
- Test: `tests/runner.test.ts`

**Step 1: Write failing attestation tests**

Prove the prompt contains only the compact manifest, attempt input contains the exact revision and five loaded component receipts, and missing or hash-mismatched components block before agent execution.

**Step 2: Run tests and verify RED**

Expected: no frozen Harness section or attempt attestation exists.

**Step 3: Implement manifest resolution and attestation**

Resolve allowed repository or resource refs, recompute hashes, build the compact prompt block, and persist the loading receipt in attempt input before execution.

**Step 4: Run runner tests and typecheck**

Run `bun test tests/runner.test.ts -t "Harness Revision"` and `bun run typecheck`.

**Step 5: Commit**

Commit message: `feat: attest loaded harness capabilities`

### Task 5: Add ResourceAllocator v0

**Files:**
- Create: `packages/harness/src/resource-allocator.ts`
- Modify: `packages/harness/src/types.ts`
- Modify: `packages/harness/src/index.ts`
- Modify: `packages/harness/src/actions.ts`
- Modify: `packages/runner/src/hooks/apply-design-actions.ts`
- Test: `tests/resource-allocator.test.ts`
- Test: `tests/harness-actions.test.ts`
- Test: `tests/design-actions-adversarial.test.ts`

**Step 1: Write failing allocator tests**

Cover strict zero-spend requests, value score, information gain, deterministic tie-break, one selected run per project, task parallelism, and duration caps.

**Step 2: Run tests and verify RED**

Expected: allocator module or action missing.

**Step 3: Implement pure selection in the existing delivery action**

Normalize the request while proposing, freeze the allocation through the existing `createRunsFromDesign` action, and copy it into the delivery run context. The supervisor selects one resource-aware run per project and caps task concurrency and attempt duration. Do not add a table, a second allocation workflow, or modify task-level FIFO.

**Step 4: Run focused tests and verify GREEN**

Run allocator, action and design-action focused tests plus typecheck.

**Step 5: Commit**

Commit message: `feat: allocate one bounded evolution candidate`

### Task 6: End-to-end generational proof

**Files:**
- Modify: `tests/cli.test.ts`
- Modify: `docs/target-system-evolution.md`
- Modify: `docs/ouroboros-hodor-meta-self-improvement.md`

**Step 1: Write the failing generational test**

Create revision A, run one cycle, activate revision B, then run the next cycle. Assert the old attempt attests A, the new attempt attests B, and the allocation receipt selected exactly one approved proposal.

**Step 2: Run and verify RED, then implement only missing glue**

Do not expand the data model during this step.

**Step 3: Run focused and full verification**

Run:

```text
bun test tests/harness-revision.test.ts tests/resource-allocator.test.ts
bun test tests/harness-actions.test.ts tests/design-actions-adversarial.test.ts tests/runner.test.ts tests/cli.test.ts
bun run typecheck
bun test
git diff --check
```

Expected: all exit 0.

**Step 4: Independent review**

Review frozen revision integrity, credential redaction, project isolation, authorization, idempotency, next-generation adoption and user dirty-file preservation.

**Step 5: Integrate and operate**

Merge the reviewed branch to `main`, push, independently read back `origin/main`, refresh the daemon generation, then create one real HarnessRevision and prove the next self-improvement cycle attests it. Use Linear for any human checkpoint and final evidence.
