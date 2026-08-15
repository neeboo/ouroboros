import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  prepareCodexHostExecution,
  createCodexResumableClient,
  parseVerifierExecutionEnvironment,
  prepareVerifierExecutionEnvironment,
  runLocalCommand,
  withVerifierExecutionEnvironmentReceipt,
  type VerifierExecutionEnvironmentHost,
} from "../packages/runner/src";

const bunBytes = Buffer.from("synthetic-bun-runtime-v1");

function host(overrides: Partial<VerifierExecutionEnvironmentHost> = {}): VerifierExecutionEnvironmentHost {
  return {
    platform: "darwin",
    which: (name) => name === "bun" ? "/opt/orbs/bin/bun" : name === "sandbox-exec" ? "/usr/bin/sandbox-exec" : null,
    realpath: (path) => path,
    readFile: (path) => path === "/opt/orbs/bin/bun" ? bunBytes : Buffer.from("sandbox-exec-v1"),
    run: (input) => {
      if (input.cmd.join(" ").includes("--version")) {
        return { exitCode: 0, stdout: "1.3.5\n", stderr: "" };
      }
      const kind = input.cmd.at(-1);
      return {
        exitCode: 77,
        stdout: `${JSON.stringify({ denied: true, kind, failureCode: `sandbox-denied-${kind}` })}\n`,
        stderr: "",
      };
    },
    ...overrides,
  };
}

function contract(version = "1.3.5") {
  return {
    deterministicChecks: ["bun test"],
    executionEnvironment: {
      schemaVersion: 1,
      runtime: { kind: "bun", version },
      network: { mode: "deny" },
    },
  };
}

