import type { AttemptOutput } from "@ouroboros/harness";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AgentBackendKind } from "./agent-backends";

const SHA256 = /^[0-9a-f]{64}$/;
const BUN_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const NETWORK_DENY_PROFILE = [
  "(version 1)",
  "(allow default)",
  "(deny network*)",
  '(deny mach-lookup (global-name "com.apple.mDNSResponder"))',
  '(deny mach-lookup (global-name "com.apple.dnssd.service"))',
].join("");
const NETWORK_DENY_IMPLEMENTATION = "darwin-sandbox-exec-deny-network-v1" as const;
const NETWORK_PROBE_SCRIPT = [
  'import { lookup } from "node:dns/promises";',
  'import { connect } from "node:net";',
  'const kind = process.argv[1];',
  'try {',
  '  if (kind === "dns") await lookup("example.com");',
  '  if (kind === "tcp") await new Promise((resolve, reject) => {',
  '    const socket = connect({ host: "192.0.2.1", port: 9 });',
  '    socket.once("connect", () => { socket.destroy(); resolve(null); });',
  '    socket.once("error", reject);',
  '  });',
  '  if (kind === "http") await fetch("http://example.com/");',
  '  console.log(JSON.stringify({ denied: false, kind, failureCode: "unexpected-network-success" }));',
  '  process.exit(70);',
  '} catch (error) {',
  '  const cause = error?.cause;',
  '  const failureCode = String(error?.code ?? cause?.code ?? error?.name ?? "network-denied");',
  '  console.log(JSON.stringify({ denied: true, kind, failureCode }));',
  '  process.exit(77);',
  '}',
].join("\n");

export interface VerifierExecutionEnvironmentV1 {
  schemaVersion: 1;
  runtime: {
    kind: "bun";
    version: string;
  };
  network: {
    mode: "deny";
  };
}

export interface VerifierExecutionEnvironmentHost {
  platform: string;
  which(name: "bun" | "sandbox-exec"): string | null;
  realpath(path: string): string;
  readFile(path: string): Uint8Array;
  run(input: { cmd: string[]; cwd: string; env: Record<string, string> }): {
    exitCode: number;
    stdout: string;
    stderr: string;
  };
}

export interface VerifierExecutionEnvironmentReceiptV1 {
  kind: "verifier_execution_environment_receipt";
  schemaVersion: 1;
  contractSha256: string;
  runtime: {
    kind: "bun";
    path: string;
    version: string;
    sha256: string;
    command: string[];
    exitCode: number;
  };
  network: {
    mode: "deny";
    implementation: typeof NETWORK_DENY_IMPLEMENTATION;
    policyExecutablePath: string;
    policyExecutableSha256: string;
    profileSha256: string;
    probes: Array<{
      kind: "dns" | "tcp" | "http";
      command: string[];
      exitCode: number;
      denied: true;
      failureCode: string;
    }>;
  };
  boundary: {
    worktreePath: string;
    databasePath: string;
  };
  receiptSha256: string;
}

export interface PreparedVerifierExecutionEnvironment {
  receipt: VerifierExecutionEnvironmentReceiptV1;
}

export function parseVerifierExecutionEnvironment(verifierContract: unknown, role: string) {
  const contract = objectOrNull(verifierContract);
  if (!contract || contract.executionEnvironment === undefined) return null;
  if (role === "unknown" || role.trim() === "") {
    throw new Error("verifierContract.executionEnvironment requires an explicit task role");
  }
  if (role !== "verifier") return null;
  const environment = strictObject(contract.executionEnvironment, "verifierContract.executionEnvironment", [
    "schemaVersion", "runtime", "network",
  ]);
  if (environment.schemaVersion !== 1) throw new Error("verifierContract.executionEnvironment.schemaVersion must be 1");
  const runtime = strictObject(environment.runtime, "verifierContract.executionEnvironment.runtime", ["kind", "version"]);
  if (runtime.kind !== "bun") throw new Error("verifierContract.executionEnvironment.runtime.kind must be bun");
  if (typeof runtime.version !== "string" || !BUN_VERSION.test(runtime.version)) {
    throw new Error("verifierContract.executionEnvironment.runtime.version must be an exact Bun version");
  }
  const network = strictObject(environment.network, "verifierContract.executionEnvironment.network", ["mode"]);
  if (network.mode !== "deny") throw new Error("verifierContract.executionEnvironment.network.mode must be deny");
  return {
    schemaVersion: 1,
    runtime: { kind: "bun", version: runtime.version },
    network: { mode: "deny" },
  } satisfies VerifierExecutionEnvironmentV1;
}

