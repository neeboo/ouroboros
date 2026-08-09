# Control Loops and Contracts

Ouroboros should treat autonomous coding as a control system. A prompt starts the work, but contracts, loops, verification, and accumulated operating rules decide whether the work can keep running without constant human steering.

This document defines the intended loop shape for self-iteration and larger project goals.

## Core Principle

A run has four different loops:

```text
designer loop -> planning loop -> execution loop -> goal review loop
                                                              |
                                                              v
                                                       outcome review loop
```

Each loop can create tasks, but each loop has a different authority.

- The designer loop owns product direction. It reads the active founder charter and current world model, researches evidence, compares alternatives, and proposes designs (or quiesces) before any planning work begins.
- The planning loop accepts a frozen proposal and evaluation contract; it sharpens the task graph, verifier contract, and stop policy without inventing product direction.
- The execution loop changes artifacts until verifier evidence satisfies the frozen contract.
- The goal review loop decides whether the whole run is complete or needs a new planning pass.
- The outcome review loop compares post-integration evidence with the proposal baseline, records `retain`/`revise`/`retire`, and feeds discrepancies back as strategy signals for the next designer cycle.

Execution should not redefine success. If the verifier contract is wrong, the run needs an explicit contract amendment instead of a silent standard change.

## Founder Charter Ownership

The founder charter is the versioned, durable, human-owned objective function. It defines mission, value metrics, principles, non-goals, constraints, capital policy, delegated authority, and review cadence.

Ownership rules:

- The designer may propose a charter amendment. The proposal records the diff and rationale.
- Only a human or an explicitly configured governance actor can activate a new charter version.
- The active charter version is immutable for the duration of a designer cycle.
- The designer cites the charter version it observed in every proposal.

The mission, capital limits, legal or privacy boundaries, destructive operations, production deployment, and irreversible infrastructure commitments are human checkpoints by default.

## Strategy Signals And Evidence Expiry

The designer maintains a time-aware world model from six signal classes: `user`, `delivery`, `technology`, `market`, `economics`, and `system`. Each signal records its source, observation time, confidence, evidence, and expiry.

Expiry rules:

- Expired `market`, `pricing`, and `technology` claims cannot authorize a new investment until refreshed.
- Conflicting signals are preserved rather than overwritten.
- A designer cycle cites the signals it used as `evidenceRefs` on every proposal.

When no trigger and no evidence-backed opportunity exists, the designer returns a mutation-free quiescent decision. The decision lives in the durable attempt summary and the run's exit rationale — it names which signals were inspected, why no work is justified, and when the next review cadence falls. The quiescent cycle writes no new strategy signal, no new proposal, and no design decision, so a quiet repository stays quiet rather than waking itself.

## Deterministic Budget And Human Gates

The authority evaluator is a pure function over the active charter and a proposal. Automatic authority is limited to changes that:

- are reversible (`investment.reversibility = "easy"`);
- fit one-time and recurring costs inside the configured experiment budget;
- cite current (non-expired) evidence;
- do not cross a mission, capital, legal, privacy, destructive, production, dependency, schema, or infrastructure-commitment checkpoint.

Everything else becomes an explicit human `decideDesign` decision. The proposing designer cannot represent a high-risk proposal as human-approved through its own output payload — the gate writes the `design_decisions` row, not the prompt.

The gate records the charter version used, the matched rules, and the reasons for approval, rejection, deferral, or retirement. The decision is auditable evidence for verifiers and outcome reviewers.

## Goal Contract

The goal contract is the run-level definition of done.

Minimum fields:

```ts
type GoalContract = {
  desiredState: string;
  successCriteria: string[];
  constraints: string[];
  requiredEvidence: string[];
  budget: {
    maxCycles?: number;
    maxRounds?: number;
    maxAttemptsPerTask?: number;
    wallClockMs?: number;
  };
  stopPolicy: {
    completeWhen: string[];
    blockWhen: string[];
    askHumanWhen: string[];
  };
};
```