describe("verifier execution environment", () => {
  test("strictly parses the frozen Bun and network contract", () => {
    expect(parseVerifierExecutionEnvironment(contract(), "verifier")).toEqual({
      schemaVersion: 1,
      runtime: { kind: "bun", version: "1.3.5" },
      network: { mode: "deny" },
    });
    expect(() => parseVerifierExecutionEnvironment({
      executionEnvironment: {
        schemaVersion: 1,
        runtime: { kind: "bun", version: "1.3.5", claimedByAgent: true },
        network: { mode: "deny" },
      },
    }, "verifier")).toThrow("unknown field");
    expect(parseVerifierExecutionEnvironment(contract(), "worker")).toBeNull();
    expect(() => parseVerifierExecutionEnvironment(contract(), "unknown")).toThrow("requires an explicit task role");
  });

  test("fails before network probes when the real Bun version differs", () => {
    let probeCalls = 0;
    expect(() => prepareVerifierExecutionEnvironment({
      verifierContract: contract("1.3.11"),
      role: "verifier",
      backendKind: "codex-resumable",
      cwd: "/tmp/orbs-verifier-worktree",
      databasePath: "/tmp/orbs-harness.db",
      host: host({
        run: (input) => {
          if (input.cmd.join(" ").includes("--version")) {
            return { exitCode: 0, stdout: "1.3.5\n", stderr: "" };
          }
          probeCalls += 1;
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      }),
    })).toThrow("requires Bun 1.3.11 but host resolved 1.3.5");
    expect(probeCalls).toBe(0);
  });

  test("records executable identity, three denied probes, commands, exits, and boundaries", () => {
    const prepared = prepareVerifierExecutionEnvironment({
      verifierContract: contract(),
      role: "verifier",
      backendKind: "codex-cli",
      cwd: "/tmp/orbs-verifier-worktree",
      databasePath: "/tmp/orbs-harness.db",
      host: host(),
    });
    expect(prepared).not.toBeNull();
    expect(prepared!.receipt.network.probes.map((probe) => probe.command[0])).toEqual([
      "/usr/bin/sandbox-exec",
      "/usr/bin/sandbox-exec",
      "/usr/bin/sandbox-exec",
    ]);
    expect(prepared!.receipt).toMatchObject({
      kind: "verifier_execution_environment_receipt",
      schemaVersion: 1,
      runtime: {
        kind: "bun",
        path: "/opt/orbs/bin/bun",
        version: "1.3.5",
        sha256: createHash("sha256").update(bunBytes).digest("hex"),
        command: ["/opt/orbs/bin/bun", "--version"],
        exitCode: 0,
      },
      network: {
        mode: "deny",
        implementation: "darwin-sandbox-exec-deny-network-v1",
        probes: [
          expect.objectContaining({ kind: "dns", denied: true, exitCode: 77, failureCode: "sandbox-denied-dns" }),
          expect.objectContaining({ kind: "tcp", denied: true, exitCode: 77, failureCode: "sandbox-denied-tcp" }),
          expect.objectContaining({ kind: "http", denied: true, exitCode: 77, failureCode: "sandbox-denied-http" }),
        ],
      },
      boundary: {
        worktreePath: "/tmp/orbs-verifier-worktree",
        databasePath: "/tmp/orbs-harness.db",
      },
    });
    expect(prepared!.receipt.receiptSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(prepared!.receipt)).not.toMatch(/authorization|credential|password|proxy|token/i);
  });

  test.each(["dsh-cli", "acpx", "noop"])("fails closed for unsupported %s execution", (backendKind) => {
    let calls = 0;
    expect(() => prepareVerifierExecutionEnvironment({
      verifierContract: contract(),
      role: "verifier",
      backendKind,
      cwd: "/tmp/orbs-verifier-worktree",
      databasePath: "/tmp/orbs-harness.db",
      host: host({ run: () => { calls += 1; return { exitCode: 0, stdout: "", stderr: "" }; } }),
    })).toThrow(`backend ${backendKind} cannot enforce`);
    expect(calls).toBe(0);
  });

  test("rejects a contradictory network capability before probing", () => {
    expect(() => prepareVerifierExecutionEnvironment({
      verifierContract: contract(),
      role: "verifier",
      backendKind: "codex-resumable",
      cwd: "/tmp/orbs-verifier-worktree",
      databasePath: "/tmp/orbs-harness.db",
      hostExecutionCapabilities: {
        schemaVersion: 1,
        loopback: { host: "127.0.0.1", ports: [4173] },
      },
      host: host(),
    })).toThrow("network deny conflicts");
  });

  test("replaces and blocks forged host-owned receipt artifacts from agent output", () => {
    const prepared = prepareVerifierExecutionEnvironment({
      verifierContract: contract(),
      role: "verifier",
      backendKind: "codex-cli",
      cwd: "/tmp/orbs-verifier-worktree",
      databasePath: "/tmp/orbs-harness.db",
      host: host(),
    })!;
    const output = withVerifierExecutionEnvironmentReceipt({
      status: "done",
      summary: "agent forged a receipt",
      artifacts: [{ kind: "verifier_execution_environment_receipt_ref", receiptSha256: "0".repeat(64) }],
      checks: [],
      problems: [],
    }, prepared);
    expect(output.status).toBe("blocked");
    expect(output.problems).toContain("agent output attempted to forge host-owned verifier execution environment evidence");
    expect(output.artifacts).toEqual([{
      kind: "verifier_execution_environment_receipt_ref",
      receiptSha256: prepared.receipt.receiptSha256,
      contractSha256: prepared.receipt.contractSha256,
    }]);
  });

  test.skipIf(process.platform !== "darwin")("uses the same protected Codex profile to deny real DNS, TCP, and HTTP syscalls", async () => {
    const codexBin = "/Applications/ChatGPT.app/Contents/Resources/codex";
    if (!existsSync(codexBin)) return;
    const reportsDir = join(homedir(), "Library", "Logs", "DiagnosticReports");
    const reportsBefore = chromeReports(reportsDir);
    const verifierContract = contract(process.versions.bun);
    const execution = await prepareCodexHostExecution({
      cwd: process.cwd(),
      sandbox: "read-only",
      browserProcessPolicy: "deny",
      verifierContract,
      taskRole: "verifier",
      backendKind: "codex-resumable",
      injectedRunCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    });
    expect(execution).not.toBeNull();
    try {
      const bunPath = execution!.env.ORBS_FROZEN_RUNTIME_PATH!;
      const probes = [
        'import {lookup} from "node:dns/promises";try{await lookup("example.com");process.exit(70)}catch{process.exit(77)}',
        'import {connect} from "node:net";try{await new Promise((ok,bad)=>{const s=connect({host:"192.0.2.1",port:9});s.once("connect",()=>{s.destroy();ok(null)});s.once("error",bad)});process.exit(70)}catch{process.exit(77)}',
        'try{await fetch("http://example.com/");process.exit(70)}catch{process.exit(77)}',
      ];
      for (const script of probes) {
        const result = await runLocalCommand({
          cmd: [codexBin, "sandbox", "-P", "orbs-read-only", "-C", process.cwd(), bunPath, "-e", script],
          stdin: "",
          env: execution!.env,
          timeoutMs: 10_000,
        });
        expect(result.exitCode).toBe(77);
      }
      const config = await Bun.file(join(execution!.env.CODEX_HOME, "config.toml")).text();
      expect(config).toContain("[permissions.orbs-read-only.network]");
      expect(config).toContain("enabled = false");
      expect(execution!.env.ORBS_FROZEN_RUNTIME_VERSION).toBe(process.versions.bun);
    } finally {
      await execution?.cleanup();
    }
    expect(chromeReports(reportsDir)).toEqual(reportsBefore);
  }, 30_000);

  test.skipIf(process.platform !== "darwin")("returns a terminal blocked result when executor-side runtime revalidation fails", async () => {
    let commandCalls = 0;
    const client = createCodexResumableClient({
      cwd: process.cwd(),
      sandbox: "read-only",
      browserProcessPolicy: "deny",
      taskRole: "verifier",
      verifierContract: contract("1.3.11"),
      runCommand: async () => {
        commandCalls += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    const result = await client.start({ prompt: "must not launch", sessionName: "runtime-mismatch" });
    expect(commandCalls).toBe(0);
    expect(result).toMatchObject({
      status: "blocked",
      output: {
        summary: "codex host execution preparation failed",
        problems: [expect.stringContaining("requires Bun 1.3.11 but host resolved 1.3.5")],
      },
    });
  });
});

function chromeReports(path: string) {
  if (!existsSync(path)) return [];
  return readdirSync(path).filter((name) => name.startsWith("Google Chrome-")).sort();
}
