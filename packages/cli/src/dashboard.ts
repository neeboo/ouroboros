import type { RunOverview } from "@ouroboros/harness";
import { isAbsolute, relative, resolve } from "node:path";
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

type DashboardAutoStartRunner = (overview: RunOverview, runner: DashboardRunnerStatus | null) => boolean;

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
      grid-template-columns: 300px minmax(0, 1fr) clamp(380px, 30vw, 520px);
      overflow-x: hidden;
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
    .project-title {
      margin-top: 7px;
      color: #aaa9a3;
      font-family: var(--mono);
      font-size: 11px;
      line-height: 1.45;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .project-header {
      min-width: 0;
      overflow: hidden;
    }
    .project-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .project-root {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
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
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
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
      width: 100%;
      min-width: 0;
      max-width: 100%;
      min-height: 0;
      overflow-x: hidden;
      overflow-y: auto;
      padding: 0 8px 24px 4px;
      scrollbar-gutter: stable;
    }
    .nav-section {
      width: 100%;
      min-width: 0;
      max-width: 100%;
      margin-bottom: 18px;
      overflow-x: hidden;
    }
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
      width: 100%;
      min-width: 0;
      max-width: 100%;
      display: grid;
      gap: 0;
      overflow-x: hidden;
    }
    .task-row {
      width: 100%;
      min-width: 0;
      display: grid;
      grid-template-columns: 12px minmax(0, 1fr) minmax(0, 72px);
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
      overflow: hidden;
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
    .task-row-text {
      min-width: 0;
      overflow: hidden;
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
      flex: 1 1 auto;
      min-width: 0;
      max-width: 760px;
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
      min-width: 0;
      color: var(--ink);
      font-size: 24px;
      font-weight: 720;
      line-height: 1.45;
      overflow-wrap: anywhere;
    }
    .workspace-title-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      align-items: start;
    }
    .workspace-title.is-collapsed {
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .workspace-title.is-expanded {
      display: block;
      overflow: visible;
    }
    .workspace-title-toggle {
      flex: 0 0 auto;
      min-width: 0;
      min-height: 28px;
      margin-top: 11px;
      padding: 0 9px;
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.065);
      color: #d8d7d0;
      font: inherit;
      font-size: 11px;
      font-weight: 720;
      cursor: pointer;
    }
    .workspace-title-toggle:hover {
      border-color: rgba(255, 255, 255, 0.26);
      background: rgba(255, 255, 255, 0.11);
    }
    .workspace-title-toggle:focus-visible {
      outline: 2px solid rgba(255, 255, 255, 0.55);
      outline-offset: 2px;
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
      min-width: 0;
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
      min-width: 0;
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
      min-width: 0;
      display: flex;
      justify-content: space-between;
      gap: 10px;
      color: #5b5b57;
      font-size: 10px;
      font-weight: 760;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .of-node-head span {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
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
    .turn-body {
      min-width: 0;
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
      overflow-wrap: anywhere;
    }
    .turn-summary {
      margin-top: 6px;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.55;
      overflow-wrap: anywhere;
    }
    .turn-text {
      margin-top: 18px;
      color: #d8d7d0;
      font-size: 14px;
      line-height: 1.85;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .conversation-evidence {
      display: grid;
      gap: 12px;
      margin-top: 16px;
    }
    .evidence-group {
      min-width: 0;
      padding-top: 12px;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
    }
    .evidence-title {
      color: #aaa9a2;
      font-size: 11px;
      font-weight: 700;
      line-height: 1.35;
    }
    .evidence-list {
      display: grid;
      gap: 6px;
      margin: 8px 0 0;
      padding: 0;
      list-style: none;
    }
    .evidence-item {
      min-width: 0;
      color: #d3d2cc;
      font-size: 12px;
      line-height: 1.55;
      overflow-wrap: anywhere;
    }
    .evidence-item .meta {
      margin-top: 2px;
      font-size: 10.5px;
    }
    .raw-stream {
      margin-top: 14px;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.45;
    }
    .raw-stream summary {
      cursor: pointer;
      color: #aaa9a2;
      font-weight: 650;
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
      overflow-wrap: anywhere;
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
      width: clamp(380px, 30vw, 520px);
      min-width: 380px;
      max-width: 520px;
      height: 100dvh;
      min-height: 0;
      padding: 46px 26px 28px;
      background: var(--app);
      border-left: 1px solid rgba(255, 255, 255, 0.08);
      overflow-x: hidden;
      overflow-y: auto;
      scrollbar-gutter: stable;
    }
    .inspector-card {
      min-width: 0;
      padding: 22px 0 24px;
      border: 0;
      border-radius: 0;
      background: transparent;
    }
    .inspector-card:first-child {
      padding-top: 0;
    }
    .inspector-card + .inspector-card {
      margin-top: 0;
      border-top: 1px solid rgba(255, 255, 255, 0.1);
    }
    .inspector-card h2 {
      margin: 0 0 18px;
      color: #a8a7a1;
      font-size: 13px;
      font-weight: 760;
      letter-spacing: 0;
      text-transform: none;
    }
    .todo-list, .lesson-list, .info-list {
      display: grid;
      gap: 9px;
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
      overflow-wrap: anywhere;
    }
    .current-task-meta {
      margin-top: 8px;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.55;
      overflow-wrap: anywhere;
    }
    .todo-item {
      display: grid;
      grid-template-columns: 18px minmax(0, 1fr);
      gap: 9px;
      align-items: start;
      color: #d9d8d1;
      font-size: 13px;
      line-height: 1.42;
    }
    .todo-text {
      min-width: 0;
      overflow-wrap: anywhere;
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
      font-size: 10.5px;
    }
    .control-row {
      margin-top: 20px;
      padding-top: 18px;
      border-top: 1px solid rgba(255, 255, 255, 0.1);
    }
    .changed-files-section {
      min-width: 0;
    }
    .changed-file-tree {
      min-width: 0;
      max-height: 280px;
      display: grid;
      gap: 2px;
      overflow-x: hidden;
      overflow-y: auto;
      scrollbar-gutter: stable;
    }
    .changed-file-children {
      display: grid;
      gap: 2px;
      margin-left: 8px;
      padding-left: 12px;
      border-left: 1px solid rgba(255, 255, 255, 0.08);
    }
    .changed-file-node {
      width: 100%;
      min-width: 0;
      display: grid;
      grid-template-columns: 28px minmax(0, 1fr);
      gap: 7px;
      align-items: center;
      padding: 5px 7px;
      border: 0;
      border-radius: 5px;
      background: transparent;
      color: #d8d7d0;
      font: inherit;
      font-size: 12px;
      line-height: 1.35;
      text-align: left;
    }
    button.changed-file-node {
      cursor: pointer;
    }
    button.changed-file-node:hover {
      background: rgba(255, 255, 255, 0.045);
      color: #f4f3ee;
    }
    button.changed-file-node.selected {
      background: rgba(255, 255, 255, 0.075);
      color: #ffffff;
    }
    button.changed-file-node.selected .changed-file-type {
      color: #c8c7c1;
    }
    .changed-file-type {
      color: var(--muted-2);
      font-family: var(--mono);
      font-size: 10px;
      line-height: 1.4;
      text-align: center;
    }
    .changed-file-name {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .changed-file-path {
      min-width: 0;
      margin-top: 8px;
      color: var(--muted);
      font-family: var(--mono);
      font-size: 11px;
      line-height: 1.55;
      overflow-wrap: anywhere;
    }
    .diff-panel {
      min-width: 0;
      max-width: 100%;
      overflow: hidden;
      margin-top: 16px;
      padding-top: 16px;
      border-top: 1px solid rgba(255, 255, 255, 0.1);
    }
    .diff-header {
      position: sticky;
      top: 0;
      z-index: 1;
      overflow: hidden;
      padding: 0 0 10px;
      background: var(--app);
    }
    .diff-path {
      min-width: 0;
      color: #deddd7;
      font-family: var(--mono);
      font-size: 11px;
      line-height: 1.55;
      overflow-wrap: anywhere;
    }
    .diff-output {
      max-height: 340px;
      overflow-x: auto;
      overflow-y: auto;
      margin: 0;
      padding: 8px 0;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 6px;
      background: rgba(18, 18, 18, 0.22);
      color: #f0f0eb;
      font-family: var(--mono);
      font-size: 11px;
      line-height: 1.62;
      white-space: pre;
      overflow-wrap: normal;
    }
    .diff-row {
      display: grid;
      grid-template-columns: 42px max-content;
      min-width: max-content;
      align-items: start;
    }
    .diff-gutter {
      user-select: none;
      padding: 0 10px 0 12px;
      color: var(--muted-2);
      text-align: right;
    }
    .diff-line {
      white-space: pre;
      font-family: var(--mono);
      padding-right: 18px;
    }
    .diff-row.added {
      background: rgba(111, 160, 122, 0.12);
    }
    .diff-row.added .diff-gutter {
      color: #a9c7b1;
    }
    .diff-row.removed {
      background: rgba(184, 113, 111, 0.12);
    }
    .diff-row.removed .diff-gutter {
      color: #d6aaa8;
    }
    .diff-row.hunk {
      background: rgba(255, 255, 255, 0.055);
      color: #cfcec8;
    }
    .diff-row.context {
      background: transparent;
    }
    .diff-state {
      min-width: 0;
      padding: 12px;
      color: var(--muted);
      font-family: var(--mono);
      font-size: 11px;
      line-height: 1.6;
      white-space: normal;
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
      width: 100%;
      max-width: 100%;
      color: var(--muted);
      font-size: 11px;
      font-weight: 760;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      overflow: hidden;
      text-overflow: ellipsis;
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
        grid-template-columns: minmax(0, 1fr);
      }
      .task-sidebar, .workspace, .inspector-panel {
        height: auto;
        max-height: none;
        overflow: visible;
      }
      .inspector-panel { width: auto; min-width: 0; max-width: none; }
      .inspector-panel {
        padding: 24px 18px 30px;
        border-left: 0;
        border-top: 1px solid rgba(255, 255, 255, 0.08);
      }
      .task-sidebar { min-width: 0; overflow-x: hidden; overflow-y: visible; }
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
        <div class="project-title project-header" id="project-title" data-project-header>
          <div class="project-name" data-project-name>Project Workspace</div>
          <div class="project-root" data-project-root></div>
        </div>
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
            <div class="workspace-title-row">
              <div class="workspace-title is-collapsed" id="workspace-title" title="Loading">Loading</div>
              <button class="workspace-title-toggle" id="workspace-title-toggle" type="button" data-workspace-title-toggle aria-expanded="false" aria-controls="workspace-title" aria-label="Expand workspace title">Expand</button>
            </div>
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
    const readableSummary = (session) => {
      const summary = session.output?.summary;
      if (typeof summary === "string" && summary.trim()) return summary.trim();
      const fallback = latestText(session);
      return fallback ? compact(fallback, 360) : "No summary recorded yet.";
    };
    const evidenceItemText = (item) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object") return String(item ?? "");
      return item.summary || item.evidence || item.name || item.path || item.kind || JSON.stringify(item);
    };
    const evidenceItemMeta = (item) => {
      if (!item || typeof item !== "object") return "";
      const parts = [];
      if (item.status) parts.push(String(item.status));
      if (item.name && item.summary) parts.push(String(item.name));
      if (item.kind && item.path) parts.push(String(item.kind));
      return parts.join(" · ");
    };
    const evidenceSection = (title, items) => {
      const list = Array.isArray(items) ? items.filter((item) => item !== null && item !== undefined) : [];
      if (list.length === 0) return "";
      return '<section class="evidence-group"><div class="evidence-title">' + escapeHtml(title) + '</div><ul class="evidence-list">' +
        list.slice(0, 8).map((item) => {
          const meta = evidenceItemMeta(item);
          return '<li class="evidence-item">' + escapeHtml(evidenceItemText(item)) +
            (meta ? '<div class="meta">' + escapeHtml(meta) + '</div>' : '') + '</li>';
        }).join("") +
        (list.length > 8 ? '<li class="evidence-item meta">' + escapeHtml(list.length - 8) + ' more</li>' : '') +
        '</ul></section>';
    };
    const conversationEvidence = (session) => {
      const output = session.output || {};
      const groups = [
        evidenceSection("Problems", output.problems),
        evidenceSection("Checks", output.checks),
        evidenceSection("Changed files", output.changedFiles),
        evidenceSection("Artifacts", output.artifacts),
      ].filter(Boolean).join("");
      return groups ? '<div class="conversation-evidence">' + groups + '</div>' : "";
    };
    const streamOutput = (session) => {
      const lines = (session.events || []).map(eventText).filter(Boolean).slice(-20);
      if (lines.length === 0 && latestText(session)) lines.push(latestText(session));
      if (lines.length === 0) return '<div class="turn-text">No stream output recorded.</div>';
      return '<div class="stream-output" data-attempt-stream="' + escapeHtml(session.attemptId) + '">' +
        lines.map((line, index) => '<div class="stream-line" data-event-index="' + index + '">' + escapeHtml(line) + '</div>').join("") +
        '</div>';
    };
    const rawStreamDetails = (session) =>
      '<details class="raw-stream"><summary>Raw output</summary>' + streamOutput(session) + '</details>';
    const promptLink = (task) => '<a class="prompt-link" target="_blank" rel="noreferrer" href="/tasks/' + encodeURIComponent(task.id) + '/prompt">Prompt</a>';
    const dashboardStorageKey = "ouroboros:dashboard:" + runId;
    const isWorkspaceMode = (value) => value === "canvas" || value === "flow";
    const readDashboardState = () => {
      try {
        const parsed = JSON.parse(window.localStorage?.getItem(dashboardStorageKey) || "{}");
        return {
          selectedGoalId: typeof parsed.selectedGoalId === "string" ? parsed.selectedGoalId : null,
          workspaceMode: isWorkspaceMode(parsed.workspaceMode) ? parsed.workspaceMode : null,
          workspaceTitleExpanded: parsed.workspaceTitleExpanded === true,
        };
      } catch {
        return { selectedGoalId: null, workspaceMode: null, workspaceTitleExpanded: false };
      }
    };
    const writeDashboardState = (state) => {
      try {
        window.localStorage?.setItem(dashboardStorageKey, JSON.stringify({
          selectedGoalId: typeof state.selectedGoalId === "string" ? state.selectedGoalId : null,
          workspaceMode: isWorkspaceMode(state.workspaceMode) ? state.workspaceMode : "flow",
          workspaceTitleExpanded: state.workspaceTitleExpanded === true,
        }));
      } catch {
      }
    };
    const restoredDashboardState = readDashboardState();
    let selectedGoalId = restoredDashboardState.selectedGoalId || null;
    let workspaceMode = restoredDashboardState.workspaceMode || "flow";
    let workspaceTitleExpanded = restoredDashboardState.workspaceTitleExpanded === true;
    let latestOverview = null;
    let selectedChangedFilePath = null;
    const diffByPath = new Map();
    const resolvedBlockedTaskIdsFor = (tasks) => {
      const repairsByParent = new Map();
      for (const task of tasks) {
        if (!task.parentId) continue;
        if (!repairsByParent.has(task.parentId)) repairsByParent.set(task.parentId, []);
        repairsByParent.get(task.parentId).push(task);
      }
      return new Set(tasks
        .filter((task) => task.status === "blocked")
        .filter((task) => (repairsByParent.get(task.id) || []).some((repair) => repair.status === "done"))
        .map((task) => task.id));
    };
    const effectiveTaskStatus = (task, resolvedBlockedTaskIds) =>
      task.status === "blocked" && resolvedBlockedTaskIds.has(task.id) ? "done" : task.status;
    const groupStatus = (tasks) => {
      const resolvedBlockedTaskIds = resolvedBlockedTaskIdsFor(tasks);
      const statuses = tasks.map((task) => effectiveTaskStatus(task, resolvedBlockedTaskIds));
      if (statuses.some((status) => status === "running")) return "running";
      if (statuses.some((status) => status === "todo")) return "todo";
      if (statuses.some((status) => status === "blocked")) return "blocked";
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
        const resolvedBlockedTaskIds = resolvedBlockedTaskIdsFor(group.tasks);
        return {
          id: group.id,
          root: group.root,
          titleTask: group.titleTask,
          tasks: group.tasks,
          sessions,
          lessons,
          activeTasks,
          resolvedBlockedTaskIds,
          resolvedBlockedCount: resolvedBlockedTaskIds.size,
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
    const normalizeChangedFilePath = (value) => {
      if (typeof value !== "string") return null;
      const trimmed = value.trim().replaceAll("\\\\", "/");
      if (!trimmed || trimmed.startsWith("/") || /^[A-Za-z]:\\//.test(trimmed)) return null;
      const normalized = trimmed.split("/").filter((part) => part && part !== ".").join("/");
      if (!normalized || normalized.split("/").some((part) => part === "..")) return null;
      return normalized;
    };
    const changedFilesForGroup = (group) => {
      const seen = new Set();
      return (group?.sessions || []).flatMap((session) => {
        const changedFiles = Array.isArray(session.output?.changedFiles) ? session.output.changedFiles : [];
        return changedFiles.flatMap((rawPath) => {
          const path = normalizeChangedFilePath(rawPath);
          if (!path || seen.has(path)) return [];
          seen.add(path);
          return [{ path, taskId: session.taskId, attemptId: session.attemptId }];
        });
      }).sort((left, right) => left.path.localeCompare(right.path));
    };
    const changedFilesTree = (files) => {
      const root = [];
      const directories = new Map([["", root]]);
      for (const file of files) {
        const parts = file.path.split("/");
        let parentPath = "";
        for (let index = 0; index < parts.length; index += 1) {
          const name = parts[index];
          const nodePath = parentPath ? parentPath + "/" + name : name;
          const parent = directories.get(parentPath) || root;
          const isFile = index === parts.length - 1;
          let node = parent.find((candidate) => candidate.path === nodePath);
          if (!node) {
            node = isFile
              ? { name, path: nodePath, type: "file", file }
              : { name, path: nodePath, type: "directory", children: [] };
            parent.push(node);
            parent.sort((left, right) => left.type === right.type ? left.path.localeCompare(right.path) : left.type === "file" ? -1 : 1);
          }
          if (!isFile) directories.set(nodePath, node.children || []);
          parentPath = nodePath;
        }
      }
      return root;
    };
    const renderChangedFilesTree = (nodes) => nodes.map((node) => {
      if (node.type === "directory") {
        return '<div data-changed-file-node="directory" data-changed-file-path="' + escapeHtml(node.path) + '">' +
          '<div class="changed-file-node"><span class="changed-file-type" aria-hidden="true">dir</span><span class="changed-file-name" title="' + escapeHtml(node.path) + '">' + escapeHtml(node.name) + '</span></div>' +
          '<div class="changed-file-children">' + renderChangedFilesTree(node.children || []) + '</div></div>';
      }
      const selected = node.path === selectedChangedFilePath;
      return '<button type="button" class="changed-file-node ' + (selected ? "selected" : "") + '" data-changed-file-node="file" data-changed-file-path="' + escapeHtml(node.path) + '"' + (selected ? ' data-selected-changed-file="true" aria-current="true"' : "") + ' title="' + escapeHtml(node.path) + '">' +
        '<span class="changed-file-type" aria-hidden="true">file</span><span class="changed-file-name">' + escapeHtml(node.name) + '</span></button>';
    }).join("");
    const diffLineType = (line) => {
      if (line.startsWith("@@")) return "hunk";
      if (line.startsWith("+") && !line.startsWith("+++")) return "added";
      if (line.startsWith("-") && !line.startsWith("---")) return "removed";
      return "context";
    };
    const renderDiffRows = (diff) => {
      const lines = String(diff || "").split("\\n");
      if (lines[lines.length - 1] === "") lines.pop();
      if (lines.length === 0) return '<div class="diff-state" data-diff-state="no-diff">No working tree diff for this file.</div>';
      return lines.map((line, index) => {
        const type = diffLineType(line);
        const mark = type === "added" ? "+" : type === "removed" ? "-" : type === "hunk" ? "@" : "";
        return '<div class="diff-row ' + type + '" data-diff-row data-diff-row-type="' + type + '" data-diff-line="' + index + '">' +
          '<span class="diff-gutter">' + escapeHtml(mark) + '</span><span class="diff-line">' + escapeHtml(line) + '</span></div>';
      }).join("");
    };
    const renderDiffState = (state, message) =>
      '<div class="diff-output" data-diff-output><div class="diff-state" data-diff-state="' + escapeHtml(state) + '">' + escapeHtml(message) + '</div></div>';
    const renderDiffPanel = (path) => {
      if (!path) return '<div class="diff-panel" data-diff-panel>' + renderDiffState("empty-selection", "Select a changed file to inspect its diff.") + '</div>';
      const state = diffByPath.get(path);
      const body = !state || state.status === "loading"
        ? renderDiffState("loading", "Loading diff...")
        : state.status === "error"
          ? renderDiffState("error", state.error || "Unable to load diff.")
          : '<div class="diff-output" data-diff-output>' + renderDiffRows(state.diff || "") + '</div>';
      return '<div class="diff-panel" data-diff-panel data-diff-path="' + escapeHtml(path) + '">' +
        '<div class="diff-header" data-diff-header><div class="diff-path" title="' + escapeHtml(path) + '">' + escapeHtml(path) + '</div></div>' + body + '</div>';
    };
    const renderChangedFilesSection = (group) => {
      const files = changedFilesForGroup(group);
      if (!files.some((file) => file.path === selectedChangedFilePath)) selectedChangedFilePath = files[0]?.path || null;
      const tree = changedFilesTree(files);
      return '<section class="inspector-card changed-files-section" data-inspector-section="changed-files" data-changed-files-section><h2>Changed Files</h2>' +
        (files.length ? '<div class="changed-file-tree" data-changed-file-tree>' + renderChangedFilesTree(tree) + '</div>' : '<div class="empty">No changed files reported for this goal.</div>') +
        renderDiffPanel(selectedChangedFilePath) +
        '</section>';
    };
    const taskMeta = (task) => '<span class="code-meta">id ' + escapeHtml(task.id) + '</span>' + (task.dependsOn.length ? ' · depends on ' + task.dependsOn.map((id) => '<span class="code-meta">' + escapeHtml(id) + '</span>').join(", ") : '');
    const relationText = (ids) => ids.length ? ids.map((id) => '<span class="code-meta">' + escapeHtml(id) + '</span>').join(", ") : '<span class="meta">none</span>';
    const roleSummary = (tasks) => [...new Set(tasks.map((task) => task.role))].join(" / ");
    const roleMark = (role) => escapeHtml(String(role || "?").slice(0, 2));
    const goalRow = (group) =>
      '<button class="task-row ' + (group.id === selectedGoalId ? 'selected' : '') + '" data-goal-id="' + escapeHtml(group.id) + '">' +
      '<span class="status-dot ' + escapeHtml(group.status) + '"></span>' +
      '<span class="task-row-text"><strong>' + escapeHtml(group.titleTask.goal) + '</strong><span class="row-meta">' + group.tasks.length + ' tasks · ' + escapeHtml(roleSummary(group.tasks)) + (group.resolvedBlockedCount ? ' · ' + escapeHtml(group.resolvedBlockedCount) + ' repaired block' : '') + '</span></span>' +
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
          '<div class="turn-text">' + escapeHtml(readableSummary(session)) + '</div>' +
          conversationEvidence(session) +
          rawStreamDetails(session),
      });
    const renderFlowWorkspace = (group) => {
      if (!group) return '<div class="flow-inner"><div class="empty">No goal selected</div></div>';
      const orderedSessions = [...group.sessions].sort((left, right) => {
        const leftTime = Date.parse(left.startedAt || "") || 0;
        const rightTime = Date.parse(right.startedAt || "") || 0;
        return leftTime - rightTime;
      });
      const taskIdsWithSessions = new Set(orderedSessions.map((session) => session.taskId));
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
        (orderedSessions.length ? orderedSessions.map(sessionFlowTurn).join("") : '<div class="empty">No sessions recorded for this goal yet.</div>') +
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
      if (!group) return '<section class="inspector-card" data-inspector-section="progress"><h2>Detail</h2><div class="empty">Select a goal</div></section>';
      const doneWhen = group.tasks.flatMap((task) => (Array.isArray(task.doneWhen) ? task.doneWhen : []).map((item) => ({ task, item })));
      const runningSessions = group.sessions.filter((session) => session.status === "running");
      const unresolvedBlockedTasks = group.tasks.filter((task) => task.status === "blocked" && !group.resolvedBlockedTaskIds.has(task.id));
      const currentTask = group.tasks.find((task) => task.status === "running") ||
        group.tasks.find((task) => task.status === "todo") ||
        unresolvedBlockedTasks[unresolvedBlockedTasks.length - 1] ||
        [...group.tasks].reverse().find((task) => task.status === "done") ||
        [...group.tasks].reverse().find((task) => task.status === "blocked");
      const rerunnableTask = runningSessions.length ? null : [...unresolvedBlockedTasks, ...group.tasks.filter((task) => task.status === "done")].reverse()[0] || null;
      return '<section class="inspector-card" data-inspector-section="progress"><h2>Progress</h2>' +
        (currentTask ? '<div class="current-task"><div class="current-task-title">' + escapeHtml(currentTask.goal) + '</div><div class="current-task-meta">' + escapeHtml(currentTask.role) + ' · <span class="status-text ' + escapeHtml(currentTask.status) + '">' + escapeHtml(currentTask.status) + '</span><br><span class="code-meta">' + escapeHtml(currentTask.id) + '</span></div></div>' : '') +
        (doneWhen.length ? '<ul class="todo-list">' + doneWhen.map(({ task, item }) =>
          '<li class="todo-item ' + (effectiveTaskStatus(task, group.resolvedBlockedTaskIds) === "done" ? "done" : "") + '"><span class="checkbox ' + (effectiveTaskStatus(task, group.resolvedBlockedTaskIds) === "done" ? "done" : "") + '" aria-hidden="true"></span><span class="todo-text">' + escapeHtml(item) + '<span class="meta">' + escapeHtml(task.role) + '</span></span></li>'
        ).join("") + '</ul>' : '<div class="empty">No todos recorded</div>') +
        (group.resolvedBlockedCount ? '<div class="meta">' + escapeHtml(group.resolvedBlockedCount) + ' blocked verifier task was repaired and is now historical evidence.</div>' : '') +
        (runningSessions.length ? '<div class="control-row"><button class="plain-button danger" data-stop-attempt-id="' + escapeHtml(runningSessions[0].attemptId) + '">Stop current task</button></div>' : '') +
        (rerunnableTask ? '<div class="control-row"><button class="plain-button" data-rerun-task-id="' + escapeHtml(rerunnableTask.id) + '">Rerun selected task</button></div>' : '') +
        '</section>' + renderChangedFilesSection(group);
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
      const queuedTasks = (overview.tasks || []).filter((task) => task.status === "todo" || task.status === "running");
      const hasQueuedWork = queuedTasks.length > 0;
      const stalledQueue = !runDone && status !== "running" && hasQueuedWork;
      const canStart = status !== "running" && !runDone && hasQueuedWork;
      const canStop = status === "running";
      const output = runnerOutputSnippet(runner, runDone);
      const statusClass = status === "running" ? "running" : stalledQueue ? "blocked" : runDone || runner?.exitCode === 0 ? "done" : status === "exited" ? "blocked" : "todo";
      const title = runDone ? "Run complete" : status === "running" ? "Background runner" : stalledQueue ? "Queue waiting for runner" : "Runner idle";
      const meta = runDone ? "goal reached" : status === "running" ? "background loop is active" : stalledQueue ? queuedTasks.length + " active task" + (queuedTasks.length === 1 ? "" : "s") + " waiting; dashboard is only observing because the runner is " + status : "no queued work";
      return '<section class="inspector-card" data-inspector-section="runner"><h2>Runner</h2>' +
        '<div class="current-task"><div class="current-task-title">' + escapeHtml(title) + '</div><div class="current-task-meta">' + escapeHtml(meta) + ' · <span class="status-text ' + escapeHtml(statusClass) + '">' + escapeHtml(status) + '</span>' +
        (runner?.pid ? '<br><span class="code-meta">pid ' + escapeHtml(runner.pid) + '</span>' : '') +
        (runner?.exitCode !== undefined && runner?.exitCode !== null ? '<br><span class="code-meta">exit ' + escapeHtml(runner.exitCode) + '</span>' : '') +
        (stalledQueue && queuedTasks[0] ? '<br><span class="code-meta">next ' + escapeHtml(queuedTasks[0].role) + ' · ' + escapeHtml(queuedTasks[0].id) + '</span>' : '') +
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
    const fetchDiffForChangedFile = async (path) => {
      if (!path) return;
      diffByPath.set(path, { status: "loading" });
      if (latestOverview) render(latestOverview);
      try {
        const response = await fetch("/api/runs/" + encodeURIComponent(runId) + "/diff?path=" + encodeURIComponent(path));
        const diff = await response.text();
        if (!response.ok) throw new Error(diff || "diff request failed");
        diffByPath.set(path, { status: "done", diff });
      } catch (error) {
        diffByPath.set(path, { status: "error", error: error && error.message ? error.message : String(error) });
      }
      if (latestOverview) render(latestOverview);
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
    const patchKeyedChildren = (id, html, keyAttribute) => {
      if (renderedHtml.get(id) === html) return;
      const node = document.getElementById(id);
      if (!node) return;
      const template = document.createElement("template");
      template.innerHTML = html;
      const nextChildren = Array.from(template.content.children);
      const keyedNextChildren = nextChildren.filter((child) => child.hasAttribute(keyAttribute));
      if (keyedNextChildren.length === 0) {
        renderedHtml.set(id, html);
        node.innerHTML = html;
        return;
      }
      const nextKeys = new Set(keyedNextChildren.map((child) => child.getAttribute(keyAttribute)));
      for (const currentChild of Array.from(node.children)) {
        const key = currentChild.getAttribute(keyAttribute);
        if (!key || !nextKeys.has(key)) currentChild.remove();
      }
      for (const nextChild of keyedNextChildren) {
        const key = nextChild.getAttribute(keyAttribute);
        const currentChild = node.querySelector("[" + keyAttribute + "=\\"" + CSS.escape(key) + "\\"]");
        if (!currentChild) {
          node.appendChild(nextChild.cloneNode(true));
          continue;
        }
        if (currentChild.outerHTML !== nextChild.outerHTML) {
          currentChild.replaceWith(nextChild.cloneNode(true));
          continue;
        }
        node.appendChild(currentChild);
      }
      renderedHtml.set(id, html);
    };
    const patchInspectorPanel = (inspectorHtml, runnerHtml) => {
      patchKeyedChildren("inspector-panel", inspectorHtml + runnerHtml, "data-inspector-section");
    };
    const syncWorkspaceToggle = () => {
      for (const button of document.querySelectorAll("[data-workspace-mode]")) {
        const active = button.getAttribute("data-workspace-mode") === workspaceMode;
        button.classList.toggle("active", active);
        button.setAttribute("aria-pressed", active ? "true" : "false");
      }
    };
    const syncWorkspaceTitle = (title) => {
      const titleNode = document.getElementById("workspace-title");
      const toggle = document.getElementById("workspace-title-toggle");
      const next = String(title ?? "");
      if (titleNode && titleNode.textContent !== next) titleNode.textContent = next;
      if (titleNode) {
        titleNode.setAttribute("title", next);
        titleNode.classList.toggle("is-expanded", workspaceTitleExpanded);
        titleNode.classList.toggle("is-collapsed", !workspaceTitleExpanded);
      }
      if (toggle) {
        toggle.setAttribute("aria-expanded", workspaceTitleExpanded ? "true" : "false");
        toggle.setAttribute("aria-label", workspaceTitleExpanded ? "Collapse workspace title" : "Expand workspace title");
        toggle.textContent = workspaceTitleExpanded ? "Collapse" : "Expand";
      }
    };
    const captureFlowScrollState = () => {
      if (workspaceMode !== "flow") return;
      const node = document.getElementById("workspace-flow");
      if (!node) return;
      const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
      return {
        scrollTop: node.scrollTop,
        shouldFollowBottom: distanceFromBottom <= 48,
        streams: Array.from(node.querySelectorAll(".stream-output[data-attempt-stream]")).map((stream) => {
          const streamDistanceFromBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight;
          return {
            attemptId: stream.getAttribute("data-attempt-stream"),
            scrollTop: stream.scrollTop,
            shouldFollowBottom: streamDistanceFromBottom <= 48,
          };
        }),
      };
    };
    const restoreFlowScrollState = (scrollState) => {
      if (workspaceMode !== "flow" || !scrollState) return;
      const node = document.getElementById("workspace-flow");
      if (!node) return;
      requestAnimationFrame(() => {
        node.scrollTop = scrollState.shouldFollowBottom ? node.scrollHeight : scrollState.scrollTop;
        for (const stream of node.querySelectorAll(".stream-output[data-attempt-stream]")) {
          const streamScroll = scrollState.streams.find((item) => item.attemptId === stream.getAttribute("data-attempt-stream"));
          if (!streamScroll) continue;
          stream.scrollTop = streamScroll.shouldFollowBottom ? stream.scrollHeight : streamScroll.scrollTop;
        }
      });
    };
    const patchStreamOutput = (currentStream, nextStream) => {
      const nextLines = Array.from(nextStream.querySelectorAll("[data-event-index]"));
      if (nextLines.length === 0) {
        if (currentStream.innerHTML !== nextStream.innerHTML) currentStream.innerHTML = nextStream.innerHTML;
        return;
      }
      const nextIndexes = new Set(nextLines.map((line) => line.getAttribute("data-event-index")));
      for (const currentLine of Array.from(currentStream.querySelectorAll("[data-event-index]"))) {
        if (!nextIndexes.has(currentLine.getAttribute("data-event-index"))) currentLine.remove();
      }
      for (const nextLine of nextLines) {
        const index = nextLine.getAttribute("data-event-index");
        const currentLine = currentStream.querySelector('[data-event-index="' + CSS.escape(index) + '"]');
        if (!currentLine) {
          currentStream.appendChild(nextLine.cloneNode(true));
          continue;
        }
        if (currentLine.outerHTML !== nextLine.outerHTML) {
          currentLine.replaceWith(nextLine.cloneNode(true));
          continue;
        }
        currentStream.appendChild(currentLine);
      }
    };
    const patchWorkspaceTurn = (currentTurn, nextTurn) => {
      if (currentTurn.outerHTML === nextTurn.outerHTML) return;
      for (const nextStream of nextTurn.querySelectorAll(".stream-output[data-attempt-stream]")) {
        const attemptId = nextStream.getAttribute("data-attempt-stream");
        const currentStream = currentTurn.querySelector('.stream-output[data-attempt-stream="' + CSS.escape(attemptId) + '"]');
        if (currentStream) patchStreamOutput(currentStream, nextStream);
      }
      if (currentTurn.outerHTML === nextTurn.outerHTML) return;
      const patchedTurn = nextTurn.cloneNode(true);
      for (const nextStream of Array.from(patchedTurn.querySelectorAll(".stream-output[data-attempt-stream]"))) {
        const attemptId = nextStream.getAttribute("data-attempt-stream");
        const currentStream = currentTurn.querySelector('.stream-output[data-attempt-stream="' + CSS.escape(attemptId) + '"]');
        if (currentStream) nextStream.replaceWith(currentStream);
      }
      currentTurn.replaceChildren(...Array.from(patchedTurn.childNodes));
    };
    const patchWorkspace = (html) => {
      const node = document.getElementById("workspace-flow");
      if (!node) return;
      const scrollState = captureFlowScrollState();
      if (renderedHtml.get("workspace-flow") === html) {
        restoreFlowScrollState(scrollState);
        return;
      }
      const template = document.createElement("template");
      template.innerHTML = html;
      const nextTranscript = template.content.querySelector(".transcript");
      const currentTranscript = node.querySelector(".transcript");
      if (!nextTranscript || !currentTranscript) {
        renderedHtml.set("workspace-flow", html);
        node.innerHTML = html;
        restoreFlowScrollState(scrollState);
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
        patchWorkspaceTurn(currentTurn, nextTurn);
        currentTranscript.appendChild(currentTurn);
      }
      renderedHtml.set("workspace-flow", html);
      restoreFlowScrollState(scrollState);
    };
    const overviewWorkerSource = [
      'let runId = null;',
      'let apiBase = "";',
      'let timer = null;',
      'const shouldPoll = (overview) => overview.runner?.status === "running" || overview.run?.status !== "done" || overview.tasks.some((task) => task.status === "todo" || task.status === "running") || overview.sessions.some((session) => session.status === "running");',
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
        workspaceTitleExpanded = false;
        writeDashboardState({ selectedGoalId, workspaceMode, workspaceTitleExpanded });
      }
      const selectedGroup = goalGroups.find((group) => group.id === selectedGoalId);
      const projectName = overview.project ? overview.project.name : "Project Workspace";
      const projectRoot = overview.project ? overview.project.rootPath : "";
      const projectTitle = projectRoot ? projectName + " · " + projectRoot : projectName;
      setTextIfChanged("run-status", overview.run?.status || "unknown");
      setTextIfChanged("run-title", overview.run ? overview.run.goal : runId);
      const projectHeader = document.querySelector("[data-project-header]");
      if (projectHeader) projectHeader.setAttribute("title", projectTitle);
      const projectNameNode = document.querySelector("[data-project-name]");
      if (projectNameNode && projectNameNode.textContent !== projectName) projectNameNode.textContent = projectName;
      const projectRootNode = document.querySelector("[data-project-root]");
      if (projectRootNode && projectRootNode.textContent !== projectRoot) projectRootNode.textContent = projectRoot;
      setTextIfChanged("workspace-kicker", selectedGroup ? selectedGroup.status + " / " + selectedGroup.tasks.length + " tasks" : "Goal Flow");
      syncWorkspaceTitle(selectedGroup ? selectedGroup.titleTask.goal : "No goal selected");
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
      patchInspectorPanel(renderInspector(overview, selectedGroup), renderRunner(overview));
    }
    document.addEventListener("click", (event) => {
      if (!event.target || !event.target.closest) return;
      const titleToggle = event.target.closest("[data-workspace-title-toggle]");
      if (titleToggle) {
        workspaceTitleExpanded = !workspaceTitleExpanded;
        writeDashboardState({ selectedGoalId, workspaceMode, workspaceTitleExpanded });
        syncWorkspaceTitle(document.getElementById("workspace-title")?.textContent || "");
        return;
      }
      const modeButton = event.target.closest("[data-workspace-mode]");
      if (modeButton) {
        workspaceMode = modeButton.getAttribute("data-workspace-mode") || "flow";
        writeDashboardState({ selectedGoalId, workspaceMode, workspaceTitleExpanded });
        if (latestOverview) render(latestOverview);
        return;
      }
      const changedFileButton = event.target.closest("[data-changed-file-node='file'][data-changed-file-path]");
      if (changedFileButton) {
        selectedChangedFilePath = changedFileButton.getAttribute("data-changed-file-path");
        if (latestOverview) render(latestOverview);
        fetchDiffForChangedFile(selectedChangedFilePath);
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
      workspaceTitleExpanded = false;
      writeDashboardState({ selectedGoalId, workspaceMode, workspaceTitleExpanded });
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
          workspaceTitleExpanded = false;
          writeDashboardState({ selectedGoalId, workspaceMode, workspaceTitleExpanded });
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
  autoStartRunner?: DashboardAutoStartRunner;
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
    autoStartRunner?: DashboardAutoStartRunner;
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
    let overview = input.overview();
    let runner = input.runnerStatus?.() ?? null;
    if (input.actions?.startRunner && input.autoStartRunner?.(overview, runner)) {
      input.actions.startRunner();
      overview = input.overview();
      runner = input.runnerStatus?.() ?? runner;
    }
    return Response.json({ ...overview, runner });
  }
  if (url.pathname === `/api/runs/${input.runId}/changed-files`) {
    return Response.json(changedFilesPayload(input.overview()));
  }
  if (url.pathname === `/api/runs/${input.runId}/diff`) {
    const format = url.searchParams.get("format");
    const asJson = format === "json";
    const result = diffForChangedPath(input.overview(), url.searchParams.get("path"));
    if (!result.ok) {
      return asJson
        ? Response.json({ error: result.error }, { status: result.status })
        : new Response(result.error, { status: result.status, headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    return asJson
      ? Response.json({ path: result.path, diff: result.diff })
      : new Response(result.diff, { headers: { "content-type": "text/plain; charset=utf-8" } });
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

function changedFilesPayload(overview: RunOverview) {
  const seen = new Set<string>();
  const files = overview.sessions
    .flatMap((session) => {
      const changedFiles = Array.isArray(session.output?.changedFiles) ? session.output.changedFiles : [];
      return changedFiles.flatMap((rawPath) => {
        const path = normalizeTrackedPath(rawPath);
        if (!path || seen.has(path)) {
          return [];
        }
        seen.add(path);
        return [{ path, taskId: session.taskId, attemptId: session.attemptId, worktreePath: session.worktreePath ?? null }];
      });
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  return { files, tree: changedFilesTree(files.map((file) => file.path)) };
}

function changedFilesTree(paths: string[]) {
  type TreeNode = { name: string; path: string; type: "directory" | "file"; children?: TreeNode[] };
  const root: TreeNode[] = [];
  const directories = new Map<string, TreeNode[]>();
  directories.set("", root);
  for (const path of paths) {
    const parts = path.split("/");
    let parentPath = "";
    for (let index = 0; index < parts.length; index += 1) {
      const name = parts[index];
      const nodePath = parentPath ? `${parentPath}/${name}` : name;
      const parent = directories.get(parentPath) ?? root;
      const isFile = index === parts.length - 1;
      let node = parent.find((candidate) => candidate.path === nodePath);
      if (!node) {
        node = isFile ? { name, path: nodePath, type: "file" } : { name, path: nodePath, type: "directory", children: [] };
        parent.push(node);
        parent.sort(compareTreeNodes);
      }
      if (!isFile) {
        directories.set(nodePath, node.children ?? []);
      }
      parentPath = nodePath;
    }
  }
  return root;
}

function compareTreeNodes(left: { type: string; path: string }, right: { type: string; path: string }) {
  if (left.type !== right.type) {
    return left.type === "file" ? -1 : 1;
  }
  return left.path.localeCompare(right.path);
}

function diffForChangedPath(overview: RunOverview, rawPath: string | null):
  | { ok: true; path: string; diff: string }
  | { ok: false; status: number; error: string } {
  const path = normalizeTrackedPath(rawPath);
  if (!path) {
    return { ok: false, status: 400, error: rawPath ? "path traversal is not allowed" : "path is required" };
  }
  const payload = changedFilesPayload(overview);
  const file = payload.files.find((candidate) => candidate.path === path);
  if (!file) {
    return { ok: false, status: 404, error: `changed file not tracked: ${path}` };
  }
  const root = file.worktreePath ?? overview.project?.rootPath ?? overview.sessions.find((session) => session.worktreePath)?.worktreePath;
  if (!root) {
    return { ok: false, status: 400, error: "project root or task worktree is required for diffs" };
  }
  const rootPath = resolve(root);
  const filePath = resolve(rootPath, path);
  const rel = relative(rootPath, filePath);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    return { ok: false, status: 400, error: "path traversal is not allowed" };
  }
  const result = Bun.spawnSync({
    cmd: ["git", "diff", "--", path],
    cwd: rootPath,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr).trim();
  if (result.exitCode !== 0) {
    return { ok: false, status: 400, error: stderr || `git diff failed for ${path}` };
  }
  return { ok: true, path, diff: stdout };
}

function normalizeTrackedPath(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim().replaceAll("\\", "/");
  if (!trimmed || trimmed.startsWith("/") || /^[A-Za-z]:\//.test(trimmed)) {
    return null;
  }
  const normalized = trimmed.split("/").filter((part) => part && part !== ".").join("/");
  if (!normalized || normalized.split("/").some((part) => part === "..")) {
    return null;
  }
  return normalized;
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
