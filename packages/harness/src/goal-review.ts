import type { AttemptOutput } from "./types";

export const GOAL_REVIEW_TASK_GOAL = "Review whether the run goal is complete";

export const GOAL_REVIEW_TASK_PROMPT = [
  "Answer this before creating more work: are we sure the original run goal has been reached?",
  "",
  "Inspect the repository, README, tests, dashboard state, recent attempts, and run lessons.",
  "Before choosing a runDecision, cite concrete evidence from repository files or docs, tests or commands, dashboard or run overview state, and recent lessons.",
  "Do not declare runDecision complete unless the summary, checks, artifacts, or problems cite that evidence before declaring complete.",
  "Return structured JSON with one of these decisions:",
  "- runDecision complete: the run goal is satisfied; do not include nextTasks.",
  "- runDecision continue: the run goal is not satisfied; include one to five nextTasks items, usually planners or workers with verifiers.",
  "- runDecision verify: completion is uncertain; include one to five verifier nextTasks items.",
  "- runDecision defer: the run goal is not satisfied, but progress is blocked by an external dependency or missing user/system action; do not include nextTasks.",
].join("\n");

export const GOAL_REVIEW_TASK_DONE_WHEN = [
  "runDecision is complete, continue, verify, or defer",
  "completion decision cites concrete evidence from repository files or docs, tests or commands, dashboard or run overview state, and recent lessons",
  "complete does not create nextTasks",
  "defer does not create nextTasks and cites the external dependency or missing action",
  "continue or verify includes one to five nextTasks items",
];

export function inferExplicitRunDecision(output: {
  summary?: unknown;
  checks?: unknown[];
  artifacts?: unknown[];
  problems?: unknown[];
}) {
  const artifactDecision = (output.artifacts ?? []).map(runDecisionFromArtifact).find((decision) => decision !== undefined);
  if (artifactDecision) {
    return artifactDecision;
  }

  const haystack = [output.summary, ...(output.checks ?? []), ...(output.artifacts ?? []), ...(output.problems ?? [])]
    .map((value) => (typeof value === "string" ? value : JSON.stringify(value)))
    .join("\n");
  const match = haystack.match(/\b(?:runDecision\s*[:=]?|decision\s*[:=])\s*(complete|continue|verify|defer)\b/i);
  if (match) {
    return match[1].toLowerCase() as "complete" | "continue" | "verify" | "defer";
  }
  if (/\b(?:run\s+goal|goal)\s+(?:is\s+)?(?:met|complete|completed|satisfied)\b/i.test(haystack)) {
    return "complete";
  }
  return undefined;
}

export function resolveRunDecision(output: AttemptOutput | Partial<AttemptOutput>) {
  const runDecision = (output as AttemptOutput).runDecision;
  return runDecision ?? inferExplicitRunDecision(output);
}

function runDecisionFromArtifact(value: unknown) {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const artifact = value as { kind?: unknown; type?: unknown; value?: unknown; runDecision?: unknown; decision?: unknown };
  const kind = typeof artifact.kind === "string" ? artifact.kind : artifact.type;
  if (kind !== "runDecision" && kind !== "run_decision" && kind !== "goal_review") {
    return undefined;
  }
  return normalizeRunDecision(artifact.runDecision ?? artifact.decision ?? artifact.value);
}

function normalizeRunDecision(value: unknown) {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "complete" || normalized === "continue" || normalized === "verify" || normalized === "defer") {
    return normalized;
  }
  return undefined;
}
