import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { chmod, lstat, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
  normalizeDshFilePolicyContract,
  type DshCredentialPathPolicyV1,
  type DshFilePolicyContractV1,
} from "@ouroboros/harness";

const DARWIN_DSH_DENIED_EXECUTABLES = [
  "/Applications/ChatGPT.app/Contents/Resources/codex",
  "/Applications/Codex.app/Contents/Resources/codex",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/open",
  "/usr/bin/osascript",
] as const;

const POLICY_FAILURE_MARKER = "orbs-dsh-agent-policy:";
const NESTED_CODEX_PATH_PATTERN = "(^|/)codex$";
const DISABLED_DSH_IN_PROCESS_ROWS = [
  "credentials",
  "llm-pi-ai",
  "session-title-llm",
  "tool-jobs",
  "tool-fs",
  "tool-fs-search",
  "agent-instructions",
  "skill-filesystem",
  "tool-skill",
  "subagent-spawn-in-process",
  "subagent-fork-in-process",
  "tool-subagent-control",
  "tool-subagent-list-agents",
  "tool-subagent",
  "tool-subagent-fork",
  "workflow-worker-thread",
  "tool-workflow",
  "tool-ralph",
  "tool-str-replace-editor",
  "web",
  "web-search-deepseek",
  "tool-web",
  "code-runtime",
] as const;

export interface DshProcessPolicyBundle {
  patchPath: string;
  patchSha256: string;
  networkMode: "deny";
  sandboxProfileSha256: string;
  filePolicySha256: string | null;
  deniedControlPathRootsSha256: string;
  disabledInProcessRows: string[];
  disabledInProcessRowsSha256: string;
  cleanup(): Promise<void>;
}

export interface DshHostReadProfile {
  profile: string;
  deniedReadPaths: string[];
  deniedReadPathsSha256: string;
}

export interface NormalizedDshFilePolicy extends DshFilePolicyContractV1 {
  sha256: string;
}

