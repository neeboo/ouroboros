import { describe, expect, test } from "bun:test";
import { runLocalCommand } from "../packages/runner/src";

describe("command runner", () => {
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
      idleTimeoutMs: 20,
    });

    expect(result.exitCode).toBe(124);
    expect(result.stdout).toContain("started");
    expect(result.stderr).toContain("idle timed out");
  });
});
