import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const DARWIN_EMBEDDED_CODEX_EXECUTABLES = [
  "/Applications/ChatGPT.app/Contents/Resources/codex",
  "/Applications/Codex.app/Contents/Resources/codex",
] as const;

const POLICY_FAILURE_MARKER = "orbs-dsh-agent-policy:";

export interface DshProcessPolicyBundle {
  patchPath: string;
  cleanup(): Promise<void>;
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
  await writeFile(patchPath, dshPolicyPatch(process.execPath, runnerPath), { mode: 0o600, flag: "wx" });
  return {
    patchPath,
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
  return forms.join(" ");
}

function dshPolicyPatch(runtimeExecutable: string, runnerPath: string) {
  return [
    `# ORBS_DSH_POLICY_RUNNER=${runnerPath}`,
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
const child = spawn("/usr/bin/sandbox-exec", ["-p", forms.join(" "), "--", ...command], {
  stdio: "inherit",
  env: process.env,
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
