import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  childToolchainEnvEvidence,
  descendantPidsFromPsOutputForTest,
  proxyEnvForChildProcess,
  proxyEnvFromScutilOutput,
  runLocalCommand,
} from "../packages/runner/src";

const testHome = "/tmp/ouroboros-test-home";
const testBunPath = `${testHome}/.bun/bin`;
const testLocalBinPath = `${testHome}/.local/bin`;

describe("command runner", () => {
  test("builds proxy env from macOS system proxy output", () => {
    const env = proxyEnvFromScutilOutput([
      "<dictionary> {",
      "  ExceptionsList : <array> {",
      "    0 : 127.0.0.1",
      "    1 : localhost",
      "  }",
      "  HTTPEnable : 1",
      "  HTTPPort : 7893",
      "  HTTPProxy : 127.0.0.1",
      "  HTTPSEnable : 1",
      "  HTTPSPort : 7893",
      "  HTTPSProxy : 127.0.0.1",
      "  SOCKSEnable : 1",
      "  SOCKSPort : 7893",
      "  SOCKSProxy : 127.0.0.1",
      "}",
    ].join("\n"));

    expect(env.HTTP_PROXY).toBe("http://127.0.0.1:7893");
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:7893");
    expect(env.ALL_PROXY).toBe("socks5://127.0.0.1:7893");
    expect(env.NO_PROXY).toContain("localhost");
    expect(env.no_proxy).toBe(env.NO_PROXY);
  });

  test("normalizes developer PATH while keeping explicit proxy env", () => {
    const env = proxyEnvForChildProcess({
      PATH: "/bin",
      HOME: testHome,
      HTTPS_PROXY: "http://manual.proxy:8080",
    });

    expect(env.HTTPS_PROXY).toBe("http://manual.proxy:8080");
    expect(env.PATH?.split(":").slice(0, 8)).toEqual([
      testBunPath,
      testLocalBinPath,
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ]);
    expect(env.PATH?.split(":").filter((entry) => entry === "/bin")).toHaveLength(1);
  });

  test("reports sanitized toolchain env evidence", () => {
    const env = proxyEnvForChildProcess({
      PATH: "/bin",
      HOME: testHome,
      HTTPS_PROXY: "http://manual.proxy:8080",
    });
    const evidence = childToolchainEnvEvidence(env);
    const path = env.PATH;
    if (typeof path !== "string") {
      throw new Error("expected normalized PATH");
    }

    expect(evidence.PATH).toBe(path);
    expect(Object.keys(evidence)).toEqual(["PATH", "tools"]);
    expect(evidence.tools).toEqual({
      bun: expect.any(Object),
      node: expect.any(Object),
      npm: expect.any(Object),
      npx: expect.any(Object),
    });
  });

  test("keeps caller shims before normalized developer PATH entries", () => {
    const env = proxyEnvForChildProcess({
      PATH: "/tmp/test-bin:/usr/bin:/bin",
      HOME: testHome,
    });

    expect(env.PATH?.split(":").slice(0, 5)).toEqual([
      "/tmp/test-bin",
      testBunPath,
      testLocalBinPath,
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ]);
  });

  test("adds local nvm node bins to child PATH with newest versions first", () => {
    const home = mkdtempSync(join(tmpdir(), "orbs-nvm-home-"));
    try {
      mkdirSync(join(home, ".nvm/versions/node/v18.20.0/bin"), { recursive: true });
      mkdirSync(join(home, ".nvm/versions/node/v22.13.0/bin"), { recursive: true });

      const env = proxyEnvForChildProcess({
        PATH: "/usr/bin:/bin",
        HOME: home,
      });

      expect(env.PATH?.split(":").slice(0, 5)).toEqual([
        join(home, ".bun/bin"),
        join(home, ".local/bin"),
        join(home, ".nvm/versions/node/v22.13.0/bin"),
        join(home, ".nvm/versions/node/v18.20.0/bin"),
        "/opt/homebrew/bin",
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("normalizes developer PATH from a clean low-PATH process environment", () => {
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "--cwd",
        process.cwd(),
        "-e",
        [
          'import { childEnvForProcess } from "./packages/runner/src/executors/proxy-env";',
          `const env = childEnvForProcess({ HOME: ${JSON.stringify(testHome)}, PATH: "/tmp" });`,
          `console.log(JSON.stringify({ path: env.PATH, hasBun: env.PATH?.split(":").includes(${JSON.stringify(testBunPath)}), hasLocalBin: env.PATH?.split(":").includes(${JSON.stringify(testLocalBinPath)}) }));`,
        ].join("\n"),
      ],
      env: {
        HOME: testHome,
        PATH: "/tmp",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stderr)).toBe("");
    expect(JSON.parse(new TextDecoder().decode(result.stdout))).toEqual({
      path: expect.stringContaining(testBunPath),
      hasBun: true,
      hasLocalBin: true,
    });
  });

  test("returns a timeout result when a command runs too long", async () => {
    const result = await runLocalCommand({
      cmd: ["bun", "-e", "await new Promise((resolve) => setTimeout(resolve, 1000));"],
      stdin: "",
      timeoutMs: 10,
    });

    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain("timed out");
  });

  test("cleans up the process tree when a command failure requests cleanup", async () => {
    const cleanedPids: number[] = [];

    const result = await runLocalCommand({
      cmd: ["bun", "-e", "process.exit(7);"],
      stdin: "",
      cleanupOnFailure: true,
      cleanupProcessTree: async (pid) => {
        cleanedPids.push(pid);
      },
    });

    expect(result.exitCode).toBe(7);
    expect(cleanedPids).toHaveLength(1);
    expect(cleanedPids[0]).toBeGreaterThan(0);
  });

  test("discovers nested child process trees from ps output", () => {
    const output = [
      " 100 1 10",
      " 200 100 200",
      " 300 200 200",
      " 400 1 400",
      " 500 200 500",
      " 600 500 500",
    ].join("\n");

    expect(descendantPidsFromPsOutputForTest(output, 100)).toEqual([200, 300, 500, 600]);
  });

  test("keeps a command alive while it continues producing output", async () => {
    const result = await runLocalCommand({
      cmd: [
        "bun",
        "-e",
        [
          "for (let index = 0; index < 5; index += 1) {",
          "  console.log(`tick ${index}`);",
          "  await new Promise((resolve) => setTimeout(resolve, 20));",
          "}",
        ].join("\n"),
      ],
      stdin: "",
      timeoutMs: 1000,
      idleTimeoutMs: 40,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("tick 0");
    expect(result.stdout).toContain("tick 4");
  });

  test("returns partial output when a command goes idle", async () => {
    const result = await runLocalCommand({
      cmd: ["bun", "-e", "console.log('started'); await new Promise((resolve) => setTimeout(resolve, 1000));"],
      stdin: "",
      timeoutMs: 1000,
      idleTimeoutMs: 80,
    });

    expect(result.exitCode).toBe(124);
    expect(result.stdout).toContain("started");
    expect(result.stderr).toContain("idle timed out");
  });

  test("notifies stdout and stderr chunks while the command is running", async () => {
    const chunks: string[] = [];

    const result = await runLocalCommand({
      cmd: [
        "bun",
        "-e",
        [
          "console.log('first');",
          "console.error('warn');",
          "await new Promise((resolve) => setTimeout(resolve, 20));",
          "console.log('second');",
        ].join("\n"),
      ],
      stdin: "",
      onStdout: (chunk) => chunks.push(`stdout:${chunk.trim()}`),
      onStderr: (chunk) => chunks.push(`stderr:${chunk.trim()}`),
    });

    expect(result.exitCode).toBe(0);
    expect(chunks).toContain("stdout:first");
    expect(chunks).toContain("stderr:warn");
    expect(chunks).toContain("stdout:second");
  });
});