The contract should be specific enough that a goal-review task can cite evidence rather than accept a worker's explanation as proof.

## Planner Loop

The first planner task should not jump straight into implementation for complex goals. It should run a short planning loop that sharpens:

- the goal contract;
- the task graph;
- worker boundaries;
- the verifier contract;
- deterministic checks;
- fuzzy review rubrics;
- required artifacts;
- stop and amendment rules.

The planning loop is complete when the verifier contract is strong enough to test the task graph without changing success criteria during execution.

Recommended planning loop questions:

- Can this verifier prove the goal, or only prove a narrow subtask?
- Can a worker pass the checks while missing the real intent?
- Which checks are deterministic and should run before agent review?
- Which judgments require language, visual review, or product taste?
- What artifacts must be stored so a human can audit the decision?
- What failures should become repair tasks?
- What failures mean the contract itself is invalid?

## Verifier Contract

The planner creates the verifier contract before execution starts.

Minimum fields:

```ts
type VerifierContract = {
  version: number;
  scope: "task" | "run";
  successCriteria: string[];
  deterministicChecks: Array<{
    name: string;
    command?: string;
    expected: string;
    required: boolean;
  }>;
  agentReviewRubric: string[];
  requiredArtifacts: string[];
  failureModesToCatch: string[];
  repairPolicy: {
    maxAttempts: number;
    createRepairTaskWhen: string[];
    blockWhen: string[];
  };
  amendmentPolicy: {
    allowed: string[];
    forbidden: string[];
    approvalRole: "planner-review" | "goal-review" | "human";
  };
};
```

Once the verifier contract is accepted, it is frozen for execution. Workers and repair workers may satisfy it, but they may not weaken it.

## Contract Amendments

Sometimes the verifier contract is wrong: a command path is invalid, a check is impossible in the current environment, or the contract misses a stronger required check.

In that case the execution loop can request a contract amendment.

Allowed amendments:

- add a stronger check;
- fix an incorrect command, path, or environment assumption;
- clarify ambiguous wording;
- add required evidence discovered during execution.

Forbidden amendments:

- remove a failing check only because it is hard to satisfy;
- redefine the goal to match the current artifact;
- lower a quality bar without human approval;
- hide a verifier failure by converting it into a lesson only.

Every accepted amendment should create a new verifier contract version and keep the old version auditable.

The implementation provides an audited, run-scoped amendment path through the `amendRunContract` `HarnessAction`. It targets a single `contractKey` inside `run.context`, writes the new value, and appends a versioned entry to `run.context.contractAmendments`. Versions are monotonic per `contractKey`, and an optional `expectedVersion` staleness guard rejects amendments made against a superseded version without mutating the run. The action does not change the database schema and never weakens the frozen task-level verifier contract; it only records the amendment as auditable JSON alongside a `harness_action_events` row.

## Execution Loop

After contracts are frozen, execution can run independently.

```text
lease runnable task
-> run worker in its session/worktree
-> collect files, logs, checks, and artifacts
-> run verifier against frozen contract
-> mark done, create repair task, block, or request amendment
```

The execution loop continues until:

- all runnable tasks are done;
- the verifier creates repair work;
- the run reaches a retry or budget limit;
- a contract amendment is required;
- no tasks remain and goal review is needed.

The loop is not allowed to rely only on each program politely continuing. Ouroboros is a harness, so the system must supervise the loop at the run level.

## Harness Supervision

Runner logic, stop hooks, and dashboard controls are local actors inside a larger control system. The harness must maintain system-level supervision over them.

Minimum supervision responsibilities:

- detect ready work: a run has `todo` tasks whose dependencies are satisfied;
- detect resumable work: a run has running attempts that can be resumed or safely marked stale;
- detect orphaned work: queued or running work exists but no runner process owns it;
- detect stale runner state: the runner exited while the run remains unfinished;
- keep a bounded restart policy: restart or resume only within max cycle, retry, and stop-policy limits;
- respect explicit human stops: a manual stop should pause automatic restart until a new goal, resume, rerun, or start command clears the pause;
- report causes in the control surface: show whether the run is waiting on dependencies, blocked evidence, runner ownership, retry budget, or human pause.

This supervision is separate from prompt quality. A prompt can be correct and a worker can finish successfully, but the harness is still wrong if the resulting verifier, repair, integrator, or goal-review task is left unowned.

Suggested state model:

```ts
type RunSupervisorState =
  | "draining"       // runner owns ready or resumable work
  | "waiting"        // todo exists but dependencies are not satisfied
  | "orphaned"       // ready or resumable work exists without a live runner
  | "paused"         // human stopped automatic execution
  | "blocked"        // only unresolved blocked work remains
  | "complete";      // run status is done
```

The dashboard should display this state, but it should not be the only place where it exists. A future daemon or desktop shell should use the same supervision rules.

Pseudocode:

```ts
while (!budgetExceeded(run)) {
  const task = leaseRunnableTask(run);

  if (!task) {
    enqueueGoalReview(run);
    break;
  }

  const attempt = await runWorker(task);
  const evidence = collectEvidence(task, attempt);

  const verification = await runVerifier({
    task,
    attempt,
    evidence,
    verifierContract: frozenContractFor(task),
  });

  if (verification.status === "pass") {
    markTaskDone(task, verification);
    continue;
  }

  if (verification.status === "fail") {
    enqueueRepairTask(task, verification);
    continue;
  }

  if (verification.status === "contract_invalid") {
    enqueueContractAmendment(task, verification);
    continue;
  }

  markTaskBlocked(task, verification);
}
```

## Runtime Overseer

The runtime overseer is the read-only diagnosis layer above the harness. It consumes the run overview and emits observable signals for the control surface and CLI, including:

- active work;
- running attempts;
- execution threads;
- recent attempt events;
- duplicate todo or running task goals;
- empty-run goal-review race risk;
- repeated blocked failures;
- orphaned leases;
- queue starvation.

Its job is to explain the current run state and surface risk, not to execute repairs.

Allowed authority:

- classify run supervision state from existing overview data;
- report evidence for scheduler and dashboard decisions;
- surface blocked, orphaned, waiting, draining, and complete signals;
- help callers decide whether they need a lease, goal review, retry, or human review.

Forbidden authority:

- create, retry, or finish tasks;
- mark runs complete;
- change a verifier contract or goal contract;
- ignore database lock evidence by silently retrying;
- invent new state that is not supported by the overview data;
- bypass the runner, action server, or lock discipline to force a repair.

## Goal Review Loop

Goal review runs only when there is no active work left or when the scheduler needs a run-level decision.

Goal review should compare the full run evidence against the goal contract.

Possible decisions:

- `complete`: the run goal is satisfied and evidence is sufficient.
- `continue`: the goal is not satisfied; create a new planner or worker graph.
- `verify`: implementation may be done, but run-level evidence is insufficient.
- `blocked`: the run cannot continue under current constraints.

Goal review should not create random follow-up tasks just because more improvements are possible. It should ask: "Are we sure the original goal is reached?" If yes, stop.

## Lessons Become Guardrails

Lessons are records of failures, near misses, verifier blocks, brittle assumptions, and repeated mistakes. A lesson should not stay as a passive summary forever.

The promotion path is:

```text
raw lesson -> summarized lesson -> candidate guardrail -> active guardrail
```

Guardrails are operating rules that constrain future runs. They are useful when a failure pattern is likely to recur.

Examples:

- Always use the task worktree when reading diffs for a task.
- Do not mark a run complete while there are running attempts.
- When no todo tasks remain, ask goal-review before creating a new planner task.
- For dashboard UI changes, verify in browser and check text truncation.

