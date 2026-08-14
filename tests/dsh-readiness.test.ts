import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  inspectDshReadiness,
  resolveDshCommand,
  type DshReadinessReceipt,
} from "../packages/runner/src/dsh-readiness";

describe("DSH readiness", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ouroboros-dsh-readiness-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("selects the first executable PATH candidate in each order", async () => {
    const first = join(dir, "first");
    const second = join(dir, "second");
    await Promise.all([
      writeExecutable(join(first, "dsh")),
      writeExecutable(join(second, "dsh")),
    ]);

    const leftFirst = resolveDshCommand({
      command: "dsh",
      cwd: dir,
      env: { PATH: `${first}:${second}` },
    });
    const rightFirst = resolveDshCommand({
      command: "dsh",
      cwd: dir,
      env: { PATH: `${second}:${first}` },
    });

    expect(leftFirst).toMatchObject({
      configuredCommand: "dsh",
      resolutionMode: "path",
      selectedPath: join(first, "dsh"),
      callable: true,
    });
    expect(rightFirst).toMatchObject({
      selectedPath: join(second, "dsh"),
      callable: true,
    });
  });

  test("keeps explicit wrapper provenance while exposing its canonical path", async () => {
    const target = join(dir, "dsh-target");
    const wrapper = join(dir, "dsh-wrapper");
    await writeExecutable(target);
    await symlink(target, wrapper);

    const result = resolveDshCommand({ command: wrapper, cwd: dir, env: { PATH: "" } });

    expect(result).toMatchObject({
      configuredCommand: wrapper,
      resolutionMode: "explicit",
      selectedPath: wrapper,
      canonicalPath: realpathSync(target),
      callable: true,
    });
    expect(JSON.stringify(result)).not.toContain("underlying");
  });

  test("uses the supplied cwd for a relative explicit executable", async () => {
    await writeExecutable(join(dir, "relative-dsh"));

    const result = resolveDshCommand({ command: "./relative-dsh", cwd: dir, env: { PATH: "" } });

    expect(result).toMatchObject({
      resolutionMode: "explicit",
      configuredCommand: "./relative-dsh",
      selectedPath: "./relative-dsh",
      canonicalPath: realpathSync(join(dir, "relative-dsh")),
      callable: true,
    });
  });

  test("runs only bounded version and help probes and reports zero inference", async () => {
    const command = join(dir, "dsh");
    await writeExecutable(command);
    const calls: string[][] = [];

    const receipt = await inspectDshReadiness({
      backendId: "dsh-cli",
      command,
      cwd: dir,
      env: { DSH_HOME: "/tmp/dsh-readiness-home" },
      runCommand: async (input) => {
        calls.push(input.cmd);
        return input.cmd.at(-1) === "--version"
          ? { exitCode: 0, stdout: "dsh 0.1.0-rc.2\n", stderr: "" }
          : { exitCode: 0, stdout: "Usage: dsh [options]\n", stderr: "" };
      },
    });

    expect(receipt).toMatchObject({
      backendId: "dsh-cli",
      configuredCommand: command,
      selectedPath: command,
      observedVersion: "0.1.0-rc.2",
      versionProbeStatus: "passed",
      helpProbeStatus: "passed",
      callable: true,
      readiness: true,
      lifecycle: "one-shot",
      evidence: { providerCalls: 0, modelInferenceCalls: 0, paidSpendUsd: 0 },
    });
    expect(calls).toEqual([[command, "--version"], [command, "--help"]]);
  });

  test("rejects non-help stdout from a successful help probe", async () => {
    const command = join(dir, "dsh");
    await writeExecutable(command);

    const receipt = await inspectDshReadiness({
      backendId: "dsh-cli",
      command,
      cwd: dir,
      runCommand: async ({ cmd }) => ({
        exitCode: 0,
        stdout: cmd.at(-1) === "--version" ? "dsh 0.1.0-rc.2\n" : "provider request accepted\n",
        stderr: "",
      }),
    });

    expect(receipt.versionProbeStatus).toBe("passed");
    expect(receipt.helpProbeStatus).toBe("failed");
    expect(receipt.readiness).toBe(false);
  });

  test("returns bounded redacted receipts for unavailable and malformed probes", async () => {
    const missing = await inspectDshReadiness({
      backendId: "dsh-cli",
      command: join(dir, "missing-dsh"),
      cwd: dir,
    });
    expect(missing).toMatchObject({
      installationState: "missing",
      callable: false,
      readiness: false,
      lifecycle: "one-shot",
    });

    const command = join(dir, "dsh");
    await writeExecutable(command);
    const malformed = await inspectDshReadiness({
      backendId: "dsh-cli",
      command,
      cwd: dir,
      runCommand: async ({ cmd }) => ({
        exitCode: cmd.at(-1) === "--help" ? 0 : 0,
        stdout: cmd.at(-1) === "--help" ? "   " : `not-a-version token=readiness-secret ${"x".repeat(20_000)}`,
        stderr: "Authorization: Bearer readiness-secret",
      }),
    });
    expect(malformed.versionProbeStatus).toBe("failed");
    expect(malformed.helpProbeStatus).toBe("failed");
    expect(malformed.readiness).toBe(false);
    expect(JSON.stringify(malformed)).not.toContain("readiness-secret");
    expect(JSON.stringify(malformed).length).toBeLessThan(12_000);
  });

  test("returns deterministic receipts for timeout, spawn failure, and nonzero probes", async () => {
    const command = join(dir, "dsh");
    await writeExecutable(command);
    const cases: Array<{ name: string; runCommand: (input: { cmd: string[] }) => Promise<{ exitCode: number; stdout: string; stderr: string }> }> = [
      {
        name: "timeout",
        runCommand: async () => ({ exitCode: 124, stdout: "", stderr: "command timed out token=timeout-secret" }),
      },
      {
        name: "nonzero",
        runCommand: async () => ({ exitCode: 9, stdout: "", stderr: "token=private-secret" }),
      },
    ];

    for (const testCase of cases) {
      const receipt = await inspectDshReadiness({
        backendId: "dsh-cli",
        command,
        cwd: dir,
        runCommand: testCase.runCommand,
      });
      expect(receipt.readiness, testCase.name).toBe(false);
      expect(JSON.stringify(receipt), testCase.name).not.toContain("secret");
      expect(JSON.stringify(receipt).length, testCase.name).toBeLessThan(12_000);
    }

    const spawnFailure = await inspectDshReadiness({
      backendId: "dsh-cli",
      command,
      cwd: dir,
      runCommand: async () => {
        throw new Error("spawn failed Authorization: Bearer spawn-secret");
      },
    });
    expect(spawnFailure.readiness).toBe(false);
    expect(JSON.stringify(spawnFailure)).not.toContain("spawn-secret");
  });
});

async function writeExecutable(path: string) {
  await mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await writeFile(path, "#!/bin/sh\nexit 0\n");
  await chmod(path, 0o755);
}

function _receiptTypeCheck(receipt: DshReadinessReceipt) {
  return receipt;
}
