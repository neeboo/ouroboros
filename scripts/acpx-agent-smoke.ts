#!/usr/bin/env bun

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { childEnvForProcess } from "../packages/runner/src/executors/proxy-env";
import { parseAttemptOutput } from "../packages/runner/src/executors/output";

type AgentId = "codex" | "claude-code" | "opencode" | "openclaw" | "hermes" | "reasonix";

export type SmokeAgent = {
  id: AgentId;
  requiredCommands: string[];
  experimental: boolean;
  acpxAgent?: string;
  rawAgentCommand?: string;
};

export type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type RunCommandInput = {
  cmd: string[];
  stdin: string;
  cwd?: string;
  timeoutMs?: number;
};

export type SmokeResult = {
  agent: AgentId;
  status: "passed" | "failed" | "skipped";
  experimental: boolean;
  summary?: string;
  artifacts: string[];
  diagnostics: string[];
};

export type RunSmokeMatrixOptions = {
  agents?: SmokeAgent[];
  commandExists?: (command: string) => Promise<boolean>;
  adapterAvailable?: (agent: SmokeAgent) => Promise<string | null>;
  runCommand?: (input: RunCommandInput) => Promise<CommandResult>;
  makeTempCwd?: () => Promise<string>;
  cleanupTempCwd?: (cwd: string) => Promise<void>;
  timeoutMs?: number;
};

export type HermesDoctorOptions = {
  commandPath?: (command: string) => Promise<string | null>;
};

export function buildAgentMatrix(): SmokeAgent[] {
  return [
    { id: "codex", acpxAgent: "codex", requiredCommands: ["codex"], experimental: false },
    { id: "claude-code", acpxAgent: "claude", requiredCommands: ["claude"], experimental: false },
    { id: "opencode", acpxAgent: "opencode", requiredCommands: ["opencode"], experimental: false },
    { id: "openclaw", acpxAgent: "openclaw", requiredCommands: ["openclaw"], experimental: true },
    { id: "hermes", rawAgentCommand: "hermes acp", requiredCommands: ["hermes"], experimental: true },
    { id: "reasonix", rawAgentCommand: "reasonix acp", requiredCommands: ["reasonix"], experimental: true },
  ];
}

export function parseAgentOutput(raw: string) {
  return parseAttemptOutput(raw);
}

export async function runSmokeMatrix(options: RunSmokeMatrixOptions = {}): Promise<SmokeResult[]> {
  const agents = options.agents ?? buildAgentMatrix();
  const commandExists = options.commandExists ?? defaultCommandExists;
  const adapterAvailable = options.adapterAvailable ?? defaultAdapterAvailable;
  const runCommand = options.runCommand ?? defaultRunCommand;
  const makeTempCwd = options.makeTempCwd ?? defaultMakeTempCwd;
  const cleanupTempCwd = options.cleanupTempCwd ?? defaultCleanupTempCwd;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const results: SmokeResult[] = [];

  for (const agent of agents) {
    const missing = await missingCommands(agent, commandExists);
    if (missing.length > 0) {
      const env = childEnvForProcess();
      results.push({
        agent: agent.id,
        status: "skipped",
        experimental: agent.experimental,
        artifacts: [],
        diagnostics: [...missing.map((command) => `missing command: ${command}`), `child PATH: ${env.PATH ?? ""}`],
      });
      continue;
    }

    const adapterProblem = await adapterAvailable(agent);
    if (adapterProblem) {
      results.push({
        agent: agent.id,
        status: "skipped",
        experimental: agent.experimental,
        artifacts: [],
        diagnostics: [adapterProblem],
      });
      continue;
    }

    const cwd = await makeTempCwd();
    try {
      results.push(await smokeAgent({ agent, cwd, runCommand, timeoutMs }));
    } finally {
      await cleanupTempCwd(cwd);
    }
  }

  return results;
}

