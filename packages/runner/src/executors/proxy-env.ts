import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

const DEFAULT_NO_PROXY = "127.0.0.1,localhost,::1";
const DEFAULT_DEVELOPER_PATHS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];

export function childEnvForProcess(
  baseEnv: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  if (hasProxyEnv(baseEnv)) {
    return normalizeChildPath({ ...baseEnv });
  }
  return normalizeChildPath({ ...baseEnv, ...systemProxyEnv() });
}

export function proxyEnvForChildProcess(
  baseEnv: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  return childEnvForProcess(baseEnv);
}

export function childToolchainEnvEvidence(env: Record<string, string | undefined> = childEnvForProcess()) {
  const path = env.PATH ?? "";
  return {
    PATH: path,
    tools: {
      bun: findOnPath("bun", path),
      node: findOnPath("node", path),
      npm: findOnPath("npm", path),
      npx: findOnPath("npx", path),
    },
  };
}

export function systemProxyEnv() {
  if (process.platform !== "darwin") {
    return {};
  }
  const result = Bun.spawnSync({
    cmd: ["/usr/sbin/scutil", "--proxy"],
    stdout: "pipe",
    stderr: "ignore",
  });
  if (result.exitCode !== 0) {
    return {};
  }
  return proxyEnvFromScutilOutput(new TextDecoder().decode(result.stdout));
}

export function proxyEnvFromScutilOutput(output: string) {
  const http = proxyFor(output, "HTTP");
  const https = proxyFor(output, "HTTPS");
  const socks = proxyFor(output, "SOCKS", "socks5");
  const httpProxy = http ?? https;
  const httpsProxy = https ?? http;
  const allProxy = socks ?? httpsProxy ?? httpProxy;
  const noProxy = noProxyFromScutilOutput(output);
  const env: Record<string, string> = {};
  if (httpProxy) {
    env.HTTP_PROXY = httpProxy;
    env.http_proxy = httpProxy;
  }
  if (httpsProxy) {
    env.HTTPS_PROXY = httpsProxy;
    env.https_proxy = httpsProxy;
  }
  if (allProxy) {
    env.ALL_PROXY = allProxy;
    env.all_proxy = allProxy;
  }
  env.NO_PROXY = noProxy;
  env.no_proxy = noProxy;
  return env;
}

function hasProxyEnv(env: Record<string, string | undefined>) {
  return ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"].some(
    (key) => typeof env[key] === "string" && env[key]!.trim().length > 0,
  );
}

function normalizeChildPath(env: Record<string, string | undefined>): Record<string, string | undefined> {
  return {
    ...env,
    PATH: normalizedDeveloperPath(env),
  };
}

function normalizedDeveloperPath(env: Record<string, string | undefined>) {
  const home = env.HOME?.trim() || homedir();
  const candidates = [
    home ? join(home, ".bun/bin") : null,
    ...DEFAULT_DEVELOPER_PATHS,
  ].filter((entry): entry is string => Boolean(entry));
  const existing = (env.PATH ?? "").split(delimiter).filter(Boolean);
  const { customPrefix, suffix } = splitCustomPathPrefix(existing);
  return dedupePath([...customPrefix, ...candidates, ...suffix]).join(delimiter);
}

function dedupePath(entries: string[]) {
  const seen = new Set<string>();
  const deduped = [];
  for (const entry of entries) {
    if (seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    deduped.push(entry);
  }
  return deduped;
}

function findOnPath(command: string, path: string) {
  for (const dir of path.split(delimiter)) {
    if (!dir) {
      continue;
    }
    const candidate = join(dir, command);
    if (existsSync(candidate)) {
      return { found: true, path: candidate };
    }
  }
  return { found: false, path: null };
}

function splitCustomPathPrefix(entries: string[]) {
  const firstKnownIndex = entries.findIndex((entry) => isCommonDeveloperPath(entry));
  if (firstKnownIndex <= 0) {
    return { customPrefix: [], suffix: entries };
  }
  return {
    customPrefix: entries.slice(0, firstKnownIndex),
    suffix: entries.slice(firstKnownIndex),
  };
}

function isCommonDeveloperPath(entry: string) {
  return entry.endsWith("/.bun/bin") || DEFAULT_DEVELOPER_PATHS.includes(entry);
}

function proxyFor(output: string, key: "HTTP" | "HTTPS" | "SOCKS", scheme = "http") {
  if (!new RegExp(`${key}Enable\\s*:\\s*1`).test(output)) {
    return null;
  }
  const host = matchValue(output, `${key}Proxy`);
  const port = matchValue(output, `${key}Port`);
  if (!host || !port) {
    return null;
  }
  return `${scheme}://${host}:${port}`;
}

function noProxyFromScutilOutput(output: string) {
  const exceptions = [...output.matchAll(/\d+\s*:\s*([^\n]+)/g)].map((match) => match[1].trim()).filter(Boolean);
  return [...new Set([...DEFAULT_NO_PROXY.split(","), ...exceptions])].join(",");
}

function matchValue(output: string, key: string) {
  const match = output.match(new RegExp(`${key}\\s*:\\s*([^\\n]+)`));
  return match?.[1]?.trim() || null;
}
