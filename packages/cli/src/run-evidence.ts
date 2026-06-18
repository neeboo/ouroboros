import { readableValue } from "@ouroboros/harness";
import type { LessonKind, RunOverview, Status } from "@ouroboros/harness";

type GoalReviewEvidence = Array<{ kind: string; text: string }>;

interface GoalReviewDecision {
  taskId: string | null;
  runDecision: string | null;
  summary: string;
  evidence: GoalReviewEvidence;
}

const DEFAULT_LESSON_LIMIT = 10;
const EVIDENCE_LIMIT = 5;
const MAX_SUMMARY_CHARS = 200;
const STATUS_ORDER: Status[] = ["todo", "running", "done", "blocked"];

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
    if (typeof file === "string" && file.length > 0) {
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
      if (typeof file !== "string" || file.length === 0 || seen.has(file)) continue;
      seen.add(file);
      ordered.push(file);
    }
  }
  return ordered;
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
