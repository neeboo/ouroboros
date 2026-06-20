import { diagnoseRunOverview, isOuroborosRuntimePath, readableValue } from "@ouroboros/harness";
import type {
  LessonKind,
  ObservableSession,
  OverseerDiagnosis,
  RunOverview,
  Status,
} from "@ouroboros/harness";

type EvidenceEntry = { kind: string; text: string };
type GoalReviewEvidence = EvidenceEntry[];

interface GoalReviewDecision {
  taskId: string | null;
  runDecision: string | null;
  summary: string;
  evidence: GoalReviewEvidence;
}

const DEFAULT_LESSON_LIMIT = 10;
const EVIDENCE_LIMIT = 5;
const RUN_EVIDENCE_LIMIT = 12;
const MAX_SUMMARY_CHARS = 200;
const STATUS_ORDER: Status[] = ["todo", "running", "done", "blocked"];
const HARNESS_ARTIFACT_KINDS = new Set(["integration", "harness_action_event"]);

export function formatRunEvidence(overview: RunOverview, options: { lessonLimit?: number } = {}): string {
  if (!overview.run) {
    throw new Error("run not found");
  }
  const lessonLimit = options.lessonLimit ?? DEFAULT_LESSON_LIMIT;
  const lines: string[] = [];
  const run = overview.run;

  lines.push(`Run ${run.id}`);
  lines.push(`Goal: ${run.goal}`);
  lines.push(`Status: ${run.status}`);

  const counts = countTasksByStatus(overview.tasks);
  lines.push(`Tasks: ${formatStatusCounts(counts)}`);

  appendOverseerDiagnosisLines(lines, diagnoseRunOverview(overview));

  const decision = latestGoalReviewDecision(overview);
  if (decision) {
    lines.push("");
    lines.push("Latest goal-review decision");
    lines.push(`  decision: ${decision.runDecision ?? "unknown"}`);
    if (decision.taskId) {
      lines.push(`  task: ${decision.taskId}`);
    }
    if (decision.summary) {
      lines.push(`  summary: ${clamp(decision.summary, MAX_SUMMARY_CHARS)}`);
    }
    const cited = decision.evidence.slice(0, EVIDENCE_LIMIT);
    if (cited.length > 0) {
      lines.push("  cited evidence:");
      for (const item of cited) {
        lines.push(`    - [${item.kind}] ${clamp(item.text, MAX_SUMMARY_CHARS)}`);
      }
    }
  } else {
    lines.push("");
    lines.push("Latest goal-review decision: (none recorded)");
  }

  const runEvidence = collectRunEvidence(overview);
  lines.push("");
  if (runEvidence.length > 0) {
    const shown = runEvidence.slice(0, RUN_EVIDENCE_LIMIT);
    lines.push(`Run evidence (${shown.length}${runEvidence.length > shown.length ? ` of ${runEvidence.length}` : ""})`);
    for (const item of shown) {
      lines.push(`  - [${item.kind}] ${clamp(item.text, MAX_SUMMARY_CHARS)}`);
    }
  } else {
    lines.push("Run evidence: (none recorded)");
  }

  const lessons = overview.lessons.slice().reverse().slice(0, lessonLimit);
  if (lessons.length > 0) {
    lines.push("");
    lines.push(`Recent lessons (last ${lessons.length})`);
    for (const lesson of lessons) {
      lines.push(`  - [${labelLessonKind(lesson.kind)}] ${clamp(lesson.summary, MAX_SUMMARY_CHARS)}`);
    }
  } else {
    lines.push("");
    lines.push("Recent lessons: (none recorded)");
  }

  const changedFiles = aggregateChangedFiles(overview);
  lines.push("");
  if (changedFiles.length > 0) {
    lines.push(`Changed files (${changedFiles.length})`);
    for (const file of changedFiles) {
      lines.push(`  - ${file}`);
    }
  } else {
    lines.push("Changed files: (none recorded)");
  }

  return lines.join("\n");
}

function countTasksByStatus(tasks: RunOverview["tasks"]): Record<Status, number> {
  const counts: Record<Status, number> = { todo: 0, running: 0, done: 0, blocked: 0 };
  for (const task of tasks) {
    counts[task.status] = (counts[task.status] ?? 0) + 1;
  }
  return counts;
}

function formatStatusCounts(counts: Record<Status, number>): string {
  return STATUS_ORDER.filter((status) => counts[status] > 0)
    .map((status) => `${status}:${counts[status]}`)
    .join("  ");
}

