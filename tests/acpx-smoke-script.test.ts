import { describe, expect, test } from "bun:test";

import { buildAgentMatrix, parseAgentOutput, runSmokeMatrix } from "../scripts/acpx-agent-smoke";

describe("acpx agent smoke script", () => {
  test("builds optional agent matrix with experimental non-builtins", () => {
    const matrix = buildAgentMatrix();

    expect(matrix.map((agent) => agent.id)).toEqual([
      "codex",
      "claude-code",
      "opencode",
      "openclaw",
      "hermes",
      "reasonix",
    ]);
    expect(matrix.find((agent) => agent.id === "openclaw")?.experimental).toBe(true);
    expect(matrix.find((agent) => agent.id === "hermes")?.experimental).toBe(true);
    expect(matrix.find((agent) => agent.id === "reasonix")?.experimental).toBe(true);
  });

  test("parses final Orbs JSON from noisy agent output", () => {
    expect(
      parseAgentOutput('notes\n```json\n{"status":"done","summary":"ok","changedFiles":[],"checks":[{"name":"cwd","status":"passed"}],"artifacts":[],"problems":[]}\n```'),
    ).toMatchObject({
      status: "done",
      summary: "ok",
      checks: [{ name: "cwd", status: "passed" }],
    });
  });

  test("skips agents when required commands are unavailable", async () => {
    const results = await runSmokeMatrix({
      agents: [
        {
          id: "codex",
          acpxAgent: "codex",
          requiredCommands: ["codex"],
          experimental: false,
        },
      ],
      commandExists: async () => false,
      runCommand: async () => {
        throw new Error("must not run unavailable agent");
      },
    });

    expect(results).toEqual([
      {
        agent: "codex",
        status: "skipped",
        experimental: false,
        diagnostics: ["missing command: acpx", "missing command: codex"],
      },
    ]);
  });

  test("validates cwd, session creation, final JSON parsing, and diagnostics", async () => {
    const calls: Array<{ cmd: string[]; stdin: string; cwd?: string }> = [];
    const results = await runSmokeMatrix({
      agents: [
        {
          id: "codex",
          acpxAgent: "codex",
          requiredCommands: ["codex"],
          experimental: false,
        },
      ],
      commandExists: async () => true,
      makeTempCwd: async () => "/tmp/orbs-smoke-test",
      cleanupTempCwd: async () => undefined,
      runCommand: async ({ cmd, stdin, cwd }) => {
        calls.push({ cmd, stdin, cwd });
        if (cmd.includes("ensure")) {
          return { exitCode: 0, stdout: "session ensured", stderr: "" };
        }
        return {
          exitCode: 0,
          stdout: '{"status":"done","summary":"smoke ok","changedFiles":[],"checks":[{"name":"cwd","status":"passed"},{"name":"session","status":"passed"}],"artifacts":[],"problems":[]}',
          stderr: "",
        };
      },
    });

    expect(results[0]).toMatchObject({
      agent: "codex",
      status: "passed",
      experimental: false,
      summary: "smoke ok",
    });
    expect(calls.map((call) => call.cmd)).toEqual([
      [
        "acpx",
        "--cwd",
        "/tmp/orbs-smoke-test",
        "--auth-policy",
        "fail",
        "--deny-all",
        "--non-interactive-permissions",
        "deny",
        "--format",
        "text",
        "codex",
        "sessions",
        "ensure",
        "--name",
        "orbs-smoke-codex",
      ],
      [
        "acpx",
        "--cwd",
        "/tmp/orbs-smoke-test",
        "--auth-policy",
        "fail",
        "--deny-all",
        "--non-interactive-permissions",
        "deny",
        "--format",
        "text",
        "codex",
        "-s",
        "orbs-smoke-codex",
      ],
    ]);
    expect(calls[1].stdin).toContain("Return only final Orbs JSON");
    expect(calls[1].stdin).toContain("/tmp/orbs-smoke-test");
  });

  test("reports command and JSON failures without credentials", async () => {
    const results = await runSmokeMatrix({
      agents: [
        {
          id: "claude-code",
          acpxAgent: "claude",
          requiredCommands: ["claude"],
          experimental: false,
        },
      ],
      commandExists: async () => true,
      makeTempCwd: async () => "/tmp/orbs-smoke-test",
      cleanupTempCwd: async () => undefined,
      runCommand: async ({ cmd }) => {
        if (cmd.includes("ensure")) {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        return { exitCode: 0, stdout: "not json", stderr: "auth required; token=secret" };
      },
    });

    expect(results[0].status).toBe("failed");
    expect(results[0].diagnostics.join("\n")).toContain("agent output did not contain a JSON object");
    expect(results[0].diagnostics.join("\n")).not.toContain("secret");
  });
});
