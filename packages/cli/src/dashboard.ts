import type { RunOverview } from "@ouroboros/harness";
import { fileURLToPath } from "node:url";

interface DashboardActionResult {
  attemptId?: string;
  taskId?: string;
  status?: string;
  interrupted?: number;
  pid?: number;
}

interface DashboardActions {
  createGoal?: (goal: string) => DashboardActionResult;
  interruptAndCreateGoal?: (goal: string) => DashboardActionResult;
  resumeTask?: (taskId: string) => DashboardActionResult;
  rerunTask?: (taskId: string) => DashboardActionResult;
  stopAttempt?: (attemptId: string) => DashboardActionResult;
  startRunner?: () => DashboardActionResult;
  stopRunner?: () => DashboardActionResult;
}

interface DashboardRunnerStatus {
  status: "idle" | "running" | "exited";
  pid?: number | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  exitCode?: number | null;
  lastOutput?: string;
}

interface DashboardTaskGraphNode {
  id: string;
  type: "task";
  position: { x: number; y: number };
  data: {
    role: string;
    status: string;
    goal: string;
    taskId: string;
    doneWhenCount: number;
    latestSession: {
      status: string;
      attemptId: string;
      sessionName: string | null;
      codexSessionId: string | null;
      latestText: string;
    } | null;
  };
}

interface DashboardTaskGraphEdge {
  id: string;
  source: string;
  target: string;
  label: "dependsOn" | "parentId" | "created" | "reviews";
  type: "smoothstep";
  animated: boolean;
  markerEnd: { type: "arrowclosed" };
}

export interface DashboardTaskGraph {
  nodes: DashboardTaskGraphNode[];
  edges: DashboardTaskGraphEdge[];
}

export function buildDashboardTaskGraph(overview: RunOverview, groupId?: string | null): DashboardTaskGraph {
  const selectedTaskIds = collectRelatedTaskIds(overview, groupId);
  const selectedTasks = overview.tasks.filter((task) => selectedTaskIds.has(task.id));
  const taskIds = new Set(selectedTasks.map((task) => task.id));
  const latestSessionByTask = new Map(
    overview.sessions
      .filter((session) => taskIds.has(session.taskId))
      .map((session) => [
        session.taskId,
        {
          status: session.status,
          attemptId: session.attemptId,
          sessionName: session.sessionName,
          codexSessionId: session.codexSessionId,
          latestText: session.latestText,
        },
      ]),
  );
  const columns = new Map<string, number>();
  const nodes = selectedTasks.map((task, index) => {
    const column = roleColumn(task.role);
    const row = columns.get(column) ?? 0;
    columns.set(column, row + 1);
    return {
      id: task.id,
      type: "task" as const,
      position: { x: columnX(column), y: row * 190 + (index % 2) * 12 },
      data: {
        role: task.role,
        status: task.status,
        goal: compactText(task.goal, 118),
        taskId: task.id,
        doneWhenCount: Array.isArray(task.doneWhen) ? task.doneWhen.length : 0,
        latestSession: latestSessionByTask.get(task.id) ?? null,
      },
    };
  });
  const edges = graphRelations(overview)
    .filter((relation) => taskIds.has(relation.sourceId) && taskIds.has(relation.targetId))
    .map((relation) =>
      taskGraphEdge(
        relation.kind,
        relation.sourceId,
        relation.targetId,
        selectedTasks.some((task) => task.id === relation.targetId && task.status === "running"),
      ),
    );
  return { nodes, edges };
}

function collectRelatedTaskIds(overview: RunOverview, groupId?: string | null) {
  if (!groupId) {
    return new Set(overview.tasks.map((task) => task.id));
  }
  const seeds = overview.tasks
    .filter((task) => task.id === groupId || (task.cycleId || task.id) === groupId)
    .map((task) => task.id);
  const related = new Set(seeds.length ? seeds : [groupId]);
  const adjacency = new Map<string, Set<string>>();
  const link = (sourceId: string, targetId: string) => {
    if (!adjacency.has(sourceId)) adjacency.set(sourceId, new Set());
    if (!adjacency.has(targetId)) adjacency.set(targetId, new Set());
    adjacency.get(sourceId)?.add(targetId);
    adjacency.get(targetId)?.add(sourceId);
  };
  for (const relation of graphRelations(overview)) {
    link(relation.sourceId, relation.targetId);
  }
  const queue = [...related];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const next of adjacency.get(id) ?? []) {
      if (!related.has(next)) {
        related.add(next);
        queue.push(next);
      }
    }
  }
  return related;
}

function graphRelations(overview: RunOverview) {
  const taskIds = new Set(overview.tasks.map((task) => task.id));
  const relations: Array<{ kind: DashboardTaskGraphEdge["label"]; sourceId: string; targetId: string }> = [];
  const seen = new Set<string>();
  const add = (kind: DashboardTaskGraphEdge["label"], sourceId: unknown, targetId: unknown) => {
    if (typeof sourceId !== "string" || typeof targetId !== "string") return;
    if (!taskIds.has(sourceId) || !taskIds.has(targetId) || sourceId === targetId) return;
    const pairKey = `${sourceId}->${targetId}`;
    const key = `${kind}:${pairKey}`;
    if (seen.has(key)) return;
    if (kind === "created" && relations.some((relation) => `${relation.sourceId}->${relation.targetId}` === pairKey)) return;
    seen.add(key);
    relations.push({ kind, sourceId, targetId });
  };

  for (const task of overview.tasks) {
    for (const sourceId of task.dependsOn || []) add("dependsOn", sourceId, task.id);
    if (task.parentId) add("parentId", task.parentId, task.id);
  }

  for (const session of overview.sessions) {
    const artifacts = Array.isArray(session.output?.artifacts) ? session.output.artifacts : [];
    for (const artifact of artifacts) {
      if (!artifact || typeof artifact !== "object") continue;
      const record = artifact as Record<string, unknown>;
      add("created", record.sourceTaskId, record.taskId);
    }
  }

  for (const task of overview.tasks) {
    if (task.role !== "goal-review") continue;
    const hasRelation = relations.some((relation) => relation.sourceId === task.id || relation.targetId === task.id);
    if (hasRelation) continue;
    const taskIndex = overview.tasks.findIndex((candidate) => candidate.id === task.id);
    const previous = [...overview.tasks.slice(0, taskIndex)]
      .reverse()
      .find((candidate) => candidate.role !== "goal-review");
    if (previous) add("reviews", previous.id, task.id);
  }

  return relations;
}

function taskGraphEdge(
  label: DashboardTaskGraphEdge["label"],
  source: string,
  target: string,
  animated: boolean,
): DashboardTaskGraphEdge {
  return {
    id: `${label}:${source}->${target}`,
    source,
    target,
    label,
    type: "smoothstep",
    animated,
    markerEnd: { type: "arrowclosed" },
  };
}

function roleColumn(role: string) {
  if (role === "planner" || role === "goal-review") return "planner";
  if (role === "verifier") return "verifier";
  return "worker";
}

function columnX(column: string) {
  if (column === "planner") return 0;
  if (column === "verifier") return 720;
  return 360;
}

