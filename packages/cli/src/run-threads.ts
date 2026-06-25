import type { ExecutionThread, RunOverview } from "@ouroboros/harness";

const SHORT_ID_LENGTH = 12;
const MAX_SUMMARY_CHARS = 200;
const THREAD_STATUS_ORDER: string[] = ["running", "done", "blocked", "interrupted", "orphaned"];

export interface ChildThreadSummary {
  threadId: string;
  summary: string;
  status: string;
  collectedAt: string | null;
}

export interface ParentTaskThreadGroup {
  taskId: string;
  role: string;
  goal: string;
  status: string;
  worktreePath: string | null;
  parentThreadId: string | null;
  childThreads: ExecutionThread[];
  latestSummaries: ChildThreadSummary[];
}

export interface RunThreadOverview {
  runId: string;
  runStatus: string;
  parentTaskCount: number;
  childThreadCount: number;
  standaloneThreadCount: number;
  groups: ParentTaskThreadGroup[];
  standaloneThreads: ExecutionThread[];
}

export function buildRunThreadOverview(overview: RunOverview): RunThreadOverview {
  const run = overview.run;
  if (!run) {
    throw new Error("run not found");
  }

  const tasksById = new Map(overview.tasks.map((task) => [task.id, task]));
  const threads = overview.threads ?? [];
  const childThreadsByTask = new Map<string, ExecutionThread[]>();
  const standaloneThreads: ExecutionThread[] = [];

  for (const thread of threads) {
    if (thread.ownerType === "subsession") {
      const parentId = thread.taskId;
      if (parentId) {
        const list = childThreadsByTask.get(parentId) ?? [];
        list.push(thread);
        childThreadsByTask.set(parentId, list);
      } else {
        standaloneThreads.push(thread);
      }
      continue;
    }
    if (thread.taskId) {
      const list = childThreadsByTask.get(thread.taskId) ?? [];
      list.push(thread);
      childThreadsByTask.set(thread.taskId, list);
    } else {
      standaloneThreads.push(thread);
    }
  }

  const summariesByThread = collectLatestSubsessionSummaries(overview);

  const groups: ParentTaskThreadGroup[] = [];
  for (const task of overview.tasks) {
    const childThreads = (childThreadsByTask.get(task.id) ?? []).filter((thread) => thread.ownerType === "subsession");
    if (childThreads.length === 0) continue;
    const sorted = sortThreads(childThreads);
    const latestSummaries = sorted
      .map((thread) => summariesByThread.get(thread.id))
      .filter((value): value is ChildThreadSummary => Boolean(value));
    const parentThreadId = pickParentThreadId(threads, task.id);
    groups.push({
      taskId: task.id,
      role: task.role,
      goal: task.goal,
      status: task.status,
      worktreePath: task.worktreePath,
      parentThreadId,
      childThreads: sorted,
      latestSummaries,
    });
  }

  const childThreadCount = groups.reduce((total, group) => total + group.childThreads.length, 0);

  return {
    runId: run.id,
    runStatus: run.status,
    parentTaskCount: groups.length,
    childThreadCount,
    standaloneThreadCount: standaloneThreads.length,
    groups,
    standaloneThreads,
  };
}

