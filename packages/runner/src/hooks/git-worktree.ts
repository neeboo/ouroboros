import type { StartHook } from "../types";
import { runLocalCommand } from "../executors/command";
import type { RunCommand } from "../executors/types";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

const GENERATED_BUN_LOCK = "bun.lock";
const GENERATED_BUN_LOCK_SOURCE = "start-hook:git-worktree:bun-install";

export function createGitWorktreeHook(options: {
  repoPath: string;
  baseRef?: string;
  runCommand?: RunCommand;
}): StartHook {
  const runCommand = options.runCommand ?? runLocalCommand;
  const baseRef = options.baseRef ?? "main";

  return async ({ task, cwd }) => {
    const branch = `ouroboros/${task.id}`;
    const checks: Array<{ name: string; status: "passed" | "failed"; summary?: string }> = [];

    if (existsSync(cwd)) {
      const existingResult = await runCommand({
        cmd: ["git", "-C", cwd, "rev-parse", "--is-inside-work-tree"],
        stdin: "",
      });
      if (existingResult.exitCode !== 0) {
        return {
          checks: [{ name: "git worktree reuse", status: "failed" }],
          problems: [existingResult.stderr || existingResult.stdout || `exit code ${existingResult.exitCode}`],
        };
      }
      checks.push({ name: "git worktree reuse", status: "passed", summary: "existing task worktree reused" });
    } else {
      const result = await runCommand({
        cmd: ["git", "-C", options.repoPath, "worktree", "add", cwd, "-b", branch, baseRef],
        stdin: "",
      });

      if (result.exitCode !== 0) {
        return {
          checks: [{ name: "git worktree add", status: "failed" }],
          problems: [result.stderr || result.stdout || `exit code ${result.exitCode}`],
        };
      }
      checks.push({ name: "git worktree add", status: "passed" });
    }

    const bunLockPath = join(cwd, GENERATED_BUN_LOCK);
    const bunLockBeforeInstall = trySnapshotBunLock(bunLockPath);
    if (!bunLockBeforeInstall.ok) {
      return boundaryFailureResult(checks, bunLockBeforeInstall.problem);
    }
    if (bunLockBeforeInstall.snapshot.kind === "symlink" || bunLockBeforeInstall.snapshot.kind === "other") {
      return boundaryFailureResult(checks, "pre-existing bun.lock is not a regular file");
    }
    if (bunLockBeforeInstall.snapshot.kind === "regular") {
      const trackedBunLock = await gitTracksBunLock(runCommand, cwd);
      if (!trackedBunLock.ok) {
        return boundaryFailureResult(checks, trackedBunLock.problem);
      }
      if (!trackedBunLock.tracked) {
        return boundaryFailureResult(checks, "pre-existing bun.lock is not tracked by git");
      }
    }
    const statusBeforeInstall = await gitStatusSnapshot(runCommand, cwd);
    if (!statusBeforeInstall.ok) {
      return {
        checks: [
          ...checks,
          { name: "generated artifact boundary", status: "failed", summary: statusBeforeInstall.problem },
        ],
        problems: [statusBeforeInstall.problem],
      };
    }
    const installResult = await runCommand({
      cmd: [
        "bun",
        "install",
        "--no-save",
        "--cwd",
        cwd,
        ...(bunLockBeforeInstall.snapshot.kind === "regular" ? ["--frozen-lockfile"] : []),
      ],
      stdin: "",
    });
    const bunLockBoundary = inspectBunLockBoundary({
      cwd,
      path: bunLockPath,
      beforeInstall: bunLockBeforeInstall.snapshot,
    });
    const statusAfterInstall = await gitStatusSnapshot(runCommand, cwd);
    const statusBoundary = statusAfterInstall.ok && statusAfterInstall.status === statusBeforeInstall.status
      ? {
          check: {
            name: "worktree status boundary",
            status: "passed" as const,
            summary: "worktree status preserved across bun install",
          },
        }
      : {
          check: {
            name: "worktree status boundary",
            status: "failed" as const,
            summary: statusAfterInstall.ok
              ? "bun install changed worktree status"
              : statusAfterInstall.problem,
          },
          problem: statusAfterInstall.ok
            ? "bun install changed worktree status"
            : statusAfterInstall.problem,
        };

    if (installResult.exitCode !== 0 || bunLockBoundary.problem || statusBoundary.problem) {
      return {
        checks: [
          ...checks,
          { name: "bun install", status: installResult.exitCode === 0 ? "passed" : "failed" },
          ...(bunLockBoundary.check ? [bunLockBoundary.check] : []),
          statusBoundary.check,
        ],
        artifacts: bunLockBoundary.artifact ? [bunLockBoundary.artifact] : [],
        problems: [
          ...(installResult.exitCode === 0
            ? []
            : [installResult.stderr || installResult.stdout || `exit code ${installResult.exitCode}`]),
          ...(bunLockBoundary.problem ? [bunLockBoundary.problem] : []),
          ...(statusBoundary.problem ? [statusBoundary.problem] : []),
        ],
      };
    }

    return {
      checks: [
        ...checks,
        { name: "bun install", status: "passed" },
        ...(bunLockBoundary.check ? [bunLockBoundary.check] : []),
        statusBoundary.check,
      ],
      artifacts: [
        { kind: "worktree", path: cwd, branch },
        ...(bunLockBoundary.artifact ? [bunLockBoundary.artifact] : []),
      ],
    };
  };
}

