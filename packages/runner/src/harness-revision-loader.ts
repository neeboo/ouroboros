import {
  parseHarnessRevisionV1,
  type AttemptOutput,
  type Harness,
  type HarnessRevisionComponentV1,
  type HarnessRevisionV1,
  type Run,
} from "@ouroboros/harness";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

const REPO_REF_PREFIX = "repo:";
const MAX_COMPONENT_BYTES = 256 * 1024;

export interface LoadedHarnessComponent extends HarnessRevisionComponentV1 {
  bytes: number;
}

export interface LoadedHarnessRevision {
  harnessRevision: HarnessRevisionV1;
  loadedHarnessComponents: LoadedHarnessComponent[];
}

export function loadFrozenHarnessRevision(input: {
  harness: Pick<Harness, "getProject">;
  run: Pick<Run, "projectId" | "context">;
  cwd: string;
}): LoadedHarnessRevision | null {
  const rawRevision = input.run.context.harnessRevision;
  if (rawRevision === undefined) {
    return null;
  }
  if (!input.run.projectId) {
    throw new Error("Frozen Harness Revision requires a project-bound run");
  }
  const project = input.harness.getProject(input.run.projectId);
  if (!project) {
    throw new Error("Frozen Harness Revision project is unavailable");
  }
  const revision = parseHarnessRevisionV1(
    rawRevision,
    input.run.projectId,
    "run.context.harnessRevision",
  );
  const projectRepository = gitRepositoryIdentity(project.rootPath, "project root");
  const executionRepository = gitRepositoryIdentity(input.cwd, "execution cwd");
  if (executionRepository.commonDir !== projectRepository.commonDir) {
    throw new Error("Frozen Harness Revision execution cwd belongs to a different Git repository");
  }
  const loadedHarnessComponents = revision.components.map((component) =>
    loadRepoComponent(component, executionRepository.topLevel));
  return { harnessRevision: revision, loadedHarnessComponents };
}

export function harnessRevisionAttemptInput(
  loaded: LoadedHarnessRevision | null,
): Record<string, unknown> {
  if (!loaded) {
    return {};
  }
  return {
    harnessRevision: loaded.harnessRevision,
    loadedHarnessComponents: loaded.loadedHarnessComponents,
  };
}

export function assertPersistedHarnessRevisionAttestation(
  attemptInput: Record<string, unknown>,
  loaded: LoadedHarnessRevision | null,
): void {
  const persistedRevision = attemptInput.harnessRevision;
  const persistedComponents = attemptInput.loadedHarnessComponents;
  if (!loaded) {
    if (persistedRevision !== undefined || persistedComponents !== undefined) {
      throw new Error(
        "Frozen Harness Revision attempt attestation exists without a frozen run revision",
      );
    }
    return;
  }
  if (
    JSON.stringify(persistedRevision) !== JSON.stringify(loaded.harnessRevision)
    || JSON.stringify(persistedComponents) !== JSON.stringify(loaded.loadedHarnessComponents)
  ) {
    throw new Error("Frozen Harness Revision attempt attestation does not match the loaded revision");
  }
}

export function blockedHarnessRevisionOutput(error: unknown): AttemptOutput {
  const message = error instanceof Error ? error.message : "unknown validation error";
  return {
    status: "blocked",
    summary: "Frozen Harness Revision blocked task execution",
    changedFiles: [],
    checks: [{ name: "Frozen Harness Revision", status: "failed" }],
    artifacts: [],
    problems: [`Frozen Harness Revision validation failed: ${message.slice(0, 512)}`],
  };
}

