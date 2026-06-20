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
  if (isEvidenceBackedCompletion(output, haystack)) {
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

function isEvidenceBackedCompletion(
  output: {
    summary?: unknown;
    checks?: unknown[];
    artifacts?: unknown[];
    problems?: unknown[];
  },
  haystack: string,
) {
  if (!hasReviewCompletionLanguage(haystack)) {
    return false;
  }
  if (!hasPassingEvidence(output, haystack)) {
    return false;
  }
  if (hasBlockingFailures(output, haystack)) {
    return false;
  }
  return true;
}

function hasReviewCompletionLanguage(haystack: string) {
  return (
    /\b[A-Z][A-Z0-9]+-\d+\s+(?:is\s+)?(?:complete|completed|done|satisfied)\b/i.test(haystack) ||
    /\b(?:verification|review|复验|验证|检查|验收)\s+(?:is\s+)?(?:complete|completed|done|passed|通过|完成)\b/i.test(haystack) ||
    /\b(?:source-worktree|worktree|workspace)\s+verification\s+(?:is\s+)?(?:complete|completed|done)\b/i.test(haystack) ||
    /\b(?:all|required|final)\s+(?:checks|verification|evidence)\s+(?:passed|complete|completed|done)\b/i.test(haystack) ||
    /(?:验证|复验|检查|验收)(?:已经|已)?(?:通过|完成)/.test(haystack)
  );
}

function hasPassingEvidence(output: { checks?: unknown[]; artifacts?: unknown[] }, haystack: string) {
  const hasPassedCheck = (output.checks ?? []).some((check) => objectFieldEquals(check, "status", "passed"));
  if (hasPassedCheck) {
    return true;
  }
  const hasPassingArtifact = (output.artifacts ?? []).some(
    (artifact) =>
      objectFieldEquals(artifact, "status", "passed") ||
      objectFieldEquals(artifact, "result", "passed") ||
      objectFieldEquals(artifact, "verdict", "passed"),
  );
  if (hasPassingArtifact) {
    return true;
  }
  return /\b(?:passed|verified|typecheck|contracts?|build|gate-lite|tests?)\b/i.test(haystack);
}

function hasBlockingFailures(output: { checks?: unknown[]; problems?: unknown[] }, haystack: string) {
  const hasFailedCheck = (output.checks ?? []).some(
    (check) =>
      objectFieldEquals(check, "status", "failed") ||
      objectFieldEquals(check, "status", "blocked") ||
      objectFieldEquals(check, "status", "error"),
  );
  if (hasFailedCheck && !hasNonBlockingFailureLanguage(haystack)) {
    return true;
  }
  const problems = output.problems ?? [];
  if (problems.length === 0) {
    return false;
  }
  return !problems.every((problem) => hasNonBlockingFailureLanguage(toText(problem)));
}

function hasNonBlockingFailureLanguage(value: string) {
  return /\b(?:non[-\s]?blocking|not\s+blocking|pre[-\s]?existing|existing|baseline|debt|unmodified|unchanged)\b/i.test(
    value,
  );
}

function objectFieldEquals(value: unknown, field: string, expected: string) {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const objectValue = value as Record<string, unknown>;
  const fieldValue = objectValue[field];
  return typeof fieldValue === "string" && fieldValue.toLowerCase() === expected;
}

function toText(value: unknown) {
  return typeof value === "string" ? value : JSON.stringify(value);
}
