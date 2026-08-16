import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createDshCliExecutor } from "../packages/runner/src";
import type { ResolvedExecutionRoute, RunCommandInput } from "../packages/runner/src";
import { darwinDshHostReadProfile, darwinDshProcessProfile } from "../packages/runner/src/executors/dsh-process-policy";

const runFixture = {
  id: "run_dsh",
  projectId: "project_dsh",
  projectRoot: "/repo",
  goal: "Evaluate DeepSeek Harness",
  status: "todo" as const,
  context: {},
};

const taskFixture = {
  id: "task_dsh",
  runId: "run_dsh",
  parentId: null,
  cycleId: "task_dsh",
  status: "todo" as const,
  role: "worker",
  goal: "Implement a bounded change",
  prompt: "Implement the task.",
  dependsOn: [],
  doneWhen: [],
  config: {},
  worktreePath: "/repo/.ouroboros/worktrees/task_dsh",
  sessionRef: null,
  contextVersion: 1,
};

const routeFixture: ResolvedExecutionRoute = {
  role: "worker",
  backend: {
    id: "deepseek-harness",
    kind: "dsh-cli",
    command: "/opt/deepseek/bin/dsh",
    profile: "headless",
    source: "task",
  },
  model: null,
  executionMode: "generic",
};

function executorInput(prompt = "Implement the bounded task and return the required JSON.") {
  return {
    prompt,
    sessionName: "task_dsh",
    run: runFixture,
    task: taskFixture,
    route: routeFixture,
  };
}

function availableDshResolution() {
  return {
    configuredCommand: "/opt/deepseek/bin/dsh",
    resolutionMode: "explicit" as const,
    selectedPath: "/opt/deepseek/bin/dsh",
    canonicalPath: "/opt/deepseek/bin/dsh",
    installationState: "available" as const,
    callable: true,
    diagnostic: null,
  };
}

