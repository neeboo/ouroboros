import { describe, expect, test } from "bun:test";

import { buildAgentMatrix, doctorHermes, parseAgentOutput, runSmokeMatrix } from "../scripts/acpx-agent-smoke";

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

  test("reports Hermes doctor diagnostics without starting ACP when hermes is missing", async () => {
    const result = await doctorHermes({
      commandPath: async (command) => (command === "acpx" ? "/opt/homebrew/bin/acpx" : null),
      runCommand: async () => {
        throw new Error("must not start Hermes ACP checks without a Hermes command");
      },
    });

    expect(result).toMatchObject({
      agent: "hermes",
      status: "skipped",
      experimental: true,
      artifacts: expect.arrayContaining([
        "acpx: /opt/homebrew/bin/acpx",
        "hermes: missing",
        "hermes-acp: missing",
        "selected raw agentCommand: hermes acp",
        "scope: Hermes ACP/acpx doctor only; no write probe or worker default enabled",
        expect.stringMatching(/^child PATH: /),
      ]),
    });
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        "missing command: hermes",
        "missing command: hermes-acp",
        "setup blocker: install Hermes CLI or expose hermes/hermes-acp on the normalized child PATH",
        expect.stringMatching(/^child PATH: /),
      ]),
    );
  });

  test("selects hermes-acp only when discovery proves it is the available Hermes command", async () => {
    const result = await doctorHermes({
      commandPath: async (command) => {
        if (command === "acpx") {
          return "/opt/homebrew/bin/acpx";
        }
        if (command === "hermes-acp") {
          return "/opt/homebrew/bin/hermes-acp";
        }
        return null;
      },
      runCommand: async ({ cmd }) => {
        if (cmd.join(" ") === "acpx config show --format json") {
          return { exitCode: 0, stdout: '{"authMethods":["custom"]}', stderr: "" };
        }
        throw new Error(`unexpected command: ${cmd.join(" ")}`);
      },
    });

    expect(result).toMatchObject({
      agent: "hermes",
      status: "skipped",
      artifacts: expect.arrayContaining([
        "acpx: /opt/homebrew/bin/acpx",
        "hermes: missing",
        "hermes-acp: /opt/homebrew/bin/hermes-acp",
        "selected raw agentCommand: hermes-acp",
        "Hermes ACP check: skipped",
        "acpx authMethods: custom",
      ]),
      diagnostics: expect.arrayContaining([
        "Hermes ACP check skipped: hermes-acp was discovered without hermes; verify the adapter command manually before enabling execution",
      ]),
    });
  });

  test("reports Hermes ACP check success and missing acpx auth as the real setup blocker", async () => {
    const calls: string[][] = [];
    const result = await doctorHermes({
      commandPath: async (command) => {
        if (command === "acpx") {
          return "/opt/homebrew/bin/acpx";
        }
        if (command === "hermes") {
          return "/Users/ghostcorn/.local/bin/hermes";
        }
        return null;
      },
      runCommand: async ({ cmd }) => {
        calls.push(cmd);
        if (cmd.join(" ") === "hermes acp --check") {
          return { exitCode: 0, stdout: "Hermes ACP check OK\n", stderr: "" };
        }
        if (cmd.join(" ") === "acpx config show --format json") {
          return { exitCode: 0, stdout: '{"authMethods":[]}', stderr: "" };
        }
        throw new Error(`unexpected command: ${cmd.join(" ")}`);
      },
    });

    expect(calls).toEqual([
      ["hermes", "acp", "--check"],
      ["acpx", "config", "show", "--format", "json"],
    ]);
    expect(result.artifacts).toEqual(
      expect.arrayContaining([
        "hermes: /Users/ghostcorn/.local/bin/hermes",
        "Hermes ACP check: passed",
        "acpx authMethods: none",
      ]),
    );
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        "missing command: hermes-acp",
        "setup blocker: acpx auth missing for Hermes; add auth.custom or auth.hermes-setup, or export ACPX_AUTH_CUSTOM / ACPX_AUTH_HERMES_SETUP",
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
