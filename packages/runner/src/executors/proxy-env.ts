const DEFAULT_NO_PROXY = "127.0.0.1,localhost,::1";

export function proxyEnvForChildProcess(baseEnv: Record<string, string | undefined> = process.env) {
  if (hasProxyEnv(baseEnv)) {
    return { ...baseEnv };
  }
  return { ...baseEnv, ...systemProxyEnv() };
}

export function systemProxyEnv() {
  if (process.platform !== "darwin") {
    return {};
  }
  const result = Bun.spawnSync({
    cmd: ["scutil", "--proxy"],
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
