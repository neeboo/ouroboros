import { describe, expect, test } from "bun:test";
import { createGitWorktreeHook } from "../packages/runner/src";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("git worktree hook", () => {
  test("falls back to the supervisor repository when a legacy run has no project root", async () => {
    const calls: string[][] = [];
    const hook = createGitWorktreeHook({
      repoPath: "/repo",
      baseRef: "main",
      runCommand: async ({ cmd }) => {
        calls.push(cmd);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    const result = await hook({
      run: {
        id: "run_1",
        projectId: "project_1",
        projectRoot: null,
        goal: "Goal",
        status: "todo",
        context: {},
      },
      task: {
        id: "task_1",
        runId: "run_1",
        parentId: null,
        cycleId: "task_1",
        status: "running",
        role: "worker",
        goal: "Task",
        prompt: "Do it",
        dependsOn: [],
        doneWhen: [],
        worktreePath: "/tmp/wt/task_1",
        sessionRef: "session-task_1",
        contextVersion: 1,
      },
      sessionName: "session-task_1",
      cwd: "/tmp/wt/task_1",
    });

    expect(calls).toEqual([
      ["git", "-C", "/repo", "worktree", "add", "/tmp/wt/task_1", "-b", "ouroboros/task_1", "main"],
      ["git", "-C", "/tmp/wt/task_1", "status", "--porcelain=v1", "-z", "--untracked-files=all"],
      ["bun", "install", "--no-save", "--cwd", "/tmp/wt/task_1"],
      ["git", "-C", "/tmp/wt/task_1", "status", "--porcelain=v1", "-z", "--untracked-files=all"],
    ]);
    expect(result).toEqual({
      checks: [
        { name: "git worktree add", status: "passed" },
        { name: "bun install", status: "passed" },
        {
          name: "worktree status boundary",
          status: "passed",
          summary: "worktree status preserved across bun install",
        },
      ],
      artifacts: [{ kind: "worktree", path: "/tmp/wt/task_1", branch: "ouroboros/task_1" }],
    });
  });

  test("creates a child run worktree from that run's project root instead of the supervisor cwd", async () => {
    const calls: string[][] = [];
    const hook = createGitWorktreeHook({
      repoPath: "/repos/hodor",
      baseRef: "main",
      runCommand: async ({ cmd }) => {
        calls.push(cmd);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    await hook({
      run: {
        id: "run_hodor_web",
        projectId: "project_hodor_web",
        projectRoot: "/repos/hodor-web",
        goal: "Verify the hodor-web delivery",
        status: "todo",
        context: { parentRunId: "run_hodor" },
      },
      task: {
        id: "task_hodor_web",
        runId: "run_hodor_web",
        parentId: null,
        cycleId: "task_hodor_web",
        status: "running",
        role: "worker",
        goal: "Verify",
        prompt: "Verify the remote delivery",
        dependsOn: [],
        doneWhen: [],
        worktreePath: "/runtime/worktrees/task_hodor_web",
        sessionRef: "session-task_hodor_web",
        contextVersion: 1,
      },
      sessionName: "session-task_hodor_web",
      cwd: "/runtime/worktrees/task_hodor_web",
    });

    expect(calls[0]).toEqual([
      "git",
      "-C",
      "/repos/hodor-web",
      "worktree",
      "add",
      "/runtime/worktrees/task_hodor_web",
      "-b",
      "ouroboros/task_hodor_web",
      "main",
    ]);
  });

  test("creates a recovery worktree from the run's frozen remote commit", async () => {
    const calls: string[][] = [];
    const expectedRemoteSha = "694a8d4c764a4a4507f58e973c8cb357e9135f9e";
    const hook = createGitWorktreeHook({
      repoPath: "/repos/hodor",
      baseRef: "main",
      runCommand: async ({ cmd }) => {
        calls.push(cmd);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    const input = hookInput("/repos/hodor-web/.ouroboros/worktrees/task_recovery");
    input.run.projectRoot = "/repos/hodor-web";
    input.run.context = { expectedRemoteSha };

    await hook(input);

    expect(calls[0]).toEqual([
      "git",
      "-C",
      "/repos/hodor-web",
      "worktree",
      "add",
      "/repos/hodor-web/.ouroboros/worktrees/task_recovery",
      "-b",
      "ouroboros/task_1",
      expectedRemoteSha,
    ]);
  });

  test("rejects an invalid frozen remote commit before creating a worktree", async () => {
    const calls: string[][] = [];
    const hook = createGitWorktreeHook({
      repoPath: "/repos/hodor-web",
      runCommand: async ({ cmd }) => {
        calls.push(cmd);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    const input = hookInput("/repos/hodor-web/.ouroboros/worktrees/task_invalid");
    input.run.context = { expectedRemoteSha: "refs/heads/main" };

    const result = await hook(input);

    expect(calls).toEqual([]);
    expect(result.problems).toEqual(["run expectedRemoteSha must be an exact lowercase commit SHA"]);
  });

  test("rejects an existing task worktree owned by a different git common directory", async () => {
    const repoPath = await committedGitRepository("target repository\n");
    const foreignRepoPath = await committedGitRepository("foreign repository\n");
    const foreignWorktreePath = await mkdtemp(join(tmpdir(), "ouroboros-foreign-worktree-parent-"));
    await rm(foreignWorktreePath, { recursive: true, force: true });
    const addWorktree = spawnCommand([
      "git",
      "-C",
      foreignRepoPath,
      "worktree",
      "add",
      "-q",
      "-b",
      "foreign-task",
      foreignWorktreePath,
      "HEAD",
    ]);
    if (addWorktree.exitCode !== 0) throw new Error(addWorktree.stderr);
    let bunCalled = false;
    try {
      const hook = createGitWorktreeHook({
        repoPath,
        runCommand: async (input) => {
          if (input.cmd[0] === "bun") {
            bunCalled = true;
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          return spawnCommand(input.cmd);
        },
      });

      const input = hookInput(foreignWorktreePath);
      input.run.projectRoot = repoPath;
      const result = await hook(input);

      expect(bunCalled).toBe(false);
      expect(result.problems ?? []).toContain("existing task worktree belongs to a different git common directory");
      expect(result.checks).toContainEqual({
        name: "git repository boundary",
        status: "failed",
        summary: "existing task worktree belongs to a different git common directory",
      });
    } finally {
      await rm(repoPath, { recursive: true, force: true });
      await rm(foreignRepoPath, { recursive: true, force: true });
      await rm(foreignWorktreePath, { recursive: true, force: true });
    }
  });

  test("reuses a child run worktree by its project root instead of the supervisor repository", async () => {
    const supervisorRepoPath = await committedGitRepository("supervisor repository\n");
    const childRepoPath = await committedGitRepository("child repository\n");
    const childWorktreePath = await mkdtemp(join(tmpdir(), "ouroboros-child-worktree-parent-"));
    await rm(childWorktreePath, { recursive: true, force: true });
    const addWorktree = spawnCommand([
      "git",
      "-C",
      childRepoPath,
      "worktree",
      "add",
      "-q",
      "-b",
      "child-task",
      childWorktreePath,
      "HEAD",
    ]);
    if (addWorktree.exitCode !== 0) throw new Error(addWorktree.stderr);

    try {
      const hook = createGitWorktreeHook({
        repoPath: supervisorRepoPath,
        runCommand: async (input) => input.cmd[0] === "bun"
          ? { exitCode: 0, stdout: "", stderr: "" }
          : spawnCommand(input.cmd),
      });
      const input = hookInput(childWorktreePath);
      input.run.projectRoot = childRepoPath;

      const result = await hook(input);

      expect(result.problems ?? []).toEqual([]);
      expect(result.checks).toContainEqual({
        name: "git repository boundary",
        status: "passed",
        summary: "existing task worktree belongs to the target repository",
      });
    } finally {
      await rm(supervisorRepoPath, { recursive: true, force: true });
      await rm(childRepoPath, { recursive: true, force: true });
      await rm(childWorktreePath, { recursive: true, force: true });
    }
  });

  test("runs one dependency install when concurrent start hooks share a worktree", async () => {
    const cwd = await gitRepository();
    let bunCalls = 0;
    let releaseInstall!: () => void;
    let markInstallStarted!: () => void;
    const installStarted = new Promise<void>((resolve) => {
      markInstallStarted = resolve;
    });
    const installRelease = new Promise<void>((resolve) => {
      releaseInstall = resolve;
    });
    try {
      const hook = createGitWorktreeHook({
        repoPath: cwd,
        runCommand: async (input) => {
          if (input.cmd[0] === "bun") {
            bunCalls += 1;
            markInstallStarted();
            await installRelease;
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          return spawnCommand(input.cmd);
        },
      });
      const firstInput = hookInput(cwd);
      const secondInput = hookInput(cwd);
      secondInput.task.id = "task_2";
      secondInput.task.sessionRef = "session-task_2";

      const first = hook(firstInput);
      await installStarted;
      const second = hook(secondInput);
      await Bun.sleep(20);

      expect(bunCalls).toBe(1);
      releaseInstall();
      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect(firstResult.problems ?? []).toEqual([]);
      expect(secondResult.problems ?? []).toEqual([]);
      expect(secondResult.checks).toContainEqual(expect.objectContaining({
        name: "worktree setup single-flight",
        status: "passed",
      }));
    } finally {
      releaseInstall?.();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("does not share setup across different frozen worktree identities", async () => {
    const cwd = await gitRepository();
    let releaseInstall!: () => void;
    let markInstallStarted!: () => void;
    const installStarted = new Promise<void>((resolve) => { markInstallStarted = resolve; });
    const installRelease = new Promise<void>((resolve) => { releaseInstall = resolve; });
    try {
      const hook = createGitWorktreeHook({
        repoPath: cwd,
        runCommand: async (input) => {
          if (input.cmd[0] === "bun") {
            markInstallStarted();
            await installRelease;
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          return spawnCommand(input.cmd);
        },
      });
      const first = hook(hookInput(cwd));
      await installStarted;
      const invalid = hookInput(cwd);
      invalid.run.context = { expectedRemoteSha: "not-a-commit" };

      const invalidResult = await hook(invalid);
      expect(invalidResult.problems).toContain("run expectedRemoteSha must be an exact lowercase commit SHA");
      expect(invalidResult.checks).not.toContainEqual(expect.objectContaining({ name: "worktree setup single-flight" }));
      releaseInstall();
      expect((await first).problems ?? []).toEqual([]);
    } finally {
      releaseInstall?.();
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("preserves and blocks on a root bun.lock created despite --no-save", async () => {
    const cwd = await gitRepository();
    const contents = "generated lock\n";
    let bunCalls = 0;
    try {
      const hook = createGitWorktreeHook({
        repoPath: cwd,
        runCommand: async (input) => {
          if (input.cmd[0] === "bun") {
            bunCalls += 1;
            await writeFile(join(cwd, "bun.lock"), contents);
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          return spawnCommand(input.cmd);
        },
      });

      const firstResult = await hook(hookInput(cwd));
      const secondResult = await hook(hookInput(cwd));

      expect(existsSync(join(cwd, "bun.lock"))).toBe(true);
      expect(bunCalls).toBe(1);
      expect(firstResult.problems ?? []).toContain("bun install created bun.lock despite --no-save");
      expect(firstResult.checks).toContainEqual({
        name: "generated artifact boundary",
        status: "failed",
        summary: "bun install created bun.lock despite --no-save",
      });
      expect(firstResult.artifacts).toContainEqual({
        kind: "generated_artifact_boundary",
        path: "bun.lock",
        worktreePath: cwd,
        source: "start-hook:git-worktree:bun-install",
        sha256: createHash("sha256").update(contents).digest("hex"),
        sizeBytes: Buffer.byteLength(contents),
        lifecycle: "preserved-and-blocked",
      });
      expect(secondResult.problems ?? []).toContain("pre-existing bun.lock is not tracked by git");
      expect(secondResult.checks).toContainEqual({
        name: "generated artifact boundary",
        status: "failed",
        summary: "pre-existing bun.lock is not tracked by git",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("preserves and blocks on a tracked bun.lock changed by dependency installation", async () => {
    const cwd = await gitRepository();
    const bunLockPath = join(cwd, "bun.lock");
    await writeFile(bunLockPath, "operator lock\n");
    const add = spawnCommand(["git", "-C", cwd, "add", "--", "bun.lock"]);
    if (add.exitCode !== 0) throw new Error(add.stderr);
    try {
      const hook = createGitWorktreeHook({
        repoPath: cwd,
        runCommand: async (input) => {
          if (input.cmd[0] === "bun") {
            await writeFile(bunLockPath, "installer changed lock\n");
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          return spawnCommand(input.cmd);
        },
      });

      const result = await hook(hookInput(cwd));

      expect(await readFile(bunLockPath, "utf8")).toBe("installer changed lock\n");
      expect(result.problems ?? []).toContain("pre-existing bun.lock changed during bun install");
      expect(result.artifacts ?? []).not.toContainEqual(expect.objectContaining({ kind: "generated_artifact" }));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("preserves and blocks on an unexpected generated file", async () => {
    const cwd = await gitRepository();
    const unexpectedPath = join(cwd, "package-lock.json");
    try {
      const hook = createGitWorktreeHook({
        repoPath: cwd,
        runCommand: async (input) => {
          if (input.cmd[0] === "bun") {
            await writeFile(unexpectedPath, "unexpected\n");
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          return spawnCommand(input.cmd);
        },
      });

      const result = await hook(hookInput(cwd));

      expect(await readFile(unexpectedPath, "utf8")).toBe("unexpected\n");
      expect(result.problems ?? []).toContain("bun install changed worktree status");
      expect(result.artifacts).not.toContainEqual(expect.objectContaining({ kind: "generated_artifact" }));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("preserves an unchanged tracked bun.lock without claiming it", async () => {
    const cwd = await gitRepository();
    const bunLockPath = join(cwd, "bun.lock");
    await writeFile(bunLockPath, "operator lock\n");
    const add = spawnCommand(["git", "-C", cwd, "add", "--", "bun.lock"]);
    if (add.exitCode !== 0) throw new Error(add.stderr);
    try {
      const hook = createGitWorktreeHook({
        repoPath: cwd,
        runCommand: async (input) => {
          if (input.cmd[0] === "bun") {
            expect(input.cmd).toContain("--frozen-lockfile");
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          return spawnCommand(input.cmd);
        },
      });

      const result = await hook(hookInput(cwd));

      expect(await readFile(bunLockPath, "utf8")).toBe("operator lock\n");
      expect(result.problems).toBeUndefined();
      expect(result.artifacts).not.toContainEqual(expect.objectContaining({ kind: "generated_artifact" }));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("preserves and blocks on a bun.lock added to the index by dependency installation", async () => {
    const cwd = await gitRepository();
    const bunLockPath = join(cwd, "bun.lock");
    try {
      const hook = createGitWorktreeHook({
        repoPath: cwd,
        runCommand: async (input) => {
          if (input.cmd[0] === "bun") {
            await writeFile(bunLockPath, "tracked lock\n");
            const add = spawnCommand(["git", "-C", cwd, "add", "--", "bun.lock"]);
            if (add.exitCode !== 0) throw new Error(add.stderr);
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          return spawnCommand(input.cmd);
        },
      });

      const result = await hook(hookInput(cwd));

      expect(await readFile(bunLockPath, "utf8")).toBe("tracked lock\n");
      expect(result.problems ?? []).toContain("bun install created bun.lock despite --no-save");
      expect(result.artifacts).toContainEqual(expect.objectContaining({
        kind: "generated_artifact_boundary",
        path: "bun.lock",
        lifecycle: "preserved-and-blocked",
      }));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("preserves and blocks on a generated bun.lock symlink", async () => {
    const cwd = await gitRepository();
    const outside = await mkdtemp(join(tmpdir(), "ouroboros-worktree-hook-outside-"));
    const outsideTarget = join(outside, "operator.lock");
    const bunLockPath = join(cwd, "bun.lock");
    await writeFile(outsideTarget, "outside\n");
    try {
      const hook = createGitWorktreeHook({
        repoPath: cwd,
        runCommand: async (input) => {
          if (input.cmd[0] === "bun") {
            await symlink(outsideTarget, bunLockPath);
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          return spawnCommand(input.cmd);
        },
      });

      const result = await hook(hookInput(cwd));

      expect(existsSync(bunLockPath)).toBe(true);
      expect(await readFile(outsideTarget, "utf8")).toBe("outside\n");
      expect(result.problems ?? []).toContain("bun install created an unsafe bun.lock despite --no-save");
      expect(result.artifacts).not.toContainEqual(expect.objectContaining({ kind: "generated_artifact" }));
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("preserves and blocks on a pre-existing broken bun.lock symlink", async () => {
    const cwd = await gitRepository();
    const bunLockPath = join(cwd, "bun.lock");
    const missingTarget = join(cwd, "missing.lock");
    let bunCalled = false;
    await symlink(missingTarget, bunLockPath);
    try {
      const hook = createGitWorktreeHook({
        repoPath: cwd,
        runCommand: async (input) => {
          if (input.cmd[0] === "bun") {
            bunCalled = true;
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          return spawnCommand(input.cmd);
        },
      });

      const result = await hook(hookInput(cwd));

      expect(await readlink(bunLockPath)).toBe(missingTarget);
      expect(bunCalled).toBe(false);
      expect(result.problems ?? []).toContain("pre-existing bun.lock is not a regular file");
      expect(result.artifacts ?? []).not.toContainEqual(expect.objectContaining({ kind: "generated_artifact" }));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("uses Bun for a legacy Yarn-declared repository without writing bun.lock", async () => {
    const cwd = await gitRepository();
    await writeFile(join(cwd, "package.json"), JSON.stringify({
      name: "empty-yarn-repository",
      private: true,
      packageManager: "yarn@1.22.22",
      dependencies: {},
      devDependencies: {},
    }, null, 2));
    await writeFile(join(cwd, "yarn.lock"), "# yarn lockfile v1\n");
    await writeFile(join(cwd, ".gitignore"), "node_modules\n");
    const commit = spawnCommand([
      "git",
      "-C",
      cwd,
      "-c",
      "user.name=Ouroboros Test",
      "-c",
      "user.email=ouroboros@example.invalid",
      "add",
      "--all",
    ]);
    if (commit.exitCode !== 0) throw new Error(commit.stderr);
    const commitResult = spawnCommand([
      "git",
      "-C",
      cwd,
      "-c",
      "user.name=Ouroboros Test",
      "-c",
      "user.email=ouroboros@example.invalid",
      "commit",
      "-qm",
      "fixture",
    ]);
    if (commitResult.exitCode !== 0) throw new Error(commitResult.stderr);
    try {
      const result = await createGitWorktreeHook({ repoPath: cwd })(hookInput(cwd));
      const status = spawnCommand(["git", "-C", cwd, "status", "--porcelain=v1", "--untracked-files=all"]);

      expect(result.problems).toBeUndefined();
      expect(result.checks).toContainEqual({ name: "bun install", status: "passed" });
      expect(existsSync(join(cwd, "bun.lock"))).toBe(false);
      expect(status).toMatchObject({ exitCode: 0, stdout: "" });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 10_000);

  test("never invokes Yarn or Corepack for a legacy Yarn-declared repository", async () => {
    const cwd = await gitRepository();
    await writeFile(join(cwd, "package.json"), JSON.stringify({
      name: "yarn-repository",
      private: true,
      packageManager: "yarn@1.22.22",
    }));
    await writeFile(join(cwd, "yarn.lock"), "# yarn lockfile v1\n");
    const calls: string[][] = [];
    try {
      const result = await createGitWorktreeHook({
        repoPath: cwd,
        runCommand: async (input) => {
          calls.push(input.cmd);
          return input.cmd[0] === "git"
            ? spawnCommand(input.cmd)
            : { exitCode: 0, stdout: "", stderr: "" };
        },
      })(hookInput(cwd));

      expect(calls).toContainEqual(["bun", "install", "--no-save", "--cwd", cwd]);
      expect(calls.some((cmd) => cmd[0] === "yarn" || cmd[0] === "corepack")).toBe(false);
      expect(existsSync(join(cwd, "bun.lock"))).toBe(false);
      expect(result.problems).toBeUndefined();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

async function gitRepository() {
  const cwd = await mkdtemp(join(tmpdir(), "ouroboros-worktree-hook-"));
  const result = spawnCommand(["git", "-C", cwd, "init", "-q"]);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr);
  }
  return cwd;
}

async function committedGitRepository(contents: string) {
  const cwd = await gitRepository();
  await writeFile(join(cwd, "README.md"), contents);
  const commit = spawnCommand([
    "git",
    "-C",
    cwd,
    "-c",
    "user.name=Ouroboros Test",
    "-c",
    "user.email=ouroboros@example.invalid",
    "add",
    "README.md",
  ]);
  if (commit.exitCode !== 0) throw new Error(commit.stderr);
  const commitResult = spawnCommand([
    "git",
    "-C",
    cwd,
    "-c",
    "user.name=Ouroboros Test",
    "-c",
    "user.email=ouroboros@example.invalid",
    "commit",
    "-qm",
    "fixture",
  ]);
  if (commitResult.exitCode !== 0) throw new Error(commitResult.stderr);
  return cwd;
}

function spawnCommand(cmd: string[]) {
  const result = Bun.spawnSync({ cmd, stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

function hookInput(cwd: string) {
  return {
    run: {
      id: "run_1",
      projectId: "project_1",
      projectRoot: cwd,
      goal: "Goal",
      status: "todo" as const,
      context: {},
    },
    task: {
      id: "task_1",
      runId: "run_1",
      parentId: null,
      cycleId: "task_1",
      status: "running" as const,
      role: "worker",
      goal: "Task",
      prompt: "Do it",
      dependsOn: [],
      doneWhen: [],
      worktreePath: cwd,
      sessionRef: "session-task_1",
      contextVersion: 1,
    },
    sessionName: "session-task_1",
    cwd,
  };
}
