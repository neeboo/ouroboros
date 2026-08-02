import { describe, expect, test } from "bun:test";

import { existsSync } from "node:fs";
import { join } from "node:path";

const repoRoot = import.meta.dir;

describe("designer-control-plane dogfood script location", () => {
  test("lives at scripts/designer-control-plane-dogfood.ts and not under tests/", () => {
    const allowedPath = join(repoRoot, "..", "scripts", "designer-control-plane-dogfood.ts");
    const forbiddenPath = join(repoRoot, "designer-control-plane-dogfood.ts");

    expect(existsSync(allowedPath)).toBe(true);
    expect(existsSync(forbiddenPath)).toBe(false);
  });
});
