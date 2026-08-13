import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { createCodexCliExecutor, createCodexResumableClient } from "../packages/runner/src";
import { runLocalCommand } from "../packages/runner/src/executors/command";
import {
  prepareCodexHostExecution,
  protectedCodexRuntimeRoot,
} from "../packages/runner/src/executors/codex-host-execution";
import {
  parseHostExecutionCapabilities,
  resolveHostExecutionCapabilities,
  verifierContractSha256,
} from "../packages/runner/src/executors/host-execution-capabilities";

const exactPan1286VerifierFixture = JSON.parse(
  await Bun.file(new URL("./fixtures/pan-1286-verifier-config.json", import.meta.url)).text(),
) as {
  taskId: string;
  attemptId: string;
  sessionId: string;
  inheritedFromTaskId: string;
  verifierContract: Record<string, unknown>;
  hostExecutionCapabilities: Record<string, unknown>;
};

const runFixture = {
  id: "run_1",
  projectId: "project_1",
  projectRoot: "/repo",
  goal: "Goal",
  status: "todo" as const,
  context: {},
};

const routeFixture = {
  role: "worker",
  backend: {
    id: "codex-cli",
    kind: "codex-cli",
    source: "cli-executor",
  },
  model: null,
  executionMode: "generic",
} as const;

