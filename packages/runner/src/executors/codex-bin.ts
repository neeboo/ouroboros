import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

const CODEX_APP_BIN = "/Applications/Codex.app/Contents/Resources/codex";
const KNOWN_BROKEN_NPM_WRAPPER = "/usr/local/bin/codex";

export function defaultCodexBin() {
  const pathCodex = findOnPath("codex");
  if (pathCodex && pathCodex !== KNOWN_BROKEN_NPM_WRAPPER) {
    return "codex";
  }
  if (process.platform === "darwin" && pathCodex === KNOWN_BROKEN_NPM_WRAPPER && existsSync(CODEX_APP_BIN)) {
    return CODEX_APP_BIN;
  }
  return "codex";
}

function findOnPath(command: string) {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) {
      continue;
    }
    const candidate = join(dir, command);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}