export function darwinDshHostReadProfile(input: {
  workspaceRoot: string;
  permissionMode?: "read-only" | "workspace-write";
  allowedPaths?: string[];
  forbiddenPaths?: string[];
  credentialPathPolicy?: DshCredentialPathPolicyV1;
  temporaryWritePaths?: string[];
}): DshHostReadProfile {
  const deniedReadPaths = dshControlReadPaths(input.workspaceRoot);
  const forms = [
    darwinDshProcessProfile({
      workspaceRoot: input.permissionMode === "workspace-write" ? input.workspaceRoot : null,
      allowedPaths: input.permissionMode === "workspace-write" ? input.allowedPaths : [],
      forbiddenPaths: input.forbiddenPaths,
      credentialPathPolicy: input.credentialPathPolicy,
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

export async function prepareDshProcessPolicy(input: {
  workspaceRoot: string;
  permissionMode: "read-only" | "workspace-write";
  filePolicy: NormalizedDshFilePolicy | null;
}): Promise<DshProcessPolicyBundle | null> {
  if (process.platform !== "darwin") return null;

  const base = join(homedir(), ".ouroboros", "runtime", "dsh-process-policies");
  await ensurePrivateDirectory(base);
  const directory = join(base, randomUUID());
  await ensurePrivateDirectory(directory);
  if (input.permissionMode === "workspace-write" && input.filePolicy && existsSync(input.workspaceRoot)) {
    await prepareAllowedPolicyDirectories(input.workspaceRoot, input.filePolicy.allowedPaths);
  }
  const runnerPath = join(directory, "runner.mjs");
  const patchPath = join(directory, "cordis.patch.yml");
  const toolHome = join(directory, "tool-home");
  await ensurePrivateDirectory(toolHome);
  const toolProfile = darwinDshHostReadProfile({
    workspaceRoot: input.workspaceRoot,
    permissionMode: input.permissionMode,
    allowedPaths: input.filePolicy?.allowedPaths,
    forbiddenPaths: [...(input.filePolicy?.readOnlyPaths ?? []), ...(input.filePolicy?.forbiddenPaths ?? [])],
    credentialPathPolicy: input.filePolicy?.credentialPathPolicy,
    temporaryWritePaths: [toolHome],
  });
  const runnerSource = darwinDshPolicyRunnerSource(toolProfile.profile, toolHome);
  await writeFile(runnerPath, runnerSource, { mode: 0o600, flag: "wx" });
  const patch = dshPolicyPatch(process.execPath, runnerPath);
  await writeFile(patchPath, patch, { mode: 0o600, flag: "wx" });
  return {
    patchPath,
    patchSha256: createHash("sha256").update(patch).digest("hex"),
    networkMode: "deny",
    sandboxProfileSha256: createHash("sha256").update(toolProfile.profile).digest("hex"),
    filePolicySha256: input.filePolicy?.sha256 ?? null,
    deniedControlPathRootsSha256: toolProfile.deniedReadPathsSha256,
    disabledInProcessRows: [...DISABLED_DSH_IN_PROCESS_ROWS],
    disabledInProcessRowsSha256: createHash("sha256").update(JSON.stringify(DISABLED_DSH_IN_PROCESS_ROWS)).digest("hex"),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

async function prepareAllowedPolicyDirectories(workspaceRoot: string, allowedPaths: string[]) {
  const root = canonicalExistingDirectory(workspaceRoot);
  for (const pattern of allowedPaths) {
    const relativeDirectory = pattern.endsWith("/**") ? pattern.slice(0, -3) : dirname(pattern);
    let current = root;
    for (const segment of relativeDirectory.split("/").filter((value) => value && value !== ".")) {
      const next = join(current, segment);
      try {
        const stat = await lstat(next);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          throw new Error(`DSH allowed path ancestor is not one real directory: ${next}`);
        }
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
        try {
          await mkdir(next, { mode: 0o755 });
        } catch (mkdirError) {
          if (!(mkdirError instanceof Error) || !("code" in mkdirError) || mkdirError.code !== "EEXIST") throw mkdirError;
        }
        const stat = await lstat(next);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          throw new Error(`DSH allowed path ancestor is not one real directory: ${next}`);
        }
      }
      const canonical = await realpath(next);
      if (canonical !== next || !canonical.startsWith(`${root}${sep}`)) {
        throw new Error(`DSH allowed path ancestor escapes its workspace: ${next}`);
      }
      current = next;
    }
  }
}

export function darwinDshProcessProfile(input: {
  workspaceRoot: string | null;
  temporaryRoot?: string;
  temporaryWritePaths?: string[];
  allowedPaths?: string[];
  forbiddenPaths?: string[];
  credentialPathPolicy?: DshCredentialPathPolicyV1;
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
    for (const entry of resolvePolicyPaths(input.workspaceRoot, input.allowedPaths ?? [])) {
      forms.push(`(allow file-write* (${entry.subtree ? "subpath" : "literal"} ${sbplString(entry.path)}))`);
    }
    for (const entry of resolvePolicyPaths(input.workspaceRoot, input.forbiddenPaths ?? [])) {
      forms.push(`(deny file-write* (${entry.subtree ? "subpath" : "literal"} ${sbplString(entry.path)}))`);
    }
    if (input.credentialPathPolicy) {
      for (const entry of resolvePolicyPaths(input.workspaceRoot, input.credentialPathPolicy.deniedSubtrees)) {
        forms.push(`(deny file-read* (subpath ${sbplString(entry.path)}))`);
        forms.push(`(deny file-write* (subpath ${sbplString(entry.path)}))`);
      }
      for (const pattern of credentialPathRegexes(input.workspaceRoot, input.credentialPathPolicy)) {
        forms.push(`(deny file-read* (regex #${sbplString(pattern)}))`);
        forms.push(`(deny file-write* (regex #${sbplString(pattern)}))`);
      }
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
  const normalized = normalizeDshFilePolicyContract(input);
  return { ...normalized, sha256: createHash("sha256").update(JSON.stringify(normalized)).digest("hex") };
}

function credentialPathRegexes(workspaceRoot: string, policy: DshCredentialPathPolicyV1) {
  const root = caseInsensitiveRegexLiteral(existsSync(workspaceRoot) ? realpathSync(workspaceRoot) : resolve(workspaceRoot));
  return [
    ...policy.deniedSubtrees.flatMap((pattern) => {
      const subtree = caseInsensitiveRegexLiteral(pattern.slice(0, -3));
      return [`^${root}/${subtree}(/|$)`, `(^|/)${subtree}(/|$)`];
    }),
    ...policy.deniedBasenamePrefixes.flatMap((prefix) => {
      const value = `${caseInsensitiveRegexLiteral(prefix)}[^/]*(/|$)`;
      return [`^${root}/(.*/)?${value}`, `(^|/)${value}`];
    }),
    ...policy.deniedFilenameTokens.flatMap((token) => {
      const value = `[^/]*${caseInsensitiveRegexLiteral(token)}[^/]*$`;
      return [`^${root}/(.*/)?${value}`, `(^|/)${value}`];
    }),
  ];
}

function regexLiteral(value: string) {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function caseInsensitiveRegexLiteral(value: string) {
  return [...value].map((character) => /[a-z]/i.test(character)
    ? `[${character.toLowerCase()}${character.toUpperCase()}]`
    : character === "." ? "[.]" : regexLiteral(character)).join("");
}

function resolvePolicyPaths(workspaceRoot: string, patterns: string[]) {
  const root = resolve(workspaceRoot);
  return patterns.map((pattern) => {
    const subtree = pattern.endsWith("/**");
    const path = resolve(root, subtree ? pattern.slice(0, -3) : pattern);
    if (path !== root && !path.startsWith(`${root}${sep}`)) {
      throw new Error(`DSH file policy escapes the workspace: ${pattern}`);
    }
    return { path, subtree };
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
    ...DISABLED_DSH_IN_PROCESS_ROWS.flatMap((id) => [
      "",
      `- id: ${id}`,
      "  disabled: true",
    ]),
    "",
  ].join("\n");
}

function darwinDshPolicyRunnerSource(profile: string, toolHome: string) {
  return `#!/usr/bin/env node
import { spawn } from "node:child_process";

const FAILURE = ${JSON.stringify(POLICY_FAILURE_MARKER)};
const PROFILE = ${JSON.stringify(profile)};
const TOOL_HOME = ${JSON.stringify(toolHome)};
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
childEnvironment.HOME = TOOL_HOME;
childEnvironment.TMPDIR = TOOL_HOME;
const child = spawn("/usr/bin/sandbox-exec", ["-p", PROFILE, "--", ...command], {
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
