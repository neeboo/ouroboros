import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { chmod, lstat, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

const DARWIN_EMBEDDED_CODEX_EXECUTABLES = [
  "/Applications/ChatGPT.app/Contents/Resources/codex",
  "/Applications/Codex.app/Contents/Resources/codex",
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

export function darwinDshHostReadProfile(input: { workspaceRoot: string }): DshHostReadProfile {
  const deniedReadPaths = dshControlReadPaths(input.workspaceRoot);
  const forms = [
    "(version 1)",
    "(allow default)",
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
    forms.push(`(allow file-write* (subpath ${sbplString(input.workspaceRoot)}))`);
    forms.push(`(allow file-write* (subpath ${sbplString(input.temporaryRoot ?? tmpdir())}))`);
    forms.push(`(allow file-write* (subpath ${sbplString("/tmp")}))`);
  }
  for (const executable of input.protectedExecutables ?? DARWIN_EMBEDDED_CODEX_EXECUTABLES) {
    forms.push(`(deny file-read* (literal ${sbplString(executable)}))`);
    forms.push(`(deny process-exec (literal ${sbplString(executable)}))`);
  }
  forms.push(`(deny file-read* (regex #${sbplString(NESTED_CODEX_PATH_PATTERN)}))`);
  forms.push(`(deny process-exec (regex #${sbplString(NESTED_CODEX_PATH_PATTERN)}))`);
  return forms.join(" ");
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
import { tmpdir } from "node:os";

const FAILURE = ${JSON.stringify(POLICY_FAILURE_MARKER)};
const PROTECTED = ${JSON.stringify(DARWIN_EMBEDDED_CODEX_EXECUTABLES)};
const NESTED_CODEX = ${JSON.stringify(NESTED_CODEX_PATH_PATTERN)};
const args = process.argv.slice(2);
const separator = args.indexOf("--");
if (separator < 0 || separator === args.length - 1) {
  process.stderr.write(FAILURE + " missing command separator\\n");
  process.exit(127);
}
const profileArgs = args.slice(0, separator);
const command = args.slice(separator + 1);
let workspaceRoot = null;
for (let index = 0; index < profileArgs.length; index += 1) {
  if (profileArgs[index] === "--bind" && profileArgs[index + 1] && profileArgs[index + 2]) {
    workspaceRoot = profileArgs[index + 2];
    index += 2;
  }
}
const quote = (value) => JSON.stringify(String(value));
const forms = [
  "(version 1)",
  "(allow default)",
  "(deny network*)",
  "(deny file-write*)",
  "(allow file-write* (literal \\\"/dev/null\\\"))",
];
if (workspaceRoot) {
  forms.push("(allow file-write* (subpath " + quote(workspaceRoot) + "))");
  forms.push("(allow file-write* (subpath " + quote(tmpdir()) + "))");
  forms.push("(allow file-write* (subpath \\\"/tmp\\\"))");
}
for (const executable of PROTECTED) {
  forms.push("(deny file-read* (literal " + quote(executable) + "))");
  forms.push("(deny process-exec (literal " + quote(executable) + "))");
}
forms.push("(deny file-read* (regex #" + quote(NESTED_CODEX) + "))");
forms.push("(deny process-exec (regex #" + quote(NESTED_CODEX) + "))");
const allowedEnvironment = new Set([
  "PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "SHELL", "USER", "LOGNAME", "TERM", "CI", "NO_COLOR",
  "PROTO_HOME", "BUN_INSTALL", "NVM_BIN", "NVM_DIR", "PNPM_HOME",
]);
const childEnvironment = {};
for (const [key, value] of Object.entries(process.env)) {
  if (allowedEnvironment.has(key) && value !== undefined) childEnvironment[key] = value;
}
const child = spawn("/usr/bin/sandbox-exec", ["-p", forms.join(" "), "--", ...command], {
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
