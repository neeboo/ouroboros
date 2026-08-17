import type { Run, Task } from "@ouroboros/harness";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { runLocalCommand } from "./executors/command";
import type { RunCommand } from "./executors/types";

export interface HostCapabilityReadback {
  docker?: {
    status: "available" | "unavailable";
    source: "host-owned-preflight";
    serverVersion?: string;
    problemCode?: "docker_cli_unavailable" | "docker_info_failed" | "invalid_server_version";
  };
  repositoryManifest?: {
    status: "verified" | "blocked";
    source: "host-owned-exact-manifest-preflight";
    repositoryId: string;
    worktreePath: string;
    head: { expected: string; actual: string };
    branch: { expected: string; actual: string };
    commonGitDir: { expected: string; actual: string };
    gitDir: string;
    files: Array<{
      path: string;
      sha256: string;
      sizeBytes: number;
      status: string;
      expectedStatus: string;
      matches: boolean;
    }>;
    manifestSha256: string;
    indexBeforeSha256: string;
    indexAfterSha256: string;
    statusBeforeSha256: string;
    statusAfterSha256: string;
    targetFilesChanged: number;
    indexChanged: boolean;
    problems: string[];
  };
}

export type HostReadbackForTask = (input: {
  run: Run;
  task: Task;
  cwd: string;
}) => Promise<HostCapabilityReadback | null>;

export async function readHostCapabilityReadback(input: {
  run: Run;
  task: Task;
  cwd: string;
  runCommand?: RunCommand;
}): Promise<HostCapabilityReadback | null> {
  const runCommand = input.runCommand ?? runLocalCommand;
  const readback: HostCapabilityReadback = {};
  if (taskRequiresDocker(input.run, input.task)) {
    let result;
    try {
      result = await runCommand({
        cmd: ["docker", "info", "--format", "{{.ServerVersion}}"],
        stdin: "",
        cwd: input.cwd,
        timeoutMs: 5_000,
        idleTimeoutMs: 5_000,
      });
    } catch {
      readback.docker = { status: "unavailable", source: "host-owned-preflight", problemCode: "docker_cli_unavailable" };
      return readback;
    }
    if (result.exitCode !== 0) {
      readback.docker = { status: "unavailable", source: "host-owned-preflight", problemCode: "docker_info_failed" };
      return readback;
    }
    const serverVersion = result.stdout.trim();
    readback.docker = /^[0-9A-Za-z.+_-]{1,64}$/.test(serverVersion)
      ? { status: "available", source: "host-owned-preflight", serverVersion }
      : { status: "unavailable", source: "host-owned-preflight", problemCode: "invalid_server_version" };
  }
  if (requiresExactRepositoryManifest(input.task)) {
    readback.repositoryManifest = await readExactRepositoryManifest(input.task, input.cwd, runCommand);
  }
  return Object.keys(readback).length > 0 ? readback : null;
}

export function renderHostCapabilityReadback(readback: HostCapabilityReadback | null | undefined) {
  if (!readback) {
    return "";
  }
  const sections: string[] = [];
  if (readback.docker) {
    sections.push([
      "## Host-Owned Capability Readback",
      "The harness ran this read-only probe outside the model sandbox before task start.",
      JSON.stringify({ docker: readback.docker }, null, 2),
      "A sandbox socket denial means this task lacks direct Docker capability; it does not prove that the host Docker daemon is unavailable.",
      "Use only the execution route and capabilities frozen for this task; do not bypass them.",
      "",
    ].join("\n"));
  }
  if (readback.repositoryManifest) {
    sections.push([
      "## Host-Owned Exact Repository Manifest",
      "The harness read the frozen paths directly without creating a script or temporary file in the repository.",
      JSON.stringify(readback.repositoryManifest, null, 2),
      "Independently judge this machine receipt. Do not rebuild it with a shell heredoc or write into the repository.",
      "",
    ].join("\n"));
  }
  return sections.join("\n");
}

