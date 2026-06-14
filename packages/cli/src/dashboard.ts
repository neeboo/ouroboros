import type { RunOverview } from "@ouroboros/harness";

interface DashboardActionResult {
  attemptId?: string;
  taskId?: string;
  status?: string;
  interrupted?: number;
}

interface DashboardActions {
  createGoal?: (goal: string) => DashboardActionResult;
  interruptAndCreateGoal?: (goal: string) => DashboardActionResult;
  resumeTask?: (taskId: string) => DashboardActionResult;
  rerunTask?: (taskId: string) => DashboardActionResult;
  stopAttempt?: (attemptId: string) => DashboardActionResult;
}

export function dashboardHtml(input: { runId: string }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Ouroboros Dashboard</title>
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
    .workspace-flow {
      min-height: 0;
      overflow: auto;
      padding: 38px 48px 128px;
      scrollbar-gutter: stable;
    }
    .flow-inner {
      width: min(100%, 720px);
      margin: 0 auto;
    }
    .transcript {
      display: grid;
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
      .workspace-flow { padding: 18px 16px 32px; }
      .workspace-head { padding: 16px; }
    }
  </style>
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
        <div class="workspace-kicker" id="workspace-kicker">Task Flow</div>
        <div class="workspace-title" id="workspace-title">Loading</div>
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
    const buildGoalGroups = (overview) => {
      const groups = new Map();
      for (const task of overview.tasks) {
        const cycleId = task.cycleId || task.id;
        if (!groups.has(cycleId)) {
          groups.set(cycleId, { id: cycleId, root: task, titleTask: task, taskIds: new Set(), tasks: [] });
        }
        const group = groups.get(cycleId);
        group.taskIds.add(task.id);
        group.tasks.push(task);
        if (task.id === cycleId || isCycleStarter(task)) group.root = task;
        group.titleTask = titleTaskFor(group.tasks);
      }
      return [...groups.values()].map((group) => {
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
    const renderWorkspace = (group) => {
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
    const renderInspector = (overview, group) => {
      if (!group) return '<section class="inspector-card"><h2>Detail</h2><div class="empty">Select a goal</div></section>';
      const doneWhen = group.tasks.flatMap((task) => (Array.isArray(task.doneWhen) ? task.doneWhen : []).map((item) => ({ task, item })));
      const resumableTasks = group.tasks.filter((task) => task.status === "blocked");
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
        (rerunnableTask ? '<div class="control-row"><button class="plain-button" data-rerun-task-id="' + escapeHtml(rerunnableTask.id) + '">Rerun task</button></div>' : '') +
        (resumableTasks.length ? '<div class="control-row"><button class="plain-button" data-resume-task-id="' + escapeHtml(resumableTasks[0].id) + '">Resume blocked task</button></div>' : '') +
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
      setHtmlIfChanged("sidebar-stats", [
        ["Goals", goalGroups.length],
        ["Active goals", activeGroups.length],
        ["Queued tasks", (taskCounts.todo || 0) + (taskCounts.running || 0)],
        ["Running sessions", sessionCounts.running || 0]
      ].map(([label, value]) => '<div class="stat"><b>' + value + '</b><span>' + label + '</span></div>').join(""));
      setHtmlIfChanged("active-goal-list", activeGroups.length ? activeGroups.map(goalRow).join("") : '<div class="empty">No active goals</div>');
      setHtmlIfChanged("history-goal-list", [...goalGroups].reverse().filter((group) => group.activeTasks.length === 0).map(goalRow).join(""));
      patchWorkspace(renderWorkspace(selectedGroup));
      setHtmlIfChanged("inspector-panel", renderInspector(overview, selectedGroup));
    }
    document.addEventListener("click", (event) => {
      if (!event.target || !event.target.closest) return;
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
  actions?: DashboardActions;
}) {
  return Bun.serve({
    port: input.port,
    fetch(request) {
      return handleDashboardRequest(request, input);
    },
  });
}

export function handleDashboardRequest(
  request: Request,
  input: {
    runId: string;
    overview: () => RunOverview;
    renderTaskPrompt: (taskId: string) => string;
    actions?: DashboardActions;
  },
) {
  const url = new URL(request.url);
  if (url.pathname === "/") {
    return new Response(dashboardHtml({ runId: input.runId }), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  if (url.pathname === `/api/runs/${input.runId}/overview`) {
    return Response.json(input.overview());
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
