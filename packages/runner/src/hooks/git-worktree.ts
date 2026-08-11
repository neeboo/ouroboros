import type { StartHook } from "../types";
import { runLocalCommand } from "../executors/command";
import type { RunCommand } from "../executors/types";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
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
      const repositoryBoundary = await verifyRepositoryBoundary(runCommand, options.repoPath, cwd);
      if (!repositoryBoundary.ok) {
        return {
          checks: [
            ...checks,
            {
              name: "git repository boundary",
              status: "failed",
              summary: repositoryBoundary.problem,
            },
          ],
          problems: [repositoryBoundary.problem],
        };
      }
      checks.push({
        name: "git repository boundary",
        status: "passed",
        summary: "existing task worktree belongs to the target repository",
      });
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
    const dependencyInstall = dependencyInstallCommand(
      cwd,
      bunLockBeforeInstall.snapshot.kind === "regular",
    );
    const installResult = await runCommand({
      cmd: dependencyInstall.cmd,
      stdin: "",
      env: dependencyInstall.env,
    });
    const bunLockBoundary = inspectBunLockBoundary({
      cwd,
      path: bunLockPath,
      beforeInstall: bunLockBeforeInstall.snapshot,
      installLabel: dependencyInstall.label,
    });
    const statusAfterInstall = await gitStatusSnapshot(runCommand, cwd);
    const statusBoundary = statusAfterInstall.ok && statusAfterInstall.status === statusBeforeInstall.status
      ? {
          check: {
            name: "worktree status boundary",
            status: "passed" as const,
            summary: `worktree status preserved across ${dependencyInstall.label}`,
          },
        }
      : {
          check: {
            name: "worktree status boundary",
            status: "failed" as const,
            summary: statusAfterInstall.ok
              ? `${dependencyInstall.label} changed worktree status`
              : statusAfterInstall.problem,
          },
          problem: statusAfterInstall.ok
            ? `${dependencyInstall.label} changed worktree status`
            : statusAfterInstall.problem,
        };

    if (installResult.exitCode !== 0 || bunLockBoundary.problem || statusBoundary.problem) {
      return {
        checks: [
          ...checks,
          { name: dependencyInstall.label, status: installResult.exitCode === 0 ? "passed" : "failed" },
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
        { name: dependencyInstall.label, status: "passed" },
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

function dependencyInstallCommand(cwd: string, hasTrackedBunLock: boolean) {
  try {
    const packageJson = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as {
      packageManager?: unknown;
    };
    const yarnOne = typeof packageJson.packageManager === "string"
      ? /^yarn@(1(?:\.[0-9]+){1,2})$/.exec(packageJson.packageManager)
      : null;
    if (yarnOne) {
      return {
        label: "yarn install",
        cmd: [
          "corepack",
          `yarn@${yarnOne[1]}`,
          "--cwd",
          cwd,
          "install",
          "--frozen-lockfile",
          "--non-interactive",
        ],
        env: { COREPACK_ENABLE_PROJECT_SPEC: "0" },
      };
    }
  } catch {
    // The selected installer reports malformed or missing package metadata.
  }
  return {
    label: "bun install",
    cmd: [
      "bun",
      "install",
      "--no-save",
      "--cwd",
      cwd,
      ...(hasTrackedBunLock ? ["--frozen-lockfile"] : []),
    ],
    env: undefined,
  };
}

async function verifyRepositoryBoundary(runCommand: RunCommand, repoPath: string, worktreePath: string) {
  const readCommonDir = async (cwd: string) => {
    const result = await runCommand({
      cmd: ["git", "-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      stdin: "",
    });
    if (result.exitCode !== 0 || result.stdout.trim().length === 0) {
      return {
        ok: false as const,
        problem: result.stderr || result.stdout || `failed to resolve git common directory for ${cwd}`,
      };
    }
    try {
      return { ok: true as const, path: realpathSync(result.stdout.trim()) };
    } catch {
      return { ok: false as const, problem: `failed to resolve git common directory for ${cwd}` };
    }
  };
  const target = await readCommonDir(repoPath);
  if (!target.ok) return target;
  const candidate = await readCommonDir(worktreePath);
  if (!candidate.ok) return candidate;
  if (target.path !== candidate.path) {
    return {
      ok: false as const,
      problem: "existing task worktree belongs to a different git common directory",
    };
  }
  return { ok: true as const };
}

function inspectBunLockBoundary(input: {
  cwd: string;
  path: string;
  beforeInstall: BunLockSnapshot;
  installLabel: string;
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
      return boundaryFailure(`pre-existing bun.lock changed during ${input.installLabel}`);
    }
    return {};
  }
  if (afterInstall.kind === "absent") {
    return {};
  }

  if (afterInstall.kind === "regular") {
    const summary = input.installLabel === "bun install"
      ? "bun install created bun.lock despite --no-save"
      : `${input.installLabel} created bun.lock despite the generated-artifact boundary`;
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
  return boundaryFailure(input.installLabel === "bun install"
    ? "bun install created an unsafe bun.lock despite --no-save"
    : `${input.installLabel} created an unsafe bun.lock despite the generated-artifact boundary`);
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
