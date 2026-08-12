import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createServer, connect, type Server, type Socket } from "node:net";
import type { CodexSandbox, RunCommand } from "./types";
import { runLocalCommand } from "./command";
import {
  parseHostExecutionCapabilities,
  resolveHostExecutionCapabilities,
  type ResolvedHostExecutionCapabilities,
} from "./host-execution-capabilities";

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
  hostExecutionCapabilities?: unknown;
  taskRole?: string;
  verifierContract?: unknown;
}

export async function prepareCodexHostExecution(input: CodexHostExecutionInput) {
  if (process.platform !== "darwin" || (input.browserProcessPolicy !== "deny" && input.hostExecutionCapabilities === undefined)) return null;
  const capabilities = input.hostExecutionCapabilities === undefined
    ? undefined
    : resolveHostExecutionCapabilities({
        cwd: input.cwd,
        capabilities: parseHostExecutionCapabilities(input.hostExecutionCapabilities, {
          role: input.taskRole ?? "unknown",
          verifierContract: input.verifierContract,
        }),
      });
  const runtimeRoot = protectedCodexRuntimeRoot(input.cwd);
  const outputDir = join(runtimeRoot, "outputs");
  const sourceHome = process.env.CODEX_HOME ?? join(process.env.HOME ?? "", ".codex");
  const sourceAuthPath = join(sourceHome, "auth.json");
  const runtimeBase = process.env.ORBS_CODEX_RUNTIME_ROOT ?? join(tmpdir(), "ouroboros-codex-runtime");
  await ensurePrivateDirectory(runtimeBase);
  await ensurePrivateDirectory(runtimeRoot);
  await ensurePrivateDirectory(join(runtimeRoot, "rules"));
  await ensurePrivateDirectory(outputDir);
  if (capabilities?.browser) await ensurePrivateDirectory(capabilities.browser.socketDirectory);
  if (capabilities?.loopback) await ensurePrivateDirectory(capabilities.loopback.socketDirectory);

  if (!input.injectedRunCommand) {
    await atomicPrivateWrite(join(runtimeRoot, "auth.json"), await readFile(sourceAuthPath));
  }

  await atomicPrivateWrite(join(runtimeRoot, "config.toml"), protectedCodexConfig({
    runtimeRoot,
    sandbox: input.sandbox,
    sourceAuthPath,
    capabilities,
  }));
  await atomicPrivateWrite(join(runtimeRoot, "rules", "default.rules"), capabilities?.browser ? "" : browserExecRules());
  let browserCleanup: (() => Promise<void>) | undefined;
  let loopbackCleanup: (() => Promise<void>) | undefined;
  try {
    browserCleanup = capabilities?.browser
      ? await ensureBrowserHostDaemon(capabilities, [runtimeRoot, sourceHome])
      : undefined;
    loopbackCleanup = capabilities?.loopback ? await ensureLoopbackRelays(capabilities) : undefined;
  } catch (error) {
    await browserCleanup?.();
    await loopbackCleanup?.();
    throw error;
  }

  const env: Record<string, string | undefined> & {
    CODEX_HOME: string;
    ORBS_BROWSER_PROCESS_POLICY: "allow" | "deny";
  } = {
    CODEX_HOME: runtimeRoot,
    ORBS_BROWSER_PROCESS_POLICY: capabilities?.browser ? "allow" : "deny",
    ...capabilityEnvironment(capabilities),
    ...clearedAmbientProxyEnvironment(capabilities),
  };
  return {
    outputDir,
    env,
    capabilities,
    cleanup: async () => {
      await browserCleanup?.();
      await loopbackCleanup?.();
    },
  };
}

export function protectedCodexRuntimeRoot(cwd: string) {
  const normalizedCwd = existsSync(cwd) ? realpathSync(cwd) : resolve(cwd);
  const identity = createHash("sha256").update(normalizedCwd).digest("hex").slice(0, 24);
  const root = process.env.ORBS_CODEX_RUNTIME_ROOT ?? join(tmpdir(), "ouroboros-codex-runtime");
  return join(root, identity);
}