function latestGoalReviewDecision(overview: RunOverview): GoalReviewDecision | null {
  const goalReviewTasks = overview.tasks.filter((task) => task.role === "goal-review");
  if (goalReviewTasks.length === 0) {
    return null;
  }
  const orderedTaskIds = goalReviewTasks.map((task) => task.id);
  const sessionsForReview = overview.sessions.filter((session) => orderedTaskIds.includes(session.taskId));
  const orderedSessions = sessionsForReview.sort(
    (a, b) => orderedTaskIds.indexOf(b.taskId) - orderedTaskIds.indexOf(a.taskId),
  );
  const session = orderedSessions[0];
  if (!session) {
    return { taskId: goalReviewTasks[goalReviewTasks.length - 1].id, runDecision: null, summary: "", evidence: [] };
  }
  const output = session.output ?? {};
  const runDecision = typeof output.runDecision === "string" ? output.runDecision : null;
  const summary = typeof output.summary === "string" ? output.summary : "";
  const evidence = collectGoalReviewEvidence(output);
  return { taskId: session.taskId, runDecision, summary, evidence };
}

function collectGoalReviewEvidence(output: RunOverview["sessions"][number]["output"]): GoalReviewEvidence {
  const evidence: GoalReviewEvidence = [];
  const checks = Array.isArray(output.checks) ? output.checks : [];
  for (const check of checks) {
    evidence.push({ kind: "check", text: readableValue(check) });
  }
  const artifacts = Array.isArray(output.artifacts) ? output.artifacts : [];
  for (const artifact of artifacts) {
    const record = artifact as Record<string, unknown> | null;
    if (record && typeof record.kind === "string" && record.kind !== "goal_review") {
      evidence.push({ kind: `artifact:${record.kind}`, text: readableValue(artifact) });
      continue;
    }
    evidence.push({ kind: "artifact", text: readableValue(artifact) });
  }
  const changedFiles = Array.isArray(output.changedFiles) ? output.changedFiles : [];
  for (const file of changedFiles) {
    if (typeof file === "string" && file.length > 0 && !isOuroborosRuntimePath(file)) {
      evidence.push({ kind: "file", text: file });
    }
  }
  return evidence;
}

function aggregateChangedFiles(overview: RunOverview): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const session of overview.sessions) {
    const files = Array.isArray(session.output?.changedFiles) ? session.output.changedFiles : [];
    for (const file of files) {
      if (typeof file !== "string" || file.length === 0 || isOuroborosRuntimePath(file) || seen.has(file)) continue;
      seen.add(file);
      ordered.push(file);
    }
  }
  return ordered;
}

function collectRunEvidence(overview: RunOverview): EvidenceEntry[] {
  const evidence: EvidenceEntry[] = [];
  const sessionsByTask = new Map<string, ObservableSession[]>();
  for (const session of overview.sessions) {
    const list = sessionsByTask.get(session.taskId) ?? [];
    list.push(session);
    sessionsByTask.set(session.taskId, list);
  }

  for (const task of overview.tasks) {
    if (task.role !== "verifier") continue;
    const sessions = (sessionsByTask.get(task.id) ?? []).filter(
      (session) => session.status === "done" || session.status === "blocked",
    );
    const latest = sessions[sessions.length - 1];
    if (!latest) continue;
    const parts = [`task ${task.id}`, `verifier ${latest.status}`];
    const checks = summarizeChecks(latest.output?.checks);
    if (checks) parts.push(checks);
    const summary = (typeof latest.output?.summary === "string" ? latest.output.summary : "").trim();
    if (summary) parts.push(clamp(summary, MAX_SUMMARY_CHARS));
    evidence.push({ kind: `verifier:${latest.status}`, text: parts.join(" · ") });
  }

  for (const session of overview.sessions) {
    const artifacts = Array.isArray(session.output?.artifacts) ? session.output!.artifacts : [];
    for (const artifact of artifacts) {
      const record = artifact as Record<string, unknown> | null;
      if (!record || typeof record.kind !== "string") continue;
      if (!HARNESS_ARTIFACT_KINDS.has(record.kind)) continue;
      const text = readableValue(artifact);
      if (!text) continue;
      evidence.push({ kind: `${session.role || "session"}:${record.kind}`, text });
    }
  }

  return evidence;
}

