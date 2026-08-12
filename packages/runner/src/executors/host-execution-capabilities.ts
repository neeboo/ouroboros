import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_DOMAIN = /^(?:localhost|[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?)$/;
const SAFE_ENVIRONMENT_VARIABLE = /^[A-Z][A-Z0-9_]{0,63}$/;
const ALLOWED_NETWORK_DOMAINS = new Set([
  "github.com",
  "ssh.github.com",
  "api.github.com",
  "api.linear.app",
]);

export interface HostExecutionCapabilitiesV1 {
  schemaVersion: 1;
  git?: {
    worktreeMetadata: "own";
    remoteDomains: string[];
  };
  postgres?: {
    environmentVariable: string;
    valueSha256: string;
    unixSocketPath: string;
  };
  loopback?: {
    host: "127.0.0.1";
    ports: number[];
  };
  network?: {
    mode: "host-fixed-actions";
    domains: string[];
    clearAmbientProxy: true;
  };
  browser?: {
    mode: "isolated-agent-browser";
    allowedDomains: string[];
    verifierContractSha256: string;
  };
}

export interface ResolvedHostExecutionCapabilities {
  schemaVersion: 1;
  contractSha256: string;
  git?: {
    gitDir: string;
    commonDir: string;
    objectsDir: string;
    branchRef: string;
    branchReflog: string;
    remoteDomains: string[];
  };
  postgres?: {
    environmentVariable: string;
    valueSha256: string;
    unixSocketPath: string;
    databaseName: string;
  };
  loopback?: NonNullable<HostExecutionCapabilitiesV1["loopback"]> & {
    socketDirectory: string;
    sockets: Array<{ port: number; path: string }>;
  };
  network?: HostExecutionCapabilitiesV1["network"];
  browser?: NonNullable<HostExecutionCapabilitiesV1["browser"]> & {
    socketDirectory: string;
    sessionName: string;
    socketPath: string;
    homeDirectory: string;
    configPath: string;
    actionPolicyPath: string;
  };
}

export function parseHostExecutionCapabilities(value: unknown, input: { role: string; verifierContract?: unknown }): HostExecutionCapabilitiesV1 {
  const object = strictObject(value, "hostExecutionCapabilities", [
    "schemaVersion", "git", "postgres", "loopback", "network", "browser",
  ]);
  if (object.schemaVersion !== 1) throw new Error("hostExecutionCapabilities.schemaVersion must be 1");

  const git = object.git === undefined ? undefined : parseGit(object.git);
  const postgres = object.postgres === undefined ? undefined : parsePostgres(object.postgres);
  const loopback = object.loopback === undefined ? undefined : parseLoopback(object.loopback);
  const network = object.network === undefined ? undefined : parseNetwork(object.network);
  const browser = object.browser === undefined ? undefined : parseBrowser(object.browser);
  if (browser && input.role !== "verifier") throw new Error("hostExecutionCapabilities browser capability is verifier-only");
  if (browser && (!input.verifierContract || typeof input.verifierContract !== "object" || Array.isArray(input.verifierContract))) {
    throw new Error("hostExecutionCapabilities browser capability requires a frozen verifierContract");
  }
  if (browser && browser.verifierContractSha256 !== sha256(canonicalJson(input.verifierContract))) {
    throw new Error("hostExecutionCapabilities browser verifierContractSha256 mismatch");
  }
  if (browser && !loopback) throw new Error("hostExecutionCapabilities.browser requires a frozen loopback capability");
  if ((git?.remoteDomains.length ?? 0) > 0 && !network) {
    throw new Error("hostExecutionCapabilities.git remoteDomains require network capability");
  }
  for (const domain of git?.remoteDomains ?? []) {
    if (!network?.domains.includes(domain)) throw new Error(`hostExecutionCapabilities.git remote domain is not present in network domains: ${domain}`);
  }
  return stripUndefined({ schemaVersion: 1, git, postgres, loopback, network, browser }) as unknown as HostExecutionCapabilitiesV1;
}

export function hostExecutionCapabilityAttemptInput(value: unknown, input: { role: string; verifierContract?: unknown }) {
  if (value === undefined) return {};
  try {
    const capabilities = parseHostExecutionCapabilities(value, input);
    return {
      hostExecutionCapability: {
        status: "frozen",
        contractSha256: sha256(canonicalJson(capabilities)),
        schemaVersion: capabilities.schemaVersion,
        git: capabilities.git ? { worktreeMetadata: "own", remoteDomains: capabilities.git.remoteDomains } : undefined,
        postgres: capabilities.postgres ? {
          environmentVariable: capabilities.postgres.environmentVariable,
          valueSha256: capabilities.postgres.valueSha256,
          unixSocketPath: capabilities.postgres.unixSocketPath,
        } : undefined,
        loopback: capabilities.loopback,
        network: capabilities.network,
        browser: capabilities.browser,
      },
    };
  } catch (error) {
    return {
      hostExecutionCapability: {
        status: "invalid",
        problem: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export function assertPersistedHostExecutionCapabilityAttestation(
  attemptInput: Record<string, unknown>,
  value: unknown,
  input: { role: string; verifierContract?: unknown },
) {
  const current = hostExecutionCapabilityAttemptInput(value, input).hostExecutionCapability as Record<string, unknown> | undefined;
  const persisted = attemptInput.hostExecutionCapability as Record<string, unknown> | undefined;
  if (!current && !persisted) return;
  if (current?.status !== "frozen" || persisted?.status !== "frozen") {
    throw new Error("frozen host execution capability attestation is missing or invalid");
  }
  if (current.contractSha256 !== persisted.contractSha256) {
    throw new Error("frozen host execution capability changed before resume");
  }
}

export function resolveHostExecutionCapabilities(input: {
  cwd: string;
  capabilities: HostExecutionCapabilitiesV1;
}): ResolvedHostExecutionCapabilities {
  const cwd = realpathSync(input.cwd);
  const contractSha256 = sha256(canonicalJson(input.capabilities));
  const git = input.capabilities.git ? resolveGit(cwd, input.capabilities.git.remoteDomains) : undefined;
  const postgres = input.capabilities.postgres ? resolvePostgres(input.capabilities.postgres) : undefined;
  const loopback = input.capabilities.loopback ? resolveLoopback(cwd, contractSha256, input.capabilities.loopback) : undefined;
  const browser = input.capabilities.browser ? resolveBrowser(cwd, contractSha256, input.capabilities.browser) : undefined;
  return stripUndefined({
    schemaVersion: 1,
    contractSha256,
    git,
    postgres,
    loopback,
    network: input.capabilities.network,
    browser,
  }) as unknown as ResolvedHostExecutionCapabilities;
}

function resolveLoopback(cwd: string, contractSha256: string, loopback: NonNullable<HostExecutionCapabilitiesV1["loopback"]>) {
  const executionIdentity = sha256(`${cwd}\0${contractSha256}\0loopback`);
  const nonce = randomUUID().replaceAll("-", "").slice(0, 12);
  const socketDirectory = join("/tmp", "ouroboros-loopback", `${executionIdentity.slice(0, 16)}-${nonce}`);
  return {
    ...loopback,
    socketDirectory,
    sockets: loopback.ports.map((port) => ({ port, path: join(socketDirectory, `port-${port}.sock`) })),
  };
}

function resolveBrowser(cwd: string, contractSha256: string, browser: NonNullable<HostExecutionCapabilitiesV1["browser"]>) {
  const executionIdentity = sha256(`${cwd}\0${contractSha256}`);
  const nonce = randomUUID().replaceAll("-", "").slice(0, 12);
  const sessionName = `orbs-${executionIdentity.slice(0, 12)}-${nonce}`;
  const socketDirectory = join("/tmp", "ouroboros-agent-browser", `${executionIdentity.slice(0, 16)}-${nonce}`);
  return {
    ...browser,
    socketDirectory,
    sessionName,
    socketPath: join(socketDirectory, `${sessionName}.sock`),
    homeDirectory: join(socketDirectory, "home"),
    configPath: join(socketDirectory, "config.json"),
    actionPolicyPath: join(socketDirectory, "action-policy.json"),
  };
}

function parseGit(value: unknown): HostExecutionCapabilitiesV1["git"] {
  const object = strictObject(value, "hostExecutionCapabilities.git", ["worktreeMetadata", "remoteDomains"]);
  if (object.worktreeMetadata !== "own") throw new Error("hostExecutionCapabilities.git.worktreeMetadata must be own");
  const remoteDomains = Array.isArray(object.remoteDomains) && object.remoteDomains.length === 0
    ? []
    : domainList(object.remoteDomains, "hostExecutionCapabilities.git.remoteDomains");
  return { worktreeMetadata: "own", remoteDomains };
}

function parsePostgres(value: unknown): NonNullable<HostExecutionCapabilitiesV1["postgres"]> {
  const object = strictObject(value, "hostExecutionCapabilities.postgres", ["environmentVariable", "valueSha256", "unixSocketPath"]);
  if (object.environmentVariable !== "TEST_DATABASE_URL" || !SAFE_ENVIRONMENT_VARIABLE.test(object.environmentVariable)) {
    throw new Error("hostExecutionCapabilities.postgres.environmentVariable must be TEST_DATABASE_URL");
  }
  if (typeof object.valueSha256 !== "string" || !SHA256.test(object.valueSha256)) {
    throw new Error("hostExecutionCapabilities.postgres.valueSha256 must be a lowercase SHA-256");
  }
  if (typeof object.unixSocketPath !== "string" || !isAbsolute(object.unixSocketPath) || !/^\/tmp\/\.s\.PGSQL\.\d{1,5}$/.test(object.unixSocketPath)) {
    throw new Error("hostExecutionCapabilities.postgres.unixSocketPath must be an exact /tmp PostgreSQL socket");
  }
  return {
    environmentVariable: object.environmentVariable,
    valueSha256: object.valueSha256,
    unixSocketPath: object.unixSocketPath,
  };
}

function parseLoopback(value: unknown): NonNullable<HostExecutionCapabilitiesV1["loopback"]> {
  const object = strictObject(value, "hostExecutionCapabilities.loopback", ["host", "ports"]);
  if (object.host !== "127.0.0.1") throw new Error("hostExecutionCapabilities.loopback.host must be 127.0.0.1");
  if (!Array.isArray(object.ports) || object.ports.length < 1 || object.ports.length > 16) {
    throw new Error("hostExecutionCapabilities.loopback.ports must contain 1-16 ports");
  }
  const ports = object.ports.map((port) => {
    if (!Number.isSafeInteger(port) || (port as number) < 1024 || (port as number) > 65535) {
      throw new Error("hostExecutionCapabilities.loopback.ports must contain non-privileged TCP ports");
    }
    return port as number;
  });
  if (new Set(ports).size !== ports.length) throw new Error("hostExecutionCapabilities.loopback.ports must be unique");
  return { host: "127.0.0.1", ports: [...ports].sort((a, b) => a - b) };
}

function parseNetwork(value: unknown): NonNullable<HostExecutionCapabilitiesV1["network"]> {
  const object = strictObject(value, "hostExecutionCapabilities.network", ["mode", "domains", "clearAmbientProxy"]);
  if (object.mode !== "host-fixed-actions") throw new Error("hostExecutionCapabilities.network.mode must be host-fixed-actions");
  if (object.clearAmbientProxy !== true) throw new Error("hostExecutionCapabilities.network.clearAmbientProxy must be true");
  const domains = domainList(object.domains, "hostExecutionCapabilities.network.domains");
  for (const domain of domains) {
    if (!ALLOWED_NETWORK_DOMAINS.has(domain)) throw new Error(`hostExecutionCapabilities.network domain is not host-approved: ${domain}`);
  }
  return { mode: "host-fixed-actions", domains, clearAmbientProxy: true };
}

function parseBrowser(value: unknown): NonNullable<HostExecutionCapabilitiesV1["browser"]> {
  const object = strictObject(value, "hostExecutionCapabilities.browser", ["mode", "allowedDomains", "verifierContractSha256"]);
  if (object.mode !== "isolated-agent-browser") throw new Error("hostExecutionCapabilities.browser.mode must be isolated-agent-browser");
  if (typeof object.verifierContractSha256 !== "string" || !SHA256.test(object.verifierContractSha256)) {
    throw new Error("hostExecutionCapabilities.browser.verifierContractSha256 must be a lowercase SHA-256");
  }
  const allowedDomains = domainList(object.allowedDomains, "hostExecutionCapabilities.browser.allowedDomains");
  if (allowedDomains.length !== 1 || allowedDomains[0] !== "127.0.0.1") {
    throw new Error("hostExecutionCapabilities.browser.allowedDomains must be exactly 127.0.0.1 in V1");
  }
  return {
    mode: "isolated-agent-browser",
    allowedDomains,
    verifierContractSha256: object.verifierContractSha256,
  };
}

export function verifierContractSha256(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("verifierContract must be an object");
  return sha256(canonicalJson(value));
}

function resolveGit(cwd: string, remoteDomains: string[]) {
  const gitDir = gitPath(cwd, "--git-dir");
  const commonDir = gitPath(cwd, "--git-common-dir");
  if (gitDir === commonDir || !inside(gitDir, commonDir)) {
    throw new Error("hostExecutionCapabilities.git requires a linked task worktree with dedicated metadata");
  }
  const branch = git(cwd, "symbolic-ref", "--quiet", "HEAD");
  if (!branch.startsWith("refs/heads/") || branch.includes("..")) {
    throw new Error("hostExecutionCapabilities.git requires an attached safe branch");
  }
  const branchPath = branch.slice("refs/heads/".length).split("/");
  const branchRef = resolve(commonDir, "refs", "heads", ...branchPath);
  const branchReflog = resolve(commonDir, "logs", "refs", "heads", ...branchPath);
  if (!inside(branchRef, commonDir) || !inside(branchReflog, commonDir)) throw new Error("hostExecutionCapabilities.git branch path escaped common metadata");
  if (remoteDomains.length > 0) {
    const remoteUrl = git(cwd, "remote", "get-url", "--push", "origin");
    const remoteDomain = gitRemoteDomain(remoteUrl);
    if (!remoteDomains.includes(remoteDomain)) throw new Error(`task worktree origin is outside frozen Git remote domains: ${remoteDomain}`);
  }
  return { gitDir, commonDir, objectsDir: join(commonDir, "objects"), branchRef, branchReflog, remoteDomains };
}

function gitRemoteDomain(value: string) {
  const scp = value.match(/^(?:[^@/:]+@)?([^:/]+):.+$/);
  if (scp) return scp[1].toLowerCase();
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.protocol !== "ssh:") throw new Error("unsupported protocol");
    return parsed.hostname.toLowerCase();
  } catch {
    throw new Error("task worktree origin must be an SSH or HTTPS remote URL");
  }
}

function resolvePostgres(value: NonNullable<HostExecutionCapabilitiesV1["postgres"]>) {
  const actual = process.env[value.environmentVariable];
  if (!actual || sha256(actual) !== value.valueSha256) throw new Error("frozen PostgreSQL environment value mismatch");
  const parsed = new URL(actual);
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") throw new Error("frozen PostgreSQL URL must use postgresql");
  if (parsed.hostname || parsed.port || parsed.username || parsed.password) throw new Error("frozen PostgreSQL URL must use local peer authentication only");
  if (parsed.searchParams.get("host") !== dirname(value.unixSocketPath)) throw new Error("frozen PostgreSQL URL host must match the approved socket directory");
  const declaredPort = parsed.searchParams.get("port") ?? "5432";
  if (!/^\d{1,5}$/.test(declaredPort) || Number(declaredPort) < 1 || Number(declaredPort) > 65535) {
    throw new Error("frozen PostgreSQL URL has an invalid port");
  }
  if (value.unixSocketPath !== join(dirname(value.unixSocketPath), `.s.PGSQL.${declaredPort}`)) {
    throw new Error("frozen PostgreSQL socket port must match TEST_DATABASE_URL");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName || !/^[a-zA-Z0-9_-]{1,63}$/.test(databaseName)) throw new Error("frozen PostgreSQL URL has an invalid database name");
  return { ...value, databaseName };
}

function strictObject(value: unknown, label: string, keys: string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const object = value as Record<string, unknown>;
  const allowed = new Set(keys);
  const unknown = Object.keys(object).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${label} has unknown field: ${unknown[0]}`);
  return object;
}

function domainList(value: unknown, label: string) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) throw new Error(`${label} must contain 1-16 domains`);
  const domains = value.map((domain) => {
    if (typeof domain !== "string" || !SAFE_DOMAIN.test(domain) || domain.includes("..")) throw new Error(`${label} contains an invalid domain`);
    return domain.toLowerCase();
  });
  if (new Set(domains).size !== domains.length) throw new Error(`${label} must be unique`);
  return [...domains].sort();
}

function gitPath(cwd: string, flag: "--git-dir" | "--git-common-dir") {
  const value = git(cwd, "rev-parse", "--path-format=absolute", flag);
  return realpathSync(value);
}

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync({ cmd: ["git", "-C", cwd, ...args], stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`failed to resolve task worktree Git metadata: ${new TextDecoder().decode(result.stderr).trim()}`);
  return new TextDecoder().decode(result.stdout).trim();
}

function inside(path: string, root: string) {
  const normalizedRoot = resolve(root);
  const normalizedPath = resolve(path);
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}${sep}`);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function stripUndefined(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