export function hostCapabilityReadbackProblem(readback: HostCapabilityReadback | null | undefined) {
  const manifest = readback?.repositoryManifest;
  return manifest?.status === "blocked"
    ? `host-owned exact repository manifest preflight failed: ${manifest.problems.join("; ")}`
    : null;
}

function taskRequiresDocker(run: Run, task: Task) {
  return [run.goal, task.goal, task.prompt, ...task.doneWhen].some((value) => /\bdocker\b/i.test(value));
}

function requiresExactRepositoryManifest(task: Task) {
  return task.role === "verifier"
    && task.config?.verifierScope === "hash-path-index-readback-only"
    && task.config?.frozenRepositoryReceipt != null
    && typeof task.config.frozenRepositoryReceipt === "object"
    && !Array.isArray(task.config.frozenRepositoryReceipt);
}

async function readExactRepositoryManifest(task: Task, cwd: string, runCommand: RunCommand) {
  const frozen = task.config!.frozenRepositoryReceipt as Record<string, unknown>;
  const repositoryId = typeof frozen.repositoryId === "string" ? frozen.repositoryId : "invalid";
  const expectedHead = typeof frozen.head === "string" ? frozen.head : "";
  const expectedBranch = typeof frozen.branch === "string" ? frozen.branch : "";
  const expectedWorktree = typeof frozen.worktreePath === "string" ? frozen.worktreePath : "";
  const expectedCommonGitDir = typeof frozen.commonGitDir === "string" ? frozen.commonGitDir : "";
  const frozenFiles = Array.isArray(frozen.files) ? frozen.files : [];
  const problems: string[] = [];
  const command = async (args: string[]) => {
    const result = await runCommand({
      cmd: ["git", ...args],
      stdin: "",
      cwd,
      timeoutMs: 5_000,
      idleTimeoutMs: 5_000,
    });
    if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed with exit ${result.exitCode}`);
    return result.stdout;
  };
  let head = "";
  let branch = "";
  let indexBefore = "";
  let indexAfter = "";
  let statusBefore = "";
  let statusAfter = "";
  let root = "";
  let gitDir = "";
  let commonGitDir = "";
  let canonicalExpectedWorktree = expectedWorktree;
  let canonicalExpectedCommonGitDir = expectedCommonGitDir;
  try {
    root = await realpath(cwd);
    canonicalExpectedWorktree = await realpath(expectedWorktree);
    canonicalExpectedCommonGitDir = await realpath(expectedCommonGitDir);
    head = (await command(["rev-parse", "HEAD"])).trim();
    branch = (await command(["branch", "--show-current"])).trim();
    gitDir = await realpath(resolve(cwd, (await command(["rev-parse", "--git-dir"])).trim()));
    commonGitDir = await realpath(resolve(cwd, (await command(["rev-parse", "--git-common-dir"])).trim()));
    indexBefore = await command(["ls-files", "--stage", "-z"]);
    statusBefore = await command(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  if (!expectedWorktree || root !== canonicalExpectedWorktree) problems.push("worktree path drifted from the frozen receipt");
  if (!expectedHead || head !== expectedHead) problems.push("repository HEAD drifted from the frozen receipt");
  if (!expectedBranch || branch !== expectedBranch) problems.push("repository branch drifted from the frozen receipt");
  if (!expectedCommonGitDir || commonGitDir !== canonicalExpectedCommonGitDir) {
    problems.push("repository common Git directory drifted from the frozen receipt");
  }
  const statusByPath = parsePorcelainStatus(statusBefore);
  const frozenPaths = new Set<string>();
  const files: Array<{
    path: string;
    sha256: string;
    sizeBytes: number;
    status: string;
    expectedStatus: string;
    matches: boolean;
  }> = [];
  for (const [index, value] of frozenFiles.entries()) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      problems.push(`frozen file ${index} is invalid`);
      continue;
    }
    const file = value as Record<string, unknown>;
    const path = typeof file.path === "string" ? file.path : "";
    const expectedSha256 = typeof file.sha256 === "string" ? file.sha256 : "";
    const expectedSizeBytes = typeof file.sizeBytes === "number" ? file.sizeBytes : -1;
    const expectedStatus = typeof file.status === "string" ? file.status : "";
    if (frozenPaths.has(path)) problems.push(`${path || `file[${index}]`} is duplicated in the frozen receipt`);
    frozenPaths.add(path);
    let sha256 = "";
    let sizeBytes = -1;
    let safe = false;
    try {
      const absolute = resolve(root, path);
      const fromRoot = relative(root, absolute);
      if (!path || fromRoot.startsWith("..") || fromRoot === "" || fromRoot.startsWith("/")) {
        throw new Error("path escapes the frozen worktree");
      }
      const stat = await lstat(absolute);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("path is not a regular file");
      const canonical = await realpath(absolute);
      if (relative(root, canonical).startsWith("..")) throw new Error("path resolves outside the frozen worktree");
      const contents = await readFile(canonical);
      sha256 = hash(contents);
      sizeBytes = contents.byteLength;
      safe = true;
    } catch (error) {
      problems.push(`${path || `file[${index}]`}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const status = statusByPath.get(path) ?? "tracked-clean";
    const matches = safe && sha256 === expectedSha256 && sizeBytes === expectedSizeBytes && status === expectedStatus;
    if (!matches) problems.push(`${path || `file[${index}]`} does not match its frozen path/size/SHA/status receipt`);
    files.push({ path, sha256, sizeBytes, status, expectedStatus, matches });
  }
  for (const path of statusByPath.keys()) {
    if (!frozenPaths.has(path)) problems.push(`${path} is an unexpected changed path outside the frozen manifest`);
  }
  try {
    indexAfter = await command(["ls-files", "--stage", "-z"]);
    statusAfter = await command(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  let targetFilesChanged = 0;
  for (const file of files) {
    try {
      const absolute = resolve(root, file.path);
      const stat = await lstat(absolute);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("path is not a regular file");
      const contents = await readFile(await realpath(absolute));
      if (contents.byteLength !== file.sizeBytes || hash(contents) !== file.sha256) targetFilesChanged += 1;
    } catch {
      targetFilesChanged += 1;
    }
  }
  const indexChanged = indexBefore !== indexAfter;
  const statusChanged = statusBefore !== statusAfter;
  if (indexChanged) problems.push("Git index changed while collecting the host receipt");
  if (statusChanged) problems.push("target files changed while collecting the host receipt");
  if (targetFilesChanged > 0) problems.push(`${targetFilesChanged} target file(s) changed while collecting the host receipt`);
  const manifestSha256 = hash(JSON.stringify(files));
  return {
    status: problems.length === 0 ? "verified" as const : "blocked" as const,
    source: "host-owned-exact-manifest-preflight" as const,
    repositoryId,
    worktreePath: root || cwd,
    head: { expected: expectedHead, actual: head },
    branch: { expected: expectedBranch, actual: branch },
    commonGitDir: { expected: canonicalExpectedCommonGitDir, actual: commonGitDir },
    gitDir,
    files,
    manifestSha256,
    indexBeforeSha256: hash(indexBefore),
    indexAfterSha256: hash(indexAfter),
    statusBeforeSha256: hash(statusBefore),
    statusAfterSha256: hash(statusAfter),
    targetFilesChanged: targetFilesChanged + (statusChanged ? 1 : 0),
    indexChanged,
    problems,
  };
}

function parsePorcelainStatus(value: string) {
  const statuses = new Map<string, string>();
  for (const record of value.split("\0").filter(Boolean)) {
    if (record.length < 4) continue;
    const code = record.slice(0, 2);
    const path = record.slice(3);
    const status = code === "??" ? "untracked"
      : code.includes("A") ? "added"
      : code.includes("M") ? "modified"
      : code.includes("D") ? "deleted"
      : "changed";
    statuses.set(path, status);
  }
  return statuses;
}

function hash(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}
