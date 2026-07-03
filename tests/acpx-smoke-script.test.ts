import { describe, expect, test } from "bun:test";

import { buildAgentMatrix, doctorAgent, parseAgentOutput, runSmokeMatrix } from "../scripts/acpx-agent-smoke";

describe("acpx agent smoke script", () => {
  test("builds the supported agent matrix", () => {
    const matrix = buildAgentMatrix();

    expect(matrix.map((agent) => agent.id)).toEqual([
      "codex",
      "claude-code",
    ]);
    expect(matrix.every((agent) => agent.experimental === false)).toBe(true);
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

  test("parses final Orbs JSON after acpx streaming tool output", () => {
    const output = `[client] initialize (running)
[tool] pwd (completed)
  input: {}
  output:
    /tmp/orbs-acpx-smoke
{
  "status": "done",
  "summary": "smoke ok",
  "changedFiles": [],
  "checks": [
    { "name": "cwd", "status": "passed" },
    { "name": "read-only prompt", "status": "passed" },
    { "name": "final Orbs JSON", "status": "passed" }
  ],
  "artifacts": [],
  "problems": []
}
[done] end_turn`;

    expect(parseAgentOutput(output)).toMatchObject({
      status: "done",
      summary: "smoke ok",
      checks: [
        { name: "cwd", status: "passed" },
        { name: "read-only prompt", status: "passed" },
        { name: "final Orbs JSON", status: "passed" },
      ],
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

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      agent: "codex",
      status: "skipped",
      experimental: false,
      artifacts: [],
    });
    expect(results[0].diagnostics).toEqual(
      expect.arrayContaining(["missing command: acpx", "missing command: codex", expect.stringMatching(/^child PATH: /)]),
    );
  });

  test("validates cwd, read-only prompt, final JSON parsing, and diagnostics", async () => {
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
        return {
          exitCode: 0,
          stdout: '{"status":"done","summary":"smoke ok","changedFiles":[],"checks":[{"name":"cwd","status":"passed"},{"name":"read-only prompt","status":"passed"},{"name":"final Orbs JSON","status":"passed"}],"artifacts":[],"problems":[]}',
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
    expect(results[0].artifacts).toContain("scope: one-shot acpx exec smoke; write workloads remain disabled");
    expect(calls.map((call) => call.cmd)).toEqual([
      [
        "acpx",
        "--cwd",
        "/tmp/orbs-smoke-test",
        "--auth-policy",
        "fail",
        "--approve-reads",
        "--non-interactive-permissions",
        "fail",
        "--format",
        "text",
        "codex",
        "exec",
      ],
    ]);
    expect(calls[0].stdin).toContain("Return only final Orbs JSON");
    expect(calls[0].stdin).toContain("/tmp/orbs-smoke-test");
    expect(calls[0].stdin).toContain("Do not write, edit, delete, move, or create files.");
  });

  test("skips claude-code when the local ACP adapter is unavailable offline", async () => {
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
      adapterAvailable: async () => "missing local npm package: @agentclientprotocol/claude-agent-acp@^0.36.1",
      runCommand: async () => {
        throw new Error("must not initialize ACP without the local adapter");
      },
    });

    expect(results).toEqual([
      {
        agent: "claude-code",
        status: "skipped",
        experimental: false,
        artifacts: [],
        diagnostics: ["missing local npm package: @agentclientprotocol/claude-agent-acp@^0.36.1"],
      },
    ]);
  });

  test("passes Claude Code doctor without starting a prompt smoke", async () => {
    const calls: string[][] = [];
    const result = await doctorAgent("claude-code", {
      commandPath: async (command) => {
        if (command === "acpx") {
          return "/opt/homebrew/bin/acpx";
        }
        if (command === "claude") {
          return "/Users/ghostcorn/.nvm/versions/node/v25.5.0/bin/claude";
        }
        return null;
      },
      adapterAvailable: async (agent) => {
        expect(agent.id).toBe("claude-code");
        return null;
      },
      runCommand: async ({ cmd }) => {
        calls.push(cmd);
        if (cmd.join(" ") === "acpx config show --format json") {
          return { exitCode: 0, stdout: '{"authMethods":["custom"]}', stderr: "" };
        }
        throw new Error(`unexpected command: ${cmd.join(" ")}`);
      },
    });

    expect(calls).toEqual([["acpx", "config", "show", "--format", "json"]]);
    expect(result).toMatchObject({
      agent: "claude-code",
      status: "passed",
      experimental: false,
      diagnostics: [expect.stringMatching(/^child PATH: /)],
      artifacts: expect.arrayContaining([
        "acpx: /opt/homebrew/bin/acpx",
        "agent: claude-code",
        "acpx agent: claude",
        "raw agentCommand: n/a",
        "claude: /Users/ghostcorn/.nvm/versions/node/v25.5.0/bin/claude",
        "adapter: available",
        "acpx authMethods: custom",
        "scope: ACP/acpx doctor only; no task session, prompt smoke, or write probe enabled",
      ]),
    });
  });

  test("skips Claude Code doctor when the offline ACP adapter is unavailable", async () => {
    const result = await doctorAgent("claude-code", {
      commandPath: async (command) => {
        if (command === "acpx") {
          return "/opt/homebrew/bin/acpx";
        }
        if (command === "claude") {
          return "/Users/ghostcorn/.nvm/versions/node/v25.5.0/bin/claude";
        }
        return null;
      },
      adapterAvailable: async () => "missing local npm package: @agentclientprotocol/claude-agent-acp@^0.36.1",
      runCommand: async ({ cmd }) => {
        if (cmd.join(" ") === "acpx config show --format json") {
          return { exitCode: 0, stdout: '{"authMethods":[]}', stderr: "" };
        }
        throw new Error(`unexpected command: ${cmd.join(" ")}`);
      },
    });

    expect(result.status).toBe("skipped");
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        "missing local npm package: @agentclientprotocol/claude-agent-acp@^0.36.1",
      ]),
    );
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
      adapterAvailable: async () => null,
      makeTempCwd: async () => "/tmp/orbs-smoke-test",
      cleanupTempCwd: async () => undefined,
      runCommand: async () => {
        return { exitCode: 0, stdout: "not json", stderr: "auth required; token=secret" };
      },
    });

    expect(results[0].status).toBe("failed");
    expect(results[0].diagnostics.join("\n")).toContain("agent output did not contain a JSON object");
    expect(results[0].diagnostics.join("\n")).not.toContain("secret");
  });
});