describe("DeepSeek Harness CLI executor", () => {
  test("defaults every DSH task to a hashed base-only offline profile receipt", async () => {
    const events: Array<Record<string, unknown>> = [];
    let processPolicy = "";
    const executor = createDshCliExecutor({
      cwd: taskFixture.worktreePath,
      command: "/opt/deepseek/bin/dsh",
      profile: "headless",
      sandbox: "workspace-write",
      env: {
        HODOR_APPLICATION_BASE_URL: "https://production.invalid",
        HODOR_APPLICATION_TOKEN: "must-not-reach-the-task",
        LINEAR_API_KEY: "must-not-reach-the-task",
        DEEPSEEK_API_KEY: "approved-model-key",
      },
      resolveCommand: availableDshResolution,
      runCommand: async (input) => {
        const home = input.env?.DSH_HOME ?? "";
        const profile = JSON.parse(readFileSync(`${home}/profiles/headless/package.json`, "utf8"));
        expect(profile.dsh.profile.bundles).toEqual(["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"]);
        expect(input.env?.HODOR_APPLICATION_BASE_URL).toBeUndefined();
        expect(input.env?.HODOR_APPLICATION_TOKEN).toBeUndefined();
        expect(input.env?.LINEAR_API_KEY).toBeUndefined();
        expect(input.env?.DEEPSEEK_API_KEY).toBe("approved-model-key");
        expect(input.inheritEnv).toBe(false);
        expect(input.cmd.slice(0, 4)).toEqual(["/usr/bin/sandbox-exec", "-p", expect.any(String), "--"]);
        expect(input.cmd[4]).toBe("/opt/deepseek/bin/dsh");
        const patchIndex = input.cmd.indexOf("--patch");
        processPolicy = readFileSync(input.cmd[patchIndex + 1]!, "utf8");
        return {
          exitCode: 0,
          stdout: '{"status":"done","summary":"offline task entered","changedFiles":[],"checks":[],"artifacts":[],"problems":[]}',
          stderr: "",
        };
      },
    });

    const output = await executor({
      ...executorInput(),
      attemptId: "attempt_offline_profile",
      recorder: { stdout() {}, stderr() {}, event: (event) => events.push(event) },
    });

    expect(output.status).toBe("done");
    expect(processPolicy).toContain("networkMode: deny");
    expect(output.artifacts).toContainEqual(expect.objectContaining({
      kind: "dsh_execution_profile_receipt",
      attemptId: "attempt_offline_profile",
      profile: "headless",
      mode: "base-headless",
      enabledPlugins: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"],
      profileSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      profilePatchSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      processPolicyPatchSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      controlPathReadPolicy: "deny",
      deniedControlPathRootsSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      network: { mode: "deny", enforcement: "dsh-sandbox-local" },
      preflight: {
        passed: true,
        projectPluginsLoaded: false,
        ambientCredentialsInherited: false,
        targetCredentialsInherited: false,
        modelCredentialNames: ["DEEPSEEK_API_KEY"],
      },
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "dsh.profile.preflight",
      attemptId: "attempt_offline_profile",
      enabledPlugins: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"],
      controlPathReadPolicy: "deny",
      deniedControlPathRootsSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      networkMode: "deny",
    }));
  });

  test("fails before DSH boot when a task requires project plugins without an explicit host configuration", async () => {
    let calls = 0;
    const executor = createDshCliExecutor({
      cwd: taskFixture.worktreePath,
      command: "/opt/deepseek/bin/dsh",
      profile: "headless",
      sandbox: "workspace-write",
      requiredPlugins: ["@hodor/hodor-project"],
      resolveCommand: availableDshResolution,
      runCommand: async () => {
        calls += 1;
        throw new Error("DSH must not start");
      },
    });

    const output = await executor(executorInput());

    expect(calls).toBe(0);
    expect(output).toMatchObject({
      status: "blocked",
      summary: "DeepSeek Harness project plugins require an explicit host configuration",
    });
    expect(output.problems?.join("\n")).toContain("@hodor/hodor-project");
  });

  test("uses an ephemeral base-only headless profile for fixed DSH repair work", async () => {
    let isolatedHome = "";
    const executor = createDshCliExecutor({
      cwd: taskFixture.worktreePath,
      command: "/opt/deepseek/bin/dsh",
      profile: "headless",
      sandbox: "workspace-write",
      isolatedProfile: "base-headless",
      env: {
        DSH_HOME: "/tmp/polluted-global-dsh-home",
        DEEPSEEK_API_KEY: "host-owned-key-not-written-to-profile",
      },
      resolveCommand: availableDshResolution,
      runCommand: async (input) => {
        isolatedHome = input.env?.DSH_HOME ?? "";
        expect(isolatedHome).not.toBe("/tmp/polluted-global-dsh-home");
        const profile = JSON.parse(readFileSync(`${isolatedHome}/profiles/headless/package.json`, "utf8"));
        expect(profile).toEqual({
          name: "dsh-profile-headless",
          private: true,
          dependencies: {},
          dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"] } },
        });
        expect(readFileSync(`${isolatedHome}/profiles/headless/cordis.patch.yml`, "utf8")).toBe("[]\n");
        expect(JSON.stringify(profile)).not.toContain("hodor");
        expect(JSON.stringify(profile)).not.toContain("host-owned-key");
        return {
          exitCode: 0,
          stdout: '{"status":"done","summary":"isolated repair started","changedFiles":[],"checks":[],"artifacts":[],"problems":[]}',
          stderr: "",
        };
      },
    });

    const output = await executor(executorInput());

    expect(output).toMatchObject({ status: "done", summary: "isolated repair started" });
    expect(isolatedHome).toContain("ouroboros-dsh-");
    expect(existsSync(isolatedHome)).toBe(false);
  });

  test("runs headless DSH in the exact task worktree and parses AttemptOutput", async () => {
    const calls: RunCommandInput[] = [];
    const events: Array<Record<string, unknown>> = [];
    const executor = createDshCliExecutor({
      cwd: taskFixture.worktreePath,
      command: "/opt/deepseek/bin/dsh",
      profile: "headless",
      sandbox: "workspace-write",
      env: { DSH_HOME: "/tmp/dsh-home" },
      resolveCommand: () => ({
        configuredCommand: "/opt/deepseek/bin/dsh",
        resolutionMode: "explicit",
        selectedPath: "/opt/deepseek/bin/dsh",
        canonicalPath: "/opt/deepseek/bin/dsh",
        installationState: "available",
        callable: true,
        diagnostic: null,
      }),
      runCommand: async (input) => {
        calls.push(input);
        return {
          exitCode: 0,
          stdout: '{"status":"done","summary":"dsh route ok","changedFiles":["src/a.ts"],"checks":[],"artifacts":[],"problems":[]}',
          stderr: "",
        };
      },
    });

    const output = await executor({
      ...executorInput(),
      recorder: { stdout() {}, stderr() {}, event: (event) => events.push(event) },
    });

    expect(output).toMatchObject({ status: "done", summary: "dsh route ok", changedFiles: ["src/a.ts"] });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      stdin: "",
      cwd: taskFixture.worktreePath,
      env: { DSH_PERMISSION_MODE: "workspace-write" },
    });
    expect(calls[0]?.env?.DSH_HOME).toContain("ouroboros-dsh-");
    expect(calls[0]?.env?.HODOR_APPLICATION_TOKEN).toBeUndefined();
    expect(calls[0]?.cmd.slice(0, 4)).toEqual(["/usr/bin/sandbox-exec", "-p", expect.any(String), "--"]);
    expect(calls[0]?.cmd.slice(4, 7)).toEqual(["/opt/deepseek/bin/dsh", "--profile", "headless"]);
    expect(calls[0]?.cmd.at(-1)).toBe(executorInput().prompt);
    expect(calls[0]?.cmd).toContain("--patch");
    expect(events.map((event) => event.type)).toEqual([
      "dsh.attempt.started",
      "dsh.profile.preflight",
      "dsh.attempt.terminal",
    ]);
    expect(JSON.stringify(events)).not.toContain(executorInput().prompt);
  });

  test.skipIf(process.platform !== "darwin")("installs a host-owned process policy before DSH can run nested Codex", async () => {
    let policyPatch = "";
    let policyRunner = "";
    let policyPatchPath = "";
    let policyRunnerPath = "";
    const executor = createDshCliExecutor({
      cwd: taskFixture.worktreePath,
      command: "/opt/deepseek/bin/dsh",
      profile: "headless",
      sandbox: "workspace-write",
      resolveCommand: availableDshResolution,
      runCommand: async (input) => {
        const patchIndex = input.cmd.indexOf("--patch");
        expect(patchIndex).toBeGreaterThan(0);
        const patchPath = input.cmd[patchIndex + 1];
        expect(patchPath).toBeString();
        policyPatchPath = patchPath!;
        policyPatch = readFileSync(patchPath!, "utf8");
        const runnerMatch = policyPatch.match(/ORBS_DSH_POLICY_RUNNER=([^\n]+)/);
        expect(runnerMatch?.[1]).toBeString();
        policyRunnerPath = runnerMatch![1]!;
        policyRunner = readFileSync(policyRunnerPath, "utf8");
        return {
          exitCode: 0,
          stdout: '{"status":"done","summary":"nested agent policy active","changedFiles":[],"checks":[],"artifacts":[],"problems":[]}',
          stderr: "",
        };
      },
    });

    const output = await executor(executorInput());

    expect(output.status).toBe("done");
    expect(policyPatch).toContain("@deepseek-ai/dsh-sandbox-local");
    expect(policyRunner).toContain("/Applications/ChatGPT.app/Contents/Resources/codex");
    expect(policyRunner).toContain("/Applications/Codex.app/Contents/Resources/codex");
    expect(policyRunner).toContain("deny process-exec");
    expect(policyRunner).toContain("deny file-read");
    expect(policyRunner).toContain("deny network*");
    expect(policyRunner).toContain("allowedEnvironment");
    expect(policyRunner).not.toContain("env: process.env");
    expect(existsSync(policyPatchPath)).toBe(false);
    expect(existsSync(policyRunnerPath)).toBe(false);
  });

  test.skipIf(process.platform !== "darwin")("denies loopback TCP from DSH tool subprocesses", () => {
    let connections = 0;
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open() { connections += 1; },
        data() {},
      },
    });
    try {
      const profile = darwinDshProcessProfile({ workspaceRoot: taskFixture.worktreePath });
      const denied = Bun.spawnSync({
        cmd: ["/usr/bin/sandbox-exec", "-p", profile, "/usr/bin/nc", "-z", "127.0.0.1", String(server.port)],
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(denied.exitCode).not.toBe(0);
      expect(connections).toBe(0);
    } finally {
      server.stop(true);
    }
  });

  test.skipIf(process.platform !== "darwin")("denies target-local control databases before DSH can read them", async () => {
    const workspace = await mkdtemp(join(homedir(), ".orbs-dsh-control-read-"));
    const ordinaryPath = join(workspace, "README.md");
    const controlPaths = [
      join(workspace, ".ouroboros", "state.json"),
      join(workspace, ".orbs", "harness.db"),
      join(workspace, ".git", "orbs", "ouroboros.db"),
    ];
    await writeFile(ordinaryPath, "ordinary\n");
    for (const path of controlPaths) {
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, "control-secret\n");
    }
    const profile = darwinDshHostReadProfile({ workspaceRoot: workspace });

    try {
      const ordinary = Bun.spawnSync({
        cmd: ["/usr/bin/sandbox-exec", "-p", profile.profile, "--", "/bin/cat", ordinaryPath],
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(ordinary.exitCode).toBe(0);
      expect(ordinary.stdout.toString()).toBe("ordinary\n");
      for (const path of controlPaths) {
        const denied = Bun.spawnSync({
          cmd: ["/usr/bin/sandbox-exec", "-p", profile.profile, "--", "/bin/cat", path],
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(denied.exitCode).not.toBe(0);
        expect(denied.stdout.toString()).not.toContain("control-secret");
      }
      expect(profile.deniedReadPathsSha256).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform !== "darwin")("denies an embedded-agent executable before a harmless sentinel can run", async () => {
    const directory = await mkdtemp(join(homedir(), ".orbs-dsh-process-policy-"));
    const outsideDirectory = await mkdtemp(join(homedir(), ".orbs-dsh-process-policy-outside-"));
    const protectedExecutable = join(directory, "embedded-codex-fixture");
    const allowedExecutable = join(directory, "ordinary-tool-fixture");
    const protectedMarker = join(directory, "protected-ran");
    const allowedMarker = join(directory, "allowed-ran");
    const outsideMarker = join(outsideDirectory, "outside-ran");
    await writeFile(protectedExecutable, `#!/bin/sh\nprintf protected > ${JSON.stringify(protectedMarker)}\n`);
    await writeFile(allowedExecutable, `#!/bin/sh\nprintf allowed > ${JSON.stringify(allowedMarker)}\n`);
    await chmod(protectedExecutable, 0o755);
    await chmod(allowedExecutable, 0o755);
    const profile = darwinDshProcessProfile({
      workspaceRoot: directory,
      protectedExecutables: [protectedExecutable],
    });

    try {
      const denied = Bun.spawnSync({
        cmd: [
          "/usr/bin/sandbox-exec",
          "-p",
          profile,
          "--",
          "/bin/sh",
          "-c",
          `p=${JSON.stringify(protectedExecutable)}; "$p"`,
        ],
        stdout: "pipe",
        stderr: "pipe",
      });
      const allowed = Bun.spawnSync({
        cmd: ["/usr/bin/sandbox-exec", "-p", profile, "--", allowedExecutable],
        stdout: "pipe",
        stderr: "pipe",
      });
      const outsideWrite = Bun.spawnSync({
        cmd: [
          "/usr/bin/sandbox-exec",
          "-p",
          profile,
          "--",
          "/bin/sh",
          "-c",
          `printf outside > ${JSON.stringify(outsideMarker)}`,
        ],
        stdout: "pipe",
        stderr: "pipe",
      });

      expect(denied.exitCode).not.toBe(0);
      expect(existsSync(protectedMarker)).toBe(false);
      expect(allowed.exitCode).toBe(0);
      expect(readFileSync(allowedMarker, "utf8")).toBe("allowed");
      expect(outsideWrite.exitCode).not.toBe(0);
      expect(existsSync(outsideMarker)).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
      await rm(outsideDirectory, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform !== "darwin")("denies a nested codex executable from any path before it can run", async () => {
    const directory = await mkdtemp(join(homedir(), ".orbs-dsh-nested-codex-"));
    const nestedCodex = join(directory, "tools", "codex");
    const marker = join(directory, "nested-codex-ran");
    await mkdir(join(directory, "tools"));
    await writeFile(nestedCodex, `#!/bin/sh\nprintf nested > ${JSON.stringify(marker)}\n`);
    await chmod(nestedCodex, 0o755);
    const profile = darwinDshProcessProfile({ workspaceRoot: directory });

    try {
      const result = Bun.spawnSync({
        cmd: [
          "/usr/bin/sandbox-exec",
          "-p",
          profile,
          "--",
          "/bin/sh",
          "-c",
          `p=${JSON.stringify(nestedCodex)}; "$p"`,
        ],
        stdout: "pipe",
        stderr: "pipe",
      });

      expect(result.exitCode).not.toBe(0);
      expect(existsSync(marker)).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("fails closed before DSH for unsupported permissions and host capabilities", async () => {
    let calls = 0;
    const runCommand = async () => {
      calls += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const dangerous = createDshCliExecutor({
      cwd: taskFixture.worktreePath,
      sandbox: "danger-full-access",
      runCommand,
    });
    const hostCapable = createDshCliExecutor({
      cwd: taskFixture.worktreePath,
      sandbox: "workspace-write",
      hostExecutionCapabilities: { schemaVersion: 1 },
      runCommand,
    });

    await expect(dangerous(executorInput())).resolves.toMatchObject({
      status: "blocked",
      summary: expect.stringContaining("danger-full-access"),
    });
    await expect(hostCapable(executorInput())).resolves.toMatchObject({
      status: "blocked",
      summary: expect.stringContaining("host execution capabilities"),
    });
    expect(calls).toBe(0);
  });

  test("blocks an oversized positional prompt before launching DSH", async () => {
    let calls = 0;
    const executor = createDshCliExecutor({
      cwd: taskFixture.worktreePath,
      resolveCommand: availableDshResolution,
      runCommand: async () => {
        calls += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    const output = await executor(executorInput("x".repeat(100_001)));

    expect(output).toMatchObject({
      status: "blocked",
      artifacts: [expect.objectContaining({ kind: "dsh_prompt_argument_too_large", characters: 100_001 })],
    });
    expect(calls).toBe(0);
  });

  test("launches the resolver-selected executable while retaining one-shot arguments", async () => {
    const calls: RunCommandInput[] = [];
    const selectedPath = "/tmp/selected-dsh-wrapper";
    const executor = createDshCliExecutor({
      cwd: taskFixture.worktreePath,
      command: "dsh",
      profile: "headless",
      resolveCommand: () => ({
        configuredCommand: "dsh",
        resolutionMode: "path",
        selectedPath,
        canonicalPath: "/tmp/canonical-dsh-wrapper",
        installationState: "available",
        callable: true,
        diagnostic: null,
      }),
      runCommand: async (input) => {
        calls.push(input);
        return {
          exitCode: 0,
          stdout: '{"status":"done","summary":"selected dsh","changedFiles":[],"checks":[],"artifacts":[],"problems":[]}',
          stderr: "",
        };
      },
    });

    await executor(executorInput());

    expect(calls[0]?.cmd.slice(0, 4)).toEqual(["/usr/bin/sandbox-exec", "-p", expect.any(String), "--"]);
    expect(calls[0]?.cmd.slice(4, 7)).toEqual([selectedPath, "--profile", "headless"]);
    expect(calls[0]?.cmd).toContain("--patch");
    expect(calls[0]?.cmd.at(-1)).toBe(executorInput().prompt);
  });

  test("bounds and redacts malformed or failed DSH output", async () => {
    const malformed = createDshCliExecutor({
      cwd: taskFixture.worktreePath,
      resolveCommand: availableDshResolution,
      runCommand: async () => ({
        exitCode: 0,
        stdout: `not-json Authorization: Bearer dsh-secret ${"z".repeat(20_000)}`,
        stderr: "",
      }),
    });
    const failed = createDshCliExecutor({
      cwd: taskFixture.worktreePath,
      resolveCommand: availableDshResolution,
      runCommand: async () => ({
        exitCode: 9,
        stdout: "",
        stderr: "token=dsh-failure-secret",
      }),
    });

    const malformedOutput = await malformed(executorInput());
    const failedOutput = await failed(executorInput());

    expect(malformedOutput).toMatchObject({ status: "blocked", summary: "DeepSeek Harness produced invalid output" });
    expect(JSON.stringify(malformedOutput)).not.toContain("dsh-secret");
    expect(JSON.stringify(malformedOutput).length).toBeLessThan(8_000);
    expect(failedOutput).toMatchObject({ status: "blocked", summary: "DeepSeek Harness CLI failed" });
    expect(JSON.stringify(failedOutput)).not.toContain("dsh-failure-secret");
  });

  test("converts a missing DSH binary into bounded blocked evidence", async () => {
    const executor = createDshCliExecutor({
      cwd: taskFixture.worktreePath,
      resolveCommand: availableDshResolution,
      runCommand: async () => {
        throw new Error("spawn dsh ENOENT Authorization: Bearer missing-binary-secret");
      },
    });

    const output = await executor(executorInput());

    expect(output).toMatchObject({ status: "blocked", summary: "DeepSeek Harness CLI could not start" });
    expect(JSON.stringify(output)).not.toContain("missing-binary-secret");
  });
});
