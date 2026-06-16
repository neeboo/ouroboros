import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOuroborosConfig } from "../packages/cli/src/config";

describe("config", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ouroboros-config-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("parses TOML role model defaults with inert adapter metadata", async () => {
    const configPath = join(dir, "config.toml");
    await writeFile(
      configPath,
      [
        "[models]",
        'model = "gpt-5-codex"',
        "",
        "[models.roles.worker]",
        'model = "gpt-5.4-mini"',
        'provider = "openai"',
        'profile = "fast"',
        'base_url = "https://api.example.test/v1"',
        'env_key = "OPENAI_API_KEY"',
        "",
        "[models.roles.verifier]",
        'model = "gpt-5.5"',
      ].join("\n"),
    );

    await expect(loadOuroborosConfig(configPath)).resolves.toMatchObject({
      modelDefaults: {
        global: { model: "gpt-5-codex" },
        roles: {
          worker: {
            model: "gpt-5.4-mini",
            provider: "openai",
            profile: "fast",
            base_url: "https://api.example.test/v1",
            env_key: "OPENAI_API_KEY",
          },
          verifier: {
            model: "gpt-5.5",
          },
        },
      },
    });
  });

  test("parses role-scoped agent backend defaults from TOML", async () => {
    const configPath = join(dir, "config.toml");
    await writeFile(
      configPath,
      [
        "[agentDefaults.roles]",
        'worker = "opencode"',
        'verifier = "claude-code"',
        "",
        "[agentBackends.opencode]",
        'kind = "acpx"',
        'agent = "opencode"',
        'approval = "approve-reads"',
        "",
        "[agentBackends.opencode.env]",
        'OPENCODE_HOME = "/tmp/opencode-home"',
        "",
        '["agentBackends"."claude-code"]',
        'kind = "acpx"',
        'agent = "claude"',
      ].join("\n"),
    );

    await expect(loadOuroborosConfig(configPath)).resolves.toMatchObject({
      agentDefaults: {
        roles: {
          worker: "opencode",
          verifier: "claude-code",
        },
      },
      agentBackends: {
        opencode: {
          kind: "acpx",
          agent: "opencode",
          approval: "approve-reads",
          env: {
            OPENCODE_HOME: "/tmp/opencode-home",
          },
        },
        "claude-code": {
          kind: "acpx",
          agent: "claude",
        },
      },
    });
  });

  test("ignores global agent defaults in TOML to keep backend config role-scoped", async () => {
    const configPath = join(dir, "config.toml");
    await writeFile(
      configPath,
      [
        "[agentDefaults]",
        'global = "opencode"',
        "",
        "[agentDefaults.roles]",
        'verifier = "claude-code"',
      ].join("\n"),
    );

    await expect(loadOuroborosConfig(configPath)).resolves.toMatchObject({
      agentDefaults: {
        roles: {
          verifier: "claude-code",
        },
      },
    });
  });
});