export function protectedCodexConfig(input: {
  runtimeRoot: string;
  sandbox: CodexSandbox;
  sourceAuthPath: string;
  capabilities?: ResolvedHostExecutionCapabilities;
}) {
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
  const filesystem = [
    ...[...new Set(deniedPaths)].map((path) => `${tomlString(path)} = "deny"`),
    ...(input.capabilities?.git ? [`${tomlString(input.capabilities.git.commonDir)} = "read"`] : []),
    ...(input.capabilities?.browser ? [`${tomlString(input.capabilities.browser.socketDirectory)} = "read"`] : []),
    ...(input.capabilities?.loopback ? [`${tomlString(input.capabilities.loopback.socketDirectory)} = "read"`] : []),
    ...writableCapabilityPaths(input.capabilities).map((path) => `${tomlString(path)} = "write"`),
  ].join("\n");
  const network = networkProfile(input.capabilities);
  return [
    `default_permissions = ${tomlString(profile)}`,
    "allow_login_shell = false",
    "",
    ...((input.capabilities?.loopback || input.capabilities?.postgres || input.capabilities?.browser) ? ["[features]", "network_proxy = true", ""] : []),
    "[permissions.orbs-workspace]",
    'extends = ":workspace"',
    "",
    "[permissions.orbs-workspace.filesystem]",
    filesystem,
    ...network.map((line) => line.replaceAll("permissions.__PROFILE__", "permissions.orbs-workspace")),
    "",
    "[permissions.orbs-read-only]",
    'extends = ":read-only"',
    "",
    "[permissions.orbs-read-only.filesystem]",
    [...new Set(deniedPaths)].map((path) => `${tomlString(path)} = "deny"`).join("\n"),
    ...network.map((line) => line.replaceAll("permissions.__PROFILE__", "permissions.orbs-read-only")),
    "",
    "[shell_environment_policy]",
    'inherit = "none"',
    `set = ${tomlInlineStringTable(protectedShellEnvironment(input.capabilities))}`,
    "",
  ].join("\n");
}

function writableCapabilityPaths(capabilities: ResolvedHostExecutionCapabilities | undefined) {
  const git = capabilities?.git;
  return [
    ...(git ? [git.gitDir, git.objectsDir, git.branchRef, `${git.branchRef}.lock`, git.branchReflog, `${git.branchReflog}.lock`] : []),
  ];
}

function networkProfile(capabilities: ResolvedHostExecutionCapabilities | undefined) {
  const sockets = [
    capabilities?.postgres?.unixSocketPath,
    capabilities?.browser?.socketPath,
    ...(capabilities?.loopback?.sockets.map((entry) => entry.path) ?? []),
  ].filter((value): value is string => Boolean(value));
  if (sockets.length === 0) return [];
  return [
    "",
    "[permissions.__PROFILE__.network]",
    "enabled = true",
    'mode = "limited"',
    "enable_socks5 = true",
    "",
    "[permissions.__PROFILE__.network.domains]",
    '"127.0.0.1" = "deny"',
    '"localhost" = "deny"',
    ...(sockets.length > 0 ? ["", "[permissions.__PROFILE__.network.unix_sockets]", ...[...new Set(sockets)].sort().map((socket) => `${tomlString(socket)} = "allow"`)] : []),
  ];
}

