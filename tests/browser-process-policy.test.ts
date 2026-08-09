import { describe, expect, test } from "bun:test";
import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyBrowserProcessPolicy,
  withBrowserProcessPolicy,
} from "../packages/runner/src/executors/browser-process-policy";
import { runLocalCommand } from "../packages/runner/src/executors/command";

describe("browser process policy", () => {
  test("uses a fixed deny command for browser control and shell entry points inside seatbelt", () => {
    const applyForHost = applyBrowserProcessPolicy as unknown as (
      cmd: string[],
      policy: "allow" | "deny",
      host: { platform: NodeJS.Platform; nestedSeatbelt: boolean },
    ) => string[];
    const deniedCommands = [
      ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "https://example.test"],
      ["Google Chrome", "https://example.test"],
      ["/usr/bin/open", "https://example.test"],
      ["open", "https://example.test"],
      ["/usr/bin/osascript", "-e", "tell application \"Safari\" to activate"],
      ["osascript", "-e", "tell application \"Safari\" to activate"],
      ["/bin/bash", "-c", "open https://example.test"],
      ["bash", "-c", "osascript -e 'tell application \"Safari\" to activate'"],
      ["/bin/zsh", "-c", "'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'"],
      ["zsh", "-c", "open https://example.test"],
      ["/bin/sh", "-c", "osascript -e 'tell application \"Safari\" to activate'"],
      ["sh", "-c", "open https://example.test"],
    ];

    for (const cmd of deniedCommands) {
      expect(applyForHost(cmd, "deny", { platform: "darwin", nestedSeatbelt: true })).toEqual([
        "/usr/bin/false",
      ]);
    }
  });

  test("does not add a second seatbelt around agent launchers", () => {
    const applyForHost = applyBrowserProcessPolicy as unknown as (
      cmd: string[],
      policy: "allow" | "deny",
      host: { platform: NodeJS.Platform; nestedSeatbelt: boolean },
    ) => string[];
    const commands = [
      ["acpx", "--cwd", "/tmp/repo", "codex", "sessions", "show", "session-1"],
      [
        "/Applications/ChatGPT.app/Contents/Resources/codex",
        "exec",
        "--sandbox",
        "workspace-write",
        "-",
      ],
      ["/usr/bin/git", "status", "--short"],
    ];

    for (const cmd of commands) {
      expect(applyForHost(cmd, "deny", { platform: "darwin", nestedSeatbelt: true })).toEqual(cmd);
    }
  });

  test.skipIf(process.platform !== "darwin")("denies browser executables launched by nested child processes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbs-browser-policy-"));
    const fakeBrowser = join(dir, "Google Chrome");
    const marker = join(dir, "browser-launched.txt");
    const previousSandbox = process.env.CODEX_SANDBOX;
    await writeFile(fakeBrowser, `#!/bin/sh\nprintf launched > ${JSON.stringify(marker)}\n`);
    await chmod(fakeBrowser, 0o755);

    try {
      process.env.CODEX_SANDBOX = "seatbelt";
      const runCommand = withBrowserProcessPolicy(runLocalCommand, "deny");
      const result = await runCommand({
        cmd: ["/bin/sh", "-c", `${JSON.stringify(fakeBrowser)} >/dev/null 2>&1; printf guarded`],
        stdin: "",
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).not.toContain("sandbox_init");
      await expect(access(marker)).rejects.toThrow();
    } finally {
      if (previousSandbox === undefined) {
        delete process.env.CODEX_SANDBOX;
      } else {
        process.env.CODEX_SANDBOX = previousSandbox;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });
});