function inspectBunLockBoundary(input: {
  cwd: string;
  path: string;
  beforeInstall: BunLockSnapshot;
}): GeneratedArtifactBoundaryResult {
  const afterInstallResult = trySnapshotBunLock(input.path);
  if (!afterInstallResult.ok) {
    return boundaryFailure(afterInstallResult.problem);
  }
  const afterInstall = afterInstallResult.snapshot;
  if (input.beforeInstall.kind !== "absent") {
    if (input.beforeInstall.kind !== "regular") {
      return boundaryFailure("pre-existing bun.lock is not a regular file");
    }
    if (!sameBunLockSnapshot(input.beforeInstall, afterInstall)) {
      return boundaryFailure("pre-existing bun.lock changed during bun install");
    }
    return {};
  }
  if (afterInstall.kind === "absent") {
    return {};
  }

  if (afterInstall.kind === "regular") {
    const summary = "bun install created bun.lock despite --no-save";
    return {
      check: {
        name: "generated artifact boundary",
        status: "failed" as const,
        summary,
      },
      artifact: {
        kind: "generated_artifact_boundary",
        path: GENERATED_BUN_LOCK,
        worktreePath: input.cwd,
        source: GENERATED_BUN_LOCK_SOURCE,
        sha256: afterInstall.sha256,
        sizeBytes: afterInstall.sizeBytes,
        lifecycle: "preserved-and-blocked",
      },
      problem: summary,
    };
  }
  return boundaryFailure("bun install created an unsafe bun.lock despite --no-save");
}

type GeneratedArtifactBoundaryResult = {
  check?: { name: string; status: "passed" | "failed"; summary: string };
  artifact?: {
    kind: "generated_artifact_boundary";
    path: string;
    worktreePath: string;
    source: string;
    sha256: string;
    sizeBytes: number;
    lifecycle: "preserved-and-blocked";
  };
  problem?: string;
};

function boundaryFailure(summary: string): GeneratedArtifactBoundaryResult {
  return {
    check: {
      name: "generated artifact boundary",
      status: "failed" as const,
      summary,
    },
    problem: summary,
  };
}

function boundaryFailureResult(
  checks: Array<{ name: string; status: "passed" | "failed"; summary?: string }>,
  problem: string,
) {
  return {
    checks: [...checks, boundaryFailure(problem).check!],
    problems: [problem],
  };
}

type BunLockSnapshot =
  | { kind: "absent" }
  | { kind: "regular"; sizeBytes: number; sha256: string }
  | { kind: "symlink"; target: string }
  | { kind: "other" };

function snapshotBunLock(path: string): BunLockSnapshot {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "absent" };
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    return { kind: "symlink", target: readlinkSync(path) };
  }
  if (!stat.isFile()) {
    return { kind: "other" };
  }
  const contents = readFileSync(path);
  return {
    kind: "regular",
    sizeBytes: contents.byteLength,
    sha256: createHash("sha256").update(contents).digest("hex"),
  };
}

function trySnapshotBunLock(path: string):
  | { ok: true; snapshot: BunLockSnapshot }
  | { ok: false; problem: string } {
  try {
    return { ok: true, snapshot: snapshotBunLock(path) };
  } catch (error) {
    return {
      ok: false,
      problem: error instanceof Error ? error.message : String(error),
    };
  }
}

function sameBunLockSnapshot(left: BunLockSnapshot, right: BunLockSnapshot) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function gitStatusSnapshot(runCommand: RunCommand, cwd: string) {
  const result = await runCommand({
    cmd: ["git", "-C", cwd, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
    stdin: "",
  });
  if (result.exitCode !== 0) {
    return {
      ok: false as const,
      problem: result.stderr || result.stdout || `git status exited with code ${result.exitCode}`,
    };
  }
  return { ok: true as const, status: result.stdout };
}

async function gitTracksBunLock(runCommand: RunCommand, cwd: string) {
  const result = await runCommand({
    cmd: ["git", "-C", cwd, "ls-files", "--error-unmatch", "--", GENERATED_BUN_LOCK],
    stdin: "",
  });
  if (result.exitCode === 0 && result.stdout.trim() === GENERATED_BUN_LOCK) {
    return { ok: true as const, tracked: true as const };
  }
  if (result.exitCode === 1) {
    return { ok: true as const, tracked: false as const };
  }
  return {
    ok: false as const,
    problem: result.stderr || result.stdout || `git ls-files exited with code ${result.exitCode}`,
  };
}
