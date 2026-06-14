import { describe, expect, test } from "bun:test";
import { proxyEnvForChildProcess, proxyEnvFromScutilOutput, runLocalCommand } from "../packages/runner/src";

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

  test("keeps explicit proxy env unchanged", () => {
    const env = proxyEnvForChildProcess({
      PATH: "/bin",
      HTTPS_PROXY: "http://manual.proxy:8080",
    });

    expect(env.HTTPS_PROXY).toBe("http://manual.proxy:8080");
    expect(env.PATH).toBe("/bin");
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
