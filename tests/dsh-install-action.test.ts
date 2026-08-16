import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readlink, rm, writeFile } from "node:fs/promises";
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyHarnessAction, Harness } from "../packages/harness/src";

describe("local DSH installation action", () => {
  let dir: string;
  let harness: Harness;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "orbs-dsh-install-action-"));
    harness = new Harness(join(dir, "orbs.db"));
    harness.init();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("builds the pinned checkout, probes the artifact, and atomically binds the launcher", async () => {
    const sourceRepoPath = join(dir, "deepseek-harness");
    const artifactPath = join(sourceRepoPath, "apps", "cli", "lib", "bin.js");
    const executablePath = join(dir, "bin", "dsh");
    await mkdir(join(sourceRepoPath, "apps", "cli", "src"), { recursive: true });
    await writeFile(join(sourceRepoPath, "package.json"), JSON.stringify({
      name: "@deepseek-ai/dsh-root",
      private: true,
      packageManager: "pnpm@11.7.0",
      scripts: { "build:lib:host": "tsc -b tsconfig.host.json && tsdown --env.DSH_BUILD_FACE host" },
    }));
    await writeFile(join(sourceRepoPath, "apps", "cli", "package.json"), JSON.stringify({
      name: "@deepseek-ai/dsh",
      version: "0.1.0-rc.5",
      bin: { dsh: "lib/bin.js" },
    }));
    await writeFile(join(sourceRepoPath, "apps", "cli", "src", "bin.ts"), "console.log('source')\n");
    git(sourceRepoPath, ["init"]);
    git(sourceRepoPath, ["config", "user.email", "fixture@example.test"]);
    git(sourceRepoPath, ["config", "user.name", "Fixture"]);
    git(sourceRepoPath, ["add", "."]);
    git(sourceRepoPath, ["commit", "-m", "fixture"]);
    const expectedHead = git(sourceRepoPath, ["rev-parse", "HEAD"]);
    await mkdir(join(sourceRepoPath, "node_modules", "typescript", "bin"), { recursive: true });
    await mkdir(join(sourceRepoPath, "node_modules", "tsdown", "dist"), { recursive: true });
    await writeFile(join(sourceRepoPath, "node_modules", "typescript", "bin", "tsc"), "// fixture\n");
    await writeFile(join(sourceRepoPath, "node_modules", "tsdown", "dist", "run.mjs"), "// fixture\n");
    const runId = harness.createRun({
      goal: "Install pinned DSH",
      context: {
        source: "design",
        runtimeIntegrationBoundary: {
          repositories: [{ id: "dsh-source", repoPath: sourceRepoPath, expectedHead, access: "read-only" }],
        },
      },
    });
    const commands: string[] = [];
    let buildOutputLimit = 0;

    const result = applyHarnessAction(harness, {
      type: "installLocalDshCli",
      runId,
      sourceRepoPath,
      expectedHead,
      executablePath,
    } as never, {
      runCommand: (input) => {
        commands.push(input.command);
        if (input.command.includes("typescript/bin/tsc") && input.command.includes("tsdown") && input.command.includes("DSH_BUILD_FACE")) {
          buildOutputLimit = input.maxOutputBytes ?? 0;
          mkdirSync(join(sourceRepoPath, "apps", "cli", "lib"), { recursive: true });
          writeFileSync(artifactPath, "#!/usr/bin/env node\nconsole.log('0.1.0-rc.5')\n");
          chmodSync(artifactPath, 0o755);
          return { exitCode: 0, stdout: "built\n", stderr: "" };
        }
        if (input.command.endsWith(" --version") && input.command.includes("node")) return { exitCode: 0, stdout: "v25.5.0\n", stderr: "" };
        if (input.command.endsWith(" --version")) return { exitCode: 0, stdout: "0.1.0-rc.5\n", stderr: "" };
        if (input.command.endsWith(" --help")) return { exitCode: 0, stdout: "Usage: dsh [options]\n", stderr: "" };
        throw new Error(`unexpected command: ${input.command}`);
      },
    });
    const receipt = result.artifacts[0] as { executableRealpath?: string };

    expect(result).toMatchObject({
      status: "done",
      actionType: "installLocalDshCli",
      artifacts: [expect.objectContaining({
        kind: "local_dsh_installation_receipt",
        sourceHead: expectedHead,
        artifactSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        executablePath,
        executableRealpath: expect.any(String),
        buildCommand: expect.stringContaining("tsdown"),
        launchability: { version: "passed", help: "passed" },
      })],
    });
    expect(receipt.executableRealpath).toBe(realpathSync(artifactPath));
    expect(await readlink(executablePath)).toBe(realpathSync(artifactPath));
    expect(commands).toHaveLength(4);
    expect(buildOutputLimit).toBe(64 * 1024 * 1024);
    expect(harness.getRun(runId)?.context.dshInstallationReceipt).toMatchObject({ sourceHead: expectedHead });

    const replay = applyHarnessAction(harness, {
      type: "installLocalDshCli", runId, sourceRepoPath, expectedHead, executablePath,
    } as never, { runCommand: () => { throw new Error("replay must not rebuild"); } });
    expect(replay).toMatchObject({ status: "done", artifacts: [expect.objectContaining({ reused: true })] });
    expect(commands).toHaveLength(4);
  });
});

function git(cwd: string, args: string[]) {
  const result = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