function summarizeChecks(checks: unknown): string {
  if (!Array.isArray(checks) || checks.length === 0) return "";
  let passed = 0;
  let failed = 0;
  for (const check of checks) {
    const status = (check as { status?: unknown } | null)?.status;
    if (status === "passed") passed += 1;
    else if (status === "failed") failed += 1;
  }
  const total = checks.length;
  const parts = [`${total} check${total === 1 ? "" : "s"}`];
  if (passed > 0) parts.push(`${passed} passed`);
  if (failed > 0) parts.push(`${failed} failed`);
  return parts.join(" · ");
}

function labelLessonKind(kind: LessonKind): string {
  return kind === "experience" ? "experience" : "lesson";
}

function clamp(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max - 1)}…`;
}

const DIAGNOSIS_REASON_LIMIT = 180;
const DIAGNOSIS_SUMMARY_LIMIT = 120;
const DIAGNOSIS_EVIDENCE_LIMIT = 4;

export interface OverseerDiagnosisSummary {
  state: OverseerDiagnosis["state"];
  reason: string;
}

export function summarizeOverseerDiagnosis(diagnosis: OverseerDiagnosis): OverseerDiagnosisSummary {
  return {
    state: diagnosis.state,
    reason: clamp(overseerDiagnosisReason(diagnosis), DIAGNOSIS_REASON_LIMIT),
  };
}

function overseerDiagnosisReason(diagnosis: OverseerDiagnosis): string {
  switch (diagnosis.state) {
    case "complete":
      return "run status is done";
    case "paused":
      return "manual pause is active";
    case "blocked":
      return "only blocked work remains";
    case "orphaned": {
      if (diagnosis.orphanedLeases.length > 0) {
        const lease = diagnosis.orphanedLeases[0];
        return `${lease.reason}: task ${lease.taskId}`;
      }
      return "ready work has no live runner";
    }
    case "draining":
      return diagnosis.runningAttempts.length > 0
        ? `${diagnosis.runningAttempts.length} running attempt${diagnosis.runningAttempts.length === 1 ? "" : "s"}`
        : "live runner thread";
    case "waiting":
      return "todo work depends on incomplete tasks";
    default:
      return "no active work";
  }
}

function appendOverseerDiagnosisLines(lines: string[], diagnosis: OverseerDiagnosis): void {
  const summary = summarizeOverseerDiagnosis(diagnosis);
  lines.push("");
  lines.push("Overseer diagnosis");
  lines.push(`  state: ${summary.state}`);
  lines.push(`  reason: ${summary.reason}`);
  lines.push(
    `  active work: ready ${diagnosis.activeWork.readyTaskIds.length} · running ${diagnosis.activeWork.runningTaskIds.length}`,
  );
  if (diagnosis.queueStarvation) {
    lines.push("  queue starvation: ready tasks exist without a live runner");
  }
  if (diagnosis.emptyRunGoalReviewRaceRisk) {
    lines.push("  empty-run goal-review race risk: queue is idle without a goal-review task");
  }

  const runningEvidence: string[] = [];
  for (const session of diagnosis.runningAttempts.slice(0, DIAGNOSIS_EVIDENCE_LIMIT)) {
    const parts = [`attempt ${session.attemptId}`, `task ${session.taskId}`];
    if (session.role) parts.push(session.role);
    if (session.codexSessionId) parts.push(`codex ${session.codexSessionId}`);
    runningEvidence.push(clamp(parts.join(" · "), DIAGNOSIS_SUMMARY_LIMIT));
  }
  if (runningEvidence.length > 0) {
    lines.push("  running attempts:");
    for (const entry of runningEvidence) {
      lines.push(`    - ${entry}`);
    }
  }

  const orphanedEvidence: string[] = [];
  for (const lease of diagnosis.orphanedLeases.slice(0, DIAGNOSIS_EVIDENCE_LIMIT)) {
    const parts = [`task ${lease.taskId}`, lease.reason];
    if (lease.sessionRef) parts.push(`session ${lease.sessionRef}`);
    if (lease.worktreePath) parts.push(`worktree ${lease.worktreePath}`);
    orphanedEvidence.push(clamp(parts.join(" · "), DIAGNOSIS_SUMMARY_LIMIT));
  }
  if (orphanedEvidence.length > 0) {
    lines.push("  orphaned leases:");
    for (const entry of orphanedEvidence) {
      lines.push(`    - ${entry}`);
    }
  }
}
