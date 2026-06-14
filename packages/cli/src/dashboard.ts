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
      --bg: #f5f7f4;
      --ink: #17201c;
      --muted: #66736d;
      --soft: #f9faf8;
      --panel: #ffffff;
      --line: #d9dfd8;
      --line-strong: #bec8c0;
      --rail: #18211e;
      --rail-2: #222c28;
      --accent: #2f6f5e;
      --accent-2: #52796f;
      --accent-soft: #dcebe5;
      --warn: #a26316;
      --danger: #a83f2f;
      --ok: #2f7d4d;
      --mono: "JetBrains Mono", "SFMono-Regular", Consolas, monospace;
      color: var(--ink);
      background: var(--bg);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100dvh;
      background:
        linear-gradient(90deg, rgba(24, 33, 30, 0.045) 1px, transparent 1px),
        linear-gradient(180deg, rgba(24, 33, 30, 0.035) 1px, transparent 1px),
        var(--bg);
      background-size: 28px 28px;
    }
    header {
      position: sticky;
      top: 0;
      z-index: 2;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 18px 28px;
      background: rgba(24, 33, 30, 0.96);
      color: #f6faf7;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      box-shadow: 0 18px 45px -32px rgba(24, 33, 30, 0.75);
      backdrop-filter: blur(14px);
    }
    h1 {
      margin: 0;
      font-size: 18px;
      font-weight: 780;
      letter-spacing: 0;
    }
    #run-title {
      max-width: 72ch;
      color: #cbd8d1;
      font-size: 13px;
      line-height: 1.4;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    main {
      width: min(100%, 1540px);
      margin: 0 auto;
      padding: 24px 28px 32px;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(4, minmax(120px, 1fr));
      gap: 1px;
      margin-bottom: 22px;
      border: 1px solid var(--line);
      border-radius: 10px;
      overflow: hidden;
      background: var(--line);
    }
    .stat, .panel, .session, .task-row, .focus-task {
      background: rgba(255, 255, 255, 0.92);
      border: 1px solid var(--line);
    }
    .stat {
      padding: 16px 18px;
      border: 0;
      border-radius: 0;
    }
    .stat b {
      display: block;
      font-family: var(--mono);
      font-size: 25px;
      line-height: 1;
      letter-spacing: -0.03em;
    }
    .stat span {
      display: block;
      margin-top: 7px;
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .layout {
      display: grid;
      grid-template-columns: minmax(320px, 0.9fr) minmax(460px, 1.5fr);
      gap: 18px;
      align-items: start;
    }
    .panel {
      padding: 16px;
      border-radius: 12px;
      box-shadow: 0 24px 70px -54px rgba(24, 33, 30, 0.58);
    }
    .panel h2 {
      margin: 0 0 14px;
      font-size: 12px;
      color: var(--muted);
      font-weight: 800;
      letter-spacing: 0.11em;
      text-transform: uppercase;
    }
    .focus-panel {
      position: relative;
      margin-bottom: 18px;
      border-color: rgba(47, 111, 94, 0.32);
      background:
        linear-gradient(135deg, rgba(24, 33, 30, 0.98), rgba(34, 44, 40, 0.98));
      color: #edf5f0;
      overflow: hidden;
    }
    .focus-panel h2 { color: #b7c9c0; }
    .focus-panel::before {
      content: "";
      position: absolute;
      inset: 0 0 auto;
      height: 1px;
      background: linear-gradient(90deg, transparent, rgba(220, 235, 229, 0.45), transparent);
    }
    .focus-list {
      display: grid;
      gap: 12px;
    }
    .focus-task {
      padding: 14px;
      border-color: rgba(220, 235, 229, 0.18);
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.055);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08);
      animation: liftIn 360ms cubic-bezier(0.16, 1, 0.3, 1) both;
    }
    .focus-head, .task-detail-head {
      align-items: flex-start;
      justify-content: space-between;
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 8px;
      margin-bottom: 10px;
    }
    .focus-title, .detail-title {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: start;
    }
    .focus-title strong, .detail-title strong {
      font-size: 15px;
      line-height: 1.35;
      letter-spacing: -0.01em;
    }
    .role-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(180px, 1fr));
      gap: 10px;
      margin-top: 12px;
    }
    .role-lane {
      min-height: 128px;
      border: 1px solid rgba(220, 235, 229, 0.18);
      border-radius: 9px;
      background: rgba(250, 252, 251, 0.06);
      padding: 10px;
    }
    .role-lane h3, .detail-section h3 {
      margin: 0 0 8px;
      font-size: 11px;
      color: var(--muted);
      font-weight: 800;
      letter-spacing: 0.11em;
      text-transform: uppercase;
    }
    .focus-panel .role-lane h3, .focus-panel .detail-section h3 { color: #aec4ba; }
    .detail-section { margin-top: 14px; }
    .task-row {
      width: 100%;
      display: grid;
      grid-template-columns: 76px 82px 1fr;
      gap: 10px;
      align-items: start;
      padding: 11px;
      border-color: transparent;
      border-radius: 10px;
      background: transparent;
      text-align: left;
      font: inherit;
      cursor: pointer;
      transition: transform 180ms cubic-bezier(0.16, 1, 0.3, 1), background 180ms, border-color 180ms;
    }
    .task-row + .task-row { margin-top: 4px; }
    .task-row.selected {
      border-color: rgba(47, 111, 94, 0.3);
      background: var(--accent-soft);
    }
    .task-row:hover {
      transform: translateY(-1px);
      border-color: rgba(82, 121, 111, 0.24);
      background: rgba(220, 235, 229, 0.48);
    }
    .task-row:active { transform: translateY(0) scale(0.995); }
    .task-list {
      max-height: 70vh;
      overflow: auto;
      padding-right: 4px;
    }
    .task-detail {
      min-height: 320px;
    }
    .empty {
      padding: 18px;
      border: 1px dashed var(--line-strong);
      border-radius: 10px;
      color: var(--muted);
      font-size: 13px;
      background: rgba(255, 255, 255, 0.42);
    }
    .focus-panel .empty {
      color: #b8c7c0;
      background: rgba(255, 255, 255, 0.055);
      border-color: rgba(220, 235, 229, 0.22);
    }
    .checklist {
      display: grid;
      gap: 6px;
      margin: 10px 0 0;
      padding: 0;
      list-style: none;
      color: var(--muted);
      font-size: 12px;
    }
    .focus-panel .checklist { color: #c8d7d0; }
    .checklist li {
      display: grid;
      grid-template-columns: 16px 1fr;
      gap: 6px;
      align-items: start;
    }
    .checkbox {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 14px;
      height: 14px;
      border: 1px solid var(--line-strong);
      border-radius: 999px;
      color: var(--ok);
      font-size: 11px;
      line-height: 1;
      margin-top: 1px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      height: 24px;
      padding: 0 8px;
      border-radius: 999px;
      background: #edf1ee;
      color: #2d3934;
      border: 1px solid rgba(23, 32, 28, 0.06);
      font-size: 11px;
      font-weight: 760;
      letter-spacing: 0.02em;
      white-space: nowrap;
    }
    .badge.running {
      background: #dbece6;
      color: #215d4f;
      animation: breathe 1.8s ease-in-out infinite;
    }
    .badge.done { background: #e1efe6; color: var(--ok); }
    .badge.blocked { background: #f4dfdb; color: var(--danger); }
    .badge.todo { background: #f3e7d2; color: var(--warn); }
    .focus-panel .badge {
      background: rgba(255, 255, 255, 0.08);
      color: #e8f1ec;
      border-color: rgba(255, 255, 255, 0.12);
    }
    .focus-panel .badge.running { color: #cde9dd; }
    .focus-panel .badge.done { color: #cfead7; }
    .focus-panel .badge.blocked { color: #f2cbc5; }
    .focus-panel .badge.todo { color: #efd6ac; }
    .prompt-link {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 28px;
      padding: 0 10px;
      margin-left: 8px;
      border: 1px solid rgba(47, 111, 94, 0.22);
      border-radius: 999px;
      color: var(--accent);
      background: rgba(220, 235, 229, 0.58);
      font-size: 12px;
      font-weight: 760;
      text-decoration: none;
      transition: transform 180ms cubic-bezier(0.16, 1, 0.3, 1), background 180ms;
    }
    .prompt-link:hover {
      transform: translateY(-1px);
      background: rgba(220, 235, 229, 0.9);
    }
    .prompt-link:active { transform: translateY(0) scale(0.98); }
    .focus-panel .prompt-link {
      color: #e8f3ef;
      background: rgba(255, 255, 255, 0.08);
      border-color: rgba(255, 255, 255, 0.14);
    }
    .sessions, .lesson-list {
      display: grid;
      gap: 8px;
    }
    .session {
      padding: 11px;
      border-color: rgba(23, 32, 28, 0.08);
      border-radius: 9px;
      box-shadow: none;
    }
    .focus-panel .session {
      color: #edf5f0;
      background: rgba(255, 255, 255, 0.055);
      border-color: rgba(255, 255, 255, 0.1);
    }
    .session-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      margin-bottom: 10px;
    }
    .role {
      font-weight: 800;
      text-transform: uppercase;
      font-size: 11px;
      letter-spacing: 0.1em;
      color: var(--muted);
    }
    .focus-panel .role { color: #b8cbc1; }
    .goal {
      font-size: 13px;
      font-weight: 720;
      line-height: 1.35;
      margin-bottom: 8px;
    }
    .meta {
      color: var(--muted);
      font-family: var(--mono);
      font-size: 11px;
      line-height: 1.55;
      overflow-wrap: anywhere;
    }
    .focus-panel .meta { color: #b6c7bf; }
    .lesson {
      padding: 10px;
      border: 1px solid rgba(23, 32, 28, 0.08);
      border-radius: 9px;
      background: rgba(255, 255, 255, 0.78);
      font-size: 12px;
      line-height: 1.45;
    }
    .lesson.experience {
      border-top-color: rgba(47, 125, 77, 0.38);
      background: linear-gradient(180deg, rgba(47, 125, 77, 0.045), rgba(255, 255, 255, 0.78) 34px);
    }
    .lesson.lesson {
      border-top-color: rgba(162, 99, 22, 0.42);
      background: linear-gradient(180deg, rgba(162, 99, 22, 0.05), rgba(255, 255, 255, 0.78) 34px);
    }
    .focus-panel .lesson {
      background: rgba(255, 255, 255, 0.055);
      border-color: rgba(255, 255, 255, 0.1);
    }
    pre {
      margin: 10px 0 0;
      min-height: 72px;
      max-height: 180px;
      overflow: auto;
      padding: 10px;
      border-radius: 9px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: #121a17;
      color: #dcebe5;
      font-family: var(--mono);
      font-size: 11px;
      line-height: 1.5;
      white-space: pre-wrap;
    }
    @keyframes breathe {
      0%, 100% { box-shadow: 0 0 0 0 rgba(47, 111, 94, 0.0); }
      50% { box-shadow: 0 0 0 4px rgba(47, 111, 94, 0.12); }
    }
    @keyframes liftIn {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @media (max-width: 900px) {
      header {
        align-items: flex-start;
        flex-direction: column;
        padding: 16px;
      }
      #run-title { white-space: normal; }
      main { padding: 16px; }
      .stats, .layout, .role-grid { grid-template-columns: 1fr; }
      .task-row { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Ouroboros</h1>
    <div id="run-title">Loading ${escapeHtml(input.runId)}</div>
  </header>
  <main>
    <section class="stats" id="stats"></section>
    <section class="panel focus-panel">
      <h2>Active Task Focus</h2>
      <div class="focus-list" id="active-focus"></div>
    </section>
    <section class="layout">
      <div class="panel">
        <h2>Task History</h2>
        <div class="task-list" id="history-task-list"></div>
      </div>
      <div class="panel">
        <h2>Task Detail</h2>
        <div class="task-detail" id="task-detail"></div>
      </div>
    </section>
  </main>
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
    const checklist = (task) => {
      const doneWhen = Array.isArray(task.doneWhen) ? task.doneWhen : [];
      if (!doneWhen.length) return "";
      const checked = task.status === "done";
      return '<ul class="checklist" data-source="doneWhen">' + doneWhen.map((item) =>
        '<li><span class="checkbox">' + (checked ? "✓" : "") + '</span><span>' + escapeHtml(item) + '</span></li>'
      ).join("") + '</ul>';
    };
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
    const sessionCard = (session) =>
      '<article class="session"><div class="session-head"><span class="role">' + escapeHtml(session.role) + '</span>' +
      '<span class="badge ' + session.status + '">' + escapeHtml(session.status) + '</span></div>' +
      '<div class="goal">' + escapeHtml(session.taskGoal) + '</div>' +
      '<div class="meta">task ' + escapeHtml(session.taskId) + '<br>attempt ' + escapeHtml(session.attemptId) +
      '<br>session ' + escapeHtml(session.sessionName || "") + '<br>codex ' + escapeHtml(session.codexSessionId || "") + '</div>' +
      '<pre>' + escapeHtml(latestText(session)) + '</pre></article>';
    const roleLane = (title, sessions) =>
      '<section class="role-lane"><h3>' + title + '</h3>' +
      (sessions.length ? sessions.map(sessionCard).join("") : '<div class="empty">No session</div>') + '</section>';
    const lessonList = (lessons) => lessons.length
      ? '<div class="lesson-list">' + lessons.map((lesson) =>
        '<div class="lesson ' + escapeHtml(lesson.kind) + '"><span class="badge">' + escapeHtml(lesson.kind) + '</span> ' +
        escapeHtml(lesson.summary) + '<div class="meta">task ' + escapeHtml(lesson.taskId) + '<br>attempt ' + escapeHtml(lesson.attemptId) + '</div></div>'
      ).join("") + '</div>'
      : '<div class="empty">No lessons or experiences</div>';
    const roleSessions = (sessions, roles) => sessions.filter((session) => roles.includes(session.role));
    const taskMeta = (task) => 'id ' + escapeHtml(task.id) + (task.dependsOn.length ? ' · depends on ' + task.dependsOn.map(escapeHtml).join(", ") : '');
    const renderFocusTask = (overview, task) => {
      const sessions = sessionsForTaskChain(overview, task);
      const lessons = lessonsForTaskChain(overview, task);
      return '<article class="focus-task"><div class="focus-head"><div class="focus-title">' +
        '<span class="badge ' + task.status + '">' + escapeHtml(task.status) + '</span>' +
        '<span class="badge">' + escapeHtml(task.role) + '</span><strong>' + escapeHtml(task.goal) + '</strong></div>' +
        '<div>' + promptLink(task) + '</div></div><div class="meta">' + taskMeta(task) + '</div>' +
        checklist(task) +
        '<div class="role-grid">' +
        roleLane("Planner", roleSessions(sessions, ["planner"])) +
        roleLane("Executor", roleSessions(sessions, ["worker"])) +
        roleLane("Reviewer", roleSessions(sessions, ["verifier", "goal-review"])) +
        '</div><div class="detail-section"><h3>Lessons And Experiences</h3>' + lessonList(lessons) + '</div></article>';
    };
    const renderTaskDetail = (overview, task) => {
      if (!task) return '<div class="empty">Select a task</div>';
      const sessions = sessionsForTaskChain(overview, task);
      const lessons = lessonsForTaskChain(overview, task);
      return '<div class="task-detail-head"><div class="detail-title">' +
        '<span class="badge ' + task.status + '">' + escapeHtml(task.status) + '</span>' +
        '<span class="badge">' + escapeHtml(task.role) + '</span><strong>' + escapeHtml(task.goal) + '</strong></div>' +
        '<div>' + promptLink(task) + '</div></div>' +
        '<div class="meta">' + taskMeta(task) + '</div>' + checklist(task) +
        '<div class="detail-section"><h3>Prompt Detail</h3><div class="meta">' + escapeHtml(task.prompt) + '</div></div>' +
        '<div class="detail-section"><h3>Related Sessions</h3><div class="sessions">' + (sessions.length ? sessions.map(sessionCard).join("") : '<div class="empty">No session</div>') + '</div></div>' +
        '<div class="detail-section"><h3>Lessons And Experiences</h3>' + lessonList(lessons) + '</div>';
    };
    async function refresh() {
      const response = await fetch("/api/runs/" + encodeURIComponent(runId) + "/overview");
      const overview = await response.json();
      render(overview);
    }
    function render(overview) {
      latestOverview = overview;
      document.getElementById("run-title").textContent = overview.run ? overview.run.goal : runId;
      const taskCounts = byStatus(overview.tasks);
      const sessionCounts = byStatus(overview.sessions);
      document.getElementById("stats").innerHTML = [
        ["Tasks", overview.tasks.length],
        ["Todo tasks", taskCounts.todo || 0],
        ["Running tasks", taskCounts.running || 0],
        ["Running sessions", sessionCounts.running || 0]
      ].map(([label, value]) => '<div class="stat"><b>' + value + '</b><span>' + label + '</span></div>').join("");
      const activeTasks = overview.tasks.filter((task) => task.status === "todo" || task.status === "running");
      if (!selectedTaskId || !overview.tasks.some((task) => task.id === selectedTaskId)) {
        selectedTaskId = (activeTasks[0] || overview.tasks[overview.tasks.length - 1] || {}).id || null;
      }
      document.getElementById("active-focus").innerHTML = activeTasks.length
        ? activeTasks.map((task) => renderFocusTask(overview, task)).join("")
        : '<div class="empty">No active tasks</div>';
      document.getElementById("history-task-list").innerHTML = [...overview.tasks].reverse().map((task) =>
        '<button class="task-row ' + (task.id === selectedTaskId ? 'selected' : '') + '" data-task-id="' + escapeHtml(task.id) + '">' +
        '<span class="badge ' + task.status + '">' + escapeHtml(task.status) + '</span>' +
        '<span class="badge">' + escapeHtml(task.role) + '</span>' +
        '<span><strong>' + escapeHtml(task.goal) + '</strong><br><span class="meta">' + taskMeta(task) + '</span></span></button>'
      ).join("");
      document.getElementById("task-detail").innerHTML = renderTaskDetail(overview, overview.tasks.find((task) => task.id === selectedTaskId));
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