export async function doctorHermes(options: HermesDoctorOptions = {}): Promise<SmokeResult> {
  const commandPath = options.commandPath ?? defaultCommandPath;
  const env = childEnvForProcess();
  const [acpx, hermes, hermesAcp] = await Promise.all([commandPath("acpx"), commandPath("hermes"), commandPath("hermes-acp")]);
  const selectedRawAgentCommand = hermes ? "hermes acp" : hermesAcp ? "hermes-acp" : "hermes acp";
  const diagnostics = [`child PATH: ${env.PATH ?? ""}`];

  if (!acpx) {
    diagnostics.push("missing command: acpx");
  }
  if (!hermes) {
    diagnostics.push("missing command: hermes");
  }
  if (!hermesAcp) {
    diagnostics.push("missing command: hermes-acp");
  }
  if (!hermes && !hermesAcp) {
    diagnostics.push("setup blocker: install Hermes CLI or expose hermes/hermes-acp on the normalized child PATH");
  } else {
    diagnostics.push("auth/model/setup blocker: Hermes CLI discovered; run Hermes auth/model setup before enabling execution");
  }

  return {
    agent: "hermes",
    status: "skipped",
    experimental: true,
    artifacts: [
      `child PATH: ${env.PATH ?? ""}`,
      `acpx: ${acpx ?? "missing"}`,
      `hermes: ${hermes ?? "missing"}`,
      `hermes-acp: ${hermesAcp ?? "missing"}`,
      `selected raw agentCommand: ${selectedRawAgentCommand}`,
      "scope: Hermes ACP/acpx doctor only; no write probe or worker default enabled",
    ].map(redact),
    diagnostics: diagnostics.map(redact),
  };
}

async function smokeAgent(input: {
  agent: SmokeAgent;
  cwd: string;
  runCommand: (input: RunCommandInput) => Promise<CommandResult>;
  timeoutMs: number;
}): Promise<SmokeResult> {
  const base = acpxBaseCommand(input.agent, input.cwd);
  const prompt = smokePrompt(input.cwd, input.agent);
  const response = await input.runCommand({
    cmd: [...base, "exec"],
    stdin: prompt,
    cwd: input.cwd,
    timeoutMs: input.timeoutMs,
  });
  if (response.exitCode !== 0) {
    return failed(input.agent, ["prompt failed", commandDiagnostic(response)]);
  }

  try {
    const parsed = parseAgentOutput(response.stdout);
    const checks = Array.isArray(parsed.checks) ? parsed.checks : [];
    const hasCwdCheck = checks.some((check) => hasPassedCheck(check, "cwd"));
    const hasReadOnlyCheck = checks.some((check) => hasPassedCheck(check, "read-only prompt"));
    const hasJsonCheck = checks.some((check) => hasPassedCheck(check, "final Orbs JSON"));
    if (parsed.status !== "done" || !hasCwdCheck || !hasReadOnlyCheck || !hasJsonCheck) {
      return failed(input.agent, [
        "final Orbs JSON must be done and include passed cwd, read-only prompt, and final Orbs JSON checks",
        `parsed summary: ${parsed.summary}`,
      ]);
    }
    return {
      agent: input.agent.id,
      status: "passed",
      experimental: input.agent.experimental,
      summary: redact(parsed.summary),
      artifacts: [
        `cwd: ${input.cwd}`,
        `command: ${redact([...base, "exec"].join(" "))}`,
        "scope: one-shot acpx exec smoke; write workloads remain disabled",
      ],
      diagnostics: [],
    };
  } catch (error) {
    return failed(input.agent, [
      error instanceof Error ? error.message : String(error),
      `stdout: ${redact(response.stdout)}`,
      `stderr: ${redact(response.stderr)}`,
    ]);
  }
}

function acpxBaseCommand(agent: SmokeAgent, cwd: string) {
  const base = [
    "acpx",
    "--cwd",
    cwd,
    "--auth-policy",
    "fail",
    "--approve-reads",
    "--non-interactive-permissions",
    "fail",
    "--format",
    "text",
  ];
  if (agent.rawAgentCommand) {
    return [...base, "--agent", agent.rawAgentCommand];
  }
  return [...base, agent.acpxAgent ?? agent.id];
}

