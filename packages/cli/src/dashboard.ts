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
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #182026;
      background: #eef2f5;
    }
    * { box-sizing: border-box; }
    body { margin: 0; }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 18px 24px;
      background: #101820;
      color: white;
    }
    h1 { margin: 0; font-size: 18px; font-weight: 700; letter-spacing: 0; }
    main { padding: 20px 24px 28px; }
    .stats {
      display: grid;
      grid-template-columns: repeat(4, minmax(120px, 1fr));
      gap: 12px;
      margin-bottom: 18px;
    }
    .stat, .panel, .session {
      background: white;
      border: 1px solid #d7dee5;
      border-radius: 8px;
      box-shadow: 0 1px 2px rgba(16, 24, 32, 0.04);
    }
    .stat { padding: 12px 14px; }
    .stat b { display: block; font-size: 24px; }
    .stat span { color: #5c6b73; font-size: 12px; }
    .layout {
      display: grid;
      grid-template-columns: minmax(320px, 1.2fr) minmax(420px, 2fr);
      gap: 16px;
      align-items: start;
    }
    .panel { padding: 14px; }
    .panel h2 { margin: 0 0 12px; font-size: 14px; }
    .queue-panel { margin-bottom: 16px; }
    .queue-list {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 10px;
    }
    .queue-item {
      display: grid;
      grid-template-columns: 78px 86px 1fr;
      gap: 8px;
      align-items: start;
      padding: 10px;
      border: 1px solid #edf1f4;
      border-radius: 6px;
      background: #fbfcfd;
      font-size: 13px;
    }
    .empty {
      padding: 10px;
      border: 1px dashed #cbd5dd;
      border-radius: 6px;
      color: #5c6b73;
      font-size: 13px;
    }
    .task {
      display: grid;
      grid-template-columns: 78px 86px 1fr;
      gap: 8px;
      align-items: center;
      padding: 8px 0;
      border-top: 1px solid #edf1f4;
      font-size: 13px;
    }
    .task:first-of-type { border-top: 0; }
    .badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      height: 24px;
      padding: 0 8px;
      border-radius: 999px;
      background: #e9eef2;
      color: #2f3b43;
      font-size: 12px;
      white-space: nowrap;
    }
    .badge.running { background: #dff1ff; color: #075985; }
    .badge.done { background: #e4f7e7; color: #166534; }
    .badge.blocked { background: #ffe7e2; color: #9f2d18; }
    .sessions {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 12px;
    }
    .session { padding: 12px; }
    .session-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      margin-bottom: 10px;
    }
    .role { font-weight: 700; text-transform: uppercase; font-size: 12px; color: #34424c; }
    .goal { font-size: 14px; font-weight: 650; margin-bottom: 8px; }
    .meta { color: #5c6b73; font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
    pre {
      margin: 10px 0 0;
      min-height: 96px;
      max-height: 240px;
      overflow: auto;
      padding: 10px;
      border-radius: 6px;
      background: #101820;
      color: #d8f3dc;
      font-size: 12px;
      white-space: pre-wrap;
    }
    @media (max-width: 900px) {
      header { align-items: flex-start; flex-direction: column; }
      .stats, .layout { grid-template-columns: 1fr; }
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
    <section class="panel queue-panel">
      <h2>Active Queue</h2>
      <div class="queue-list" id="active-queue"></div>
    </section>
    <section class="layout">
      <div class="panel">
        <h2>Tasks</h2>
        <div id="tasks"></div>
      </div>
      <div class="panel">
        <h2>Sessions</h2>
        <div class="sessions" id="sessions"></div>
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
    async function refresh() {
      const response = await fetch("/api/runs/" + encodeURIComponent(runId) + "/overview");
      const overview = await response.json();
      render(overview);
    }
    function render(overview) {
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
      document.getElementById("active-queue").innerHTML = activeTasks.length ? activeTasks.map((task) =>
        '<div class="queue-item"><span class="badge ' + task.status + '">' + escapeHtml(task.status) + '</span>' +
        '<span class="badge">' + escapeHtml(task.role) + '</span>' +
        '<div><strong>' + escapeHtml(task.goal) + '</strong><div class="meta">' +
        'id ' + escapeHtml(task.id) + (task.dependsOn.length ? ' · depends on ' + task.dependsOn.map(escapeHtml).join(", ") : '') +
        '</div></div></div>'
      ).join("") : '<div class="empty">No active tasks</div>';
      document.getElementById("tasks").innerHTML = overview.tasks.map((task) =>
        '<div class="task"><span class="badge ' + task.status + '">' + escapeHtml(task.status) + '</span>' +
        '<span class="badge">' + escapeHtml(task.role) + '</span>' +
        '<div><strong>' + escapeHtml(task.goal) + '</strong><div class="meta">' +
        'id ' + escapeHtml(task.id) + (task.dependsOn.length ? ' · depends on ' + task.dependsOn.map(escapeHtml).join(", ") : '') +
        '</div></div></div>'
      ).join("");
      document.getElementById("sessions").innerHTML = overview.sessions.map((session) =>
        '<article class="session"><div class="session-head"><span class="role">' + escapeHtml(session.role) + '</span>' +
        '<span class="badge ' + session.status + '">' + escapeHtml(session.status) + '</span></div>' +
        '<div class="goal">' + escapeHtml(session.taskGoal) + '</div>' +
        '<div class="meta">task ' + escapeHtml(session.taskId) + '<br>attempt ' + escapeHtml(session.attemptId) +
        '<br>session ' + escapeHtml(session.sessionName || "") + '<br>codex ' + escapeHtml(session.codexSessionId || "") + '</div>' +
        '<pre>' + escapeHtml(latestText(session)) + '</pre></article>'
      ).join("");
    }
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
}) {
  return Bun.serve({
    port: input.port,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/") {
        return new Response(dashboardHtml({ runId: input.runId }), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (url.pathname === `/api/runs/${input.runId}/overview`) {
        return Response.json(input.overview());
      }
      return new Response("not found", { status: 404 });
    },
  });
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
