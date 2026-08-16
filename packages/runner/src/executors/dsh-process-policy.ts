import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { chmod, lstat, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

const DARWIN_DSH_DENIED_EXECUTABLES = [
  "/Applications/ChatGPT.app/Contents/Resources/codex",
  "/Applications/Codex.app/Contents/Resources/codex",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/open",
  "/usr/bin/osascript",
] as const;

const POLICY_FAILURE_MARKER = "orbs-dsh-agent-policy:";
const NESTED_CODEX_PATH_PATTERN = "(^|/)codex$";

export interface DshProcessPolicyBundle {
  patchPath: string;
  patchSha256: string;
  networkMode: "deny";
  cleanup(): Promise<void>;
}

export interface DshHostReadProfile {
  profile: string;
  deniedReadPaths: string[];
  deniedReadPathsSha256: string;
}

export interface NormalizedDshFilePolicy {
  schemaVersion: 1;
  source: "frozen-design-mutation-surfaces";
  allowedPaths: string[];
  forbiddenPaths: string[];
  sha256: string;
}

export function darwinDshHostReadProfile(input: {
  workspaceRoot: string;
  permissionMode?: "read-only" | "workspace-write";
  allowedPaths?: string[];
  forbiddenPaths?: string[];
  temporaryWritePaths?: string[];
}): DshHostReadProfile {
  const deniedReadPaths = dshControlReadPaths(input.workspaceRoot);
  const forms = [
    darwinDshProcessProfile({
      workspaceRoot: input.permissionMode === "workspace-write" ? input.workspaceRoot : null,
      allowedPaths: input.permissionMode === "workspace-write" ? input.allowedPaths : [],
      forbiddenPaths: input.forbiddenPaths,
      temporaryWritePaths: input.temporaryWritePaths,
    }),
    ...deniedReadPaths.flatMap((path) => [
      `(deny file-read* (subpath ${sbplString(path)}))`,
      `(deny file-write* (subpath ${sbplString(path)}))`,
    ]),
  ];
  return {
    profile: forms.join(" "),
    deniedReadPaths,
    deniedReadPathsSha256: createHash("sha256").update(JSON.stringify(deniedReadPaths)).digest("hex"),
  };
}

function dshControlReadPaths(workspaceRoot: string) {
  const workspace = existsSync(workspaceRoot) ? canonicalExistingDirectory(workspaceRoot) : resolve(workspaceRoot);
  const paths = new Set<string>([
    join(workspace, ".ouroboros"),
    join(workspace, ".orbs"),
    join(workspace, ".git", "orbs"),
  ]);
  const gitEntry = join(workspace, ".git");
  try {
    const stat = lstatSync(gitEntry);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      paths.add(join(realpathSync(gitEntry), "orbs"));
    } else if (stat.isFile() && !stat.isSymbolicLink()) {
      const match = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(gitEntry, "utf8"));
      if (match?.[1]) {
        const gitDir = canonicalExistingDirectory(resolve(workspace, match[1]));
        paths.add(join(gitDir, "orbs"));
        const commonFile = join(gitDir, "commondir");
        if (existsSync(commonFile)) {
          const commonDir = canonicalExistingDirectory(resolve(gitDir, readFileSync(commonFile, "utf8").trim()));
          paths.add(join(commonDir, "orbs"));
        }
      }
    }
  } catch {
    // A missing .git entry is valid for isolated non-Git executor fixtures.
  }

  const worktreeMarker = `${sep}.ouroboros${sep}worktrees${sep}`;
  const markerIndex = workspace.indexOf(worktreeMarker);
  if (markerIndex >= 0) {
    const projectRoot = workspace.slice(0, markerIndex);
    const worktreesRoot = join(projectRoot, ".ouroboros", "worktrees");
    try {
      for (const entry of readdirSync(worktreesRoot, { withFileTypes: true })) {
        const candidate = join(worktreesRoot, entry.name);
        if (entry.isDirectory() && realpathSync(candidate) !== workspace) paths.add(realpathSync(candidate));
      }
    } catch {
      // The current worktree remains usable even if sibling enumeration is unavailable.
    }
  }
  return [...paths].sort();
}

function canonicalExistingDirectory(path: string) {
  const canonical = realpathSync(path);
  const stat = lstatSync(canonical);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`DSH workspace boundary is not one real directory: ${path}`);
  }
  return canonical;
}