Minimum fields:

```ts
type Guardrail = {
  id: string;
  sourceLessonIds: string[];
  rule: string;
  appliesTo: Array<"planner" | "worker" | "verifier" | "goal-review" | "dashboard">;
  severity: "advice" | "warning" | "blocker";
  activationCriteria: string[];
  verificationHint?: string;
};
```

Guardrails should feed future prompts and planner checks. High-confidence blocker guardrails can also become deterministic preflight checks.

## Experiences Stay Reusable Evidence

Experiences are records of successful patterns: commands that worked, useful implementation sequences, good decomposition shapes, UI verification flows, or reliable repair strategies.

The default path is:

```text
raw experience -> summarized experience -> reusable procedure evidence
```

Ouroboros should not promote experience into repo skills by default. Experience is useful as compact context for planners, workers, and verifiers. Turning experience into a formal skill adds process weight and should require an explicit human decision.

Examples:

- How to run a self-iteration smoke test with fake Codex.
- How to verify dashboard streaming without manual refresh.
- How to inspect changed files from task worktrees.
- How to configure model defaults for planner, worker, and verifier.

Minimum fields:

```ts
type ExperiencePattern = {
  id: string;
  sourceExperienceIds: string[];
  name: string;
  procedure: string[];
  verification: string[];
  exampleCommands: string[];
  risks: string[];
};
```

A single success can become an experience. Repeated success can become a stronger experience pattern or guardrail-adjacent hint, but not a skill unless a human asks for skills.

## Storage and Prompt Use

The database should store raw lessons and experiences separately from promoted guardrails and experience patterns.

Recommended flow:

1. Stop hooks record raw lesson or experience for every finished attempt.
2. Context-summary condenses raw records into short run-level summaries.
3. A periodic or goal-review step proposes guardrails and experience patterns.
4. Accepted guardrails are injected into relevant role prompts.
5. Experience patterns are shown to planners as reusable evidence and example procedures.

This keeps prompts compact while letting the harness become more capable over time.

## Supervisor-Owned Integration Handoff

Integration of verified worker output into the target repository is a database-writing harness action. Only the supervisor process may perform it. Worker and verifier attempts may collect repository evidence (diffs, command output, worktree state) but their sessions cannot write the shared harness database and cannot represent their own output as integration proof. The supervisor performs the audited integration after the verifier has accepted the worker evidence and goal review has produced a terminal decision.

The supervisor invokes `integrateVerifiedRun` with these frozen boundary fields on every accepted terminal delivery:

```ts
{
  type: "integrateVerifiedRun",
  runId,
  workerTaskId,
  repoPath: run.projectRoot,
  targetBranch: "main",
  push: false,
  immediateOutcomeReview: true,
}
```

The supervisor only records `integrated` state when all three of the following hold:

1. The `integrateVerifiedRun` action status is `done`.
2. The corresponding harness action event status is `done`.
3. A matching integration artifact (kind `integration`) is present on that event for the run and worker.

Worker status, verifier status, and goal-review prose are necessary but never sufficient. Without an audited receipt the proposal stays in its previous state and no outcome-review task is created.

### Disjoint-Path Classification

When the target repository has uncommitted changes at integration time, the supervisor does not reject the integration outright. It classifies every dirty path against the normalized verified worker output:

- **Verified dirty paths**: dirty in the target AND present in the worker's `changedFiles`. These must match the worker worktree byte-for-byte before they can be staged.
- **Disjoint dirty paths**: dirty in the target but NOT present in the worker's `changedFiles`. These are operator edits that must be preserved through the integration commit.
- **Overlapping paths**: any dirty path that is a parent, child, or equal of any verified worker path. These block integration.
- **Rename records**: any dirty path reported as `R` or `C` in porcelain v1. These block integration.
- **File/directory collisions**: any verified worker path that is a parent of a disjoint dirty path or vice versa. These block integration.
- **Unsafe paths**: any path that fails normalization (absolute, traversal, empty). These block integration.

