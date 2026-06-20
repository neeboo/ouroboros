export const OUROBOROS_RUNTIME_PATHS = [".ouroboros/", ".orbs/", ".git/orbs/"] as const;

export function isOuroborosRuntimePath(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  return (
    normalized === ".ouroboros" ||
    normalized === ".orbs" ||
    normalized === ".git/orbs" ||
    normalized.startsWith(".ouroboros/") ||
    normalized.startsWith(".orbs/") ||
    normalized.startsWith(".git/orbs/")
  );
}

export function filterOuroborosRuntimePaths(paths: string[]) {
  return paths.filter((path) => !isOuroborosRuntimePath(path));
}