export function prepareVerifierExecutionEnvironment(input: {
  verifierContract: unknown;
  role: string;
  backendKind: AgentBackendKind | string;
  cwd: string;
  databasePath: string;
  hostExecutionCapabilities?: unknown;
  host?: VerifierExecutionEnvironmentHost;
}): PreparedVerifierExecutionEnvironment | null {
  const contract = parseVerifierExecutionEnvironment(input.verifierContract, input.role);
  if (!contract) return null;
  if (input.backendKind !== "codex-cli" && input.backendKind !== "codex-resumable") {
    throw new Error(`backend ${input.backendKind} cannot enforce the frozen verifier execution environment`);
  }
  assertNetworkDenyCompatible(input.hostExecutionCapabilities);
  const host = input.host ?? defaultHost();
  if (host.platform !== "darwin") {
    throw new Error("network deny verifier execution is unsupported on this host and must fail closed");
  }
  const bunCandidate = host.which("bun");
  const sandboxCandidate = host.which("sandbox-exec");
  if (!bunCandidate) throw new Error("frozen verifier runtime requires a host Bun executable");
  if (!sandboxCandidate) throw new Error("network deny verifier execution requires sandbox-exec");
  const bunPath = host.realpath(bunCandidate);
  const sandboxPath = host.realpath(sandboxCandidate);
  const cwd = host.realpath(input.cwd);
  const versionResult = host.run({
    cmd: [bunPath, "--version"],
    cwd,
    env: minimalEnvironment(bunPath),
  });
  const actualVersion = versionResult.stdout.trim();
  if (versionResult.exitCode !== 0 || !BUN_VERSION.test(actualVersion)) {
    throw new Error(`failed to read the host Bun version from ${bunPath}`);
  }
  if (actualVersion !== contract.runtime.version) {
    throw new Error(
      `frozen verifier requires Bun ${contract.runtime.version} but host resolved ${actualVersion}; `
      + "runtime installation or download requires an explicit human checkpoint and was not attempted",
    );
  }

  const runtimeSha256 = sha256(host.readFile(bunPath));
  const sandboxSha256 = sha256(host.readFile(sandboxPath));
  const probes = (["dns", "tcp", "http"] as const).map((kind) => {
    const command = [sandboxPath, "-p", NETWORK_DENY_PROFILE, bunPath, "--config=/dev/null", "-e", NETWORK_PROBE_SCRIPT, kind];
    const result = host.run({ cmd: command, cwd, env: minimalEnvironment(bunPath) });
    const evidence = parseProbeOutput(result.stdout);
    if (result.exitCode !== 77 || evidence.denied !== true || evidence.kind !== kind || !evidence.failureCode) {
      throw new Error(`network deny ${kind} probe did not fail inside the host sandbox (exit ${result.exitCode})`);
    }
    return {
      kind,
      command,
      exitCode: result.exitCode,
      denied: true as const,
      failureCode: evidence.failureCode,
    };
  });
  const receiptBody = {
    kind: "verifier_execution_environment_receipt" as const,
    schemaVersion: 1 as const,
    contractSha256: sha256(Buffer.from(canonicalJson(input.verifierContract), "utf8")),
    runtime: {
      kind: "bun" as const,
      path: bunPath,
      version: actualVersion,
      sha256: runtimeSha256,
      command: [bunPath, "--version"],
      exitCode: versionResult.exitCode,
    },
    network: {
      mode: "deny" as const,
      implementation: NETWORK_DENY_IMPLEMENTATION,
      policyExecutablePath: sandboxPath,
      policyExecutableSha256: sandboxSha256,
      profileSha256: sha256(Buffer.from(NETWORK_DENY_PROFILE, "utf8")),
      probes,
    },
    boundary: {
      worktreePath: cwd,
      databasePath: input.databasePath === ":memory:" ? input.databasePath : host.realpath(resolve(input.databasePath)),
    },
  };
  return {
    receipt: {
      ...receiptBody,
      receiptSha256: sha256(Buffer.from(canonicalJson(receiptBody), "utf8")),
    },
  };
}

export function verifierExecutionEnvironmentAttemptInput(prepared: PreparedVerifierExecutionEnvironment | null) {
  return prepared ? { verifierExecutionEnvironmentReceipt: prepared.receipt } : {};
}

export function blockedVerifierExecutionEnvironmentOutput(error: unknown): AttemptOutput {
  const problem = error instanceof Error ? error.message : String(error);
  return {
    status: "blocked",
    summary: "Verifier execution environment validation failed before task startup.",
    changedFiles: [],
    checks: [{ name: "host-owned verifier execution environment", status: "failed", evidence: problem }],
    artifacts: [{ kind: "verifier_execution_environment_preflight", status: "blocked", problem }],
    problems: [problem],
  };
}