function compactText(value: string, max: number) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function dashboardHtml(input: { runId: string }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Ouroboros Dashboard</title>
  <link rel="stylesheet" href="/assets/dashboard-canvas.css">
  <style>
    :root {
      color-scheme: light;
      font-family: "Aptos", "Segoe UI Variable", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
      --app: #121212;
      --sidebar: #30302f;
      --sidebar-soft: #3a3a38;
      --panel: #252524;
      --panel-soft: #2f2f2e;
      --canvas: #151515;
      --canvas-soft: #1d1d1c;
      --line: rgba(255, 255, 255, 0.1);
      --line-strong: rgba(255, 255, 255, 0.18);
      --ink: #f0f0eb;
      --muted: #aaa9a3;
      --muted-2: #787772;
      --ok: #b8d4c2;
      --warn: #d4c7a8;
      --danger: #d2aaa8;
      --mono: "JetBrains Mono", "SFMono-Regular", Consolas, monospace;
      color: var(--ink);
      background: var(--app);
    }
    * { box-sizing: border-box; }
    * {
      scrollbar-width: thin;
      scrollbar-color: rgba(255, 255, 255, 0.22) transparent;
    }
    *::-webkit-scrollbar {
      width: 12px;
      height: 12px;
    }
    *::-webkit-scrollbar-track {
      background: transparent;
    }
    *::-webkit-scrollbar-thumb {
      min-height: 44px;
      border: 4px solid transparent;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.2);
      background-clip: padding-box;
    }
    *::-webkit-scrollbar-thumb:hover {
      background: rgba(255, 255, 255, 0.32);
      background-clip: padding-box;
    }
    html, body { min-height: 100%; }
    body {
      margin: 0;
      min-height: 100dvh;
      overflow: hidden;
      background: var(--app);
    }
    .app-shell {
      min-height: 100dvh;
      display: grid;
      grid-template-columns: 300px minmax(520px, 1fr) 326px;
      background: var(--app);
    }
    .task-sidebar {
      display: grid;
      grid-template-rows: auto auto 1fr;
      min-width: 0;
      padding: 14px 10px;
      background: linear-gradient(180deg, #313130, #565652);
      border-right: 1px solid rgba(255, 255, 255, 0.12);
      overflow: hidden;
    }
    .sidebar-head {
      padding: 2px 6px 14px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    }
    .brand-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    h1 {
      margin: 0;
      font-size: 18px;
      font-weight: 760;
      letter-spacing: 0;
    }
    .run-status {
      min-width: 0;
      max-width: 160px;
      padding: 0;
      border: 0;
      color: var(--ok);
      font-size: 11px;
      font-weight: 760;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .run-status.updating::after {
      content: "";
      display: inline-block;
      width: 4px;
      height: 4px;
      margin-left: 7px;
      border-radius: 999px;
      background: currentColor;
      vertical-align: middle;
      animation: breathe 1.2s ease-in-out infinite;
    }
    #run-title {
      margin-top: 10px;
      color: #d0d0c9;
      font-size: 14px;
      line-height: 1.5;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .goal-composer {
      display: grid;
      gap: 8px;
      margin-top: 16px;
    }
    .goal-label {
      color: #bab9b2;
      font-size: 11px;
      font-weight: 760;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .goal-input {
      width: 100%;
      min-height: 72px;
      resize: vertical;
      padding: 10px 11px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 12px;
      outline: 0;
      background: rgba(18, 18, 18, 0.3);
      color: #f0f0eb;
      font: inherit;
      font-size: 13px;
      line-height: 1.45;
    }
    .goal-input:focus {
      border-color: rgba(255, 255, 255, 0.32);
      background: rgba(18, 18, 18, 0.44);
    }
    .goal-actions {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }
    .plain-button {
      min-width: 0;
      min-height: 30px;
      padding: 0 10px;
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.07);
      color: #efeee9;
      font: inherit;
      font-size: 12px;
      font-weight: 680;
      cursor: pointer;
      transition: transform 160ms cubic-bezier(0.16, 1, 0.3, 1), background 160ms, border-color 160ms;
    }
    .plain-button:hover {
      background: rgba(255, 255, 255, 0.11);
      border-color: rgba(255, 255, 255, 0.24);
    }
    .plain-button:active {
      transform: scale(0.98);
    }
    .plain-button.secondary {
      color: #d7d6cf;
      background: transparent;
    }
    .plain-button.danger {
      color: #ead2d0;
      border-color: rgba(210, 170, 168, 0.32);
      background: rgba(210, 170, 168, 0.08);
    }
    .plain-button.danger:hover {
      border-color: rgba(210, 170, 168, 0.48);
      background: rgba(210, 170, 168, 0.14);
    }
    .plain-button:disabled {
      cursor: default;
      opacity: 0.45;
      transform: none;
    }
    .form-status {
      min-height: 15px;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.35;
    }
    .sidebar-stats {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 0;
      padding: 14px 6px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    }
    .stat {
      padding: 9px 10px 11px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    }
    .stat b {
      display: block;
      font-family: var(--mono);
      font-size: 24px;
      line-height: 1.1;
      color: #f1f1ec;
    }
    .stat span {
      display: block;
      margin-top: 5px;
      color: #bbbab3;
      font-size: 11px;
      font-weight: 720;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .task-nav {
      min-height: 0;
      overflow: auto;
      padding: 0 8px 24px 4px;
      scrollbar-gutter: stable;
    }
    .nav-section { margin-bottom: 18px; }
    .section-label {
      margin: 0 0 8px;
      padding: 0 4px;
      color: #bab9b2;
      font-size: 11px;
      font-weight: 760;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .task-list {
      display: grid;
      gap: 0;
    }
    .task-row {
      width: 100%;
      display: grid;
      grid-template-columns: 12px 1fr auto;
      gap: 9px;
      align-items: start;
      padding: 10px 6px 11px;
      border: 1px solid transparent;
      border-bottom-color: rgba(255, 255, 255, 0.07);
      border-radius: 0;
      background: transparent;
      color: #e4e3dd;
      text-align: left;
      font: inherit;
      cursor: pointer;
      transition: transform 160ms cubic-bezier(0.16, 1, 0.3, 1), background 160ms, border-color 160ms;
    }
    .task-row:hover {
      transform: translateX(2px);
      background: rgba(255, 255, 255, 0.055);
    }
    .task-row:active { transform: translateY(0) scale(0.995); }
    .task-row.selected {
      background: rgba(255, 255, 255, 0.09);
      border-bottom-color: rgba(255, 255, 255, 0.11);
    }
    .task-row strong {
      display: block;
      min-width: 0;
      color: #f2f1ec;
      font-size: 14px;
      font-weight: 680;
      line-height: 1.35;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .task-row .row-meta {
      margin-top: 4px;
      color: #aaa9a2;
      font-size: 11px;
      line-height: 1.35;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .workspace {
      min-width: 0;
      height: 100dvh;
      display: grid;
      grid-template-rows: auto 1fr;
      background: var(--canvas);
      overflow: hidden;
    }
    .workspace-head {
      padding: 24px 44px 18px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(18, 18, 18, 0.88);
      backdrop-filter: blur(12px);
    }
    .workspace-head-row {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 18px;
    }
    .workspace-title-block {
      min-width: 0;
    }
    .workspace-kicker {
      color: var(--muted-2);
      font-size: 11px;
      font-weight: 740;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .workspace-title {
      margin-top: 8px;
      max-width: 760px;
      color: var(--ink);
      font-size: 24px;
      font-weight: 720;
      line-height: 1.45;
    }
    .workspace-toggle {
      flex: 0 0 auto;
      display: inline-grid;
      grid-template-columns: repeat(2, minmax(72px, 1fr));
      gap: 3px;
      padding: 3px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.055);
    }
    .workspace-toggle button {
      min-width: 0;
      height: 30px;
      padding: 0 13px;
      border: 0;
      border-radius: 999px;
      background: transparent;
      color: #b9b8b1;
      font: inherit;
      font-size: 12px;
      font-weight: 720;
      cursor: pointer;
    }
    .workspace-toggle button.active {
      background: #e3e2dc;
      color: #171716;
      box-shadow: 0 1px 8px rgba(0, 0, 0, 0.24);
    }
    .workspace-flow {
      min-height: 0;
      overflow: auto;
      padding: 38px 48px 128px;
      scrollbar-gutter: stable;
    }
    .workspace-flow.canvas-workspace {
      overflow: hidden;
      padding: 0;
      scrollbar-gutter: auto;
    }
    .flow-inner {
      width: min(100%, 720px);
      margin: 0 auto;
    }
    .transcript {
      display: grid;
    }
    .canvas-inner {
      width: 100%;
      min-height: 0;
      height: 100%;
      margin: 0;
      border: 0;
      border-radius: 0;
      overflow: hidden;
      background: #f6f6f3;
    }
    #dashboard-canvas-root {
      width: 100%;
      height: 100%;
    }
    .of-node {
      width: 250px;
      display: grid;
      gap: 10px;
      padding: 13px 14px 14px;
      border: 1px solid #c7c7c2;
      border-radius: 8px;
      background: #ffffff;
      color: #151515;
      box-shadow: 0 8px 20px rgba(0, 0, 0, 0.08);
    }
    .of-node-running { border-color: #777773; }
    .of-node-done { border-color: #222222; }
    .of-node-blocked { border-color: #8b8b8b; border-style: dashed; }
    .of-node-todo { border-color: #adadad; }
    .of-node-head {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      color: #5b5b57;
      font-size: 10px;
      font-weight: 760;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .of-node-goal {
      color: #181818;
      font-size: 13px;
      font-weight: 720;
      line-height: 1.45;
      overflow-wrap: anywhere;
    }
    .of-node-meta {
      display: grid;
      gap: 3px;
      color: #666661;
      font-family: var(--mono);
      font-size: 10px;
      line-height: 1.45;
      overflow-wrap: anywhere;
    }
    .of-handle {
      width: 8px;
      height: 8px;
      border: 1px solid #5f5f5b;
      background: #ffffff;
    }
    .react-flow__edge-text {
      font-size: 10px;
      fill: #3f3f3d;
    }
    .react-flow__controls button {
      border-color: #dededa;
      background: #ffffff;
      color: #1b1b1b;
    }
    .react-flow__minimap {
      border: 1px solid #d7d7d2;
      border-radius: 6px;
      background: #fbfbf8;
    }
    .turn {
      display: grid;
      grid-template-columns: 34px minmax(0, 1fr);
      gap: 18px;
      padding: 28px 0 36px;
      border-top: 1px solid rgba(255, 255, 255, 0.065);
      background: transparent;
      animation: liftIn 260ms cubic-bezier(0.16, 1, 0.3, 1) both;
    }
    .turn.primary {
      padding-top: 12px;
      border-top: 0;
    }
    .turn-gutter {
      display: grid;
      grid-template-rows: 26px 1fr;
      justify-items: center;
      min-height: 100%;
    }
    .turn-avatar {
      width: 26px;
      height: 26px;
      display: inline-grid;
      place-items: center;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.055);
      color: #ecebe5;
      font-size: 11px;
      font-weight: 760;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .turn-rail {
      width: 1px;
      min-height: 24px;
      margin-top: 8px;
      background: rgba(255, 255, 255, 0.08);
    }
    .turn-head, .inspector-row {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
    }
    .turn-author {
      color: #f1f1ec;
      font-size: 16px;
      font-weight: 720;
      line-height: 1.45;
    }
    .turn-summary {
      margin-top: 6px;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.55;
    }
    .turn-text {
      margin-top: 18px;
      color: #d8d7d0;
      font-size: 14px;
      line-height: 1.85;
      white-space: pre-wrap;
    }
    .stream-output {
      margin: 18px 0 0;
      max-height: 320px;
      overflow: auto;
      padding: 14px 0 0 16px;
      border-left: 1px solid rgba(255, 255, 255, 0.12);
      color: #efefea;
      font-family: var(--mono);
      font-size: 11px;
      line-height: 1.6;
      white-space: pre-wrap;
    }
    .stream-line + .stream-line {
      margin-top: 8px;
    }
    .tool-line {
      margin-top: 14px;
      color: var(--muted-2);
      font-size: 11px;
      line-height: 1.6;
    }
    .turn .meta { margin-top: 10px; }
    .inspector-panel {
      height: 100dvh;
      padding: 58px 24px 24px;
      background: var(--app);
      border-left: 1px solid rgba(255, 255, 255, 0.08);
      overflow: auto;
      scrollbar-gutter: stable;
    }
    .inspector-card {
      padding: 24px 26px 28px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 28px;
      background: #2a2a29;
    }
    .inspector-card:first-child {
      padding-top: 24px;
    }
    .inspector-card + .inspector-card {
      margin-top: 14px;
    }
    .inspector-card h2 {
      margin: 0 0 22px;
      color: #a8a7a1;
      font-size: 15px;
      font-weight: 760;
      letter-spacing: 0;
      text-transform: none;
    }
    .todo-list, .lesson-list, .info-list {
      display: grid;
      gap: 16px;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .current-task {
      margin: 0 0 20px;
      padding-bottom: 18px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
    }
    .current-task-title {
      color: #efeee9;
      font-size: 13px;
      font-weight: 690;
      line-height: 1.5;
    }
    .current-task-meta {
      margin-top: 8px;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.55;
    }
    .todo-item {
      display: grid;
      grid-template-columns: 22px 1fr;
      gap: 12px;
      align-items: start;
      color: #d9d8d1;
      font-size: 16px;
      line-height: 1.48;
    }
    .todo-item.done {
      color: var(--muted);
    }
    .todo-item.done .todo-text {
      text-decoration: line-through;
      text-decoration-color: rgba(255, 255, 255, 0.38);
    }
    .todo-item .meta {
      display: block;
      margin-top: 2px;
    }
    .control-row {
      margin-top: 20px;
      padding-top: 18px;
      border-top: 1px solid rgba(255, 255, 255, 0.1);
    }
    .checkbox {
      width: 18px;
      height: 18px;
      margin-top: 2px;
      display: inline-grid;
      place-items: center;
      border: 2px solid rgba(255, 255, 255, 0.42);
      border-radius: 999px;
    }
    .checkbox.done { background: #deded8; border-color: #deded8; }
    .checkbox.done::after {
      content: "";
      width: 5px;
      height: 3px;
      border-left: 1.5px solid #111;
      border-bottom: 1.5px solid #111;
      transform: translateY(-1px) rotate(-45deg);
    }
    .lesson {
      padding: 9px 0 11px;
      border-top: 1px solid rgba(255, 255, 255, 0.07);
      color: #d6d5cf;
      font-size: 14px;
      line-height: 1.55;
    }
    .prompt-link {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 24px;
      padding: 0;
      border: 0;
      border-radius: 0;
      color: #d9d9d4;
      background: transparent;
      font-size: 14px;
      font-weight: 720;
      text-decoration: underline;
      text-decoration-color: rgba(255, 255, 255, 0.28);
      text-underline-offset: 3px;
      transition: color 160ms, text-decoration-color 160ms;
    }
    .prompt-link:hover {
      color: #ffffff;
      text-decoration-color: rgba(255, 255, 255, 0.72);
    }
    .prompt-link:active { color: #cfcfc9; }
    .status-dot {
      width: 8px;
      height: 8px;
      margin-top: 6px;
      border-radius: 999px;
      background: #8f8f88;
    }
    .status-dot.done { background: var(--ok); }
    .status-dot.running { background: #d8d0a8; animation: breathe 1.8s ease-in-out infinite; }
    .status-dot.blocked { background: var(--danger); }
    .status-dot.todo { background: var(--warn); }
    .status-text {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: var(--muted);
      font-size: 11px;
      font-weight: 760;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      white-space: nowrap;
    }
    .status-text.done { color: var(--ok); }
    .status-text.running { color: #d8d0a8; }
    .status-text.blocked { color: var(--danger); }
    .status-text.todo { color: var(--warn); }
    .role-label, .kind-label {
      color: var(--muted-2);
      font-size: 11px;
      font-weight: 760;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .empty {
      padding: 16px;
      border-top: 1px dashed rgba(255, 255, 255, 0.14);
      border-bottom: 1px dashed rgba(255, 255, 255, 0.14);
      border-radius: 0;
      color: #aaa9a3;
      font-size: 14px;
      line-height: 1.6;
      background: rgba(255, 255, 255, 0.035);
    }
    .empty strong {
      display: block;
      margin-bottom: 4px;
      color: #d8d7d0;
      font-size: 13px;
      font-weight: 680;
    }
    .meta {
      color: var(--muted);
      font-size: 11px;
      line-height: 1.6;
      overflow-wrap: anywhere;
    }
    .code-meta {
      font-family: var(--mono);
      font-size: 11px;
      line-height: 1.65;
    }
    @keyframes breathe {
      0%, 100% { box-shadow: 0 0 0 0 rgba(0, 0, 0, 0); }
      50% { box-shadow: 0 0 0 4px rgba(0, 0, 0, 0.08); }
    }
    @keyframes liftIn {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @media (max-width: 900px) {
      body { overflow: auto; }
      .app-shell {
        min-height: 100dvh;
        grid-template-columns: 1fr;
      }
      .task-sidebar, .workspace, .inspector-panel {
        height: auto;
        max-height: none;
        overflow: visible;
      }
      .workspace-head-row {
        display: grid;
      }
      .workspace-toggle {
        width: 100%;
      }
      .workspace-flow { padding: 18px 16px 32px; }
      .workspace-flow.canvas-workspace { min-height: 560px; padding: 0; }
      .workspace-head { padding: 16px; }
      .canvas-inner {
        height: 560px;
        min-height: 560px;
      }
    }
  </style>
  <script type="module" src="/assets/dashboard-canvas.js"></script>
</head>
<body>
  <div class="app-shell">
    <aside class="task-sidebar">
      <div class="sidebar-head">
        <div class="brand-row">
          <h1>Ouroboros</h1>
          <div class="run-status" id="run-status">Loading</div>
        </div>
        <div id="run-title">Loading ${escapeHtml(input.runId)}</div>
        <form class="goal-composer" id="goal-composer">
          <label class="goal-label" for="goal-input">New goal</label>
          <textarea class="goal-input" id="goal-input" name="goal" placeholder="Describe a new goal or change request"></textarea>
          <div class="goal-actions">
            <button class="plain-button" type="submit" data-goal-action="add">Add goal</button>
            <button class="plain-button secondary" type="submit" data-goal-action="interrupt">Interrupt + replan</button>
          </div>
          <div class="form-status" id="goal-form-status"></div>
        </form>
      </div>
      <section class="sidebar-stats" id="sidebar-stats"></section>
      <nav class="task-nav" aria-label="Goals">
        <section class="nav-section">
          <h2 class="section-label">Active Goals</h2>
          <div class="task-list" id="active-goal-list"></div>
        </section>
        <section class="nav-section">
          <h2 class="section-label">History</h2>
          <div class="task-list" id="history-goal-list"></div>
        </section>
      </nav>
    </aside>
    <main class="workspace">
      <header class="workspace-head">
        <div class="workspace-head-row">
          <div class="workspace-title-block">
            <div class="workspace-kicker" id="workspace-kicker">Task Flow</div>
            <div class="workspace-title" id="workspace-title">Loading</div>
          </div>
          <div class="workspace-toggle" aria-label="Workspace view">
            <button type="button" data-workspace-mode="canvas" aria-pressed="false">Canvas</button>
            <button type="button" data-workspace-mode="flow" aria-pressed="true" class="active">Flow</button>
          </div>
        </div>
      </header>
      <section class="workspace-flow" id="workspace-flow"></section>
    </main>
    <aside class="inspector-panel" id="inspector-panel"></aside>
  </div>
  <script>
    const runId = ${JSON.stringify(input.runId)};
    const byStatus = (items) => items.reduce((acc, item) => {
      acc[item.status] = (acc[item.status] || 0) + 1;
      return acc;
    }, {});
    const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[char]));
    const eventText = (event) => {
      if (event.text && String(event.text).trim()) return String(event.text).trim();
      const payload = event.payload || {};
      for (const key of ["delta", "message", "text", "content"]) {
        if (typeof payload[key] === "string" && payload[key].trim()) return payload[key].trim();
      }
      return "";
    };
    const latestText = (session) => session.latestText || session.events.map(eventText).filter(Boolean).slice(-1)[0] || "";
    const streamOutput = (session) => {
      const lines = (session.events || []).map(eventText).filter(Boolean).slice(-20);
      if (lines.length === 0 && latestText(session)) lines.push(latestText(session));
      if (lines.length === 0) return '<div class="turn-text">No stream output recorded.</div>';
      return '<div class="stream-output" data-attempt-stream="' + escapeHtml(session.attemptId) + '">' +
        lines.map((line, index) => '<div class="stream-line" data-event-index="' + index + '">' + escapeHtml(line) + '</div>').join("") +
        '</div>';
    };
    const promptLink = (task) => '<a class="prompt-link" target="_blank" rel="noreferrer" href="/tasks/' + encodeURIComponent(task.id) + '/prompt">Prompt</a>';
    let selectedGoalId = null;
    let workspaceMode = "flow";
    let latestOverview = null;
    const groupStatus = (tasks) => {
      if (tasks.some((task) => task.status === "running")) return "running";
      if (tasks.some((task) => task.status === "todo")) return "todo";
      if (tasks.some((task) => task.status === "blocked")) return "blocked";
      return "done";
    };
    const isCycleStarter = (task) => task.role === "planner" || task.role === "goal-review";
    const titleTaskFor = (tasks) =>
      tasks.find((task) => !["planner", "verifier", "goal-review"].includes(task.role) && !task.goal.startsWith("Repair:")) ||
      tasks.find((task) => task.role === "verifier") ||
      tasks[0];
    const addRelation = (relations, seen, taskIds, kind, sourceId, targetId) => {
      if (typeof sourceId !== "string" || typeof targetId !== "string") return;
      if (!taskIds.has(sourceId) || !taskIds.has(targetId) || sourceId === targetId) return;
      const pairKey = sourceId + "->" + targetId;
      if (kind === "created" && relations.some((relation) => relation.sourceId + "->" + relation.targetId === pairKey)) return;
      const key = kind + ":" + pairKey;
      if (seen.has(key)) return;
      seen.add(key);
      relations.push({ kind, sourceId, targetId });
    };
    const graphRelationsFor = (overview) => {
      const taskIds = new Set((overview.tasks || []).map((task) => task.id));
      const relations = [];
      const seen = new Set();
      for (const task of overview.tasks || []) {
        for (const sourceId of task.dependsOn || []) addRelation(relations, seen, taskIds, "dependsOn", sourceId, task.id);
        if (task.parentId) addRelation(relations, seen, taskIds, "parentId", task.parentId, task.id);
      }
      for (const session of overview.sessions || []) {
        const artifacts = Array.isArray(session.output?.artifacts) ? session.output.artifacts : [];
        for (const artifact of artifacts) {
          if (!artifact || typeof artifact !== "object") continue;
          addRelation(relations, seen, taskIds, "created", artifact.sourceTaskId, artifact.taskId);
        }
      }
      for (const task of overview.tasks || []) {
        if (task.role !== "goal-review") continue;
        const hasRelation = relations.some((relation) => relation.sourceId === task.id || relation.targetId === task.id);
        if (hasRelation) continue;
        const taskIndex = overview.tasks.findIndex((candidate) => candidate.id === task.id);
        const previous = [...overview.tasks.slice(0, taskIndex)].reverse().find((candidate) => candidate.role !== "goal-review");
        if (previous) addRelation(relations, seen, taskIds, "reviews", previous.id, task.id);
      }
      return relations;
    };
    const relatedTaskIdsFor = (overview, groupId) => {
      if (!groupId) return new Set((overview.tasks || []).map((task) => task.id));
      const seeds = (overview.tasks || [])
        .filter((task) => task.id === groupId || (task.cycleId || task.id) === groupId)
        .map((task) => task.id);
      const related = new Set(seeds.length ? seeds : [groupId]);
      const adjacency = new Map();
      const link = (sourceId, targetId) => {
        if (!adjacency.has(sourceId)) adjacency.set(sourceId, new Set());
        if (!adjacency.has(targetId)) adjacency.set(targetId, new Set());
        adjacency.get(sourceId).add(targetId);
        adjacency.get(targetId).add(sourceId);
      };
      for (const relation of graphRelationsFor(overview)) link(relation.sourceId, relation.targetId);
      const queue = [...related];
      while (queue.length) {
        const id = queue.shift();
        for (const next of adjacency.get(id) || []) {
          if (!related.has(next)) {
            related.add(next);
            queue.push(next);
          }
        }
      }
      return related;
    };
    const buildGoalGroups = (overview) => {
      const relations = graphRelationsFor(overview);
      const adjacency = new Map();
      const link = (sourceId, targetId) => {
        if (!adjacency.has(sourceId)) adjacency.set(sourceId, new Set());
        if (!adjacency.has(targetId)) adjacency.set(targetId, new Set());
        adjacency.get(sourceId).add(targetId);
        adjacency.get(targetId).add(sourceId);
      };
      for (const relation of relations) link(relation.sourceId, relation.targetId);
      const taskById = new Map((overview.tasks || []).map((task) => [task.id, task]));
      const visited = new Set();
      const groups = [];
      for (const task of overview.tasks) {
        if (visited.has(task.id)) continue;
        const taskIds = new Set();
        const queue = [task.id];
        visited.add(task.id);
        while (queue.length) {
          const id = queue.shift();
          taskIds.add(id);
          for (const next of adjacency.get(id) || []) {
            if (!visited.has(next)) {
              visited.add(next);
              queue.push(next);
            }
          }
        }
        const tasks = overview.tasks.filter((candidate) => taskIds.has(candidate.id));
        const root = tasks.find((candidate) => isCycleStarter(candidate)) || taskById.get(task.id) || tasks[0];
        groups.push({ id: root.cycleId || root.id, root, titleTask: titleTaskFor(tasks), taskIds, tasks });
      }
      return groups.map((group) => {
        const ids = group.taskIds;
        const sessions = overview.sessions.filter((session) => ids.has(session.taskId));
        const lessons = (overview.lessons || []).filter((lesson) => ids.has(lesson.taskId));
        const activeTasks = group.tasks.filter((task) => task.status === "todo" || task.status === "running");
        return {
          id: group.id,
          root: group.root,
          titleTask: group.titleTask,
          tasks: group.tasks,
          sessions,
          lessons,
          activeTasks,
          status: groupStatus(group.tasks),
        };
      });
    };
    const compact = (value, max = 140) => {
      const text = String(value ?? "").replace(/\\s+/g, " ").trim();
      return text.length > max ? text.slice(0, max - 1) + "…" : text;
    };
    const lessonList = (lessons) => lessons.length
      ? '<div class="lesson-list">' + lessons.map((lesson) =>
        '<div class="lesson ' + escapeHtml(lesson.kind) + '"><span class="kind-label">' + escapeHtml(lesson.kind) + '</span> ' +
        escapeHtml(lesson.summary) + '<div class="meta code-meta">task ' + escapeHtml(lesson.taskId) + '<br>attempt ' + escapeHtml(lesson.attemptId) + '</div></div>'
      ).join("") + '</div>'
      : '<div class="empty">No lessons or experiences</div>';
    const taskMeta = (task) => '<span class="code-meta">id ' + escapeHtml(task.id) + '</span>' + (task.dependsOn.length ? ' · depends on ' + task.dependsOn.map((id) => '<span class="code-meta">' + escapeHtml(id) + '</span>').join(", ") : '');
    const relationText = (ids) => ids.length ? ids.map((id) => '<span class="code-meta">' + escapeHtml(id) + '</span>').join(", ") : '<span class="meta">none</span>';
    const roleSummary = (tasks) => [...new Set(tasks.map((task) => task.role))].join(" / ");
    const roleMark = (role) => escapeHtml(String(role || "?").slice(0, 2));
    const goalRow = (group) =>
      '<button class="task-row ' + (group.id === selectedGoalId ? 'selected' : '') + '" data-goal-id="' + escapeHtml(group.id) + '">' +
      '<span class="status-dot ' + escapeHtml(group.status) + '"></span>' +
      '<span><strong>' + escapeHtml(group.titleTask.goal) + '</strong><span class="row-meta">' + group.tasks.length + ' tasks · ' + escapeHtml(roleSummary(group.tasks)) + '</span></span>' +
      '<span class="status-text ' + escapeHtml(group.status) + '">' + escapeHtml(group.status) + '</span></button>';
    const turn = (input) =>
      '<article class="turn ' + (input.primary ? "primary" : "") + '" data-turn-key="' + escapeHtml(input.key || input.mark) + '"><div class="turn-gutter"><div class="turn-avatar">' + input.mark + '</div><div class="turn-rail"></div></div>' +
      '<div class="turn-body"><div class="turn-head"><div><div class="turn-author">' + input.author + '</div>' +
      (input.summary ? '<div class="turn-summary">' + input.summary + '</div>' : '') + '</div>' +
      (input.action || '') + '</div>' + (input.body || '') + '</div></article>';
    const sessionFlowTurn = (session) =>
      turn({
        key: session.attemptId,
        mark: roleMark(session.role),
        author: escapeHtml(session.role),
        summary: escapeHtml(session.taskGoal) + ' · ' + escapeHtml(session.status),
        action: '<span class="status-text ' + escapeHtml(session.status) + '">' + escapeHtml(session.status) + '</span>',
        body:
          '<div class="tool-line code-meta">task ' + escapeHtml(session.taskId) + ' · attempt ' + escapeHtml(session.attemptId) +
          (session.sessionName ? '<br>session ' + escapeHtml(session.sessionName) : '') +
          (session.codexSessionId ? '<br>codex ' + escapeHtml(session.codexSessionId) : '') + '</div>' +
          streamOutput(session),
      });
    const renderFlowWorkspace = (group) => {
      if (!group) return '<div class="flow-inner"><div class="empty">No goal selected</div></div>';
      const taskIdsWithSessions = new Set(group.sessions.map((session) => session.taskId));
      const pendingFlow = group.tasks.filter((task) => !taskIdsWithSessions.has(task.id) && (task.status === "todo" || task.status === "running"));
      return '<div class="flow-inner"><div class="transcript">' +
        turn({
          primary: true,
          key: "goal:" + group.id,
          mark: "go",
          author: escapeHtml(group.titleTask.goal),
          summary: '<span class="role-label">' + escapeHtml(roleSummary(group.tasks)) + '</span> · <span class="status-text ' + escapeHtml(group.status) + '">' + escapeHtml(group.status) + '</span>',
          action: promptLink(group.titleTask),
          body: '<div class="tool-line">' + taskMeta(group.root) + '</div><div class="turn-text">' + escapeHtml(group.root.prompt) + '</div>',
        }) +
        (group.sessions.length ? group.sessions.map(sessionFlowTurn).join("") : '<div class="empty">No sessions recorded for this goal yet.</div>') +
        (pendingFlow.length ? pendingFlow.map((task) => turn({
          key: "task:" + task.id,
          mark: roleMark(task.role),
          author: escapeHtml(task.role),
          summary: escapeHtml(task.goal),
          action: '<span class="status-text ' + escapeHtml(task.status) + '">' + escapeHtml(task.status) + '</span>',
          body: '<div class="tool-line">' + taskMeta(task) + '</div>',
        })).join("") : '') +
        (group.lessons.length ? turn({
          key: "lessons:" + group.id,
          mark: "le",
          author: "Lessons and experiences",
          summary: escapeHtml(group.lessons.length + " records"),
          body: lessonList(group.lessons.slice(-6)),
        }) : '') +
        '</div></div>';
    };
    const graphColumn = (role) => role === "planner" || role === "goal-review" ? "planner" : role === "verifier" ? "verifier" : "worker";
    const graphColumnX = (column) => column === "planner" ? 0 : column === "verifier" ? 720 : 360;
    const canvasGraphFor = (overview, group) => {
      if (!group) return { nodes: [], edges: [] };
      const groupTaskIds = relatedTaskIdsFor(overview, group.id);
      const tasks = overview.tasks.filter((task) => groupTaskIds.has(task.id));
      const sessions = new Map((overview.sessions || []).filter((session) => groupTaskIds.has(session.taskId)).map((session) => [session.taskId, {
        status: session.status,
        attemptId: session.attemptId,
        sessionName: session.sessionName,
        codexSessionId: session.codexSessionId,
        latestText: latestText(session),
      }]));
      const columns = new Map();
      const nodes = tasks.map((task, index) => {
        const column = graphColumn(task.role);
        const row = columns.get(column) || 0;
        columns.set(column, row + 1);
        return {
          id: task.id,
          type: "task",
          position: { x: graphColumnX(column), y: row * 190 + (index % 2) * 12 },
          data: {
            role: task.role,
            status: task.status,
            goal: compact(task.goal, 118),
            taskId: task.id,
            doneWhenCount: Array.isArray(task.doneWhen) ? task.doneWhen.length : 0,
            latestSession: sessions.get(task.id) || null,
          },
        };
      });
      const edges = graphRelationsFor(overview).filter((edge) => groupTaskIds.has(edge.sourceId) && groupTaskIds.has(edge.targetId)).map((edge) => ({
        id: edge.kind + ":" + edge.sourceId + "->" + edge.targetId,
        source: edge.sourceId,
        target: edge.targetId,
        label: edge.kind,
        type: "smoothstep",
        animated: tasks.some((task) => task.id === edge.targetId && task.status === "running"),
        markerEnd: { type: "arrowclosed" },
      }));
      return { nodes, edges };
    };
    const renderCanvasWorkspace = (group) => {
      if (!group) return '<div class="canvas-inner"><div class="empty">No goal selected</div></div>';
      const graph = canvasGraphFor(latestOverview || { tasks: group.tasks, sessions: group.sessions, lessons: group.lessons }, group);
      return '<div class="canvas-inner" data-canvas-goal-id="' + escapeHtml(group.id) + '">' +
        '<div id="dashboard-canvas-root" data-canvas-graph="' + escapeHtml(JSON.stringify(graph)) + '"></div>' +
        '<div hidden>' + graph.nodes.map((node) => {
          const task = node.data;
          return '<span data-canvas-task-id="' + escapeHtml(task.taskId) + '">' + escapeHtml(task.role) + ' ' + escapeHtml(task.status) + '</span>';
        }).join("") + graph.edges.map((edge) =>
          '<span data-canvas-edge="' + escapeHtml(edge.id) + '">' + escapeHtml(edge.label) + '</span>'
        ).join("") + '</div>' +
        '</div>';
    };
    const renderWorkspace = (group) => workspaceMode === "canvas" ? renderCanvasWorkspace(group) : renderFlowWorkspace(group);
    const mountReactFlowCanvas = () => {
      if (workspaceMode !== "canvas") return;
      const mount = document.getElementById("dashboard-canvas-root");
      if (!mount) return;
      const graphJson = mount.getAttribute("data-canvas-graph") || '{"nodes":[],"edges":[]}';
      const mountGraph = () => {
        try {
          window.OuroborosCanvas?.render(mount, JSON.parse(graphJson));
        } catch (error) {
          mount.innerHTML = '<div class="empty">Canvas failed to render: ' + escapeHtml(error && error.message ? error.message : String(error)) + '</div>';
        }
      };
      if (window.OuroborosCanvas) {
        mountGraph();
      } else {
        window.addEventListener("ouroboros-canvas-ready", mountGraph, { once: true });
      }
    };
    const renderInspector = (overview, group) => {
      if (!group) return '<section class="inspector-card"><h2>Detail</h2><div class="empty">Select a goal</div></section>';
      const doneWhen = group.tasks.flatMap((task) => (Array.isArray(task.doneWhen) ? task.doneWhen : []).map((item) => ({ task, item })));
      const runningSessions = group.sessions.filter((session) => session.status === "running");
      const currentTask = group.tasks.find((task) => task.status === "running") ||
        group.tasks.find((task) => task.status === "todo") ||
        [...group.tasks].reverse().find((task) => task.status === "blocked" || task.status === "done");
      const rerunnableTask = runningSessions.length ? null : [...group.tasks].reverse().find((task) => task.status === "blocked" || task.status === "done");
      return '<section class="inspector-card"><h2>Progress</h2>' +
        (currentTask ? '<div class="current-task"><div class="current-task-title">' + escapeHtml(currentTask.goal) + '</div><div class="current-task-meta">' + escapeHtml(currentTask.role) + ' · <span class="status-text ' + escapeHtml(currentTask.status) + '">' + escapeHtml(currentTask.status) + '</span><br><span class="code-meta">' + escapeHtml(currentTask.id) + '</span></div></div>' : '') +
        (doneWhen.length ? '<ul class="todo-list">' + doneWhen.map(({ task, item }) =>
          '<li class="todo-item ' + (task.status === "done" ? "done" : "") + '"><span class="checkbox ' + (task.status === "done" ? "done" : "") + '" aria-hidden="true"></span><span class="todo-text">' + escapeHtml(item) + '<span class="meta">' + escapeHtml(task.role) + '</span></span></li>'
        ).join("") + '</ul>' : '<div class="empty">No todos recorded</div>') +
        (runningSessions.length ? '<div class="control-row"><button class="plain-button danger" data-stop-attempt-id="' + escapeHtml(runningSessions[0].attemptId) + '">Stop current task</button></div>' : '') +
        (rerunnableTask ? '<div class="control-row"><button class="plain-button" data-rerun-task-id="' + escapeHtml(rerunnableTask.id) + '">Rerun selected task</button></div>' : '') +
        '</section>';
    };
    const latestRunnerSignal = (overview) => {
      const session = [...(overview.sessions || [])].reverse()[0];
      const text = session ? latestText(session) : "";
      if (!session || !text || session.status === "done") return null;
      if (session.status !== "running" && session.status !== "blocked") return null;
      const timedOut = text.includes("Reconnecting... 5/5") || text.toLowerCase().includes("request timed out");
      return {
        status: session.status,
        taskGoal: session.taskGoal,
        attemptId: session.attemptId,
        text,
        timedOut,
      };
    };
    const runnerOutputSnippet = (runner, runDone) => {
      const text = String(runner?.lastOutput || "").trim();
      if (!text || runDone || runner?.exitCode === 0) return "";
      if (text.startsWith("{") && text.includes('"status":"done"')) return "";
      return compact(text, 900);
    };
    const renderRunner = (overview) => {
      const runner = overview.runner;
      const issue = latestRunnerSignal(overview);
      const status = runner?.status || "idle";
      const runDone = overview.run?.status === "done";
      const hasQueuedWork = (overview.tasks || []).some((task) => task.status === "todo" || task.status === "running");
      const canStart = status !== "running" && !runDone && hasQueuedWork;
      const canStop = status === "running";
      const output = runnerOutputSnippet(runner, runDone);
      const statusClass = status === "running" ? "running" : runDone || runner?.exitCode === 0 ? "done" : status === "exited" ? "blocked" : "todo";
      const title = runDone ? "Run complete" : status === "running" ? "Background runner" : "Runner idle";
      const meta = runDone ? "goal reached" : status === "running" ? "background loop is active" : canStart ? "ready to process queued work" : "no queued work";
      return '<section class="inspector-card"><h2>Runner</h2>' +
        '<div class="current-task"><div class="current-task-title">' + escapeHtml(title) + '</div><div class="current-task-meta">' + escapeHtml(meta) + ' · <span class="status-text ' + escapeHtml(statusClass) + '">' + escapeHtml(status) + '</span>' +
        (runner?.pid ? '<br><span class="code-meta">pid ' + escapeHtml(runner.pid) + '</span>' : '') +
        (runner?.exitCode !== undefined && runner?.exitCode !== null ? '<br><span class="code-meta">exit ' + escapeHtml(runner.exitCode) + '</span>' : '') +
        '</div></div>' +
        (issue ? '<div class="current-task"><div class="current-task-title">' + escapeHtml(issue.timedOut ? "Connection timed out" : "Latest runner issue") + '</div><div class="current-task-meta">' + escapeHtml(issue.taskGoal) + '<br><span class="code-meta">' + escapeHtml(issue.attemptId) + '</span></div><div class="stream-output">' + escapeHtml(issue.text) + '</div></div>' : '') +
        (output ? '<div class="stream-output">' + escapeHtml(output) + '</div>' : '') +
        (canStart || canStop ? '<div class="control-row">' +
          (canStart ? '<button class="plain-button" data-start-runner>Start background runner</button>' : '') +
          (canStop ? '<button class="plain-button danger" data-stop-runner>Stop background runner</button>' : '') +
        '</div>' : '') +
        '</section>';
    };
    const postJson = async (path, body) => {
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "request failed");
      return payload;
    };
    const refreshOverview = () => overviewWorker.postMessage({ type: "refresh" });
    const setGoalFormStatus = (message) => {
      const node = document.getElementById("goal-form-status");
      if (node) node.textContent = message;
    };
    const renderedHtml = new Map();
    const setTextIfChanged = (id, value) => {
      const node = document.getElementById(id);
      const next = String(value ?? "");
      if (node && node.textContent !== next) node.textContent = next;
    };
    const setHtmlIfChanged = (id, html) => {
      const current = renderedHtml.get(id);
      if (current === html) return;
      renderedHtml.set(id, html);
      const node = document.getElementById(id);
      if (node) node.innerHTML = html;
    };
    const syncWorkspaceToggle = () => {
      for (const button of document.querySelectorAll("[data-workspace-mode]")) {
        const active = button.getAttribute("data-workspace-mode") === workspaceMode;
        button.classList.toggle("active", active);
        button.setAttribute("aria-pressed", active ? "true" : "false");
      }
    };
    const patchWorkspace = (html) => {
      const node = document.getElementById("workspace-flow");
      if (!node || renderedHtml.get("workspace-flow") === html) return;
      const template = document.createElement("template");
      template.innerHTML = html;
      const nextTranscript = template.content.querySelector(".transcript");
      const currentTranscript = node.querySelector(".transcript");
      if (!nextTranscript || !currentTranscript) {
        renderedHtml.set("workspace-flow", html);
        node.innerHTML = html;
        return;
      }
      const nextTurns = Array.from(nextTranscript.querySelectorAll("[data-turn-key]"));
      const nextKeys = new Set(nextTurns.map((turnNode) => turnNode.getAttribute("data-turn-key")));
      for (const currentTurn of Array.from(currentTranscript.querySelectorAll("[data-turn-key]"))) {
        if (!nextKeys.has(currentTurn.getAttribute("data-turn-key"))) currentTurn.remove();
      }
      for (const nextTurn of nextTurns) {
        const key = nextTurn.getAttribute("data-turn-key");
        const currentTurn = currentTranscript.querySelector('[data-turn-key="' + CSS.escape(key) + '"]');
        if (!currentTurn) {
          currentTranscript.appendChild(nextTurn.cloneNode(true));
          continue;
        }
        if (currentTurn.outerHTML !== nextTurn.outerHTML) {
          currentTurn.replaceWith(nextTurn.cloneNode(true));
          continue;
        }
        currentTranscript.appendChild(currentTurn);
      }
      renderedHtml.set("workspace-flow", html);
      for (const stream of node.querySelectorAll(".stream-output")) {
        stream.scrollTop = stream.scrollHeight;
      }
    };
    const overviewWorkerSource = [
      'let runId = null;',
      'let apiBase = "";',
      'let timer = null;',
      'const shouldPoll = (overview) => overview.run?.status !== "done" || overview.tasks.some((task) => task.status === "todo" || task.status === "running") || overview.sessions.some((session) => session.status === "running");',
      'const schedule = (delay) => { if (timer) clearTimeout(timer); timer = setTimeout(refresh, delay); };',
      'async function refresh() {',
      '  if (!runId) return;',
      '  try {',
      '    self.postMessage({ type: "refreshing" });',
      '    const response = await fetch(apiBase + "/api/runs/" + encodeURIComponent(runId) + "/overview");',
      '    if (!response.ok) throw new Error("overview request failed: " + response.status);',
      '    const overview = await response.json();',
      '    self.postMessage({ type: "overview", overview });',
      '    if (shouldPoll(overview)) schedule(1500);',
      '  } catch (error) {',
      '    self.postMessage({ type: "error", message: error && error.message ? error.message : String(error) });',
      '    schedule(5000);',
      '  }',
      '}',
      'self.onmessage = (event) => {',
      '  if (event.data?.type === "start") { runId = event.data.runId; apiBase = event.data.apiBase || ""; refresh(); }',
      '  if (event.data?.type === "refresh") refresh();',
      '};'
    ].join("\\n");
    const overviewWorker = new Worker(URL.createObjectURL(new Blob([overviewWorkerSource], { type: "text/javascript" })));
    overviewWorker.onmessage = (event) => {
      if (event.data?.type === "refreshing") document.getElementById("run-status")?.classList.add("updating");
      if (event.data?.type === "overview") {
        document.getElementById("run-status")?.classList.remove("updating");
        render(event.data.overview);
      }
      if (event.data?.type === "error") console.error("overview worker:", event.data.message);
    };
    overviewWorker.onerror = (event) => console.error("overview worker:", event.message);
    function render(overview) {
      latestOverview = overview;
      const taskCounts = byStatus(overview.tasks);
      const sessionCounts = byStatus(overview.sessions);
      const goalGroups = buildGoalGroups(overview);
      const activeGroups = goalGroups.filter((group) => group.activeTasks.length > 0);
      if (!selectedGoalId || !goalGroups.some((group) => group.id === selectedGoalId)) {
        selectedGoalId = (activeGroups[0] || goalGroups[goalGroups.length - 1] || {}).id || null;
      }
      const selectedGroup = goalGroups.find((group) => group.id === selectedGoalId);
      setTextIfChanged("run-status", overview.run?.status || "unknown");
      setTextIfChanged("run-title", overview.run ? overview.run.goal : runId);
      setTextIfChanged("workspace-kicker", selectedGroup ? selectedGroup.status + " / " + selectedGroup.tasks.length + " tasks" : "Goal Flow");
      setTextIfChanged("workspace-title", selectedGroup ? selectedGroup.titleTask.goal : "No goal selected");
      syncWorkspaceToggle();
      document.getElementById("workspace-flow")?.classList.toggle("canvas-workspace", workspaceMode === "canvas");
      setHtmlIfChanged("sidebar-stats", [
        ["Goals", goalGroups.length],
        ["Active goals", activeGroups.length],
        ["Queued tasks", (taskCounts.todo || 0) + (taskCounts.running || 0)],
        ["Running sessions", sessionCounts.running || 0]
      ].map(([label, value]) => '<div class="stat"><b>' + value + '</b><span>' + label + '</span></div>').join(""));
      setHtmlIfChanged("active-goal-list", activeGroups.length ? activeGroups.map(goalRow).join("") : '<div class="empty"><strong>Idle</strong>No active tasks. Open a blocked history goal and rerun it, or add a new goal.</div>');
      setHtmlIfChanged("history-goal-list", [...goalGroups].reverse().filter((group) => group.activeTasks.length === 0).map(goalRow).join(""));
      patchWorkspace(renderWorkspace(selectedGroup));
      mountReactFlowCanvas();
      setHtmlIfChanged("inspector-panel", renderInspector(overview, selectedGroup) + renderRunner(overview));
    }
    document.addEventListener("click", (event) => {
      if (!event.target || !event.target.closest) return;
      const modeButton = event.target.closest("[data-workspace-mode]");
      if (modeButton) {
        workspaceMode = modeButton.getAttribute("data-workspace-mode") || "flow";
        if (latestOverview) render(latestOverview);
        return;
      }
      const stopButton = event.target.closest("[data-stop-attempt-id]");
      if (stopButton) {
        const attemptId = stopButton.getAttribute("data-stop-attempt-id");
        stopButton.disabled = true;
        postJson("/api/attempts/" + encodeURIComponent(attemptId) + "/stop", {})
          .then(() => {
            setGoalFormStatus("Stopped current task.");
            refreshOverview();
          })
          .catch((error) => setGoalFormStatus(error.message))
          .finally(() => { stopButton.disabled = false; });
        return;
      }
      const startRunnerButton = event.target.closest("[data-start-runner]");
      if (startRunnerButton) {
        startRunnerButton.disabled = true;
        postJson("/api/runs/" + encodeURIComponent(runId) + "/runner/start", {})
          .then(() => {
            setGoalFormStatus("Runner started.");
            refreshOverview();
          })
          .catch((error) => setGoalFormStatus(error.message))
          .finally(() => { startRunnerButton.disabled = false; });
        return;
      }
      const stopRunnerButton = event.target.closest("[data-stop-runner]");
      if (stopRunnerButton) {
        stopRunnerButton.disabled = true;
        postJson("/api/runs/" + encodeURIComponent(runId) + "/runner/stop", {})
          .then(() => {
            setGoalFormStatus("Runner stopped.");
            refreshOverview();
          })
          .catch((error) => setGoalFormStatus(error.message))
          .finally(() => { stopRunnerButton.disabled = false; });
        return;
      }
      const rerunButton = event.target.closest("[data-rerun-task-id]");
      if (rerunButton) {
        const taskId = rerunButton.getAttribute("data-rerun-task-id");
        rerunButton.disabled = true;
        postJson("/api/tasks/" + encodeURIComponent(taskId) + "/rerun", {})
          .then(() => {
            setGoalFormStatus("Task queued for rerun.");
            refreshOverview();
          })
          .catch((error) => setGoalFormStatus(error.message))
          .finally(() => { rerunButton.disabled = false; });
        return;
      }
      const resumeButton = event.target.closest("[data-resume-task-id]");
      if (resumeButton) {
        const taskId = resumeButton.getAttribute("data-resume-task-id");
        resumeButton.disabled = true;
        postJson("/api/tasks/" + encodeURIComponent(taskId) + "/resume", {})
          .then(() => refreshOverview())
          .catch((error) => setGoalFormStatus(error.message))
          .finally(() => { resumeButton.disabled = false; });
        return;
      }
      const row = event.target.closest("[data-goal-id]");
      if (!row) return;
      selectedGoalId = row.getAttribute("data-goal-id");
      if (latestOverview) render(latestOverview);
    });
    document.getElementById("goal-composer").addEventListener("submit", (event) => {
      event.preventDefault();
      const submitter = event.submitter;
      const action = submitter?.getAttribute("data-goal-action") || "add";
      const input = document.getElementById("goal-input");
      const goal = input.value.trim();
      if (!goal) {
        setGoalFormStatus("Write a goal first.");
        return;
      }
      submitter.disabled = true;
      setGoalFormStatus(action === "interrupt" ? "Interrupting and replanning..." : "Adding goal...");
      const path = action === "interrupt" ? "/api/runs/" + encodeURIComponent(runId) + "/interrupt" : "/api/runs/" + encodeURIComponent(runId) + "/goals";
      postJson(path, { goal })
        .then((payload) => {
          input.value = "";
          selectedGoalId = payload.taskId || selectedGoalId;
          setGoalFormStatus(action === "interrupt" ? "Interrupted. Planner queued." : "Planner queued.");
          refreshOverview();
        })
        .catch((error) => setGoalFormStatus(error.message))
        .finally(() => { submitter.disabled = false; });
    });
    overviewWorker.postMessage({ type: "start", runId, apiBase: window.location.origin });
  </script>
</body>
</html>`;
}

export function serveDashboard(input: {
  runId: string;
  port: number;
  overview: () => RunOverview;
  renderTaskPrompt: (taskId: string) => string;
  runnerStatus?: () => DashboardRunnerStatus | null;
  actions?: DashboardActions;
}) {
  return Bun.serve({
    port: input.port,
    fetch(request) {
      return handleDashboardRequest(request, input);
    },
  });
}

export async function handleDashboardRequest(
  request: Request,
  input: {
    runId: string;
    overview: () => RunOverview;
    renderTaskPrompt: (taskId: string) => string;
    runnerStatus?: () => DashboardRunnerStatus | null;
    actions?: DashboardActions;
  },
) {
  const url = new URL(request.url);
  if (url.pathname === "/") {
    return new Response(dashboardHtml({ runId: input.runId }), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  if (url.pathname === "/assets/dashboard-canvas.js") {
    return new Response(await bundledDashboardCanvasScript(), {
      headers: { "content-type": "text/javascript; charset=utf-8" },
    });
  }
  if (url.pathname === "/assets/dashboard-canvas.css") {
    return new Response(await bundledDashboardCanvasCss(), {
      headers: { "content-type": "text/css; charset=utf-8" },
    });
  }
  if (url.pathname === `/api/runs/${input.runId}/overview`) {
    return Response.json({ ...input.overview(), runner: input.runnerStatus?.() ?? null });
  }
  if (request.method === "POST" && url.pathname === `/api/runs/${input.runId}/runner/start`) {
    return withDashboardAction(async () => {
      if (!input.actions?.startRunner) {
        throw new Error("dashboard runner start is not configured");
      }
      return input.actions.startRunner();
    });
  }
  if (request.method === "POST" && url.pathname === `/api/runs/${input.runId}/runner/stop`) {
    return withDashboardAction(async () => {
      if (!input.actions?.stopRunner) {
        throw new Error("dashboard runner stop is not configured");
      }
      return input.actions.stopRunner();
    });
  }
  if (request.method === "POST" && url.pathname === `/api/runs/${input.runId}/goals`) {
    return withDashboardAction(async () => {
      if (!input.actions?.createGoal) {
        throw new Error("dashboard goal creation is not configured");
      }
      const body = await readJsonBody(request);
      const goal = requiredBodyString(body, "goal");
      return input.actions.createGoal(goal);
    });
  }
  if (request.method === "POST" && url.pathname === `/api/runs/${input.runId}/interrupt`) {
    return withDashboardAction(async () => {
      if (!input.actions?.interruptAndCreateGoal) {
        throw new Error("dashboard interrupt is not configured");
      }
      const body = await readJsonBody(request);
      const goal = requiredBodyString(body, "goal");
      return input.actions.interruptAndCreateGoal(goal);
    });
  }
  const resumeMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/resume$/);
  if (request.method === "POST" && resumeMatch) {
    return withDashboardAction(async () => {
      if (!input.actions?.resumeTask) {
        throw new Error("dashboard resume is not configured");
      }
      return input.actions.resumeTask(decodeURIComponent(resumeMatch[1]));
    });
  }
  const rerunMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/rerun$/);
  if (request.method === "POST" && rerunMatch) {
    return withDashboardAction(async () => {
      if (!input.actions?.rerunTask) {
        throw new Error("dashboard rerun is not configured");
      }
      return input.actions.rerunTask(decodeURIComponent(rerunMatch[1]));
    });
  }
  const stopMatch = url.pathname.match(/^\/api\/attempts\/([^/]+)\/stop$/);
  if (request.method === "POST" && stopMatch) {
    return withDashboardAction(async () => {
      if (!input.actions?.stopAttempt) {
        throw new Error("dashboard stop is not configured");
      }
      return input.actions.stopAttempt(decodeURIComponent(stopMatch[1]));
    });
  }
  const promptMatch = url.pathname.match(/^\/tasks\/([^/]+)\/prompt$/);
  if (promptMatch) {
    return new Response(input.renderTaskPrompt(decodeURIComponent(promptMatch[1])), {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  return new Response("not found", { status: 404 });
}

async function withDashboardAction(input: () => DashboardActionResult | Promise<DashboardActionResult>) {
  try {
    return Response.json(await input());
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

async function readJsonBody(request: Request) {
  const value = await request.json().catch(() => null);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function requiredBodyString(body: Record<string, unknown>, key: string) {
  const value = body[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} is required`);
  }
  return value.trim();
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return char;
    }
  });
}

let canvasScriptCache: Promise<string> | null = null;
let canvasCssCache: Promise<string> | null = null;

function bundledDashboardCanvasScript() {
  canvasScriptCache ??= buildDashboardCanvasScript();
  return canvasScriptCache;
}

async function buildDashboardCanvasScript() {
  const result = await Bun.build({
    entrypoints: [fileURLToPath(new URL("./dashboard-canvas.tsx", import.meta.url))],
    target: "browser",
    format: "esm",
    minify: false,
    sourcemap: "none",
  });
  if (!result.success) {
    throw new Error(result.logs.map((log) => log.message).join("\n") || "dashboard canvas bundle failed");
  }
  const artifact = result.outputs.find((output) => output.path.endsWith(".js")) ?? result.outputs[0];
  return artifact.text();
}

function bundledDashboardCanvasCss() {
  canvasCssCache ??= buildDashboardCanvasCss();
  return canvasCssCache;
}

async function buildDashboardCanvasCss() {
  const xyflowCssUrl = import.meta.resolve("@xyflow/react/dist/style.css");
  const xyflowCss = await Bun.file(fileURLToPath(xyflowCssUrl)).text();
  return `${xyflowCss}

.react-flow {
  font-family: "Aptos", "Segoe UI Variable", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
}
`;
}