export async function prepareDshProcessPolicy(): Promise<DshProcessPolicyBundle | null> {
  if (process.platform !== "darwin") return null;

  const base = join(homedir(), ".ouroboros", "runtime", "dsh-process-policies");
  await ensurePrivateDirectory(base);
  const directory = join(base, randomUUID());
  await ensurePrivateDirectory(directory);
  const runnerPath = join(directory, "runner.mjs");
  const patchPath = join(directory, "cordis.patch.yml");
  await writeFile(runnerPath, darwinDshPolicyRunnerSource(), { mode: 0o600, flag: "wx" });
  const patch = dshPolicyPatch(process.execPath, runnerPath);
  await writeFile(patchPath, patch, { mode: 0o600, flag: "wx" });
  return {
    patchPath,
    patchSha256: createHash("sha256").update(patch).digest("hex"),
    networkMode: "deny",
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

export function darwinDshProcessProfile(input: {
  workspaceRoot: string | null;
  temporaryRoot?: string;
  temporaryWritePaths?: string[];
  allowedPaths?: string[];
  forbiddenPaths?: string[];
  protectedExecutables?: readonly string[];
}) {
  const forms = [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    "(deny file-write*)",
    `(allow file-write* (literal ${sbplString("/dev/null")}))`,
  ];
  if (input.workspaceRoot) {
    for (const path of resolvePolicyPaths(input.workspaceRoot, input.allowedPaths ?? [])) {
      forms.push(`(allow file-write* (subpath ${sbplString(path)}))`);
    }
    for (const path of resolvePolicyPaths(input.workspaceRoot, input.forbiddenPaths ?? [])) {
      forms.push(`(deny file-write* (subpath ${sbplString(path)}))`);
    }
  }
  for (const path of [...new Set(input.temporaryWritePaths ?? [input.temporaryRoot ?? tmpdir(), "/tmp"])]) {
    const canonicalPath = existsSync(path) ? realpathSync(path) : resolve(path);
    forms.push(`(allow file-write* (subpath ${sbplString(canonicalPath)}))`);
  }
  for (const executable of input.protectedExecutables ?? DARWIN_DSH_DENIED_EXECUTABLES) {
    forms.push(`(deny file-read* (literal ${sbplString(executable)}))`);
    forms.push(`(deny process-exec (literal ${sbplString(executable)}))`);
  }
  forms.push(`(deny file-read* (regex #${sbplString(NESTED_CODEX_PATH_PATTERN)}))`);
  forms.push(`(deny process-exec (regex #${sbplString(NESTED_CODEX_PATH_PATTERN)}))`);
  return forms.join(" ");
}

export function normalizeDshFilePolicy(input: unknown): NormalizedDshFilePolicy {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("DSH workspace-write requires a frozen file policy");
  }
  const record = input as Record<string, unknown>;
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(["allowedPaths", "forbiddenPaths", "schemaVersion", "source"])) {
    throw new Error("DSH file policy contains unknown or missing fields");
  }
  if (record.schemaVersion !== 1 || record.source !== "frozen-design-mutation-surfaces") {
    throw new Error("DSH file policy schema or source is invalid");
  }
  const allowedPaths = normalizePolicyPatterns(record.allowedPaths, "allowedPaths");
  const forbiddenPaths = normalizePolicyPatterns(record.forbiddenPaths, "forbiddenPaths");
  if (allowedPaths.length === 0) throw new Error("DSH file policy must allow at least one frozen path");
  const normalized = { schemaVersion: 1 as const, source: "frozen-design-mutation-surfaces" as const, allowedPaths, forbiddenPaths };
  return { ...normalized, sha256: createHash("sha256").update(JSON.stringify(normalized)).digest("hex") };
}

function normalizePolicyPatterns(value: unknown, name: string) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`DSH file policy ${name} must be a string array`);
  }
  const patterns = [...new Set(value.map((entry) => entry.trim()))].sort();
  for (const pattern of patterns) {
    if (!pattern || pattern.startsWith("/") || pattern.includes("..") || !pattern.endsWith("/**") || pattern.slice(0, -3).includes("*")) {
      throw new Error(`DSH file policy ${name} contains an unsafe path: ${pattern}`);
    }
  }
  return patterns;
}

function resolvePolicyPaths(workspaceRoot: string, patterns: string[]) {
  const root = resolve(workspaceRoot);
  return patterns.map((pattern) => {
    const path = resolve(root, pattern.slice(0, -3));
    if (path !== root && !path.startsWith(`${root}${sep}`)) {
      throw new Error(`DSH file policy escapes the workspace: ${pattern}`);
    }
    return path;
  });
}

function dshPolicyPatch(runtimeExecutable: string, runnerPath: string) {
  return [
    `# ORBS_DSH_POLICY_RUNNER=${runnerPath}`,
    "# networkMode: deny",
    "- id: sandbox",
    "  name: '@deepseek-ai/dsh-sandbox-local'",
    "  config:",
    "    runnerCommand:",
    `      - ${JSON.stringify(runtimeExecutable)}`,
    `      - ${JSON.stringify(runnerPath)}`,
    "    runnerFailureSignatures:",
    `      - ${JSON.stringify(POLICY_FAILURE_MARKER)}`,
    "",
  ].join("\n");
}

function darwinDshPolicyRunnerSource() {
  return `#!/usr/bin/env node
import { spawn } from "node:child_process";

const FAILURE = ${JSON.stringify(POLICY_FAILURE_MARKER)};
const args = process.argv.slice(2);
const separator = args.indexOf("--");
if (separator < 0 || separator === args.length - 1) {
  process.stderr.write(FAILURE + " missing command separator\\n");
  process.exit(127);
}
const command = args.slice(separator + 1);
const allowedEnvironment = new Set([
  "PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "SHELL", "USER", "LOGNAME", "TERM", "CI", "NO_COLOR",
  "PROTO_HOME", "BUN_INSTALL", "NVM_BIN", "NVM_DIR", "PNPM_HOME",
]);
const childEnvironment = {};
for (const [key, value] of Object.entries(process.env)) {
  if (allowedEnvironment.has(key) && value !== undefined) childEnvironment[key] = value;
}
const child = spawn(command[0], command.slice(1), {
  stdio: "inherit",
  env: childEnvironment,
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.once("error", (error) => {
  process.stderr.write(FAILURE + " " + error.message + "\\n");
  process.exit(127);
});
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 127);
});
`;
}

async function ensurePrivateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`DSH process policy path is not a private directory: ${path}`);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`DSH process policy path has a foreign owner: ${path}`);
  }
  if (await realpath(path) !== join(await realpath(dirname(path)), basename(path))) {
    throw new Error(`DSH process policy path resolves outside its declared location: ${path}`);
  }
  await chmod(path, 0o700);
}

function sbplString(path: string) {
  return JSON.stringify(path);
}
