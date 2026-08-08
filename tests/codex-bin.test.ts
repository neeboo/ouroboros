import { describe, expect, test } from "bun:test";
import { resolveDefaultCodexBin } from "../packages/runner/src/executors/codex-bin";

const CHATGPT_CODEX = "/Applications/ChatGPT.app/Contents/Resources/codex";
const CODEX_APP_CODEX = "/Applications/Codex.app/Contents/Resources/codex";

describe("Codex binary resolution", () => {
  test("prefers the bundled ChatGPT Codex over a broken NVM shim on macOS", () => {
    const executable = new Set([
      CHATGPT_CODEX,
      "/Users/test/.nvm/versions/node/v25/bin/codex",
    ]);

    expect(
      resolveDefaultCodexBin({
        platform: "darwin",
        isExecutable: (candidate) => executable.has(candidate),
      }),
    ).toBe(CHATGPT_CODEX);
  });

  test("falls back to the standalone Codex app before PATH on macOS", () => {
    const executable = new Set([
      CODEX_APP_CODEX,
      "/usr/local/bin/codex",
    ]);

    expect(
      resolveDefaultCodexBin({
        platform: "darwin",
        isExecutable: (candidate) => executable.has(candidate),
      }),
    ).toBe(CODEX_APP_CODEX);
  });

  test("uses PATH when no executable desktop bundle is available", () => {
    expect(
      resolveDefaultCodexBin({
        platform: "darwin",
        isExecutable: (candidate) => candidate === "/opt/tools/bin/codex",
      }),
    ).toBe("codex");
  });

  test("does not apply macOS desktop paths on other platforms", () => {
    expect(
      resolveDefaultCodexBin({
        platform: "linux",
        isExecutable: (candidate) => candidate === CHATGPT_CODEX,
      }),
    ).toBe("codex");
  });
});
