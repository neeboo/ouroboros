export const DSH_CREDENTIAL_FILENAME_TOKENS = ["api_key", "credential", "secret", "token"] as const;
export const DSH_CREDENTIAL_BASENAME_PREFIXES = [".env"] as const;

export interface DshCredentialPathPolicyV1 {
  schemaVersion: 1;
  source: "frozen-runtime-credential-isolation";
  deniedSubtrees: string[];
  deniedBasenamePrefixes: Array<(typeof DSH_CREDENTIAL_BASENAME_PREFIXES)[number]>;
  deniedFilenameTokens: Array<(typeof DSH_CREDENTIAL_FILENAME_TOKENS)[number]>;
}

export interface DshFilePolicyContractV1 {
  schemaVersion: 1;
  source: "frozen-design-mutation-surfaces";
  allowedPaths: string[];
  readOnlyPaths: string[];
  forbiddenPaths: string[];
  credentialPathPolicy?: DshCredentialPathPolicyV1;
}

export function normalizeDshFilePolicyContract(input: unknown): DshFilePolicyContractV1 {
  const record = objectRecord(input, "DSH workspace-write requires a frozen file policy");
  const requiredKeys = ["allowedPaths", "forbiddenPaths", "schemaVersion", "source"];
  const optionalKeys = new Set(["readOnlyPaths", "credentialPathPolicy"]);
  const keys = Object.keys(record);
  if (requiredKeys.some((key) => !keys.includes(key)) || keys.some((key) => !requiredKeys.includes(key) && !optionalKeys.has(key))) {
    throw new Error("DSH file policy contains unknown or missing fields");
  }
  if (record.schemaVersion !== 1
    || (record.source !== "frozen-design-mutation-surfaces" && record.source !== "frozen-runtime-integration-boundary")) {
    throw new Error("DSH file policy schema or source is invalid");
  }
  const allowedPaths = normalizeDshPolicyPaths(record.allowedPaths, "allowedPaths");
  if (allowedPaths.length === 0) throw new Error("DSH file policy must allow at least one frozen path");
  const credentialPathPolicy = record.credentialPathPolicy === undefined
    ? undefined
    : normalizeDshCredentialPathPolicy(record.credentialPathPolicy);
  return {
    schemaVersion: 1,
    source: "frozen-design-mutation-surfaces",
    allowedPaths,
    readOnlyPaths: normalizeDshPolicyPaths(record.readOnlyPaths ?? [], "readOnlyPaths"),
    forbiddenPaths: normalizeDshPolicyPaths(record.forbiddenPaths, "forbiddenPaths"),
    ...(credentialPathPolicy ? { credentialPathPolicy } : {}),
  };
}

export function normalizeDshCredentialPathPolicy(input: unknown): DshCredentialPathPolicyV1 {
  const record = objectRecord(input, "DSH credential path policy must be an object");
  const keys = Object.keys(record).sort();
  const expectedKeys = [
    "deniedBasenamePrefixes",
    "deniedFilenameTokens",
    "deniedSubtrees",
    "schemaVersion",
    "source",
  ];
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)
    || record.schemaVersion !== 1
    || record.source !== "frozen-runtime-credential-isolation") {
    throw new Error("DSH credential path policy schema contains unknown or missing fields");
  }
  const deniedBasenamePrefixes = exactControlledStrings(
    record.deniedBasenamePrefixes,
    DSH_CREDENTIAL_BASENAME_PREFIXES,
    "deniedBasenamePrefixes",
  );
  const deniedFilenameTokens = exactControlledStrings(
    record.deniedFilenameTokens,
    DSH_CREDENTIAL_FILENAME_TOKENS,
    "deniedFilenameTokens",
  );
  return {
    schemaVersion: 1,
    source: "frozen-runtime-credential-isolation",
    deniedSubtrees: normalizeDshPolicyPaths(record.deniedSubtrees, "credentialPathPolicy.deniedSubtrees"),
    deniedBasenamePrefixes,
    deniedFilenameTokens,
  };
}

export function credentialPathPolicyFromFrozenPatterns(input: unknown): DshCredentialPathPolicyV1 {
  if (!Array.isArray(input) || input.some((entry) => typeof entry !== "string")) {
    throw new Error("runtime credential isolation forbidden paths must be a string array");
  }
  const deniedSubtrees: string[] = [];
  const deniedBasenamePrefixes: string[] = [];
  const deniedFilenameTokens: string[] = [];
  for (const pattern of [...new Set(input.map((entry) => entry.trim()))].sort()) {
    if (pattern === "**/.env*") deniedBasenamePrefixes.push(".env");
    else if (pattern === "**/*api_key*") deniedFilenameTokens.push("api_key");
    else if (pattern === "**/*credential*") deniedFilenameTokens.push("credential");
    else if (pattern === "**/*secret*") deniedFilenameTokens.push("secret");
    else if (pattern === "**/*token*") deniedFilenameTokens.push("token");
    else deniedSubtrees.push(...normalizeDshPolicyPaths([pattern], "credentialIsolation.forbiddenPaths"));
  }
  return normalizeDshCredentialPathPolicy({
    schemaVersion: 1,
    source: "frozen-runtime-credential-isolation",
    deniedSubtrees,
    deniedBasenamePrefixes,
    deniedFilenameTokens,
  });
}

export function normalizeDshPolicyPaths(value: unknown, name: string) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`DSH file policy ${name} must be a string array`);
  }
  const patterns: string[] = [...new Set((value as string[]).map((entry) => entry.trim()))].sort();
  for (const pattern of patterns) {
    const isSubtree = pattern.endsWith("/**");
    const relativePath = isSubtree ? pattern.slice(0, -3) : pattern;
    const segments = relativePath.split("/");
    if (!relativePath || pattern.startsWith("/") || pattern.includes("\\") || pattern.includes("\0")
      || segments.some((segment) => !segment || segment === "." || segment === "..")
      || (isSubtree ? relativePath.includes("*") : pattern.includes("*"))) {
      throw new Error(`DSH file policy ${name} contains an unsafe path: ${pattern}`);
    }
  }
  return patterns;
}

function exactControlledStrings<const T extends readonly string[]>(value: unknown, allowed: T, name: string): Array<T[number]> {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`DSH credential path policy ${name} must be a string array`);
  }
  const normalized = [...new Set(value.map((entry) => entry.trim()))].sort();
  if (normalized.some((entry) => !allowed.includes(entry as T[number]))) {
    throw new Error(`DSH credential path policy ${name} contains an unsupported classifier`);
  }
  return normalized as Array<T[number]>;
}

function objectRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}
