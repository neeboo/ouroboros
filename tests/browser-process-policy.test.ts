import { describe, expect, test } from "bun:test";
import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withBrowserProcessPolicy } from "../packages/runner/src/executors/browser-process-policy";
import { runLocalCommand } from "../packages/runner/src/executors/command";

describe("browser process policy", () => {
  test.skipIf(process.platform !== "darwin")("denies browser executables launched by nested child processes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbs-browser-policy-"));
    const fakeBrowser = join(dir, "Google Chrome");
    const marker = join(dir, "browser-launched.txt");
    await writeFile(fakeBrowser, `#!/bin/sh\nprintf launched > ${JSON.stringify(marker)}\n`);
    await chmod(fakeBrowser, 0o755);

    try {
      const runCommand = withBrowserProcessPolicy(runLocalCommand, "deny");
      const result = await runCommand({
        cmd: ["/bin/sh", "-c", `${JSON.stringify(fakeBrowser)} >/dev/null 2>&1; printf guarded`],
        stdin: "",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("guarded");
      await expect(access(marker)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
