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
      --chip: #3a3a38;
      --chip-strong: #4a4a47;
      --ok: #c9c9c3;
      --warn: #b8b7b0;
      --danger: #d4d3cc;
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
      padding: 4px 8px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 999px;
      color: #e5e5df;
      font-size: 11px;
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
      gap: 8px;
      padding: 14px 6px;
    }
    .stat {
      padding: 9px 10px;
      border-radius: 9px;
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.08);
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
      gap: 5px;
    }
    .task-row {
      width: 100%;
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 8px;
      align-items: start;
      padding: 9px 10px;
      border: 1px solid transparent;
      border-radius: 9px;
      background: transparent;
      color: #e4e3dd;
      text-align: left;
      font: inherit;
      cursor: pointer;
      transition: transform 160ms cubic-bezier(0.16, 1, 0.3, 1), background 160ms, border-color 160ms;
    }
    .task-row:hover {
      transform: translateY(-1px);
      background: rgba(255, 255, 255, 0.08);
      border-color: rgba(255, 255, 255, 0.08);
    }
    .task-row:active { transform: translateY(0) scale(0.995); }
    .task-row.selected {
      background: rgba(255, 255, 255, 0.14);
      border-color: rgba(255, 255, 255, 0.16);
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
      padding: 22px 28px 96px;
    }
    .flow-inner {
      width: min(100%, 820px);
      margin: 0 auto;
    }
    .flow-card {
      margin-bottom: 18px;
      padding: 16px 18px;
      border: 1px solid rgba(255, 255, 255, 0.09);
      border-radius: 14px;
      background: var(--canvas-soft);
      animation: liftIn 260ms cubic-bezier(0.16, 1, 0.3, 1) both;
    }
    .flow-card.primary {
      background: transparent;
      border-color: rgba(255, 255, 255, 0.12);
    }
    .flow-card-head, .inspector-row {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
    }
    .flow-card-title {
      color: #f1f1ec;
      font-size: 18px;
      font-weight: 720;
      line-height: 1.45;
    }
    .flow-card-text {
      margin-top: 10px;
      color: #d8d7d0;
      font-size: 14px;
      line-height: 1.75;
      white-space: pre-wrap;
    }
    .flow-card .meta { margin-top: 10px; }
    .inspector-panel {
      height: 100dvh;
      padding: 18px 16px;
      background: var(--app);
      border-left: 1px solid rgba(255, 255, 255, 0.08);
      overflow: auto;
    }
    .inspector-card {
      margin-bottom: 14px;
      padding: 14px 16px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 18px;
      background: var(--panel);
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
      padding: 10px;
      border-radius: 11px;
      background: rgba(255, 255, 255, 0.045);
      color: #d6d5cf;
      font-size: 14px;
      line-height: 1.55;
    }
    .prompt-link {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 30px;
      padding: 0 11px;
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 999px;
      color: #efeee8;
      background: rgba(255, 255, 255, 0.07);
      font-size: 14px;
      font-weight: 720;
      text-decoration: none;
      transition: transform 160ms cubic-bezier(0.16, 1, 0.3, 1), background 160ms;
    }
    .prompt-link:hover {
      transform: translateY(-1px);
      background: rgba(255, 255, 255, 0.11);
    }
    .prompt-link:active { transform: translateY(0) scale(0.98); }
    .badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      height: 22px;
      padding: 0 8px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 999px;
      background: var(--chip);
      color: #e8e7e1;
      font-size: 11px;
      font-weight: 720;
      white-space: nowrap;
    }
    .badge.running { animation: breathe 1.8s ease-in-out infinite; }
    .badge.done { color: #d8d7d0; }
    .badge.blocked { background: var(--chip-strong); }
    .badge.todo { color: #c9c8c2; }
    .empty {
      padding: 16px;
      border: 1px dashed rgba(255, 255, 255, 0.14);
      border-radius: 12px;
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
    pre {
      margin: 12px 0 0;
      max-height: 240px;
      overflow: hidden;
      border-radius: 10px;
      padding: 10px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: #171717;
      color: #efefea;
      font-family: var(--mono);
      font-size: 11px;
      line-height: 1.55;
      white-space: pre-wrap;
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
      <nav class="task-nav" aria-label="Tasks">
        <section class="nav-section">
          <h2 class="section-label">Active Tasks</h2>
          <div class="task-list" id="active-task-list"></div>
        </section>
        <section class="nav-section">
          <h2 class="section-label">History</h2>
          <div class="task-list" id="history-task-list"></div>
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
    let selectedTaskId = null;
    let latestOverview = null;
    const taskById = (overview) => new Map(overview.tasks.map((task) => [task.id, task]));
    const collectTaskChain = (task, map, seen = new Set()) => {
      if (!task || seen.has(task.id)) return seen;
      seen.add(task.id);
      for (const id of task.dependsOn || []) collectTaskChain(map.get(id), map, seen);
      return seen;
    };
    const sessionsForTaskChain = (overview, task) => {
      const ids = collectTaskChain(task, taskById(overview));
      return overview.sessions.filter((session) => ids.has(session.taskId));
    };
    const lessonsForTaskChain = (overview, task) => {
      const ids = collectTaskChain(task, taskById(overview));
      return (overview.lessons || []).filter((lesson) => ids.has(lesson.taskId));
    };
    const compact = (value, max = 140) => {
      const text = String(value ?? "").replace(/\\s+/g, " ").trim();
      return text.length > max ? text.slice(0, max - 1) + "…" : text;
    };
    const lessonList = (lessons) => lessons.length
      ? '<div class="lesson-list">' + lessons.map((lesson) =>
        '<div class="lesson ' + escapeHtml(lesson.kind) + '"><span class="badge">' + escapeHtml(lesson.kind) + '</span> ' +
        escapeHtml(lesson.summary) + '<div class="meta code-meta">task ' + escapeHtml(lesson.taskId) + '<br>attempt ' + escapeHtml(lesson.attemptId) + '</div></div>'
      ).join("") + '</div>'
      : '<div class="empty">No lessons or experiences</div>';
    const taskMeta = (task) => '<span class="code-meta">id ' + escapeHtml(task.id) + '</span>' + (task.dependsOn.length ? ' · depends on ' + task.dependsOn.map((id) => '<span class="code-meta">' + escapeHtml(id) + '</span>').join(", ") : '');
    const taskRow = (task) =>
      '<button class="task-row ' + (task.id === selectedTaskId ? 'selected' : '') + '" data-task-id="' + escapeHtml(task.id) + '">' +
      '<span><strong>' + escapeHtml(task.goal) + '</strong><span class="row-meta">' + escapeHtml(task.role) + ' · ' + escapeHtml(task.status) + '</span></span>' +
      '<span class="badge ' + task.status + '">' + escapeHtml(task.status) + '</span></button>';
    const sessionFlowCard = (session) =>
      '<article class="flow-card"><div class="flow-card-head"><div><span class="badge">' + escapeHtml(session.role) + '</span>' +
      '<div class="flow-card-title">' + escapeHtml(session.taskGoal) + '</div></div>' +
      '<span class="badge ' + session.status + '">' + escapeHtml(session.status) + '</span></div>' +
      '<div class="meta code-meta">task ' + escapeHtml(session.taskId) + '<br>attempt ' + escapeHtml(session.attemptId) +
      '<br>session ' + escapeHtml(session.sessionName || "") + '<br>codex ' + escapeHtml(session.codexSessionId || "") + '</div>' +
      (latestText(session) ? '<pre>' + escapeHtml(latestText(session)) + '</pre>' : '<div class="flow-card-text">No stream output recorded.</div>') +
      '</article>';
    const renderWorkspace = (overview, task) => {
      if (!task) return '<div class="flow-inner"><div class="empty">No task selected</div></div>';
      const sessions = sessionsForTaskChain(overview, task);
      const lessons = lessonsForTaskChain(overview, task);
      return '<div class="flow-inner"><article class="flow-card primary"><div class="flow-card-head"><div>' +
        '<span class="badge ' + task.status + '">' + escapeHtml(task.status) + '</span> <span class="badge">' + escapeHtml(task.role) + '</span>' +
        '<div class="flow-card-title">' + escapeHtml(task.goal) + '</div></div>' + promptLink(task) + '</div>' +
        '<div class="meta">' + taskMeta(task) + '</div><div class="flow-card-text">' + escapeHtml(task.prompt) + '</div></article>' +
        (sessions.length ? sessions.map(sessionFlowCard).join("") : '<div class="empty">No sessions recorded for this task yet.</div>') +
        (lessons.length ? '<article class="flow-card"><div class="flow-card-head"><div class="flow-card-title">Lessons and experiences</div></div>' + lessonList(lessons.slice(-6)) + '</article>' : '') +
        '</div>';
    };
    const renderInspector = (overview, task) => {
      if (!task) return '<section class="inspector-card"><h2>Detail</h2><div class="empty">Select a task</div></section>';
      const lessons = lessonsForTaskChain(overview, task);
      const doneWhen = Array.isArray(task.doneWhen) ? task.doneWhen : [];
      return '<section class="inspector-card"><h2>Todos</h2>' +
        (doneWhen.length ? '<ul class="todo-list">' + doneWhen.map((item) =>
          '<li class="todo-item"><span class="checkbox ' + (task.status === "done" ? "done" : "") + '"></span><span>' + escapeHtml(item) + '</span></li>'
        ).join("") + '</ul>' : '<div class="empty">No todos recorded</div>') + '</section>' +
        '<section class="inspector-card"><h2>Task</h2><div class="inspector-row"><span class="badge ' + task.status + '">' + escapeHtml(task.status) + '</span>' + promptLink(task) + '</div>' +
        '<div class="meta" style="margin-top:10px">' + taskMeta(task) + '</div><div class="meta" style="margin-top:10px">' + escapeHtml(compact(task.prompt, 420)) + '</div></section>' +
        '<section class="inspector-card"><h2>Lessons</h2>' + lessonList(lessons.slice(-8)) + '</section>' +
        '<section class="inspector-card"><h2>Run Info</h2><ul class="info-list">' +
        '<li class="meta">Run status: ' + escapeHtml(overview.run?.status || "") + '</li>' +
        '<li class="meta">Tasks: ' + overview.tasks.length + '</li>' +
        '<li class="meta">Sessions: ' + overview.sessions.length + '</li>' +
        '<li class="meta">Lessons: ' + (overview.lessons || []).length + '</li></ul></section>';
    };
    async function refresh() {
      const response = await fetch("/api/runs/" + encodeURIComponent(runId) + "/overview");
      const overview = await response.json();
      render(overview);
    }
    function render(overview) {
      latestOverview = overview;
      const taskCounts = byStatus(overview.tasks);
      const sessionCounts = byStatus(overview.sessions);
      const activeTasks = overview.tasks.filter((task) => task.status === "todo" || task.status === "running");
      if (!selectedTaskId || !overview.tasks.some((task) => task.id === selectedTaskId)) {
        selectedTaskId = (activeTasks[0] || overview.tasks[overview.tasks.length - 1] || {}).id || null;
      }
      const selectedTask = overview.tasks.find((task) => task.id === selectedTaskId);
      document.getElementById("run-status").textContent = overview.run?.status || "unknown";
      document.getElementById("run-title").textContent = overview.run ? overview.run.goal : runId;
      document.getElementById("workspace-kicker").textContent = selectedTask ? selectedTask.role + " / " + selectedTask.status : "Task Flow";
      document.getElementById("workspace-title").textContent = selectedTask ? selectedTask.goal : "No task selected";
      document.getElementById("sidebar-stats").innerHTML = [
        ["Tasks", overview.tasks.length],
        ["Todo tasks", taskCounts.todo || 0],
        ["Running tasks", taskCounts.running || 0],
        ["Running sessions", sessionCounts.running || 0]
      ].map(([label, value]) => '<div class="stat"><b>' + value + '</b><span>' + label + '</span></div>').join("");
      document.getElementById("active-task-list").innerHTML = activeTasks.length ? activeTasks.map(taskRow).join("") : '<div class="empty">No active tasks</div>';
      document.getElementById("history-task-list").innerHTML = [...overview.tasks].reverse().map(taskRow).join("");
      document.getElementById("workspace-flow").innerHTML = renderWorkspace(overview, selectedTask);
      document.getElementById("inspector-panel").innerHTML = renderInspector(overview, selectedTask);
    }
    document.addEventListener("click", (event) => {
      if (!event.target || !event.target.closest) return;
      const row = event.target.closest("[data-task-id]");
      if (!row) return;
      selectedTaskId = row.getAttribute("data-task-id");
      if (latestOverview) render(latestOverview);
    });
    refresh().catch(console.error);
    setInterval(() => refresh().catch(console.error), 1500);
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
