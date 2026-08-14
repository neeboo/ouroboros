# DSH CLI Executor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add DeepSeek Harness as an explicit, bounded one-shot executor while preserving Ouroboros as the control plane.

**Architecture:** Extend backend resolution with `dsh-cli`, execute `dsh --profile headless` in the exact task worktree, parse its stdout into the existing `AttemptOutput` contract, and fail closed on unsupported permissions or malformed evidence. Keep `codex-resumable` as the default and defer ACP sessions to a later milestone.

**Tech Stack:** TypeScript, Bun, existing runner executor interfaces, existing bounded diagnostics and prompt budgets.

---

### Task 1: Define the DSH backend contract

**Files:**

- Modify: `packages/runner/src/agent-backends.ts`
- Modify: `packages/runner/src/execution-routing.ts`
- Modify: `packages/cli/src/config.ts`
- Modify: `packages/harness/src/actions.ts`
- Test: `tests/runner.test.ts`
- Test: `tests/config.test.ts`
- Test: `tests/harness-actions.test.ts`

**Step 1: Write failing tests**

Add tests for the built-in `dsh-cli` backend, a named DSH backend with `command` and `profile`, DSH model ownership, and rejection of unsupported profile values.

**Step 2: Run the focused tests and confirm RED**

Run:

```bash
bun test tests/runner.test.ts tests/config.test.ts tests/harness-actions.test.ts --test-name-pattern 'dsh|DeepSeek Harness'
```

**Step 3: Implement the smallest backend contract**

Add `dsh-cli` to the backend kind, normalize `command` and `profile`, expose only `headless`, return no Ouroboros model override, and allow the fixed action validator to recognize the backend.

**Step 4: Run focused tests and confirm GREEN**

**Step 5: Commit**

```bash
git add packages/runner/src/agent-backends.ts packages/runner/src/execution-routing.ts packages/cli/src/config.ts packages/harness/src/actions.ts tests/runner.test.ts tests/config.test.ts tests/harness-actions.test.ts
git commit -m "feat(runner): define dsh backend contract"
```

### Task 2: Preserve the exact task working directory

**Files:**

- Modify: `packages/runner/src/executors/types.ts`
- Modify: `packages/runner/src/executors/command.ts`
- Test: `tests/command.test.ts`

**Step 1: Write a failing test**

Prove that `runLocalCommand` ignores a requested task directory today.

**Step 2: Run the test and confirm RED**

**Step 3: Add optional `cwd` to the command contract and Bun spawn call**

**Step 4: Run `tests/command.test.ts` and confirm GREEN**

**Step 5: Commit**

```bash
git add packages/runner/src/executors/types.ts packages/runner/src/executors/command.ts tests/command.test.ts
git commit -m "feat(runner): execute commands in task worktrees"
```

### Task 3: Implement the bounded DSH CLI executor

**Files:**

- Create: `packages/runner/src/executors/dsh-cli.ts`
- Modify: `packages/runner/src/executors/types.ts`
- Modify: `packages/runner/src/index.ts`
- Create: `tests/dsh-executor.test.ts`

**Step 1: Write failing executor tests**

Cover valid structured output, exact argv and cwd, permission mapping, missing executable, non-zero exit, malformed output, command-line prompt limit, credential-safe diagnostics, and zero command calls for unsupported host capabilities or `danger-full-access`.

**Step 2: Run `tests/dsh-executor.test.ts` and confirm RED**

**Step 3: Implement the executor using existing prompt budgets and bounded diagnostics**

**Step 4: Run the executor test and confirm GREEN**

**Step 5: Commit**

```bash
git add packages/runner/src/executors/dsh-cli.ts packages/runner/src/executors/types.ts packages/runner/src/index.ts tests/dsh-executor.test.ts
git commit -m "feat(runner): add bounded dsh cli executor"
```

### Task 4: Route explicit tasks to DSH

**Files:**

- Modify: `packages/runner/src/route-executor.ts`
- Modify: `packages/cli/src/main.ts`
- Test: `tests/route-executor.test.ts`
- Test: `tests/cli.test.ts`

**Step 1: Write failing route tests**

Prove that an explicit `dsh-cli` task currently falls through to Codex and that unsupported host capabilities are not rejected.

**Step 2: Run focused route and CLI tests and confirm RED**

**Step 3: Wire the DSH executor into the generic task route**

Keep daemon orchestration on `codex-resumable`; only the selected task executor changes.

**Step 4: Run focused and complete route tests**

**Step 5: Commit**

```bash
git add packages/runner/src/route-executor.ts packages/cli/src/main.ts tests/route-executor.test.ts tests/cli.test.ts
git commit -m "feat(cli): route tasks to deepseek harness"
```

### Task 5: Document and verify the first real DSH route

**Files:**

- Modify: `README.md`
- Modify: `zh_CN.md`
- Test: use an isolated temporary repository and the installed `dsh` binary

**Step 1: Add concise English and Chinese usage documentation**

Document installation ownership, named backend configuration, explicit task selection, current one-shot limitation, and the planned ACP follow-up.

**Step 2: Run a real canary**

Create an isolated repository, give DSH a bounded file change, read back the exact diff and structured attempt evidence, and confirm it cannot write outside the worktree.

**Step 3: Run repository gates**

```bash
bun run typecheck
bun test
git diff --check
```

**Step 4: Request independent review**

Review permission boundaries, output parsing, credential handling, route compatibility, and documentation truthfulness.

**Step 5: Commit**

```bash
git add README.md zh_CN.md
git commit -m "docs: explain deepseek harness execution"
```