function loadRepoComponent(
  component: HarnessRevisionComponentV1,
  cwdRoot: string,
): LoadedHarnessComponent {
  if (!component.ref.startsWith(REPO_REF_PREFIX)) {
    throw new Error(
      `Frozen Harness Revision component ${component.kind} must use a repo: ref`,
    );
  }
  const relativePath = component.ref.slice(REPO_REF_PREFIX.length);
  if (
    relativePath.length === 0
    || isAbsolute(relativePath)
    || relativePath.startsWith("/")
    || relativePath.startsWith("\\")
    || relativePath.split(/[\\/]/).includes("..")
  ) {
    throw new Error(
      `Frozen Harness Revision component ${component.kind} has an invalid repo path`,
    );
  }
  const candidate = resolve(cwdRoot, relativePath);
  if (!isWithin(cwdRoot, candidate)) {
    throw new Error(`Frozen Harness Revision component ${component.kind} escapes the execution cwd`);
  }

  let realPath: string;
  try {
    realPath = realpathSync(candidate);
  } catch {
    throw new Error(`Frozen Harness Revision component ${component.kind} is missing or unreadable`);
  }
  if (!isWithin(cwdRoot, realPath)) {
    throw new Error(
      `Frozen Harness Revision component ${component.kind} must be a regular file inside the execution cwd`,
    );
  }
  if (typeof fsConstants.O_NOFOLLOW !== "number" || fsConstants.O_NOFOLLOW === 0) {
    throw new Error("Frozen Harness Revision secure no-follow file loading is unavailable");
  }

  let fd: number | null = null;
  try {
    fd = openSync(candidate, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = fstatSync(fd);
    validateOpenedComponent(before, component.kind);
    const contents = readFileSync(fd);
    const after = fstatSync(fd);
    validateOpenedComponent(after, component.kind);
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
      || contents.byteLength !== after.size
    ) {
      throw new Error(`Frozen Harness Revision component ${component.kind} changed while loading`);
    }
    const sha256 = createHash("sha256").update(contents).digest("hex");
    if (sha256 !== component.sha256) {
      throw new Error(`Frozen Harness Revision component ${component.kind} SHA-256 does not match`);
    }
    return { ...component, bytes: contents.byteLength };
  } catch {
    throw new Error(`Frozen Harness Revision component ${component.kind} failed secure loading`);
  } finally {
    if (fd !== null) {
      closeSync(fd);
    }
  }
}

function validateOpenedComponent(
  file: ReturnType<typeof fstatSync>,
  kind: HarnessRevisionComponentV1["kind"],
): void {
  if (!file.isFile() || file.nlink !== 1) {
    throw new Error(`Frozen Harness Revision component ${kind} must be a single-link regular file`);
  }
  if (file.size > MAX_COMPONENT_BYTES) {
    throw new Error(`Frozen Harness Revision component ${kind} exceeds the size limit`);
  }
}

function trustedRealDirectory(path: string, label: string): string {
  let realPath: string;
  let pathInfo: ReturnType<typeof lstatSync>;
  try {
    realPath = realpathSync(path);
    pathInfo = lstatSync(realPath);
  } catch {
    throw new Error(`Frozen Harness Revision ${label} is unavailable`);
  }
  if (!pathInfo.isDirectory()) {
    throw new Error(`Frozen Harness Revision ${label} must be a directory`);
  }
  return realPath;
}

function gitRepositoryIdentity(path: string, label: string): {
  topLevel: string;
  commonDir: string;
} {
  const root = trustedRealDirectory(path, label);
  const result = spawnSync(
    "/usr/bin/git",
    [
      "-C",
      root,
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
      "--git-common-dir",
    ],
    {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 16 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        LANG: "C",
        LC_ALL: "C",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_OPTIONAL_LOCKS: "0",
      },
    },
  );
  if (result.status !== 0 || result.error || typeof result.stdout !== "string") {
    throw new Error(`Frozen Harness Revision ${label} is not a readable Git worktree`);
  }
  const lines = result.stdout.trimEnd().split("\n");
  if (lines.length !== 2 || lines.some((line) => !isAbsolute(line))) {
    throw new Error(`Frozen Harness Revision ${label} returned an invalid Git identity`);
  }
  const topLevel = trustedRealDirectory(lines[0]!, `${label} Git top-level`);
  const commonDir = trustedRealDirectory(lines[1]!, `${label} Git common-dir`);
  if (!isWithin(topLevel, root)) {
    throw new Error(`Frozen Harness Revision ${label} is outside its Git worktree`);
  }
  return { topLevel, commonDir };
}

function isWithin(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}
