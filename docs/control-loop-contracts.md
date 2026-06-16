# Control Loops and Contracts

Ouroboros should treat autonomous coding as a control system. A prompt starts the work, but contracts, loops, verification, and accumulated operating rules decide whether the work can keep running without constant human steering.

This document defines the intended loop shape for self-iteration and larger project goals.

## Core Principle

A run has three different loops:

```text
planning loop -> execution loop -> goal review loop
```

Each loop can create tasks, but each loop has a different authority.

- The planning loop defines the goal contract, task graph, verifier contract, and stop policy.
- The execution loop changes artifacts until verifier evidence satisfies the frozen contract.
- The goal review loop decides whether the whole run is complete or needs a new planning pass.

Execution should not redefine success. If the verifier contract is wrong, the run needs an explicit contract amendment instead of a silent standard change.

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

## Minimal Next Implementation

The smallest useful implementation should add:

- persisted goal contract JSON on runs;
- persisted verifier contract JSON on verifier tasks or run context;
- a planning-loop task type or planner mode that can revise contracts before execution;
- contract version metadata on verifier attempts;
- a guardrail table or guardrail section in run context;
- an experience pattern artifact type for successful reusable procedures.

The first version can keep the schema simple and store contracts as JSON. The important behavior is freezing verifier contracts before execution and making contract changes explicit.