export function withVerifierExecutionEnvironmentReceipt(
  output: AttemptOutput,
  prepared: PreparedVerifierExecutionEnvironment | VerifierExecutionEnvironmentReceiptV1 | null,
): AttemptOutput {
  if (!prepared) return output;
  const receipt = "receipt" in prepared ? prepared.receipt : prepared;
  const reservedEvidence = (output.artifacts ?? []).some((artifact) => {
    const object = objectOrNull(artifact);
    return typeof object?.kind === "string" && object.kind.startsWith("verifier_execution_environment");
  }) || (output.checks ?? []).some((check) => objectOrNull(check)?.name === "host-owned verifier execution environment");
  return {
    ...output,
    status: reservedEvidence ? "blocked" : output.status,
    checks: [
      ...(output.checks ?? []).filter((check) => objectOrNull(check)?.name !== "host-owned verifier execution environment"),
      {
        name: "host-owned verifier execution environment",
        status: "passed",
        evidence: receipt.receiptSha256,
      },
    ],
    artifacts: [
      ...(output.artifacts ?? []).filter((artifact) => {
        const object = objectOrNull(artifact);
        return !(typeof object?.kind === "string" && object.kind.startsWith("verifier_execution_environment"));
      }),
      {
        kind: "verifier_execution_environment_receipt_ref",
        receiptSha256: receipt.receiptSha256,
        contractSha256: receipt.contractSha256,
      },
    ],
    problems: reservedEvidence
      ? [...(output.problems ?? []), "agent output attempted to forge host-owned verifier execution environment evidence"]
      : output.problems,
  };
}

export function preparedVerifierExecutionEnvironmentFromAttempt(input: Record<string, unknown>) {
  const receipt = input.verifierExecutionEnvironmentReceipt;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return null;
  const record = receipt as VerifierExecutionEnvironmentReceiptV1;
  if (record.kind !== "verifier_execution_environment_receipt" || !SHA256.test(record.receiptSha256 ?? "")) {
    throw new Error("persisted verifier execution environment receipt is invalid");
  }
  const { receiptSha256, ...body } = record;
  if (sha256(Buffer.from(canonicalJson(body), "utf8")) !== receiptSha256) {
    throw new Error("persisted verifier execution environment receipt hash mismatch");
  }
  return record;
}

export function assertPersistedVerifierExecutionEnvironmentReceipt(
  attemptInput: Record<string, unknown>,
  current: PreparedVerifierExecutionEnvironment | null,
) {
  const persisted = preparedVerifierExecutionEnvironmentFromAttempt(attemptInput);
  if (!persisted && !current) return;
  if (!persisted || !current || canonicalJson(stableReceiptIdentity(persisted)) !== canonicalJson(stableReceiptIdentity(current.receipt))) {
    throw new Error("frozen verifier execution environment changed before resume");
  }
}

function assertNetworkDenyCompatible(value: unknown) {
  const capabilities = objectOrNull(value);
  if (!capabilities) return;
  const git = objectOrNull(capabilities.git);
  const remoteDomains = Array.isArray(git?.remoteDomains) ? git.remoteDomains : [];
  if (capabilities.postgres !== undefined
    || capabilities.loopback !== undefined
    || capabilities.network !== undefined
    || capabilities.browser !== undefined
    || remoteDomains.length > 0) {
    throw new Error("verifier network deny conflicts with network-capable hostExecutionCapabilities");
  }
}

function stableReceiptIdentity(receipt: VerifierExecutionEnvironmentReceiptV1) {
  return {
    contractSha256: receipt.contractSha256,
    runtime: receipt.runtime,
    network: {
      mode: receipt.network.mode,
      implementation: receipt.network.implementation,
      policyExecutablePath: receipt.network.policyExecutablePath,
      policyExecutableSha256: receipt.network.policyExecutableSha256,
      profileSha256: receipt.network.profileSha256,
      deniedProbeKinds: receipt.network.probes.filter((probe) => probe.denied && probe.exitCode !== 0).map((probe) => probe.kind).sort(),
    },
    boundary: receipt.boundary,
  };
}

function parseProbeOutput(stdout: string) {
  try {
    const parsed = JSON.parse(stdout.trim()) as Record<string, unknown>;
    return {
      denied: parsed.denied,
      kind: parsed.kind,
      failureCode: typeof parsed.failureCode === "string" ? parsed.failureCode : "",
    };
  } catch {
    return { denied: false, kind: null, failureCode: "" };
  }
}

function minimalEnvironment(bunPath: string) {
  return {
    PATH: `${dirname(bunPath)}:/usr/bin:/bin`,
    HOME: "/tmp",
    LANG: "C.UTF-8",
    HTTP_PROXY: "",
    HTTPS_PROXY: "",
    ALL_PROXY: "",
    http_proxy: "",
    https_proxy: "",
    all_proxy: "",
  };
}

function defaultHost(): VerifierExecutionEnvironmentHost {
  return {
    platform: process.platform,
    which: (name) => name === "bun" && process.versions.bun ? process.execPath : Bun.which(name),
    realpath: (path) => realpathSync(path),
    readFile: (path) => readFileSync(path),
    run: (input) => {
      const result = Bun.spawnSync({
        cmd: input.cmd,
        cwd: input.cwd,
        env: input.env,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5_000,
      });
      return {
        exitCode: result.exitCode,
        stdout: new TextDecoder().decode(result.stdout),
        stderr: new TextDecoder().decode(result.stderr),
      };
    },
  };
}

function strictObject(value: unknown, label: string, keys: string[]) {
  const object = objectOrNull(value);
  if (!object) throw new Error(`${label} must be an object`);
  const allowed = new Set(keys);
  const unknown = Object.keys(object).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`${label} has unknown field: ${unknown}`);
  return object;
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}
