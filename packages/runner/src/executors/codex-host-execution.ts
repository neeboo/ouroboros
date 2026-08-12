import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { CodexSandbox, RunCommand } from "./types";

const DARWIN_BROWSER_EXECUTABLES = [
  "/usr/bin/open",
  "/usr/bin/osascript",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Safari.app/Contents/MacOS/Safari",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Arc.app/Contents/MacOS/Arc",
  "/Applications/Firefox.app/Contents/MacOS/firefox",
];

export interface CodexHostExecutionInput {
  cwd: string;
  sandbox: CodexSandbox;
  browserProcessPolicy?: "allow" | "deny";
  injectedRunCommand?: RunCommand;
}

export async function prepareCodexHostExecution(input: CodexHostExecutionInput) {
  if (process.platform !== "darwin" || input.browserProcessPolicy !== "deny") return null;
  const runtimeRoot = protectedCodexRuntimeRoot(input.cwd);
  const outputDir = join(runtimeRoot, "outputs");
  const sourceHome = process.env.CODEX_HOME ?? join(process.env.HOME ?? "", ".codex");
  const sourceAuthPath = join(sourceHome, "auth.json");
  const runtimeBase = process.env.ORBS_CODEX_RUNTIME_ROOT ?? join(tmpdir(), "ouroboros-codex-runtime");
  await ensurePrivateDirectory(runtimeBase);
  await ensurePrivateDirectory(runtimeRoot);
  await ensurePrivateDirectory(join(runtimeRoot, "rules"));
  await ensurePrivateDirectory(outputDir);

  if (!input.injectedRunCommand) {
    await atomicPrivateWrite(join(runtimeRoot, "auth.json"), await readFile(sourceAuthPath));
  }

  await atomicPrivateWrite(join(runtimeRoot, "config.toml"), protectedCodexConfig({
    runtimeRoot,
    sandbox: input.sandbox,
    sourceAuthPath,
  }));
  await atomicPrivateWrite(join(runtimeRoot, "rules", "default.rules"), browserExecRules());

  return {
    outputDir,
    env: {
      CODEX_HOME: runtimeRoot,
      ORBS_BROWSER_PROCESS_POLICY: "deny",
    },
  };
}

export function protectedCodexRuntimeRoot(cwd: string) {
  const normalizedCwd = existsSync(cwd) ? realpathSync(cwd) : resolve(cwd);
  const identity = createHash("sha256").update(normalizedCwd).digest("hex").slice(0, 24);
  const root = process.env.ORBS_CODEX_RUNTIME_ROOT ?? join(tmpdir(), "ouroboros-codex-runtime");
  return join(root, identity);
}

export function protectedCodexConfig(input: { runtimeRoot: string; sandbox: CodexSandbox; sourceAuthPath: string }) {
  if (input.sandbox === "danger-full-access") {
    throw new Error("danger-full-access is prohibited for protected Codex execution");
  }
  const profile = input.sandbox === "workspace-write" ? "orbs-workspace" : "orbs-read-only";
  const deniedPaths = [
    input.runtimeRoot,
    input.sourceAuthPath,
    ...DARWIN_BROWSER_EXECUTABLES,
    ...resolvedPathBrowserExecutables(),
  ];
  const filesystem = [...new Set(deniedPaths)].map((path) => `${tomlString(path)} = "deny"`).join("\n");
  return [
    `default_permissions = ${tomlString(profile)}`,
    "",
    "[permissions.orbs-workspace]",
    'extends = ":workspace"',
    "",
    "[permissions.orbs-workspace.filesystem]",
    filesystem,
    "",
    "[permissions.orbs-read-only]",
    'extends = ":read-only"',
    "",
    "[permissions.orbs-read-only.filesystem]",
    filesystem,
    "",
    "[shell_environment_policy]",
    'exclude = [".*KEY.*", ".*TOKEN.*", ".*SECRET.*", "^CODEX_HOME$"]',
    "",
  ].join("\n");
}

function resolvedPathBrowserExecutables() {
  const names = ["google-chrome", "chrome", "chromium", "chromium-browser", "firefox", "agent-browser"];
  const dirs = (process.env.PATH ?? "").split(":").filter(Boolean);
  const paths: string[] = [];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) {
        paths.push(realpathSync(candidate));
      }
    }
  }
  return paths;
}

function browserExecRules() {
  const commands = [
    "/usr/bin/open",
    "open",
    "/usr/bin/osascript",
    "osascript",
    ...DARWIN_BROWSER_EXECUTABLES,
  ];
  return commands
    .map((command) => `prefix_rule(pattern=[${JSON.stringify(command)}], decision="forbidden")`)
    .join("\n") + "\n";
}

function tomlString(value: string) {
  return JSON.stringify(value);
}

async function ensurePrivateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`protected Codex runtime path is not a private directory: ${path}`);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`protected Codex runtime path has a foreign owner: ${path}`);
  }
  if (await realpath(path) !== join(await realpath(dirname(path)), basename(path))) {
    throw new Error(`protected Codex runtime path resolves outside its declared location: ${path}`);
  }
  await chmod(path, 0o700);
}

async function atomicPrivateWrite(path: string, content: string | Buffer) {
  const existing = await lstatIfPresent(path);
  if (existing) {
    const stat = existing;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error(`protected Codex runtime file has an unsafe existing node: ${path}`);
    }
  }
  const temporaryPath = join(resolve(path, ".."), `.${randomUUID()}.tmp`);
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function lstatIfPresent(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