function capabilityEnvironment(capabilities: ResolvedHostExecutionCapabilities | undefined) {
  if (!capabilities) return {};
  const browserClientDirectory = capabilities.browser
    ? join(capabilities.browser.socketDirectory, "client-bin")
    : undefined;
  return {
    ...(browserClientDirectory ? {
      PATH: `${browserClientDirectory}:${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
    } : {}),
    ORBS_HOST_EXECUTION_CAPABILITY_SHA256: capabilities.contractSha256,
    ORBS_ALLOWED_LOOPBACK_HOST: capabilities.loopback?.host,
    ORBS_ALLOWED_LOOPBACK_PORTS: capabilities.loopback?.ports.join(","),
    ORBS_LOOPBACK_SOCKET_MAP: capabilities.loopback
      ? JSON.stringify(Object.fromEntries(capabilities.loopback.sockets.map((entry) => [entry.port, entry.path])))
      : undefined,
    ORBS_GIT_COMMIT_ARGS: capabilities.git ? "--no-gpg-sign --no-verify" : undefined,
    AGENT_BROWSER_ALLOWED_DOMAINS: capabilities.browser?.allowedDomains.join(","),
    AGENT_BROWSER_SOCKET_DIR: capabilities.browser?.socketDirectory,
    AGENT_BROWSER_SESSION: capabilities.browser?.sessionName,
    AGENT_BROWSER_CONFIG: capabilities.browser?.configPath,
    AGENT_BROWSER_ACTION_POLICY: capabilities.browser?.actionPolicyPath,
    AGENT_BROWSER_ALLOW_FILE_ACCESS: capabilities.browser ? "false" : undefined,
  };
}

function protectedShellEnvironment(capabilities: ResolvedHostExecutionCapabilities | undefined) {
  const runtimeHome = capabilities?.browser?.homeDirectory
    ?? capabilities?.loopback?.socketDirectory
    ?? tmpdir();
  return {
    HOME: runtimeHome,
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL,
    LC_CTYPE: process.env.LC_CTYPE ?? "C.UTF-8",
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    ORBS_BROWSER_PROCESS_POLICY: capabilities?.browser ? "allow" : "deny",
    ...capabilityEnvironment(capabilities),
    ...(capabilities?.postgres ? {
      [capabilities.postgres.environmentVariable]: process.env[capabilities.postgres.environmentVariable],
    } : {}),
  };
}

const AMBIENT_PROXY_VARIABLES = [
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy",
  "GIT_SSH_COMMAND",
];

function clearedAmbientProxyEnvironment(capabilities: ResolvedHostExecutionCapabilities | undefined) {
  if (!capabilities) return {};
  return Object.fromEntries(AMBIENT_PROXY_VARIABLES.map((key) => [key, undefined]));
}

function resolvedPathBrowserExecutables() {
  const names = ["google-chrome", "chrome", "chromium", "chromium-browser", "firefox"];
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

function tomlInlineStringTable(input: Record<string, string | undefined>) {
  return `{ ${Object.entries(input)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key} = ${tomlString(value)}`)
    .join(", ")} }`;
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

async function ensureBrowserHostDaemon(capabilities: ResolvedHostExecutionCapabilities, deniedReadPaths: string[]) {
  const browser = capabilities.browser;
  const loopback = capabilities.loopback;
  if (!browser || !loopback) throw new Error("browser host daemon requires frozen loopback capability");
  const existing = await lstatIfPresent(browser.socketPath);
  if (existing) {
    throw new Error("browser host daemon socket already exists before host startup");
  }
  const agentBrowser = Bun.which("agent-browser");
  if (!agentBrowser) throw new Error("browser host daemon requires agent-browser");
  const nativeAgentBrowser = join(dirname(realpathSync(agentBrowser)), `agent-browser-darwin-${process.arch}`);
  if (!existsSync(nativeAgentBrowser)) throw new Error("browser host daemon requires the native agent-browser executable");
  const agentBrowserVersion = await readAgentBrowserVersion(agentBrowser);
  if (await readAgentBrowserVersion(nativeAgentBrowser) !== agentBrowserVersion) {
    throw new Error("browser host daemon executable version does not match its login-shell client");
  }
  const frozenClientDirectory = join(browser.socketDirectory, "client-bin");
  await ensurePrivateDirectory(frozenClientDirectory);
  const frozenClientPath = join(frozenClientDirectory, "agent-browser");
  const versionPath = browser.socketPath.replace(/\.sock$/, ".version");
  const pidPath = browser.socketPath.replace(/\.sock$/, ".pid");
  await atomicPrivateWrite(
    frozenClientPath,
    frozenBrowserClient({
      nativeAgentBrowser,
      socketPath: browser.socketPath,
      socketDirectory: browser.socketDirectory,
      sessionName: browser.sessionName,
      configPath: browser.configPath,
      actionPolicyPath: browser.actionPolicyPath,
      versionPath,
      pidPath,
      expectedVersion: agentBrowserVersion,
    }),
  );
  await chmod(frozenClientPath, 0o700);
  await ensurePrivateDirectory(browser.homeDirectory);
  await atomicPrivateWrite(browser.actionPolicyPath, JSON.stringify({
    default: "deny",
    allow: ["launch", "url", "gettext", "navigate", "snapshot", "click", "fill", "select", "scroll", "scrollintoview", "wait", "read", "get", "interact"],
  }) + "\n");
  await atomicPrivateWrite(browser.configPath, JSON.stringify({
    actionPolicy: browser.actionPolicyPath,
    contentBoundaries: true,
    maxOutput: 50_000,
  }) + "\n");
  const cdpPort = await reserveLoopbackPort();
  const cdpAddress = `http://127.0.0.1:${cdpPort}`;
  const env: Record<string, string | undefined> = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: browser.homeDirectory,
    XDG_CONFIG_HOME: join(browser.homeDirectory, ".config"),
    XDG_CACHE_HOME: join(browser.homeDirectory, ".cache"),
    TMPDIR: tmpdir(),
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
    LC_CTYPE: process.env.LC_CTYPE ?? "C.UTF-8",
    AGENT_BROWSER_SOCKET_DIR: browser.socketDirectory,
    AGENT_BROWSER_SESSION: browser.sessionName,
    AGENT_BROWSER_CONFIG: browser.configPath,
    AGENT_BROWSER_ACTION_POLICY: browser.actionPolicyPath,
    AGENT_BROWSER_ALLOWED_DOMAINS: browser.allowedDomains.join(","),
    AGENT_BROWSER_ALLOW_FILE_ACCESS: "false",
  };
  const chromeExecutable = DARWIN_BROWSER_EXECUTABLES.find((path) => path.includes("Chrome.app") && existsSync(path));
  if (!chromeExecutable) throw new Error("browser host daemon requires an installed Chrome executable");
  const chrome = Bun.spawn({
    cmd: [
      "/usr/bin/sandbox-exec",
      "-p",
      browserProcessSandboxProfile(cdpPort, loopback.ports),
      realpathSync(chromeExecutable),
      "--headless=new",
      "--no-sandbox",
      "--no-first-run",
      "--no-default-browser-check",
      "--password-store=basic",
      "--use-mock-keychain",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--disable-extensions",
      `--remote-debugging-port=${cdpPort}`,
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${join(browser.homeDirectory, "chrome-profile")}`,
      "about:blank",
    ],
    env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    await waitForChromeCdp(cdpPort, chrome);
  } catch (error) {
    await terminateSubprocess(chrome);
    throw error;
  }
  let daemonPids: number[] = [];
  const cleanup = async () => {
    await runLocalCommand({
      cmd: [agentBrowser, "close"],
      stdin: "",
      env,
      inheritEnv: false,
      timeoutMs: 10_000,
      cleanupOnFailure: true,
    });
    await terminateOwnedProcesses(daemonPids);
    await terminateSubprocess(chrome);
    await rm(browser.socketPath, { force: true });
    await rm(versionPath, { force: true });
    await rm(pidPath, { force: true });
  };
  try {
    const connected = await runLocalCommand({
      cmd: [
        "/usr/bin/sandbox-exec",
        "-p",
        browserDaemonSandboxProfile(cdpPort, browser.socketDirectory, nativeAgentBrowser, deniedReadPaths),
        nativeAgentBrowser,
        "--cdp",
        cdpAddress,
        "get",
        "url",
      ],
      stdin: "",
      env,
      inheritEnv: false,
      timeoutMs: 15_000,
      cleanupOnFailure: false,
    });
    if (connected.exitCode !== 0) throw new Error(`browser host daemon failed to connect to frozen Chrome: ${connected.stderr || connected.stdout}`);
    const socket = await lstatIfPresent(browser.socketPath);
    if (!socket?.isSocket() || socket.isSymbolicLink()) throw new Error("browser host daemon did not create its frozen Unix socket");
    await ensureBrowserDaemonVersionMarker(
      versionPath,
      agentBrowserVersion,
    );
    daemonPids = await processesHoldingPath(browser.socketPath);
    if (daemonPids.length !== 1) throw new Error("browser host daemon must have exactly one process holding its frozen Unix socket");
    await atomicPrivateWrite(pidPath, `${daemonPids[0]}\n`);
    return cleanup;
  } catch (error) {
    await cleanup();
    throw error;
  }
}

function frozenBrowserClient(input: {
  nativeAgentBrowser: string;
  socketPath: string;
  socketDirectory: string;
  sessionName: string;
  configPath: string;
  actionPolicyPath: string;
  versionPath: string;
  pidPath: string;
  expectedVersion: string;
}) {
  const fixedEnvironment = [
    ["AGENT_BROWSER_SOCKET_DIR", input.socketDirectory],
    ["AGENT_BROWSER_SESSION", input.sessionName],
    ["AGENT_BROWSER_CONFIG", input.configPath],
    ["AGENT_BROWSER_ACTION_POLICY", input.actionPolicyPath],
    ["AGENT_BROWSER_ALLOW_FILE_ACCESS", "false"],
  ] as const;
  return [
    "#!/bin/sh",
    "set -eu",
    `socket=${shellSingleQuoted(input.socketPath)}`,
    `version_file=${shellSingleQuoted(input.versionPath)}`,
    `pid_file=${shellSingleQuoted(input.pidPath)}`,
    `expected_version=${shellSingleQuoted(input.expectedVersion)}`,
    'if [ ! -S "$socket" ]; then echo "frozen browser daemon socket is unavailable" >&2; exit 78; fi',
    'if [ ! -f "$version_file" ] || [ "$(/bin/cat "$version_file")" != "$expected_version" ]; then echo "frozen browser daemon version mismatch" >&2; exit 78; fi',
    'if [ ! -f "$pid_file" ]; then echo "frozen browser daemon process receipt is unavailable" >&2; exit 78; fi',
    'daemon_pid=$(/bin/cat "$pid_file")',
    'case "$daemon_pid" in ""|*[!0-9]*) echo "frozen browser daemon process receipt is invalid" >&2; exit 78;; esac',
    'for arg in "$@"; do',
    '  case "$arg" in',
    '    --session|--session=*|--session-name|--session-name=*|--profile|--profile=*|--state|--state=*|--auto-connect|--cdp|--cdp=*|--provider|--provider=*|-p|-p?*|--executable-path|--executable-path=*|--extension|--extension=*|--args|--args=*|--proxy|--proxy=*|--allow-file-access|--allow-file-access=*|--config|--config=*|--action-policy|--action-policy=*|--headed|--headed=*|--engine|--engine=*)',
    '      echo "browser client connection override is forbidden" >&2; exit 78;;',
    '  esac',
    'done',
    ...fixedEnvironment.map(([key, value]) => `${key}=${shellSingleQuoted(value)}; export ${key}`),
    `exec ${shellSingleQuoted(input.nativeAgentBrowser)} "$@"`,
    "",
  ].join("\n");
}

async function readAgentBrowserVersion(executablePath: string) {
  const result = await runLocalCommand({
    cmd: [executablePath, "--version"],
    stdin: "",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    inheritEnv: false,
    timeoutMs: 5_000,
  });
  const match = result.exitCode === 0
    ? /^agent-browser\s+([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)$/.exec(result.stdout.trim())
    : null;
  if (!match) throw new Error("browser host daemon executable did not report a valid version");
  return match[1]!;
}

async function ensureBrowserDaemonVersionMarker(path: string, expectedVersion: string) {
  const existing = await lstatIfPresent(path);
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1) {
      throw new Error("browser host daemon version marker is not a private regular file");
    }
    if ((await readFile(path, "utf8")).trim() === expectedVersion) return;
  }
  await atomicPrivateWrite(path, `${expectedVersion}\n`);
  if ((await readFile(path, "utf8")).trim() !== expectedVersion) {
    throw new Error("browser host daemon version marker readback failed");
  }
}

function shellSingleQuoted(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function browserDaemonSandboxProfile(cdpPort: number, socketDirectory: string, executablePath: string, deniedReadPaths: string[]) {
  return [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    "(allow system-socket (socket-domain AF_UNIX))",
    "(allow network-bind (local unix-socket))",
    "(allow network-inbound (local unix-socket))",
    "(allow network-outbound (remote unix-socket))",
    `(allow network-outbound (remote ip "localhost:${cdpPort}"))`,
    `(allow file-read* file-write* (subpath ${JSON.stringify(socketDirectory)}))`,
    ...deniedReadPaths.map((path) => `(deny file-read* (subpath ${JSON.stringify(path)}))`),
    "(deny process-exec*)",
    `(allow process-exec (literal ${JSON.stringify(executablePath)}))`,
  ].join("\n");
}

function browserProcessSandboxProfile(cdpPort: number, ports: number[]) {
  return [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    "(allow system-socket (socket-domain AF_UNIX))",
    "(allow network-bind (local unix-socket))",
    "(allow network-outbound (remote unix-socket))",
    `(allow network-bind (local ip "localhost:${cdpPort}"))`,
    `(allow network-inbound (local ip "localhost:${cdpPort}"))`,
    ...ports.map((port) => `(allow network-outbound (remote ip "localhost:${port}"))`),
  ].join("\n");
}

async function reserveLoopbackPort() {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  if (!address || typeof address === "string") throw new Error("failed to reserve browser CDP port");
  return address.port;
}

async function waitForChromeCdp(port: number, chrome: Bun.Subprocess) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (chrome.exitCode !== null) throw new Error(`frozen browser process exited before CDP startup (${chrome.exitCode})`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(250) });
      if (response.ok) return;
    } catch {
      // Retry only until the bounded startup deadline.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error("frozen browser process did not expose CDP before startup deadline");
}

async function terminateSubprocess(subprocess: Bun.Subprocess) {
  if (subprocess.exitCode !== null) return;
  subprocess.kill("SIGTERM");
  const exited = await Promise.race([
    subprocess.exited.then(() => true),
    new Promise<false>((resolveWait) => setTimeout(() => resolveWait(false), 2_000)),
  ]);
  if (!exited && subprocess.exitCode === null) {
    subprocess.kill("SIGKILL");
    await subprocess.exited;
  }
}

async function processesHoldingPath(path: string) {
  const result = await runLocalCommand({
    cmd: ["/usr/sbin/lsof", "-t", "--", path],
    stdin: "",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    inheritEnv: false,
    timeoutMs: 5_000,
  });
  if (result.exitCode !== 0) return [];
  return [...new Set(result.stdout.split(/\s+/).filter(Boolean).map(Number).filter((pid) => Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid))];
}

async function terminateOwnedProcesses(pids: number[]) {
  for (const pid of pids) {
    try { process.kill(pid, "SIGTERM"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && pids.some(processExists)) await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  for (const pid of pids.filter(processExists)) {
    try { process.kill(pid, "SIGKILL"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  if (pids.some(processExists)) throw new Error("browser host daemon did not terminate during cleanup");
}

function processExists(pid: number) {
  try {
    process.kill(pid, 0);
    const state = Bun.spawnSync({ cmd: ["/bin/ps", "-o", "state=", "-p", String(pid)], stdout: "pipe", stderr: "ignore" });
    if (state.exitCode !== 0) return false;
    return !new TextDecoder().decode(state.stdout).trim().startsWith("Z");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function ensureLoopbackRelays(capabilities: ResolvedHostExecutionCapabilities) {
  const loopback = capabilities.loopback;
  if (!loopback) return undefined;
  const servers: Server[] = [];
  const connections = new Set<Socket>();
  const closeAll = async () => {
    for (const connection of connections) connection.destroy();
    await Promise.all(servers.map((server) => new Promise<void>((resolveClose) => server.close(() => resolveClose()))));
    await Promise.all(loopback.sockets.map((entry) => rm(entry.path, { force: true })));
  };
  try {
    for (const entry of loopback.sockets) {
      if (await lstatIfPresent(entry.path)) throw new Error(`loopback relay socket already exists: ${entry.path}`);
      const server = createServer((client) => {
        const upstream = connect({ host: loopback.host, port: entry.port });
        connections.add(client);
        connections.add(upstream);
        client.pipe(upstream);
        upstream.pipe(client);
        const closePeer = () => {
          connections.delete(client);
          connections.delete(upstream);
          client.destroy();
          upstream.destroy();
        };
        client.on("close", closePeer);
        upstream.on("close", closePeer);
        client.on("error", closePeer);
        upstream.on("error", closePeer);
      });
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once("error", rejectListen);
        server.listen(entry.path, () => {
          server.off("error", rejectListen);
          resolveListen();
        });
      });
      servers.push(server);
    }
    return closeAll;
  } catch (error) {
    await closeAll();
    throw error;
  }
}