describe("codex cli executor", () => {
  test("preserves the exact failing PAN-1286 verifier capability fixture", () => {
    expect(exactPan1286VerifierFixture.taskId).toBe("task_e9464a9b199f42febc596f7d4342ee36");
    expect(exactPan1286VerifierFixture.attemptId).toBe("attempt_226ae4f59e164b7e9ab94b6dbcf62104");
    expect(exactPan1286VerifierFixture.sessionId).toBe("019ff830-46cb-7311-9f0e-383c60022193");
    expect(exactPan1286VerifierFixture.inheritedFromTaskId).toBe("task_3796794bed4f47fea9d9f41f874e8db2");
    expect(verifierContractSha256(exactPan1286VerifierFixture.verifierContract)).toBe(
      "df239ffff74e06c3557b4b32f90736632852c0bba791248e7c54158e4126fa2d",
    );
    expect(() => parseHostExecutionCapabilities(exactPan1286VerifierFixture.hostExecutionCapabilities, {
      role: "verifier",
      verifierContract: exactPan1286VerifierFixture.verifierContract,
    })).not.toThrow();
  });

  test("host execution capabilities reject unknown fields and browser access outside verifier tasks", () => {
    const verifierContract = { deterministicChecks: ["browser health"] };
    const verifierContractHash = verifierContractSha256(verifierContract);
    expect(() => parseHostExecutionCapabilities({
      schemaVersion: 1,
      browser: { mode: "isolated-agent-browser", allowedDomains: ["127.0.0.1"], verifierContractSha256: verifierContractHash },
      extra: true,
    }, { role: "verifier", verifierContract })).toThrow("unknown field");

    expect(() => parseHostExecutionCapabilities({
      schemaVersion: 1,
      browser: { mode: "isolated-agent-browser", allowedDomains: ["127.0.0.1"], verifierContractSha256: verifierContractHash },
    }, { role: "worker", verifierContract })).toThrow("browser capability is verifier-only");

    expect(() => parseHostExecutionCapabilities({
      schemaVersion: 1,
      browser: { mode: "isolated-agent-browser", allowedDomains: ["127.0.0.1"], verifierContractSha256: "0".repeat(64) },
    }, { role: "verifier", verifierContract })).toThrow("verifierContractSha256 mismatch");
  });

  test("host execution capabilities bind Git metadata and local services to the frozen task contract", async () => {
    const root = await mkdtemp(join(tmpdir(), "orbs-host-capability-git-"));
    const worktree = `${root}-worktree`;
    const databaseUrl = "postgresql:///hodor_test?host=/tmp";
    const previousDatabaseUrl = process.env.TEST_DATABASE_URL;
    try {
      git(root, "init", "-b", "main");
      git(root, "config", "user.email", "orbs@example.test");
      git(root, "config", "user.name", "ORBS Test");
      await writeFile(join(root, "README.md"), "root\n", "utf8");
      git(root, "add", "README.md");
      git(root, "commit", "-m", "root");
      git(root, "remote", "add", "origin", "git@github.com:example/repository.git");
      git(root, "worktree", "add", "-b", "codex/capability", worktree);
      process.env.TEST_DATABASE_URL = databaseUrl;

      const parsed = parseHostExecutionCapabilities({
        schemaVersion: 1,
        git: { worktreeMetadata: "own", remoteDomains: ["github.com"] },
        postgres: {
          environmentVariable: "TEST_DATABASE_URL",
          valueSha256: new Bun.CryptoHasher("sha256").update(databaseUrl).digest("hex"),
          unixSocketPath: "/tmp/.s.PGSQL.5432",
        },
        loopback: { host: "127.0.0.1", ports: [43127] },
        network: { mode: "host-fixed-actions", domains: ["github.com", "api.github.com", "api.linear.app"], clearAmbientProxy: true },
      }, { role: "worker" });
      const resolved = resolveHostExecutionCapabilities({ cwd: worktree, capabilities: parsed });

      expect(resolved.git?.gitDir).toContain("/.git/worktrees/");
      expect(resolved.git?.commonDir).toBe(realpathSync(join(root, ".git")));
      expect(resolved.git?.branchRef).toBe(join(realpathSync(join(root, ".git")), "refs", "heads", "codex", "capability"));
      expect(resolved.postgres).toMatchObject({
        environmentVariable: "TEST_DATABASE_URL",
        unixSocketPath: "/tmp/.s.PGSQL.5432",
        databaseName: "hodor_test",
      });
      expect(resolved.loopback).toMatchObject({ host: "127.0.0.1", ports: [43127] });
      expect(resolved.loopback?.sockets).toEqual([{ port: 43127, path: expect.stringMatching(/port-43127\.sock$/) }]);
      expect(JSON.stringify(resolved)).not.toContain(databaseUrl);
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.TEST_DATABASE_URL;
      else process.env.TEST_DATABASE_URL = previousDatabaseUrl;
      await rm(worktree, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  test("host execution capabilities fail before launch when the frozen PostgreSQL value drifts", async () => {
    const previousDatabaseUrl = process.env.TEST_DATABASE_URL;
    const cwd = await mkdtemp(join(tmpdir(), "orbs-host-capability-drift-"));
    try {
      process.env.TEST_DATABASE_URL = "postgresql:///other?host=/tmp";
      const parsed = parseHostExecutionCapabilities({
        schemaVersion: 1,
        postgres: {
          environmentVariable: "TEST_DATABASE_URL",
          valueSha256: "0".repeat(64),
          unixSocketPath: "/tmp/.s.PGSQL.5432",
        },
      }, { role: "worker" });
      expect(() => resolveHostExecutionCapabilities({ cwd, capabilities: parsed })).toThrow(
        "frozen PostgreSQL environment value mismatch",
      );
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.TEST_DATABASE_URL;
      else process.env.TEST_DATABASE_URL = previousDatabaseUrl;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("host execution capabilities reject alternate database variables and mismatched socket ports", () => {
    expect(() => parseHostExecutionCapabilities({
      schemaVersion: 1,
      postgres: {
        environmentVariable: "UNRELATED_DATABASE_URL",
        valueSha256: "0".repeat(64),
        unixSocketPath: "/tmp/.s.PGSQL.5432",
      },
    }, { role: "worker" })).toThrow("must be TEST_DATABASE_URL");

    const databaseUrl = "postgresql:///hodor_test?host=/tmp";
    const previous = process.env.TEST_DATABASE_URL;
    process.env.TEST_DATABASE_URL = databaseUrl;
    try {
      const parsed = parseHostExecutionCapabilities({
        schemaVersion: 1,
        postgres: {
          environmentVariable: "TEST_DATABASE_URL",
          valueSha256: new Bun.CryptoHasher("sha256").update(databaseUrl).digest("hex"),
          unixSocketPath: "/tmp/.s.PGSQL.6543",
        },
      }, { role: "worker" });
      expect(() => resolveHostExecutionCapabilities({ cwd: process.cwd(), capabilities: parsed })).toThrow(
        "socket port must match TEST_DATABASE_URL",
      );
    } finally {
      if (previous === undefined) delete process.env.TEST_DATABASE_URL;
      else process.env.TEST_DATABASE_URL = previous;
    }
  });

  test.skipIf(process.platform !== "darwin")("Codex clears ambient proxies while outbound domains remain host-owned", async () => {
    const cwd = await mkdtemp(join(process.cwd(), ".orbs-host-network-"));
    const previousProxy = process.env.HTTPS_PROXY;
    const calls: Array<{ env?: Record<string, string | undefined> }> = [];
    try {
      process.env.HTTPS_PROXY = "http://dead-proxy.invalid:9999";
      const executor = createCodexCliExecutor({
        cwd,
        sandbox: "workspace-write",
        taskRole: "worker",
        hostExecutionCapabilities: {
          schemaVersion: 1,
          network: { mode: "host-fixed-actions", domains: ["github.com", "api.github.com", "api.linear.app"], clearAmbientProxy: true },
        },
        runCommand: async ({ env, cmd }) => {
          calls.push({ env });
          const outputPath = cmd[cmd.indexOf("--output-last-message") + 1];
          await writeFile(outputPath, JSON.stringify({ status: "done", summary: "network-ready", changedFiles: [], checks: [], artifacts: [], problems: [] }));
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      });
      const result = await executor({ prompt: "check network", run: runFixture, task: { id: "task_network", runId: "run_1", parentId: null, cycleId: "cycle", status: "todo", role: "worker", goal: "network", prompt: "network", dependsOn: [], doneWhen: [], config: {}, worktreePath: cwd, sessionRef: null, contextVersion: 1 }, sessionName: "network", route: routeFixture });
      expect(result.status).toBe("done");
      expect(calls[0]?.env?.HTTPS_PROXY).toBeUndefined();
      expect(calls[0]?.env?.https_proxy).toBeUndefined();
      expect(calls[0]?.env?.GIT_SSH_COMMAND).toBeUndefined();
      const config = await Bun.file(join(calls[0]!.env!.CODEX_HOME!, "config.toml")).text();
      expect(config).not.toContain('"api.linear.app" = "allow"');
      expect(config).not.toContain("dead-proxy.invalid");
    } finally {
      if (previousProxy === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = previousProxy;
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform !== "darwin")("protected Codex profile commits through only its linked worktree metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "orbs-host-git-canary-"));
    const worktree = `${root}-worktree`;
    try {
      git(root, "init", "-b", "main");
      git(root, "config", "user.email", "orbs@example.test");
      git(root, "config", "user.name", "ORBS Test");
      await writeFile(join(root, "README.md"), "root\n", "utf8");
      git(root, "add", "README.md");
      git(root, "commit", "-m", "root");
      git(root, "worktree", "add", "-b", "codex/capability-canary", worktree);
      const execution = await prepareCodexHostExecution({
        cwd: worktree,
        sandbox: "workspace-write",
        browserProcessPolicy: "deny",
        hostExecutionCapabilities: {
          schemaVersion: 1,
          git: { worktreeMetadata: "own", remoteDomains: [] },
        },
        taskRole: "worker",
        injectedRunCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      });
      const codexBin = "/Applications/ChatGPT.app/Contents/Resources/codex";
      const committed = await runLocalCommand({
        cmd: [codexBin, "sandbox", "-P", "orbs-workspace", "-C", worktree, "/bin/sh", "-c", "printf worker >> README.md && git add README.md && git commit --no-gpg-sign --no-verify -m worker"],
        stdin: "",
        env: execution!.env,
      });
      if (committed.exitCode !== 0) throw new Error(committed.stderr || committed.stdout);
      expect(committed.exitCode).toBe(0);
      expect(git(worktree, "show", "--format=", "--name-only", "HEAD")).toBe("README.md");

      const mainRef = join(realpathSync(join(root, ".git")), "refs", "heads", "main");
      const originalMain = await Bun.file(mainRef).text();
      const unrelated = await runLocalCommand({
        cmd: [codexBin, "sandbox", "-P", "orbs-workspace", "-C", worktree, "/bin/sh", "-c", `printf forbidden > ${JSON.stringify(mainRef)}`],
        stdin: "",
        env: execution!.env,
      });
      expect(unrelated.exitCode).not.toBe(0);
      expect(await Bun.file(mainRef).text()).toBe(originalMain);
    } finally {
      await rm(worktree, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);

  test.skipIf(process.platform !== "darwin")("protected Codex profile reaches only the frozen PostgreSQL socket and loopback service", async () => {
    const cwd = await mkdtemp(join(process.cwd(), ".orbs-host-local-canary-"));
    const databaseUrl = "postgresql:///hodor_test?host=/tmp";
    const previousDatabaseUrl = process.env.TEST_DATABASE_URL;
    const allowedServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("health-ok") });
    const undeclaredServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("must-not-be-readable") });
    const port = allowedServer.port;
    let execution: Awaited<ReturnType<typeof prepareCodexHostExecution>> = null;
    try {
      process.env.TEST_DATABASE_URL = databaseUrl;
      execution = await prepareCodexHostExecution({
        cwd,
        sandbox: "workspace-write",
        hostExecutionCapabilities: {
          schemaVersion: 1,
          postgres: {
            environmentVariable: "TEST_DATABASE_URL",
            valueSha256: new Bun.CryptoHasher("sha256").update(databaseUrl).digest("hex"),
            unixSocketPath: "/tmp/.s.PGSQL.5432",
          },
          loopback: { host: "127.0.0.1", ports: [port] },
        },
        taskRole: "worker",
        injectedRunCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      });
      const codexBin = "/Applications/ChatGPT.app/Contents/Resources/codex";
      const postgres = await runLocalCommand({
        cmd: [codexBin, "sandbox", "-P", "orbs-workspace", "-C", cwd, "/opt/homebrew/opt/postgresql@15/bin/psql", databaseUrl, "-Atc", "select current_database()"],
        stdin: "",
        env: execution!.env,
      });
      if (postgres.exitCode !== 0) throw new Error(postgres.stderr || postgres.stdout);
      expect(postgres.stdout.trim()).toBe("hodor_test");

      const socketMap = JSON.parse(execution!.env.ORBS_LOOPBACK_SOCKET_MAP!) as Record<string, string>;
      const loopback = await runLocalCommand({
        cmd: [codexBin, "sandbox", "-P", "orbs-workspace", "-C", cwd, "/usr/bin/curl", "--unix-socket", socketMap[String(port)]!, "http://localhost/healthz"],
        stdin: "",
        env: execution!.env,
        timeoutMs: 8_000,
      });
      if (loopback.exitCode !== 0) throw new Error(loopback.stderr || loopback.stdout);
      expect(loopback.stdout.trim()).toBe("health-ok");
      expect(execution!.env.ORBS_ALLOWED_LOOPBACK_PORTS).toBe(String(port));
      const undeclared = await runLocalCommand({
        cmd: [codexBin, "sandbox", "-P", "orbs-workspace", "-C", cwd, "/usr/bin/curl", "--fail-with-body", "--max-time", "2", `http://127.0.0.1:${undeclaredServer.port}/healthz`],
        stdin: "",
        env: execution!.env,
        timeoutMs: 4_000,
      });
      expect(undeclared.exitCode).not.toBe(0);
      expect(undeclared.stdout).not.toContain("must-not-be-readable");
    } finally {
      await execution?.cleanup?.();
      allowedServer.stop(true);
      undeclaredServer.stop(true);
      if (previousDatabaseUrl === undefined) delete process.env.TEST_DATABASE_URL;
      else process.env.TEST_DATABASE_URL = previousDatabaseUrl;
      await rm(cwd, { recursive: true, force: true });
    }
  }, 15_000);

  test.skipIf(process.platform !== "darwin")("verifier-only browser capability opens the frozen loopback service", async () => {
    const cwd = await mkdtemp(join(process.cwd(), ".orbs-host-browser-canary-"));
    const protectedHome = await mkdtemp(join(tmpdir(), "orbs-protected-browser-auth-"));
    const protectedAuth = join(protectedHome, "auth.json");
    const protectedSentinel = "ORBS_PROTECTED_AUTH_SENTINEL_71C8";
    await writeFile(protectedAuth, protectedSentinel);
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = protectedHome;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(`
        <body>
          browser-health
          <input id="f" type="file">
          <div role="dialog" aria-label="project settings" style="height: 120px; overflow: auto">
            <div style="height: 480px"></div>
            <button id="preset" type="button">use preset</button>
            <label>visual manual
              <select id="visual-manual">
                <option value="">unconfigured</option>
                <option value="western_fantasy">western fantasy</option>
              </select>
            </label>
            <output id="selection-state">unconfigured</output>
          </div>
          <a id="download" download="proof.txt" href="data:text/plain,blocked">download proof</a>
          <script>
            document.querySelector('#preset').addEventListener('click', () => {
              document.querySelector('#selection-state').textContent = 'clicked';
            });
            document.querySelector('#visual-manual').addEventListener('change', (event) => {
              document.querySelector('#selection-state').textContent = event.target.value;
            });
          </script>
        </body>
      `, {
        headers: { "content-type": "text/html" },
      }),
    });
    const port = server.port;
    const verifierContract = { deterministicChecks: ["healthz", "browser body"] };
    try {
      const execution = await prepareCodexHostExecution({
        cwd,
        sandbox: "workspace-write",
        browserProcessPolicy: "allow",
        hostExecutionCapabilities: {
          schemaVersion: 1,
          loopback: { host: "127.0.0.1", ports: [port] },
          browser: {
            mode: "isolated-agent-browser",
            allowedDomains: ["127.0.0.1"],
            verifierContractSha256: verifierContractSha256(verifierContract),
          },
        },
        taskRole: "verifier",
        verifierContract,
        injectedRunCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      });
      const codexBin = "/Applications/ChatGPT.app/Contents/Resources/codex";
      const agentBrowserReadback = await runLocalCommand({
        cmd: ["/usr/bin/env", "agent-browser", "--version"],
        stdin: "",
        env: execution!.env,
        timeoutMs: 5_000,
      });
      const agentBrowser = join(execution!.capabilities!.browser!.socketDirectory, "client-bin", "agent-browser");
      expect(agentBrowserReadback.exitCode).toBe(0);
      const socketPath = execution!.capabilities!.browser!.socketPath;
      const versionPath = socketPath.replace(/\.sock$/, ".version");
      const clientVersion = await runLocalCommand({
        cmd: [agentBrowser, "--version"],
        stdin: "",
        inheritEnv: false,
        timeoutMs: 5_000,
      });
      expect(clientVersion.exitCode).toBe(0);
      expect(clientVersion.stdout).toBe(agentBrowserReadback.stdout);
      expect((await Bun.file(versionPath).text()).trim()).toBe(clientVersion.stdout.trim().replace(/^agent-browser\s+/, ""));
      const frozenClientSource = await Bun.file(agentBrowser).text();
      for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "AGENT_BROWSER_PROXY"]) {
        expect(frozenClientSource).toContain(`unset ${name}`);
      }
      const clientOverwrite = await runLocalCommand({
        cmd: [codexBin, "sandbox", "-P", "orbs-workspace", "-C", cwd, "/bin/sh", "-c", `printf replaced > ${JSON.stringify(agentBrowser)}`],
        stdin: "",
        env: execution!.env,
        timeoutMs: 5_000,
        cleanupOnFailure: true,
      });
      expect(clientOverwrite.exitCode).not.toBe(0);
      expect((await Bun.file(agentBrowser).text())).toContain("exec ");
      const arbitraryApplication = await runLocalCommand({
        cmd: [codexBin, "sandbox", "-P", "orbs-workspace", "-C", cwd, "/usr/bin/open", "-Ra", "Safari"],
        stdin: "",
        env: execution!.env,
        timeoutMs: 5_000,
        cleanupOnFailure: true,
      });
      expect(arbitraryApplication.exitCode).not.toBe(0);
      const initialDaemonPidReadback = await runLocalCommand({
        cmd: ["/usr/sbin/lsof", "-t", "--", socketPath],
        stdin: "",
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
        inheritEnv: false,
        timeoutMs: 5_000,
      });
      const initialDaemonPids = initialDaemonPidReadback.stdout.trim().split(/\s+/).filter(Boolean);
      expect(initialDaemonPids).toHaveLength(1);
      const protectedConfig = await Bun.file(join(execution!.env.CODEX_HOME, "config.toml")).text();
      const actionPolicy = JSON.parse(await Bun.file(execution!.capabilities!.browser!.actionPolicyPath).text()) as { default: string; allow: string[] };
      expect(actionPolicy.default).toBe("deny");
      expect(actionPolicy.allow).toContain("reload");
      expect(actionPolicy.allow).toContain("dialog");
      expect(actionPolicy.allow).not.toContain("eval");
      expect(actionPolicy.allow).not.toContain("upload");
      expect(actionPolicy.allow).not.toContain("download");
      expect(protectedConfig).toContain("[shell_environment_policy]");
      expect(protectedConfig).toContain('inherit = "none"');
      expect(protectedConfig).toContain("allow_login_shell = false");
      expect(protectedConfig).toContain(`AGENT_BROWSER_SESSION = ${JSON.stringify(execution!.capabilities!.browser!.sessionName)}`);
      expect(protectedConfig).toContain(`AGENT_BROWSER_SOCKET_DIR = ${JSON.stringify(execution!.capabilities!.browser!.socketDirectory)}`);
      expect(protectedConfig).toContain(`AGENT_BROWSER_CONFIG = ${JSON.stringify(execution!.capabilities!.browser!.configPath)}`);
      expect(protectedConfig).toContain(`AGENT_BROWSER_ACTION_POLICY = ${JSON.stringify(execution!.capabilities!.browser!.actionPolicyPath)}`);
      expect(protectedConfig).toContain(join(execution!.capabilities!.browser!.socketDirectory, "client-bin"));
      const strippedExecutorEnvironment = {
        CODEX_HOME: execution!.env.CODEX_HOME,
        HOME: process.env.HOME ?? "",
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        LINEAR_API_KEY: "synthetic-linear-key-must-not-propagate",
        HOST_PAYMENT_DSN: "synthetic-payment-dsn-must-not-propagate",
      };
      const propagatedEnvironment = await runLocalCommand({
        cmd: [
          codexBin,
          "sandbox",
          "-P",
          "orbs-workspace",
          "-C",
          cwd,
          "/bin/sh",
          "-c",
          "printf '%s\\n%s\\n%s\\n' \"$AGENT_BROWSER_SESSION\" \"$AGENT_BROWSER_SOCKET_DIR\" \"$AGENT_BROWSER_CONFIG\"",
        ],
        stdin: "",
        env: strippedExecutorEnvironment,
        inheritEnv: false,
        timeoutMs: 5_000,
        cleanupOnFailure: true,
      });
      expect(propagatedEnvironment.exitCode).toBe(0);
      expect(propagatedEnvironment.stdout).toContain(execution!.capabilities!.browser!.sessionName);
      expect(propagatedEnvironment.stdout).toContain(execution!.capabilities!.browser!.socketDirectory);
      expect(propagatedEnvironment.stdout).toContain(execution!.capabilities!.browser!.configPath);
      const secretEnvironment = await runLocalCommand({
        cmd: [codexBin, "sandbox", "-P", "orbs-workspace", "-C", cwd, "/bin/sh", "-c", "test -z \"${LINEAR_API_KEY:-}\" && test -z \"${HOST_PAYMENT_DSN:-}\""],
        stdin: "",
        env: strippedExecutorEnvironment,
        inheritEnv: false,
        timeoutMs: 5_000,
        cleanupOnFailure: true,
      });
      expect(secretEnvironment.exitCode).toBe(0);
      for (const invocation of ["-ic", "-lic"]) {
        const nestedShellEnvironment = await runLocalCommand({
          cmd: [codexBin, "sandbox", "-P", "orbs-workspace", "-C", cwd, "/bin/zsh", invocation, "test -z \"${LINEAR_API_KEY:-}\" && test -z \"${HOST_PAYMENT_DSN:-}\""],
          stdin: "",
          env: strippedExecutorEnvironment,
          inheritEnv: false,
          timeoutMs: 5_000,
          cleanupOnFailure: true,
        });
        expect(nestedShellEnvironment.exitCode).toBe(0);
      }
      const attachmentProof = await runLocalCommand({
        cmd: [
          codexBin,
          "sandbox",
          "-P",
          "orbs-workspace",
          "-C",
          cwd,
          "/usr/bin/env",
          "HTTP_PROXY=",
          "HTTPS_PROXY=",
          "ALL_PROXY=",
          "http_proxy=",
          "https_proxy=",
          "all_proxy=",
          "AGENT_BROWSER_SESSION_NAME=unfrozen-session",
          "AGENT_BROWSER_STREAM_PORT=1",
          "AGENT_BROWSER_IDLE_TIMEOUT_MS=1",
          "AGENT_BROWSER_CONFIRM_ACTIONS=upload,download",
          "AGENT_BROWSER_SCREENSHOT_DIR=/tmp/unfrozen-browser-output",
          "agent-browser",
          "--orbs-attachment-proof",
        ],
        stdin: "",
        env: strippedExecutorEnvironment,
        inheritEnv: false,
        timeoutMs: 10_000,
        cleanupOnFailure: true,
      });
      expect(attachmentProof.exitCode).toBe(0);
      expect(JSON.parse(attachmentProof.stdout)).toMatchObject({
        schemaVersion: 1,
        sessionName: execution!.capabilities!.browser!.sessionName,
        socketPath,
        clientVersion: clientVersion.stdout.trim().replace(/^agent-browser\s+/, ""),
      });
      const rejectedOverrides = await runLocalCommand({
        cmd: [
          codexBin,
          "sandbox",
          "-P",
          "orbs-workspace",
          "-C",
          cwd,
          "/bin/sh",
          "-c",
          [
            "set -eu",
            "reject_override() { output=$(agent-browser \"$@\" 2>&1) && exit 1; case \"$output\" in *\"browser client connection override is forbidden\"*) ;; *) printf '%s\\n' \"$output\" >&2; exit 1;; esac; }",
            "reject_override --session unfrozen-session get url",
            "reject_override --cdp http://127.0.0.1:9 get url",
            `reject_override --config ${JSON.stringify(join(cwd, "alternate-browser.json"))} get url`,
            "reject_override --allow-file-access=true get url",
            "reject_override --allowed-domains example.com get url",
            "reject_override -pios get url",
          ].join("\n"),
        ],
        stdin: "",
        env: strippedExecutorEnvironment,
        inheritEnv: false,
        timeoutMs: 10_000,
        cleanupOnFailure: true,
      });
      expect(rejectedOverrides.exitCode).toBe(0);
      const browserCommand = await runLocalCommand({
        cmd: [
          codexBin,
          "sandbox",
          "-P",
          "orbs-workspace",
          "-C",
          cwd,
          "/bin/sh",
          "-c",
          [
            `agent-browser open http://127.0.0.1:${port}/healthz`,
            "agent-browser get url",
            "agent-browser reload",
            "agent-browser snapshot -i",
            "agent-browser get text body",
          ].join("\n"),
        ],
        stdin: "",
        env: execution!.env,
        timeoutMs: 20_000,
        cleanupOnFailure: true,
      });
      if (browserCommand.exitCode !== 0) throw new Error(browserCommand.stderr || browserCommand.stdout);
      for (const expected of ["127.0.0.1", "选择文件", "browser-health"]) {
        expect(browserCommand.stdout).toContain(expected);
      }
      const snapshot = await runLocalCommand({
        cmd: [codexBin, "sandbox", "-P", "orbs-workspace", "-C", cwd, "/usr/bin/env", "agent-browser", "snapshot", "-i"],
        stdin: "",
        env: execution!.env,
        timeoutMs: 10_000,
        cleanupOnFailure: true,
      });
      const presetRef = /button "use preset" \[ref=(e\d+)\]/.exec(snapshot.stdout)?.[1];
      expect(presetRef).toBeDefined();
      const referenceClick = await runLocalCommand({
        cmd: [codexBin, "sandbox", "-P", "orbs-workspace", "-C", cwd, "/usr/bin/env", "agent-browser", "click", `@${presetRef}`],
        stdin: "",
        env: execution!.env,
        timeoutMs: 10_000,
        cleanupOnFailure: true,
      });
      expect(referenceClick.exitCode).toBe(0);
      const clickedState = await runLocalCommand({
        cmd: [codexBin, "sandbox", "-P", "orbs-workspace", "-C", cwd, "/usr/bin/env", "agent-browser", "get", "text", "#selection-state"],
        stdin: "",
        env: execution!.env,
        timeoutMs: 10_000,
        cleanupOnFailure: true,
      });
      expect(clickedState.stdout).toContain("unconfigured");
      const scrollIntoView = await runLocalCommand({
        cmd: [codexBin, "sandbox", "-P", "orbs-workspace", "-C", cwd, "/usr/bin/env", "agent-browser", "scrollintoview", "#preset"],
        stdin: "",
        env: execution!.env,
        timeoutMs: 10_000,
        cleanupOnFailure: true,
      });
      if (scrollIntoView.exitCode !== 0) throw new Error(scrollIntoView.stderr || scrollIntoView.stdout);
      const selectorClick = await runLocalCommand({
        cmd: [codexBin, "sandbox", "-P", "orbs-workspace", "-C", cwd, "/usr/bin/env", "agent-browser", "click", `@${presetRef}`],
        stdin: "",
        env: execution!.env,
        timeoutMs: 10_000,
        cleanupOnFailure: true,
      });
      expect(selectorClick.exitCode).toBe(0);
      const selectorClickedState = await runLocalCommand({
        cmd: [codexBin, "sandbox", "-P", "orbs-workspace", "-C", cwd, "/usr/bin/env", "agent-browser", "get", "text", "#selection-state"],
        stdin: "",
        env: execution!.env,
        timeoutMs: 10_000,
        cleanupOnFailure: true,
      });
      expect(selectorClickedState.stdout).toContain("clicked");
      for (const args of [
        ["scrollintoview", "#visual-manual"],
        ["select", "#visual-manual", "western_fantasy"],
      ]) {
        const interaction = await runLocalCommand({
          cmd: [codexBin, "sandbox", "-P", "orbs-workspace", "-C", cwd, "/usr/bin/env", "agent-browser", ...args],
          stdin: "",
          env: execution!.env,
          timeoutMs: 10_000,
          cleanupOnFailure: true,
        });
        if (interaction.exitCode !== 0) throw new Error(interaction.stderr || interaction.stdout);
      }
      const selectedSnapshot = await runLocalCommand({
        cmd: [codexBin, "sandbox", "-P", "orbs-workspace", "-C", cwd, "/usr/bin/env", "agent-browser", "snapshot", "-i"],
        stdin: "",
        env: execution!.env,
        timeoutMs: 10_000,
        cleanupOnFailure: true,
      });
      const selectedState = await runLocalCommand({
        cmd: [codexBin, "sandbox", "-P", "orbs-workspace", "-C", cwd, "/usr/bin/env", "agent-browser", "get", "text", "#selection-state"],
        stdin: "",
        env: execution!.env,
        timeoutMs: 10_000,
        cleanupOnFailure: true,
      });
      expect(selectedSnapshot.stdout).toContain("western fantasy");
      expect(selectedSnapshot.stdout).toContain("selected");
      expect(selectedState.stdout).toContain("western_fantasy");
      const deniedInteractions = await runLocalCommand({
        cmd: [
          codexBin,
          "sandbox",
          "-P",
          "orbs-workspace",
          "-C",
          cwd,
          "/bin/sh",
          "-c",
          [
            "set -eu",
            "reject_action() { agent-browser \"$@\" >/dev/null 2>&1 && exit 1 || :; }",
            "reject_action focus '#visual-manual'",
            "reject_action press Enter",
            "reject_action get value '#visual-manual'",
            "reject_action eval 'document.body.textContent'",
            `reject_action download '#download' ${JSON.stringify(join(cwd, "download-proof.txt"))}`,
          ].join("\n"),
        ],
        stdin: "",
        env: execution!.env,
        timeoutMs: 10_000,
        cleanupOnFailure: true,
      });
      expect(deniedInteractions.exitCode).toBe(0);
      expect(existsSync(join(cwd, "download-proof.txt"))).toBe(false);
      const directCredentialRead = await runLocalCommand({
        cmd: [codexBin, "sandbox", "-P", "orbs-workspace", "-C", cwd, "/bin/cat", protectedAuth],
        stdin: "",
        env: execution!.env,
        timeoutMs: 5_000,
        cleanupOnFailure: true,
      });
      expect(directCredentialRead.exitCode).not.toBe(0);
      expect(`${directCredentialRead.stdout}${directCredentialRead.stderr}`).not.toContain(protectedSentinel);
      const browserCredentialRead = await runLocalCommand({
        cmd: [codexBin, "sandbox", "-P", "orbs-workspace", "-C", cwd, "/usr/bin/env", "agent-browser", "upload", "#f", protectedAuth],
        stdin: "",
        env: execution!.env,
        timeoutMs: 5_000,
        cleanupOnFailure: true,
      });
      expect(browserCredentialRead.exitCode).not.toBe(0);
      expect(`${browserCredentialRead.stdout}${browserCredentialRead.stderr}`).not.toContain(protectedSentinel);
      const adjacentServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("adjacent-secret-service") });
      try {
        const adjacent = await runLocalCommand({
          cmd: [codexBin, "sandbox", "-P", "orbs-workspace", "-C", cwd, "/usr/bin/env", "agent-browser", "open", `http://127.0.0.1:${adjacentServer.port}/secret`],
          stdin: "",
          env: execution!.env,
          timeoutMs: 10_000,
          cleanupOnFailure: true,
        });
        expect(adjacent.exitCode).not.toBe(0);
        expect(`${adjacent.stdout}${adjacent.stderr}`).not.toContain("adjacent-secret-service");
      } finally {
        adjacentServer.stop(true);
      }
      expect(execution!.env.ORBS_BROWSER_PROCESS_POLICY).toBe("allow");
      const config = await Bun.file(join(execution!.env.CODEX_HOME!, "config.toml")).text();
      expect(config).not.toContain('"127.0.0.1" = "allow"');
      const directNetwork = await runLocalCommand({
        cmd: [codexBin, "sandbox", "-P", "orbs-workspace", "-C", cwd, "/usr/bin/curl", "--fail-with-body", "--max-time", "3", "https://example.com"],
        stdin: "",
        env: execution!.env,
        timeoutMs: 5_000,
        cleanupOnFailure: true,
      });
      expect(directNetwork.exitCode).not.toBe(0);
      await writeFile(versionPath, "0.0.0\n");
      const staleVersion = await runLocalCommand({
        cmd: [codexBin, "sandbox", "-P", "orbs-workspace", "-C", cwd, "/usr/bin/env", "agent-browser", "get", "url"],
        stdin: "",
        env: strippedExecutorEnvironment,
        inheritEnv: false,
        timeoutMs: 5_000,
        cleanupOnFailure: true,
      });
      expect(staleVersion.exitCode).not.toBe(0);
      expect(`${staleVersion.stdout}${staleVersion.stderr}`).toContain("frozen browser daemon version mismatch");
      await writeFile(versionPath, `${clientVersion.stdout.trim().replace(/^agent-browser\s+/, "")}\n`);
      const identityPath = socketPath.replace(/\.sock$/, ".identity");
      const expectedIdentity = (await Bun.file(identityPath).text()).trim();
      await writeFile(identityPath, "0:0\n");
      const mismatchedIdentity = await runLocalCommand({
        cmd: [codexBin, "sandbox", "-P", "orbs-workspace", "-C", cwd, "/usr/bin/env", "agent-browser", "get", "url"],
        stdin: "",
        env: strippedExecutorEnvironment,
        inheritEnv: false,
        timeoutMs: 5_000,
        cleanupOnFailure: true,
      });
      expect(mismatchedIdentity.exitCode).not.toBe(0);
      expect(`${mismatchedIdentity.stdout}${mismatchedIdentity.stderr}`).toContain("frozen browser daemon socket identity mismatch");
      await writeFile(identityPath, `${expectedIdentity}\n`);
      const hiddenSocketPath = `${socketPath}.hidden`;
      await rename(socketPath, hiddenSocketPath);
      const missingSocket = await runLocalCommand({
        cmd: [codexBin, "sandbox", "-P", "orbs-workspace", "-C", cwd, "/usr/bin/env", "agent-browser", "get", "url"],
        stdin: "",
        env: strippedExecutorEnvironment,
        inheritEnv: false,
        timeoutMs: 5_000,
        cleanupOnFailure: true,
      });
      expect(missingSocket.exitCode).not.toBe(0);
      expect(`${missingSocket.stdout}${missingSocket.stderr}`).toContain("frozen browser daemon socket is unavailable");
      await rename(hiddenSocketPath, socketPath);
      expect(existsSync(socketPath)).toBe(true);
      const daemonPidReadback = await runLocalCommand({
        cmd: ["/usr/sbin/lsof", "-t", "--", socketPath],
        stdin: "",
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
        inheritEnv: false,
        timeoutMs: 5_000,
      });
      const daemonPids = daemonPidReadback.stdout.trim().split(/\s+/).filter(Boolean);
      expect(daemonPids).toHaveLength(1);
      expect(daemonPids).toEqual(initialDaemonPids);
      const browserProcessReadback = await runLocalCommand({
        cmd: ["/bin/ps", "-axo", "pid=,command="],
        stdin: "",
        env: { PATH: "/usr/bin:/bin" },
        inheritEnv: false,
        timeoutMs: 5_000,
      });
      const browserPids = browserProcessReadback.stdout
        .split(/\r?\n/)
        .filter((line) => line.includes(join(execution!.capabilities!.browser!.homeDirectory, "chrome-profile")))
        .map((line) => line.trim().split(/\s+/, 1)[0]!)
        .filter(Boolean);
      expect(browserPids.length).toBeGreaterThan(0);
      await execution!.cleanup?.();
      expect(existsSync(socketPath)).toBe(false);
      const terminated = await runLocalCommand({
        cmd: ["/bin/ps", "-o", "state=", "-p", [...daemonPids, ...browserPids].join(",")],
        stdin: "",
        env: { PATH: "/usr/bin:/bin" },
        inheritEnv: false,
        timeoutMs: 5_000,
      });
      expect(terminated.stdout.split(/\s+/).filter(Boolean).every((state) => state.startsWith("Z"))).toBe(true);
    } finally {
      server.stop(true);
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      await rm(protectedHome, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
    }
  }, 35_000);

  test.skipIf(process.platform !== "darwin")("codex executor cleans frozen loopback relays when command startup fails", async () => {
    const cwd = await mkdtemp(join(process.cwd(), ".orbs-host-cleanup-canary-"));
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("unused") });
    let relayPath = "";
    try {
      const executor = createCodexCliExecutor({
        cwd,
        sandbox: "workspace-write",
        hostExecutionCapabilities: {
          schemaVersion: 1,
          loopback: { host: "127.0.0.1", ports: [server.port] },
        },
        taskRole: "worker",
        runCommand: async ({ env }) => {
          const socketMap = JSON.parse(env?.ORBS_LOOPBACK_SOCKET_MAP ?? "{}") as Record<string, string>;
          relayPath = socketMap[String(server.port)] ?? "";
          expect(existsSync(relayPath)).toBe(true);
          throw new Error("synthetic command startup failure");
        },
      });
      await expect(executor({
        prompt: "Exercise cleanup",
        sessionName: "cleanup",
        run: { ...runFixture, projectRoot: cwd },
        route: routeFixture,
        task: {
          id: "task_cleanup",
          runId: "run_1",
          parentId: null,
          cycleId: "task_cleanup",
          status: "todo",
          role: "worker",
          goal: "Cleanup",
          prompt: "Exercise cleanup",
          dependsOn: [],
          doneWhen: [],
          worktreePath: cwd,
          sessionRef: null,
          contextVersion: 1,
        },
      })).rejects.toThrow("synthetic command startup failure");
      expect(relayPath).not.toBe("");
      expect(existsSync(relayPath)).toBe(false);
    } finally {
      server.stop(true);
      await rm(cwd, { recursive: true, force: true });
    }
  }, 10_000);

  test("derives a stable protected runtime identity for a synthetic executor cwd", () => {
    expect(protectedCodexRuntimeRoot("/repo")).toBe(protectedCodexRuntimeRoot("/repo"));
  });

  test("runs codex exec through an injectable command runner", async () => {
    const calls: Array<{ cmd: string[]; stdin: string }> = [];
    const executor = createCodexCliExecutor({
      cwd: "/repo",
      sandbox: "read-only",
      codexBin: "/custom/codex",
      runCommand: async ({ cmd, stdin }) => {
        calls.push({ cmd, stdin });
        const outputPath = cmd[cmd.indexOf("--output-last-message") + 1];
        await writeFile(
          outputPath,
          '{"status":"done","summary":"planned","changedFiles":[],"checks":[],"artifacts":[],"problems":[]}',
        );
        return {
          exitCode: 0,
          stdout: "OpenAI Codex logs before final response",
          stderr: "",
        };
      },
    });

    const output = await executor({
      prompt: "Plan next task",
      sessionName: "task_1",
      run: runFixture,
      route: routeFixture,
      task: {
        id: "task_1",
        runId: "run_1",
        parentId: null,
        cycleId: "task_1",
        status: "todo",
        role: "planner",
        goal: "Task",
        prompt: "Plan",
        dependsOn: [],
        doneWhen: [],
        worktreePath: null,
        sessionRef: null,
        contextVersion: 1,
      },
    });

    expect(calls).toEqual([
      {
        cmd: [
          "/custom/codex",
          "exec",
          "--skip-git-repo-check",
          "--ignore-user-config",
          "-c",
          'approval_policy="never"',
          "--output-last-message",
          expect.any(String),
          "-C",
          "/repo",
          "--sandbox",
          "read-only",
          "-",
        ],
        stdin: "Plan next task",
      },
    ]);
    expect(output.status).toBe("done");
    expect(output.summary).toBe("planned");
  });

  test("direct codex cli executor blocks ASCII prompts above the character budget without invoking runCommand", async () => {
    let commandCalls = 0;
    const executor = createCodexCliExecutor({
      cwd: "/repo",
      runCommand: async () => {
        commandCalls += 1;
        throw new Error("runCommand should not be called");
      },
    });

    const output = await executor({
      prompt: `ASCII_PROMPT_${"x".repeat(900_001)}`,
      sessionName: "oversized-ascii",
      run: runFixture,
      route: routeFixture,
      task: {
        id: "task_ascii",
        runId: "run_1",
        parentId: null,
        cycleId: "task_ascii",
        status: "todo",
        role: "worker",
        goal: "Reject oversized ASCII",
        prompt: "Reject oversized ASCII",
        dependsOn: [],
        doneWhen: [],
        worktreePath: null,
        sessionRef: null,
        contextVersion: 1,
      },
    });

    expect(commandCalls).toBe(0);
    expect(output.status).toBe("blocked");
    expect(output.summary).toContain("input_too_large");
    expect(output.artifacts).toContainEqual(expect.objectContaining({
      kind: "prompt_input_budget_exceeded",
      characterLimit: 900_000,
      utf8ByteLimit: 900_000,
    }));
  });

  test("direct codex cli executor blocks high-byte Unicode prompts above the UTF-8 budget without invoking runCommand", async () => {
    let commandCalls = 0;
    const executor = createCodexCliExecutor({
      cwd: "/repo",
      runCommand: async () => {
        commandCalls += 1;
        throw new Error("runCommand should not be called");
      },
    });

    const output = await executor({
      prompt: `UNICODE_PROMPT_${"界".repeat(400_000)}`,
      sessionName: "oversized-unicode",
      run: runFixture,
      route: routeFixture,
      task: {
        id: "task_unicode",
        runId: "run_1",
        parentId: null,
        cycleId: "task_unicode",
        status: "todo",
        role: "worker",
        goal: "Reject oversized Unicode",
        prompt: "Reject oversized Unicode",
        dependsOn: [],
        doneWhen: [],
        worktreePath: null,
        sessionRef: null,
        contextVersion: 1,
      },
    });

    expect(commandCalls).toBe(0);
    expect(output.status).toBe("blocked");
    expect(output.summary).toContain("input_too_large");
    expect(output.artifacts).toContainEqual(expect.objectContaining({
      kind: "prompt_input_budget_exceeded",
      characters: 400_015,
      utf8Bytes: 1_200_015,
      characterLimit: 900_000,
      utf8ByteLimit: 900_000,
    }));
  });

  test("falls back to stdout when no output file is present", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ouroboros-codex-"));
    try {
      const executor = createCodexCliExecutor({
        cwd: "/repo",
        outputDir: dir,
        runCommand: async () => ({
          exitCode: 0,
          stdout: '{"status":"done","summary":"stdout","changedFiles":[],"checks":[],"artifacts":[],"problems":[]}',
          stderr: "",
        }),
      });

      const output = await executor({
        prompt: "Plan next task",
        sessionName: "task_1",
        run: runFixture,
      route: routeFixture,
        task: {
          id: "task_1",
          runId: "run_1",
          parentId: null,
        cycleId: "task_1",
        status: "todo",
          role: "planner",
          goal: "Task",
          prompt: "Plan",
          dependsOn: [],
          doneWhen: [],
          worktreePath: null,
          sessionRef: null,
          contextVersion: 1,
        },
      });

      expect(output.summary).toBe("stdout");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("passes an explicit model to codex exec", async () => {
    const calls: Array<{ cmd: string[] }> = [];
    const executor = createCodexCliExecutor({
      cwd: "/repo",
      model: "gpt-5.6-luna",
      reasoningEffort: "high",
      runCommand: async ({ cmd }) => {
        calls.push({ cmd });
        return {
          exitCode: 0,
          stdout: '{"status":"done","summary":"ok","changedFiles":[],"checks":[],"artifacts":[],"problems":[]}',
          stderr: "",
        };
      },
    });

    await executor({
      prompt: "Plan next task",
      sessionName: "task_1",
      run: runFixture,
      route: routeFixture,
      task: {
        id: "task_1",
        runId: "run_1",
        parentId: null,
        cycleId: "task_1",
        status: "todo",
        role: "planner",
        goal: "Task",
        prompt: "Plan",
        dependsOn: [],
        doneWhen: [],
        worktreePath: null,
        sessionRef: null,
        contextVersion: 1,
      },
    });

    expect(calls[0].cmd).toContain("-m");
    expect(calls[0].cmd).toContain("gpt-5.6-luna");
    expect(calls[0].cmd).toContain('model_reasoning_effort="high"');
  });

  test("passes hard and idle timeouts to the command runner", async () => {
    const calls: Array<{ timeoutMs?: number; idleTimeoutMs?: number }> = [];
    const executor = createCodexCliExecutor({
      cwd: "/repo",
      timeoutMs: 900000,
      idleTimeoutMs: 300000,
      runCommand: async ({ timeoutMs, idleTimeoutMs }) => {
        calls.push({ timeoutMs, idleTimeoutMs });
        return {
          exitCode: 0,
          stdout: '{"status":"done","summary":"ok","changedFiles":[],"checks":[],"artifacts":[],"problems":[]}',
          stderr: "",
        };
      },
    });

    await executor({
      prompt: "Plan next task",
      sessionName: "task_1",
      run: runFixture,
      route: routeFixture,
      task: {
        id: "task_1",
        runId: "run_1",
        parentId: null,
        cycleId: "task_1",
        status: "todo",
        role: "planner",
        goal: "Task",
        prompt: "Plan",
        dependsOn: [],
        doneWhen: [],
        worktreePath: null,
        sessionRef: null,
        contextVersion: 1,
      },
    });

    expect(calls).toEqual([{ timeoutMs: 900000, idleTimeoutMs: 300000 }]);
  });

  test("returns a blocked output when codex succeeds without structured JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ouroboros-codex-"));
    try {
      const executor = createCodexCliExecutor({
        cwd: "/repo",
        outputDir: dir,
        runCommand: async () => ({
          exitCode: 0,
          stdout: "Codex completed without final JSON",
          stderr: "",
        }),
      });

      const output = await executor({
        prompt: "Plan next task",
        sessionName: "task_1",
        run: runFixture,
      route: routeFixture,
        task: {
          id: "task_1",
          runId: "run_1",
          parentId: null,
        cycleId: "task_1",
        status: "todo",
          role: "planner",
          goal: "Task",
          prompt: "Plan",
          dependsOn: [],
          doneWhen: [],
          worktreePath: null,
          sessionRef: null,
          contextVersion: 1,
        },
      });

      expect(output).toEqual({
        status: "blocked",
        summary: "codex cli executor produced invalid output",
        changedFiles: [],
        checks: [{ name: "codex output parse", status: "failed" }],
        artifacts: [],
        problems: ["agent output did not contain a JSON object\n\nOutput:\nCodex completed without final JSON"],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("includes exit code stdout and stderr when codex exec fails", async () => {
    const executor = createCodexCliExecutor({
      cwd: "/repo",
      runCommand: async () => ({
        exitCode: 1,
        stdout: "codex stdout",
        stderr: "codex stderr",
      }),
    });

    const output = await executor({
      prompt: "Plan next task",
      sessionName: "task_1",
      run: runFixture,
      route: routeFixture,
      task: {
        id: "task_1",
        runId: "run_1",
        parentId: null,
        cycleId: "task_1",
        status: "todo",
        role: "planner",
        goal: "Task",
        prompt: "Plan",
        dependsOn: [],
        doneWhen: [],
        worktreePath: null,
        sessionRef: null,
        contextVersion: 1,
      },
    });

    expect(output.problems).toEqual(["exit code: 1\n\nstdout:\ncodex stdout\n\nstderr:\ncodex stderr"]);
  });

  test("bounds and redacts failed command diagnostics with head tail digest and original size", async () => {
    const middleSentinel = `UNBOUNDED_COMMAND_MIDDLE_${"m".repeat(80_000)}`;
    const executor = createCodexCliExecutor({
      cwd: "/repo",
      runCommand: async () => ({
        exitCode: 1,
        stdout: `STDOUT_HEAD token=ghp_secretvalue\n${"a".repeat(10_000)}${middleSentinel}${"z".repeat(10_000)}\nSTDOUT_TAIL`,
        stderr: `STDERR_HEAD password=super-secret\n${"a".repeat(10_000)}${middleSentinel}${"z".repeat(10_000)}\nSTDERR_TAIL`,
      }),
    });

    const output = await executor({
      prompt: "Plan next task",
      sessionName: "task_1",
      run: runFixture,
      route: routeFixture,
      task: {
        id: "task_1",
        runId: "run_1",
        parentId: null,
        cycleId: "task_1",
        status: "todo",
        role: "planner",
        goal: "Task",
        prompt: "Plan",
        dependsOn: [],
        doneWhen: [],
        worktreePath: null,
        sessionRef: null,
        contextVersion: 1,
      },
    });

    const problem = output.problems?.[0] ?? "";
    expect(problem.length).toBeLessThan(20_000);
    expect(problem).toContain("STDOUT_HEAD");
    expect(problem).toContain("STDOUT_TAIL");
    expect(problem).toContain("STDERR_HEAD");
    expect(problem).toContain("STDERR_TAIL");
    expect(problem).toContain("sha256=");
    expect(problem).toContain("originalChars=");
    expect(problem).toContain("[REDACTED]");
    expect(problem).not.toContain("UNBOUNDED_COMMAND_MIDDLE");
    expect(problem).not.toContain("ghp_secretvalue");
    expect(problem).not.toContain("super-secret");
  });

  test("resumable client returns running when a json event stream times out after session creation", async () => {
    const calls: Array<{ cmd: string[]; stdin: string; timeoutMs?: number; idleTimeoutMs?: number }> = [];
    const client = createCodexResumableClient({
      cwd: "/repo",
      codexBin: "/custom/codex",
      model: "gpt-5-mini",
      timeoutMs: 900000,
      idleTimeoutMs: 300000,
      runCommand: async ({ cmd, stdin, timeoutMs, idleTimeoutMs }) => {
        calls.push({ cmd, stdin, timeoutMs, idleTimeoutMs });
        return {
          exitCode: 124,
          stdout: [
            JSON.stringify({ type: "thread.started", thread_id: "session_123" }),
            JSON.stringify({ type: "agent.message.delta", delta: "thinking" }),
          ].join("\n"),
          stderr: "command idle timed out after 300000ms",
        };
      },
    });

    const result = await client.start({
      prompt: "Plan next task",
      sessionName: "task_1",
    });

    expect(result).toEqual({
      status: "running",
      sessionId: "session_123",
      outputPath: expect.any(String),
      stdout: expect.stringContaining("thread.started"),
      stderr: "command idle timed out after 300000ms",
      events: [
        { type: "thread.started", thread_id: "session_123" },
        { type: "agent.message.delta", delta: "thinking" },
      ],
    });
    expect(calls[0]).toMatchObject({
      cmd: [
        "/custom/codex",
        "exec",
        "-m",
        "gpt-5-mini",
        "--json",
        "--skip-git-repo-check",
        "--ignore-user-config",
        "-c",
        'approval_policy="never"',
        "--output-last-message",
        expect.any(String),
        "-C",
        "/repo",
        "--sandbox",
        "read-only",
        "-",
      ],
      stdin: "Plan next task",
      timeoutMs: 900000,
      idleTimeoutMs: 300000,
    });
  });

  test("resumable client extracts nested session ids from codex json events", async () => {
    const client = createCodexResumableClient({
      cwd: "/repo",
      codexBin: "/custom/codex",
      runCommand: async () => ({
        exitCode: 124,
        stdout: [
          JSON.stringify({ type: "session.created", payload: { session: { id: "ignored", sessionId: "nested_session" } } }),
          JSON.stringify({ type: "agent.message.delta", delta: "thinking" }),
        ].join("\n"),
        stderr: "command idle timed out after 300000ms",
      }),
    });

    const result = await client.start({
      prompt: "Plan next task",
      sessionName: "task_1",
    });

    expect(result).toMatchObject({
      status: "running",
      sessionId: "nested_session",
    });
  });

  test("resumable client streams stdout and parsed json events", async () => {
    const observedChunks: string[] = [];
    const observedEvents: Array<Record<string, unknown>> = [];
    const client = createCodexResumableClient({
      cwd: "/repo",
      codexBin: "/custom/codex",
      runCommand: async ({ onStdout }) => {
        onStdout?.(`${JSON.stringify({ type: "session.started", session_id: "session_123" })}\n`);
        onStdout?.(`${JSON.stringify({ type: "agent.message.delta", delta: "thinking" })}\n`);
        return {
          exitCode: 124,
          stdout: [
            JSON.stringify({ type: "session.started", session_id: "session_123" }),
            JSON.stringify({ type: "agent.message.delta", delta: "thinking" }),
          ].join("\n"),
          stderr: "command idle timed out after 300000ms",
        };
      },
    });

    await client.start({
      prompt: "Plan next task",
      sessionName: "task_1",
      onStdout: (chunk) => observedChunks.push(chunk),
      onEvent: (event) => observedEvents.push(event),
    });

    expect(observedChunks.join("")).toContain("session.started");
    expect(observedEvents).toEqual([
      { type: "session.started", session_id: "session_123" },
      { type: "agent.message.delta", delta: "thinking" },
    ]);
  });

  test("resumable client enforces a browser process deny policy", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "orbs-codex-browser-policy-"));
    const calls: Array<{ cmd: string[]; env?: Record<string, string | undefined> }> = [];
    const client = createCodexResumableClient({
      cwd,
      codexBin: "/custom/codex",
      browserProcessPolicy: "deny",
      runCommand: async ({ cmd, env }) => {
        calls.push({ cmd, env });
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            type: "agent.message",
            message: '{"status":"done","summary":"reviewed","changedFiles":[],"checks":[],"artifacts":[],"problems":[]}',
          }),
          stderr: "",
        };
      },
    });

    await client.start({ prompt: "Review without a browser", sessionName: "goal-review" });

    expect(calls[0]?.cmd.slice(0, 2)).toEqual(["/custom/codex", "exec"]);
    expect(calls[0]?.cmd).not.toContain("danger-full-access");
    if (process.platform === "darwin") {
      expect(calls[0]?.cmd).not.toContain("--sandbox");
      expect(calls[0]?.cmd).not.toContain("--ignore-user-config");
      expect(calls[0]?.cmd).toContain("--strict-config");
      expect(calls[0]?.env?.CODEX_HOME).toContain("ouroboros-codex-runtime");
    } else {
      expect(calls[0]?.cmd).toContain("--sandbox");
      expect(calls[0]?.cmd).toContain("read-only");
    }
    expect(calls[0]?.env?.ORBS_BROWSER_PROCESS_POLICY).toBe("deny");
    await rm(cwd, { recursive: true, force: true });
  });

  test.skipIf(process.platform !== "darwin")("protected Codex profile hides runtime credentials and limits writes to the worktree", async () => {
    const dir = await mkdtemp(join(process.cwd(), ".orbs-protected-codex-"));
    const outside = `${dir}-outside.txt`;
    try {
      const execution = await prepareCodexHostExecution({
        cwd: dir,
        sandbox: "workspace-write",
        browserProcessPolicy: "deny",
        injectedRunCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      });
      expect(execution).not.toBeNull();
      const codexHome = execution!.env.CODEX_HOME;
      await writeFile(join(codexHome, "private-proof.txt"), "secret-token", "utf8");
      const codexBin = "/Applications/ChatGPT.app/Contents/Resources/codex";

      const inside = await runLocalCommand({
        cmd: [codexBin, "sandbox", "-P", "orbs-workspace", "-C", dir, "/bin/sh", "-c", "printf ok > inside.txt"],
        stdin: "",
        env: execution!.env,
      });
      expect(inside.exitCode).toBe(0);
      expect(await Bun.file(join(dir, "inside.txt")).text()).toBe("ok");

      const credentials = await runLocalCommand({
        cmd: [codexBin, "sandbox", "-P", "orbs-workspace", "-C", dir, "/bin/cat", join(codexHome, "private-proof.txt")],
        stdin: "",
        env: execution!.env,
      });
      expect(credentials.exitCode).not.toBe(0);
      expect(credentials.stdout).not.toContain("secret-token");

      const credentialsWrite = await runLocalCommand({
        cmd: [codexBin, "sandbox", "-P", "orbs-workspace", "-C", dir, "/bin/sh", "-c", `printf replaced > ${JSON.stringify(join(codexHome, "private-proof.txt"))}`],
        stdin: "",
        env: execution!.env,
      });
      expect(credentialsWrite.exitCode).not.toBe(0);
      expect(await Bun.file(join(codexHome, "private-proof.txt")).text()).toBe("secret-token");

      const sourceCredentials = await runLocalCommand({
        cmd: [codexBin, "sandbox", "-P", "orbs-workspace", "-C", dir, "/bin/sh", "-c", `/bin/cat ${JSON.stringify(join(process.env.HOME ?? "", ".codex", "auth.json"))} >/dev/null`],
        stdin: "",
        env: execution!.env,
      });
      expect(sourceCredentials.exitCode).not.toBe(0);

      const outsideWrite = await runLocalCommand({
        cmd: [codexBin, "sandbox", "-P", "orbs-workspace", "-C", dir, "/bin/sh", "-c", `printf denied > ${JSON.stringify(outside)}`],
        stdin: "",
        env: execution!.env,
      });
      expect(outsideWrite.exitCode).not.toBe(0);
      expect(await Bun.file(outside).exists()).toBe(false);

      const readOnly = await runLocalCommand({
        cmd: [codexBin, "sandbox", "-P", "orbs-read-only", "-C", dir, "/bin/sh", "-c", "printf denied > read-only.txt"],
        stdin: "",
        env: execution!.env,
      });
      expect(readOnly.exitCode).not.toBe(0);
      expect(await Bun.file(join(dir, "read-only.txt")).exists()).toBe(false);

      const openBaseline = await runLocalCommand({
        cmd: ["/bin/sh", "-c", 'p=/usr/bin/o; "$p"pen -Ra Safari'],
        stdin: "",
      });
      expect(openBaseline.exitCode).toBe(0);

      const open = await runLocalCommand({
        cmd: [codexBin, "sandbox", "-P", "orbs-workspace", "-C", dir, "/bin/sh", "-c", 'p=/usr/bin/o; "$p"pen -Ra Safari'],
        stdin: "",
        env: execution!.env,
      });
      expect(open.exitCode).not.toBe(0);

      const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
      if (await Bun.file(chrome).exists()) {
        const browser = await runLocalCommand({
          cmd: [codexBin, "sandbox", "-P", "orbs-workspace", "-C", dir, "/bin/sh", "-c", `p=${JSON.stringify(chrome)}; "$p" --version`],
          stdin: "",
          env: execution!.env,
        });
        expect(browser.exitCode).not.toBe(0);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(outside, { force: true });
    }
  }, 10_000);

  test.skipIf(process.platform !== "darwin")("protected Codex runtime rejects a precreated auth symlink before copying credentials", async () => {
    const dir = await mkdtemp(join(process.cwd(), ".orbs-protected-codex-symlink-"));
    const sourceHome = await mkdtemp(join(tmpdir(), "orbs-source-codex-home-"));
    const runtimeBase = await mkdtemp(join(tmpdir(), "orbs-protected-runtime-"));
    const leakedAuth = join(dir, "leaked-auth.json");
    const previousCodexHome = process.env.CODEX_HOME;
    const previousRuntimeRoot = process.env.ORBS_CODEX_RUNTIME_ROOT;
    try {
      process.env.CODEX_HOME = sourceHome;
      process.env.ORBS_CODEX_RUNTIME_ROOT = runtimeBase;
      await writeFile(join(sourceHome, "auth.json"), "host-secret", "utf8");
      const runtimeRoot = protectedCodexRuntimeRoot(dir);
      await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
      await symlink(leakedAuth, join(runtimeRoot, "auth.json"));

      await expect(prepareCodexHostExecution({
        cwd: dir,
        sandbox: "workspace-write",
        browserProcessPolicy: "deny",
      })).rejects.toThrow("unsafe existing node");
      expect(await Bun.file(leakedAuth).exists()).toBe(false);
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      if (previousRuntimeRoot === undefined) delete process.env.ORBS_CODEX_RUNTIME_ROOT;
      else process.env.ORBS_CODEX_RUNTIME_ROOT = previousRuntimeRoot;
      await rm(dir, { recursive: true, force: true });
      await rm(sourceHome, { recursive: true, force: true });
      await rm(runtimeBase, { recursive: true, force: true });
    }
  });

  test("resumable client rejects danger-full-access before launching Codex", async () => {
    let calls = 0;
    const client = createCodexResumableClient({
      cwd: "/repo",
      codexBin: "/custom/codex",
      sandbox: "danger-full-access",
      runCommand: async () => {
        calls += 1;
        throw new Error("danger-full-access must not launch");
      },
    });

    const result = await client.start({ prompt: "write without limits", sessionName: "danger" });

    expect(calls).toBe(0);
    expect(result.status).toBe("blocked");
    if (result.status === "running") throw new Error("expected blocked result");
    expect(result.output.summary).toContain("host_sandbox_capability_unavailable");
    expect(result.output.artifacts).toContainEqual(expect.objectContaining({
      kind: "host_sandbox_capability",
      requestedSandbox: "danger-full-access",
      recoverable: false,
    }));
  });

  test.skipIf(process.platform !== "darwin")("resumable client fails before launch when its host is already inside seatbelt", async () => {
    const previousSandbox = process.env.CODEX_SANDBOX;
    let calls = 0;
    try {
      process.env.CODEX_SANDBOX = "seatbelt";
      const client = createCodexResumableClient({
        cwd: "/repo",
        codexBin: "/custom/codex",
        sandbox: "workspace-write",
        runCommand: async () => {
          calls += 1;
          throw new Error("nested codex must not launch");
        },
      });

      const start = await client.start({ prompt: "write safely", sessionName: "nested-start" });
      const resume = await client.resume({
        sessionId: "session_nested",
        prompt: "continue safely",
        sessionName: "nested-resume",
      });

      expect(calls).toBe(0);
      for (const result of [start, resume]) {
        expect(result.status).toBe("blocked");
        if (result.status === "running") throw new Error("expected blocked result");
        expect(result.output.summary).toContain("host_sandbox_capability_unavailable");
        expect(result.output.artifacts).toContainEqual(expect.objectContaining({
          kind: "host_sandbox_capability",
          requestedSandbox: "workspace-write",
          hostSandbox: "seatbelt",
          recoverable: true,
        }));
      }
    } finally {
      if (previousSandbox === undefined) delete process.env.CODEX_SANDBOX;
      else process.env.CODEX_SANDBOX = previousSandbox;
    }
  });

  test("resumable client resumes a session and parses the final attempt output", async () => {
    const calls: Array<{ cmd: string[]; stdin: string }> = [];
    const client = createCodexResumableClient({
      cwd: "/repo",
      codexBin: "/custom/codex",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      runCommand: async ({ cmd, stdin }) => {
        calls.push({ cmd, stdin });
        return {
          exitCode: 0,
          stdout: [
            JSON.stringify({ type: "session.started", session_id: "session_123" }),
            JSON.stringify({
              type: "agent.message",
              message:
                '{"status":"done","summary":"planned","changedFiles":[],"checks":[],"artifacts":[],"problems":[]}',
            }),
          ].join("\n"),
          stderr: "",
        };
      },
    });

    const result = await client.resume({
      sessionId: "session_123",
      prompt: "continue",
      sessionName: "task_1",
    });

    expect(result.status).toBe("done");
    if (result.status === "running") {
      throw new Error("expected finished result");
    }
    expect(result.output).toMatchObject({
      status: "done",
      summary: "planned",
    });
    expect(calls[0].cmd).toEqual([
      "/custom/codex",
      "exec",
      "-m",
      "gpt-5.6-sol",
      "-c",
      'model_reasoning_effort="high"',
      "--json",
      "--skip-git-repo-check",
      "--ignore-user-config",
      "-c",
      'approval_policy="never"',
      "--output-last-message",
      expect.any(String),
      "-C",
      "/repo",
      "--sandbox",
      "read-only",
      "resume",
      "session_123",
      "-",
    ]);
    expect(calls[0].stdin).toBe("continue");
  });

  test("resumable client returns compact input_too_large results without invoking start or resume commands", async () => {
    let commandCalls = 0;
    const client = createCodexResumableClient({
      cwd: "/repo",
      codexBin: "/custom/codex",
      runCommand: async () => {
        commandCalls += 1;
        throw new Error("runCommand should not be called");
      },
    });
    const oversized = `OVERSIZED_DIRECT_CODEX_INPUT_${"界".repeat(910_000)}`;

    const startResult = await client.start({ prompt: oversized, sessionName: "oversized-start" });
    const resumeResult = await client.resume({
      sessionId: "session_oversized",
      prompt: oversized,
      sessionName: "oversized-resume",
    });

    expect(commandCalls).toBe(0);
    for (const result of [startResult, resumeResult]) {
      expect(result.status).toBe("blocked");
      if (result.status === "running") throw new Error("expected blocked result");
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
      expect(result.events).toEqual([]);
      expect(result.output.summary).toContain("input_too_large");
      expect(result.output.artifacts).toContainEqual(expect.objectContaining({
        kind: "prompt_input_budget_exceeded",
        characterLimit: 900_000,
        utf8ByteLimit: 900_000,
      }));
    }
  });
});

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync({ cmd: ["git", "-C", cwd, ...args], stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return new TextDecoder().decode(result.stdout).trim();
}