export function formatRunThreads(overview: RunOverview): string {
  const view = buildRunThreadOverview(overview);
  const lines: string[] = [];
  lines.push(`Run ${view.runId}  ${view.runStatus}`);
  lines.push(
    `Threads: ${view.childThreadCount} subsession child thread${view.childThreadCount === 1 ? "" : "s"} across ${view.parentTaskCount} parent task${view.parentTaskCount === 1 ? "" : "s"} · ${view.standaloneThreadCount} standalone`,
  );

  if (view.groups.length === 0) {
    lines.push("");
    lines.push("Parent task groups: (none recorded)");
  } else {
    for (const group of view.groups) {
      lines.push("");
      lines.push(`Parent task ${shortId(group.taskId)}  ${group.role}  ${group.status}`);
      lines.push(`  goal: ${clamp(group.goal, 100)}`);
      if (group.worktreePath) {
        lines.push(`  cwd: ${group.worktreePath}`);
      }
      if (group.parentThreadId) {
        lines.push(`  parent_thread: ${shortId(group.parentThreadId)}`);
      }
      lines.push(`  children (${group.childThreads.length}):`);
      for (const thread of group.childThreads) {
        const session = thread.sessionName ?? thread.agentSessionId ?? "(unnamed)";
        const role = thread.role || "(no role)";
        const heartbeat = thread.heartbeatAt ? `heartbeat ${clamp(thread.heartbeatAt, 24)}` : "no heartbeat";
        lines.push(
          `    - ${shortId(thread.id)}  ${thread.status}  ${role}  ${session}  ${heartbeat}`,
        );
        if (thread.interruptReason) {
          lines.push(`      interrupt_reason: ${clamp(thread.interruptReason, 120)}`);
        }
      }
      if (group.latestSummaries.length > 0) {
        lines.push("  latest summaries:");
        for (const summary of group.latestSummaries) {
          lines.push(
            `    - ${shortId(summary.threadId)}  ${summary.status}  ${clamp(summary.summary, MAX_SUMMARY_CHARS)}`,
          );
        }
      }
    }
  }

  if (view.standaloneThreads.length > 0) {
    lines.push("");
    lines.push(`Standalone threads (${view.standaloneThreads.length}):`);
    for (const thread of view.standaloneThreads) {
      const session = thread.sessionName ?? thread.agentSessionId ?? "(unnamed)";
      lines.push(
        `  - ${shortId(thread.id)}  ${thread.status}  ${thread.ownerType}  ${thread.role || "(no role)"}  ${session}`,
      );
    }
  }

  return lines.join("\n");
}

function collectLatestSubsessionSummaries(overview: RunOverview): Map<string, ChildThreadSummary> {
  const byThread = new Map<string, ChildThreadSummary>();
  for (const session of overview.sessions) {
    const artifacts = Array.isArray(session.output?.artifacts) ? session.output!.artifacts : [];
    for (const artifact of artifacts) {
      const record = artifact as Record<string, unknown> | null;
      if (!record || record.kind !== "subsession_summary") continue;
      const threadId = typeof record.threadId === "string" ? record.threadId : null;
      if (!threadId) continue;
      const summary = typeof record.summary === "string" ? record.summary : "";
      const status = typeof record.status === "string" ? record.status : "done";
      const existing = byThread.get(threadId);
      if (existing && existing.collectedAt && existing.collectedAt >= (session.finishedAt ?? session.startedAt ?? "")) {
        continue;
      }
      byThread.set(threadId, {
        threadId,
        summary,
        status,
        collectedAt: session.finishedAt ?? session.startedAt ?? null,
      });
    }
  }
  return byThread;
}

function pickParentThreadId(threads: ExecutionThread[], taskId: string): string | null {
  const candidates = threads.filter((thread) => thread.taskId === taskId && thread.ownerType !== "subsession");
  if (candidates.length === 0) return null;
  return sortThreads(candidates)[0]?.id ?? null;
}

function sortThreads(threads: ExecutionThread[]): ExecutionThread[] {
  return [...threads].sort((left, right) => {
    const leftStatus = THREAD_STATUS_ORDER.indexOf(left.status);
    const rightStatus = THREAD_STATUS_ORDER.indexOf(right.status);
    if (leftStatus !== rightStatus) {
      return leftStatus === -1 ? 1 : rightStatus === -1 ? -1 : leftStatus - rightStatus;
    }
    return compareTimestamps(right.heartbeatAt, left.heartbeatAt);
  });
}

function compareTimestamps(a: string | null, b: string | null): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function shortId(value: string): string {
  if (value.length <= SHORT_ID_LENGTH) return value;
  return value.slice(-SHORT_ID_LENGTH);
}

function clamp(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}