function smokePrompt(cwd: string, agent: SmokeAgent) {
  return `Return only final Orbs JSON. Do not use secrets, do not print environment variables, and do not modify files.

Smoke-test agent backend: ${agent.id}
Expected cwd: ${cwd}

Validate that the working directory provided to the ACP session is the expected cwd. Do not write, edit, delete, move, or create files. If cwd cannot be validated without writes, return status "blocked" with a short diagnostic.

Use exactly this JSON shape:
{
  "status": "done",
  "summary": "short smoke-test result",
  "changedFiles": [],
  "checks": [
    { "name": "cwd", "status": "passed" },
    { "name": "read-only prompt", "status": "passed" },
    { "name": "final Orbs JSON", "status": "passed" }
  ],
  "artifacts": [],
  "problems": []
}`;
}

async function missingCommands(agent: SmokeAgent, commandExists: (command: string) => Promise<boolean>) {
  const commands = ["acpx", ...agent.requiredCommands];
  const missing: string[] = [];
  for (const command of commands) {
    if (!(await commandExists(command))) {
      missing.push(command);
    }
  }
  return missing;
}

async function defaultCommandExists(command: string) {
  return (await defaultCommandPath(command)) !== null;
}

async function defaultCommandPath(command: string) {
  const result = await defaultRunCommand({ cmd: ["which", command], stdin: "" });
  if (result.exitCode !== 0) {
    return null;
  }
  const path = result.stdout.trim().split("\n")[0]?.trim();
  return path && path.length > 0 ? path : null;
}

async function defaultAdapterAvailable(agent: SmokeAgent) {
  if (agent.id !== "claude-code") {
    return null;
  }
  const result = await defaultRunCommand({
    cmd: ["npm", "exec", "--offline", "--package", "@agentclientprotocol/claude-agent-acp@^0.36.1", "--", "claude-agent-acp", "--help"],
    stdin: "",
    timeoutMs: 20_000,
  });
  if (result.exitCode === 0) {
    return null;
  }
  return [
    "missing local npm package: @agentclientprotocol/claude-agent-acp@^0.36.1",
    "Claude Code smoke skipped before ACP initialization to avoid network-dependent npm fetch",
    commandDiagnostic(result),
  ].join("\n");
}

async function defaultRunCommand(input: RunCommandInput): Promise<CommandResult> {
  const proc = Bun.spawn(input.cmd, {
    cwd: input.cwd,
    env: childEnvForProcess(),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (input.stdin.length > 0) {
    proc.stdin.write(input.stdin);
  }
  proc.stdin.end();

  const timeout = input.timeoutMs === undefined ? null : setTimeout(() => proc.kill(), input.timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function defaultMakeTempCwd() {
  const cwd = await mkdtemp(join(tmpdir(), "orbs-acpx-smoke-"));
  await writeFile(join(cwd, "README.md"), "Temporary Orbs ACP smoke-test workspace.\n");
  return cwd;
}

async function defaultCleanupTempCwd(cwd: string) {
  await rm(cwd, { recursive: true, force: true });
}

function failed(agent: SmokeAgent, diagnostics: string[]): SmokeResult {
  return {
    agent: agent.id,
    status: "failed",
    experimental: agent.experimental,
    artifacts: [],
    diagnostics: diagnostics.map(redact),
  };
}

function hasPassedCheck(check: unknown, name: string) {
  if (!check || typeof check !== "object" || Array.isArray(check)) {
    return false;
  }
  const record = check as Record<string, unknown>;
  return record.name === name && record.status === "passed";
}

function commandDiagnostic(result: CommandResult) {
  return redact(`exit code: ${result.exitCode}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

function redact(value: string) {
  return value
    .replace(/(token|api[_-]?key|secret|password|credential)(\s*[=:]\s*)\S+/gi, "$1$2[redacted]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/g, "$1[redacted]");
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const selected = new Set(args.filter((arg) => !arg.startsWith("-")));
  const doctor = args.includes("--doctor") || selected.has("hermes-doctor");
  const results = doctor ? [await doctorHermes()] : await runSmokeMatrix({ agents: selected.size === 0 ? buildAgentMatrix() : buildAgentMatrix().filter((agent) => selected.has(agent.id)) });
  console.log(JSON.stringify({ status: results.some((result) => result.status === "failed") ? "failed" : "done", results }, null, 2));
  process.exitCode = results.some((result) => result.status === "failed" && !result.experimental) ? 1 : 0;
}
