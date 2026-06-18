import type { RunOverview, Status } from "@ouroboros/harness";

const MAX_GOAL_CHARS = 100;
const MAX_TASK_GOAL_CHARS = 80;
const SHORT_ID_LENGTH = 12;
const STATUS_ORDER: Status[] = ["todo", "running", "done", "blocked"];

export function formatRunGraph(overview: RunOverview): string {
  if (!overview.run) {
    throw new Error("run not found");
  }
  const lines: string[] = [];
  const run = overview.run;

  lines.push(`Run ${run.id}  ${run.status}`);
  lines.push(`Goal: ${clamp(run.goal, MAX_GOAL_CHARS)}`);
  lines.push("");

  const shortIdByTaskId = new Map<string, string>();
  for (const task of overview.tasks) {
    shortIdByTaskId.set(task.id, shortTaskId(task.id));
  }

  if (overview.tasks.length === 0) {
    lines.push("Tasks: (none)");
  } else {
    for (const task of overview.tasks) {
      const shortId = shortIdByTaskId.get(task.id) ?? shortTaskId(task.id);
      const deps = task.dependsOn
        .map((dep) => shortIdByTaskId.get(dep) ?? shortTaskId(dep))
        .join(",") || "-";
      lines.push(
        `${shortId}  ${task.role}  ${task.status}  deps=${deps}  ${clamp(task.goal, MAX_TASK_GOAL_CHARS)}`,
      );
    }
  }

  lines.push("");
  const counts = countTasksByStatus(overview.tasks);
  lines.push(`Counts: ${formatStatusCounts(counts)}`);

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

function shortTaskId(taskId: string): string {
  if (taskId.length <= SHORT_ID_LENGTH) {
    return taskId;
  }
  return taskId.slice(-SHORT_ID_LENGTH);
}

function clamp(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max - 1)}…`;
}
