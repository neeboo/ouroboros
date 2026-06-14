import type { RunOverview } from "@ouroboros/harness";

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
      padding: 0 4px 8px;
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
      padding: 18px 28px 12px;
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
      max-width: 900px;
      color: var(--ink);
      font-size: 24px;
      font-weight: 720;
      line-height: 1.45;
    }
    .workspace-flow {
      min-height: 0;
      overflow: auto;
      padding: 18px 28px 96px;
    }
    .flow-inner {
      width: min(100%, 820px);
      margin: 0 auto;
    }
    .transcript {
      display: grid;
    }
    .turn {
      display: grid;
      grid-template-columns: 34px minmax(0, 1fr);
      gap: 14px;
      padding: 18px 0 22px;
      border-top: 1px solid rgba(255, 255, 255, 0.09);
      background: transparent;
      animation: liftIn 260ms cubic-bezier(0.16, 1, 0.3, 1) both;
    }
    .turn.primary {
      padding-top: 8px;
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
      margin-top: 3px;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.55;
    }
    .turn-text {
      margin-top: 12px;
      color: #d8d7d0;
      font-size: 14px;
      line-height: 1.75;
      white-space: pre-wrap;
    }
    .stream-output {
      margin: 12px 0 0;
      max-height: 260px;
      overflow: hidden;
      padding: 12px 0 0 14px;
      border-left: 1px solid rgba(255, 255, 255, 0.16);
      color: #efefea;
      font-family: var(--mono);
      font-size: 11px;
      line-height: 1.6;
      white-space: pre-wrap;
    }
    .tool-line {
      margin-top: 10px;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.6;
    }
    .turn .meta { margin-top: 10px; }
    .inspector-panel {
      height: 100dvh;
      padding: 18px 16px;
      background: var(--app);
      border-left: 1px solid rgba(255, 255, 255, 0.08);
      overflow: auto;
    }
    .inspector-card {
      padding: 16px 0 18px;
      border-top: 1px solid rgba(255, 255, 255, 0.09);
      background: transparent;
    }
    .inspector-card:first-child {
      padding-top: 0;
      border-top: 0;
    }
    .inspector-card h2 {
      margin: 0 0 12px;
      color: #d2d1ca;
      font-size: 11px;
      font-weight: 760;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .todo-list, .lesson-list, .info-list {
      display: grid;
      gap: 9px;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .todo-item {
      display: grid;
      grid-template-columns: 16px 1fr;
      gap: 9px;
      align-items: start;
      color: #d9d8d1;
      font-size: 14px;
      line-height: 1.55;
    }
    .checkbox {
      width: 13px;
      height: 13px;
      margin-top: 3px;
      border: 1px solid rgba(255, 255, 255, 0.35);
      border-radius: 999px;
    }
    .checkbox.done { background: #deded8; border-color: #deded8; }
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
    const latestText = (session) => session.latestText || session.events.map((event) => event.text || event.payload?.delta || event.payload?.message || "").filter(Boolean).slice(-1)[0] || "";
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
      '<article class="turn ' + (input.primary ? "primary" : "") + '"><div class="turn-gutter"><div class="turn-avatar">' + input.mark + '</div><div class="turn-rail"></div></div>' +
      '<div class="turn-body"><div class="turn-head"><div><div class="turn-author">' + input.author + '</div>' +
      (input.summary ? '<div class="turn-summary">' + input.summary + '</div>' : '') + '</div>' +
      (input.action || '') + '</div>' + (input.body || '') + '</div></article>';
    const sessionFlowTurn = (session) =>
      turn({
        mark: roleMark(session.role),
        author: escapeHtml(session.role),
        summary: escapeHtml(session.taskGoal) + ' · ' + escapeHtml(session.status),
        action: '<span class="status-text ' + escapeHtml(session.status) + '">' + escapeHtml(session.status) + '</span>',
        body:
          '<div class="tool-line code-meta">task ' + escapeHtml(session.taskId) + ' · attempt ' + escapeHtml(session.attemptId) +
          (session.sessionName ? '<br>session ' + escapeHtml(session.sessionName) : '') +
          (session.codexSessionId ? '<br>codex ' + escapeHtml(session.codexSessionId) : '') + '</div>' +
          (latestText(session) ? '<div class="stream-output">' + escapeHtml(latestText(session)) + '</div>' : '<div class="turn-text">No stream output recorded.</div>'),
      });
    const renderWorkspace = (group) => {
      if (!group) return '<div class="flow-inner"><div class="empty">No goal selected</div></div>';
      const taskIdsWithSessions = new Set(group.sessions.map((session) => session.taskId));
      const pendingFlow = group.tasks.filter((task) => !taskIdsWithSessions.has(task.id) && (task.status === "todo" || task.status === "running"));
      return '<div class="flow-inner"><div class="transcript">' +
        turn({
          primary: true,
          mark: "go",
          author: escapeHtml(group.titleTask.goal),
          summary: '<span class="role-label">' + escapeHtml(roleSummary(group.tasks)) + '</span> · <span class="status-text ' + escapeHtml(group.status) + '">' + escapeHtml(group.status) + '</span>',
          action: promptLink(group.titleTask),
          body: '<div class="tool-line">' + taskMeta(group.root) + '</div><div class="turn-text">' + escapeHtml(group.root.prompt) + '</div>',
        }) +
        (group.sessions.length ? group.sessions.map(sessionFlowTurn).join("") : '<div class="empty">No sessions recorded for this goal yet.</div>') +
        (pendingFlow.length ? pendingFlow.map((task) => turn({
          mark: roleMark(task.role),
          author: escapeHtml(task.role),
          summary: escapeHtml(task.goal),
          action: '<span class="status-text ' + escapeHtml(task.status) + '">' + escapeHtml(task.status) + '</span>',
          body: '<div class="tool-line">' + taskMeta(task) + '</div>',
        })).join("") : '') +
        (group.lessons.length ? turn({
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
      return '<section class="inspector-card"><h2>Todos</h2>' +
        (doneWhen.length ? '<ul class="todo-list">' + doneWhen.map(({ task, item }) =>
          '<li class="todo-item"><span class="checkbox ' + (task.status === "done" ? "done" : "") + '"></span><span>' + escapeHtml(item) + '<span class="meta"> · ' + escapeHtml(task.role) + '</span></span></li>'
        ).join("") + '</ul>' : '<div class="empty">No todos recorded</div>') + '</section>' +
        '<section class="inspector-card"><h2>Queue</h2>' +
        (group.activeTasks.length ? '<ul class="info-list">' + group.activeTasks.map((task) => '<li class="meta"><span class="status-text ' + escapeHtml(task.status) + '">' + escapeHtml(task.status) + '</span> ' + escapeHtml(task.role) + ' · ' + escapeHtml(task.goal) + '</li>').join("") + '</ul>' : '<div class="empty">No active queue for this goal</div>') + '</section>' +
        '<section class="inspector-card"><h2>Goal</h2><div class="inspector-row"><span class="status-text ' + escapeHtml(group.status) + '">' + escapeHtml(group.status) + '</span>' + promptLink(group.titleTask) + '</div>' +
        '<div class="meta" style="margin-top:10px">' + group.tasks.length + ' tasks · ' + group.sessions.length + ' sessions</div><div class="meta" style="margin-top:10px">' + escapeHtml(compact(group.root.prompt, 420)) + '</div></section>' +
        '<section class="inspector-card"><h2>Lessons</h2>' + lessonList(group.lessons.slice(-8)) + '</section>' +
        '<section class="inspector-card"><h2>Run Info</h2><ul class="info-list">' +
        '<li class="meta">Run status: ' + escapeHtml(overview.run?.status || "") + '</li>' +
        '<li class="meta">Tasks: ' + overview.tasks.length + '</li>' +
        '<li class="meta">Sessions: ' + overview.sessions.length + '</li>' +
        '<li class="meta">Lessons: ' + (overview.lessons || []).length + '</li></ul></section>';
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
      if (event.data?.type === "overview") render(event.data.overview);
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
      document.getElementById("run-status").textContent = overview.run?.status || "unknown";
      document.getElementById("run-title").textContent = overview.run ? overview.run.goal : runId;
      document.getElementById("workspace-kicker").textContent = selectedGroup ? selectedGroup.status + " / " + selectedGroup.tasks.length + " tasks" : "Goal Flow";
      document.getElementById("workspace-title").textContent = selectedGroup ? selectedGroup.titleTask.goal : "No goal selected";
      document.getElementById("sidebar-stats").innerHTML = [
        ["Goals", goalGroups.length],
        ["Active goals", activeGroups.length],
        ["Queued tasks", (taskCounts.todo || 0) + (taskCounts.running || 0)],
        ["Running sessions", sessionCounts.running || 0]
      ].map(([label, value]) => '<div class="stat"><b>' + value + '</b><span>' + label + '</span></div>').join("");
      document.getElementById("active-goal-list").innerHTML = activeGroups.length ? activeGroups.map(goalRow).join("") : '<div class="empty">No active goals</div>';
      document.getElementById("history-goal-list").innerHTML = [...goalGroups].reverse().filter((group) => group.activeTasks.length === 0).map(goalRow).join("");
      document.getElementById("workspace-flow").innerHTML = renderWorkspace(selectedGroup);
      document.getElementById("inspector-panel").innerHTML = renderInspector(overview, selectedGroup);
    }
    document.addEventListener("click", (event) => {
      if (!event.target || !event.target.closest) return;
      const row = event.target.closest("[data-goal-id]");
      if (!row) return;
      selectedGoalId = row.getAttribute("data-goal-id");
      if (latestOverview) render(latestOverview);
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
  const promptMatch = url.pathname.match(/^\/tasks\/([^/]+)\/prompt$/);
  if (promptMatch) {
    return new Response(input.renderTaskPrompt(decodeURIComponent(promptMatch[1])), {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  return new Response("not found", { status: 404 });
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
