import { accessSync, constants } from "node:fs";

const CHATGPT_APP_BIN = "/Applications/ChatGPT.app/Contents/Resources/codex";
const CODEX_APP_BIN = "/Applications/Codex.app/Contents/Resources/codex";

interface ResolveDefaultCodexBinInput {
  platform: NodeJS.Platform | string;
  isExecutable: (candidate: string) => boolean;
}

export function defaultCodexBin() {
  return resolveDefaultCodexBin({
    platform: process.platform,
    isExecutable,
  });
}

export function resolveDefaultCodexBin(input: ResolveDefaultCodexBinInput) {
  if (input.platform === "darwin") {
    for (const candidate of [CHATGPT_APP_BIN, CODEX_APP_BIN]) {
      if (input.isExecutable(candidate)) {
        return candidate;
      }
    }
  }
  return "codex";
}

function isExecutable(candidate: string) {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