The supervisor rejects every unsafe, overlapping, renamed, or colliding path before any mutation. The target HEAD and operator edits stay byte-for-byte unchanged and no successful receipt is recorded.

### Snapshot, Stage, Restore, Readback

For every integration that proceeds, the supervisor captures the following evidence and applies the following ordering:

1. **Preflight snapshot**. Read porcelain v1 with `--untracked-files=all` and `-c core.quotepath=false`. Classify each dirty path. Reject unsafe, renamed, or colliding entries.
2. **Disjoint snapshot**. For each disjoint dirty path, capture its exact porcelain state, tracked status, index mode/blob/stage, existence, lstat mode (regular file, directory, or symlink), byte content, or symlink target. If any path cannot be snapshotted, block without mutating the working tree.
3. **HEAD and porcelain baseline**. Read `rev-parse HEAD` and `status --short` once, immediately before creating the isolated tree. Drift between this baseline and the commit attempt blocks the integration.
4. **Isolated index**. Create a temporary `GIT_INDEX_FILE` from target HEAD and add only verified paths. The operator's real index and worktree are never unstaged or restored by the supervisor.
5. **Commit only verified paths**. Write the isolated tree and create an unsigned `commit-tree` object, then update the target branch with a compare-and-swap against `<HEAD-before>`.
6. **Synchronize verified paths**. After the branch update, copy only verified worker bytes and modes into the target worktree and update only their index entries. Disjoint operator index entries are left untouched.
7. **Independent readback**. Re-read porcelain, tracking status, index mode/blob/stage, existence, mode, content, and symlink target for every disjoint path. Any mismatch blocks the integration.
8. **Rollback on failure**. If commit or readback fails, the supervisor may compare-and-swap the target branch ref back from the supervisor-created commit to `<HEAD-before>`. It must leave operator paths untouched; a failed compare-and-swap remains blocked and cannot emit a receipt.

A successful receipt is emitted only when isolated tree creation, branch update, verified-path synchronization, and readback all succeed and the preserved-path evidence matches its pre-integration snapshot.

### Repair Limits

The supervisor owns a bounded repair budget for each accepted terminal delivery. The default limit is `3` repair attempts per delivery. An unchanged failure fingerprint does not create repeated repair work; the supervisor records the same failure evidence and either schedules the same bounded repair or transitions the proposal to `revise` after exhaustion.

After exhaustion the supervisor:

- Records a terminal disposition of `repair-budget-exhausted` on the run context.
- Transitions the proposal to `revise`.
- Does not create additional worker, verifier, repair, reconciliation, or outcome-review tasks for the same delivery.

### Exact-Once Behavior

The supervisor's terminal reconciliation is idempotent. Repeated invocations of `reconcileTerminalDesignDeliveries` for the same accepted proposal and delivery run must not create:

- a duplicate child run;
- a duplicate harness action event for the same `integrateVerifiedRun` operation;
- a duplicate integration receipt;
- a duplicate repair task;
- a duplicate reconciliation task; or
- a duplicate outcome-review task.

Replay uses the recorded `integrationConvergence` fingerprint on the run context to return the previously recorded blocked or successful event without mutating the database. A previously completed integration is therefore detected by the same audited receipt, and the supervisor binds its reconciliation task to that receipt instead of issuing another action.

## Minimal Next Implementation

The smallest useful implementation should add:

- persisted goal contract JSON on runs;
- persisted verifier contract JSON on verifier tasks or run context;
- a planning-loop task type or planner mode that can revise contracts before execution;
- contract version metadata on verifier attempts;
- a guardrail table or guardrail section in run context;
- an experience pattern artifact type for successful reusable procedures.

The first version can keep the schema simple and store contracts as JSON. The important behavior is freezing verifier contracts before execution and making contract changes explicit.
