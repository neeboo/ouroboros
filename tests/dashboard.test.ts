import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyHarnessAction, Harness } from "../packages/harness/src";
import { buildTaskPrompt } from "../packages/runner/src";
import {
  buildDashboardTaskGraph,
  dashboardEvidenceItemTextForTest,
  dashboardHtml,
  handleDashboardRequest,
} from "../packages/cli/src/dashboard";
import { DASHBOARD_REACT_MODULES } from "../packages/cli/src/dashboard-app";

const pathologicalText = {
  token: "SupercalifragilisticDashboardOverflowRegressionToken".repeat(6),
  prose: "Reusable dashboard overflow discovery needs long prose with spaces ".repeat(12),
  status: "running-with-pathological-status-label".repeat(4),
  id: "task_" + "pathological_identifier_".repeat(8),
  projectRoot: join(
    tmpdir(),
    "ouroboros-dashboard-project-root-" + "deeply_nested_segment_".repeat(8),
    "workspace-with-a-long-name-" + "ownership_boundary_".repeat(6),
  ),
  filePath: [
    "packages",
    "dashboard",
    "src",
    "features",
    "project-workspace",
    "changed-files",
    "extremely-long-file-name-" + "diff-inspection-contract-".repeat(5) + ".ts",
  ].join("/"),
};

function longTextDashboardFixture() {
  const workerId = pathologicalText.id;
  const verifierId = "task_" + "verifier_identifier_".repeat(8);
  return {
    run: {
      id: "run_long_text",
      goal: `${pathologicalText.prose} ${pathologicalText.token}`,
      status: "running",
    },
    tasks: [
      {
        id: workerId,
        runId: "run_long_text",
        role: "worker",
        goal: `Worker goal ${pathologicalText.token} ${pathologicalText.prose}`,
        prompt: `Prompt body ${pathologicalText.token}\n${pathologicalText.prose}`,
        status: "running",
        dependsOn: [],
        parentId: null,
        cycleId: "cycle_long_text",
        doneWhen: [
          `Inspector todo item ${pathologicalText.token}`,
          `Metadata and status row stays readable ${pathologicalText.prose}`,
        ],
      },
      {
        id: verifierId,
        runId: "run_long_text",
        role: "verifier",
        goal: `Verifier goal ${pathologicalText.prose}`,
        prompt: `Verifier prompt ${pathologicalText.token}`,
        status: "todo",
        dependsOn: [workerId],
        parentId: workerId,
        cycleId: "cycle_long_text",
        doneWhen: [`Verifier doneWhen ${pathologicalText.token}`],
      },
    ],
    sessions: [
      {
        taskId: workerId,
        taskGoal: `Stream task goal ${pathologicalText.token}`,
        role: "worker",
        status: "running",
        attemptId: "attempt_" + "long_attempt_".repeat(6),
        sessionName: "session-" + pathologicalText.token,
        codexSessionId: "codex_" + "long_codex_".repeat(6),
        latestText: `Stream latest text ${pathologicalText.token}`,
        events: [
          { text: `Stream line ${pathologicalText.token}` },
          { payload: { delta: `Code-like output ${pathologicalText.token}` } },
        ],
        output: {
          artifacts: [
            { kind: "created_task", sourceTaskId: workerId, taskId: verifierId },
          ],
        },
      },
    ],
    lessons: [
      {
        taskId: workerId,
        attemptId: "attempt_" + "lesson_attempt_".repeat(6),
        kind: "experience",
        summary: `Lesson summary ${pathologicalText.prose}`,
      },
    ],
  };
}

function dashboardResolvedBlockedTaskIdsForTest(tasks: Array<Record<string, unknown>>) {
  const html = dashboardHtml({ runId: "run_123" });
  const match = html.match(/const resolvedBlockedTaskIdsFor = \(tasks\) => \{([\s\S]*?)\n    \};/);
  if (!match) throw new Error("resolvedBlockedTaskIdsFor script not found");
  return new Function("tasks", `${match[1]}; return resolvedBlockedTaskIdsFor(tasks);`)(tasks) as Set<string>;
}

function createdTaskIdFromActionResult(result: { artifacts: Array<Record<string, unknown>> }): string | undefined {
  const created = result.artifacts.find((artifact) => artifact.kind === "task" && typeof artifact.taskId === "string");
  return typeof created?.taskId === "string" ? created.taskId : undefined;
}

function styleBlock(html: string) {
  const match = html.match(/<style>([\s\S]*?)<\/style>/);
  if (!match) throw new Error("dashboard style block not found");
  return match[1];
}

function cssRule(html: string, selector: string) {
  for (const block of styleBlock(html).split("}")) {
    const [rawSelector, rule] = block.split("{");
    if (!rawSelector || !rule) continue;
    if (rawSelector.trim() === selector) return rule;
  }
  throw new Error(`CSS rule not found: ${selector}`);
}

function expectCssRule(html: string, selector: string, declarations: string[]) {
  const rule = cssRule(html, selector);
  for (const declaration of declarations) {
    expect(rule).toContain(declaration);
  }
}

const browserOverflowVerifierSnippet = `
// Run in a local browser verifier after loading the dashboard at desktop and mobile widths.
// Example labels: verifyDashboardOverflow("desktop 1440x900") and verifyDashboardOverflow("mobile 390x844").
function verifyDashboardOverflow(label) {
  const selectors = ["html", "body", ".app-shell", ".task-sidebar", ".task-nav", ".workspace", ".workspace-head", ".inspector-panel", ".changed-file-tree", ".diff-panel"];
  const rows = selectors.map((selector) => {
    const node = document.querySelector(selector) || document.scrollingElement;
    return {
      label,
      selector,
      clientWidth: node.clientWidth,
      scrollWidth: node.scrollWidth,
      horizontalOverflow: node.scrollWidth > node.clientWidth,
      "scrollWidth <= node.clientWidth": node.scrollWidth <= node.clientWidth,
    };
  });
  const inspector = document.querySelector(".inspector-panel");
  const appShell = document.querySelector(".app-shell");
  const workspace = document.querySelector(".workspace");
  const changedFileTree = document.querySelector(".changed-file-tree");
  const diffPanel = document.querySelector(".diff-panel");
  const diffOutput = document.querySelector(".diff-output");
  const workspaceRect = workspace?.getBoundingClientRect();
  const inspectorRect = inspector?.getBoundingClientRect();
  const diffScrollContained = !!diffOutput && diffOutput.scrollWidth >= diffOutput.clientWidth && diffOutput.clientWidth <= (diffPanel?.clientWidth || diffOutput.clientWidth);
  const mobileStacked = !!workspaceRect && !!inspectorRect && window.innerWidth <= 900 && inspectorRect.top >= workspaceRect.bottom - 1;
  console.table(rows);
  console.log("dashboard-overflow-summary", {
    label,
    viewportWidth: window.innerWidth,
    appShellClientWidth: appShell?.clientWidth,
    appShellScrollWidth: appShell?.scrollWidth,
    inspectorClientWidth: inspector?.clientWidth,
    inspectorScrollWidth: inspector?.scrollWidth,
    changedFileTreeClientWidth: changedFileTree?.clientWidth,
    changedFileTreeScrollWidth: changedFileTree?.scrollWidth,
    diffPanelClientWidth: diffPanel?.clientWidth,
    diffPanelScrollWidth: diffPanel?.scrollWidth,
    diffOutputClientWidth: diffOutput?.clientWidth,
    diffOutputScrollWidth: diffOutput?.scrollWidth,
    diffScrollContained,
    mobileStacked,
    pageHasHorizontalOverflow: rows.some((row) => row.horizontalOverflow && row.selector !== ".diff-output"),
  });
}
verifyDashboardOverflow("desktop and mobile widths");
`;

describe("dashboard", () => {
  test("exposes a React dashboard module boundary for the incremental migration", () => {
    expect(DASHBOARD_REACT_MODULES.map((module) => module.id)).toEqual([
      "shell",
      "sidebar",
      "flow-view",
      "inspector",
      "controls",
    ]);
    expect(DASHBOARD_REACT_MODULES.every((module) => module.status === "active")).toBe(true);
    expect(DASHBOARD_REACT_MODULES.flatMap((module) => module.owns)).toEqual(
      expect.arrayContaining([
        "intake-composer",
        "supervisor-controls",
        "workspace-flow",
        "dashboard-canvas-root",
        "inspector-panel",
        "changed-files",
        "diff-panel",
      ]),
    );
  });

  test("renders Codex-style intake composer and goal navigation", () => {
    const html = dashboardHtml({ runId: "run_123" });

    expect(html).toContain("Active Goals");
    expect(html).toContain('id="active-goal-list"');
    expect(html).toContain('id="history-goal-list"');
    expect(html).toContain("todo");
    expect(html).toContain("running");
    expect(html).toContain("/prompt");
    expect(html).toContain('id="intake-composer"');
    expect(html).toContain('id="attachment-input"');
    expect(html).toContain('id="attachment-chips"');
    expect(html).toContain('id="intake-input"');
    expect(html).toContain('data-attach-files');
    expect(html).toContain('data-clear-attachments');
    expect(html).toContain('data-send-intake');
    expect(html).toContain("attachmentMetaForFile");
    expect(html).toContain("readAttachment");
    expect(html).toContain("attachments.map");
    expect(html).toContain('event.key !== "Enter"');
    expect(html).toContain("event.metaKey");
    expect(html).toContain("event.ctrlKey");
    expect(html).toContain('requestSubmit(document.querySelector("[data-send-intake]"))');
    expect(html).toContain('/api/runs/" + encodeURIComponent(runId) + "/intake"');
    expect(html).toContain("No active tasks. Describe the next goal in the composer.");
    expect(html).not.toContain('id="goal-composer"');
    expect(html).not.toContain("Interrupt + replan");
    expect(html).not.toContain('data-goal-action="add"');
    expect(html).toContain("data-stop-attempt-id");
    expect(html).toContain("Stop current task");
    expect(html).toContain("data-rerun-task-id");
    expect(html).toContain("Rerun selected task");
    expect(html).toContain("data-start-runner");
    expect(html).toContain("data-stop-runner");
    expect(html).toContain("data-start-supervisor");
    expect(html).toContain("data-stop-supervisor");
    expect(html).toContain("Start background runner");
    expect(html).toContain("Stop background runner");
    expect(html).toContain("Start supervisor");
    expect(html).toContain("Stop supervisor");
    expect(html).toContain("Connection timed out");
    expect(html).toContain("latestRunnerSignal");
  });

  test("renders workspace and inspector regions for sessions prompts and lessons", () => {
    const html = dashboardHtml({ runId: "run_123" });

    expect(html).toContain('id="workspace-flow"');
    expect(html).toContain('id="inspector-panel"');
    expect(html).toContain("buildGoalGroups");
    expect(html).toContain("task.cycleId");
    expect(html).toContain("transcript");
    expect(html).toContain("readableSummary");
    expect(html).toContain("conversationEvidence");
    expect(html).toContain("evidenceSection");
    expect(html).toContain("rawStreamDetails");
    expect(html).toContain("eventText");
    expect(html).toContain("streamOutput");
    expect(html).toContain("renderWorkspace");
    expect(html).toContain("renderInspector");
    expect(html).toContain("orderedSessions");
    expect(html).toContain("captureFlowScrollState");
    expect(html).toContain("restoreFlowScrollState");
    expect(html).toContain("node.scrollTop = scrollState.shouldFollowBottom ? node.scrollHeight : scrollState.scrollTop");
  });

  test("renders structured dashboard evidence as readable text", () => {
    const problem = dashboardEvidenceItemTextForTest({
      severity: "high",
      path: "packages/cli/src/dashboard.ts",
      message: "Dashboard rendered structured problem as an object",
      details: { command: "bun test tests/dashboard.test.ts", status: "failed" },
    });
    const artifact = dashboardEvidenceItemTextForTest({
      kind: "context_lesson_archive",
      summary: {
        message: "Artifact summary was structured",
        evidence: { status: "blocked" },
      },
    });

    expect(problem).toContain("Dashboard rendered structured problem as an object");
    expect(problem).toContain("packages/cli/src/dashboard.ts");
    expect(problem).toContain("bun test tests/dashboard.test.ts");
    expect(problem).not.toContain("[object Object]");
    expect(artifact).toContain("Artifact summary was structured");
    expect(artifact).toContain("blocked");
    expect(artifact).not.toContain("[object Object]");
  });

  test("treats repaired blocked verifier tasks as historical evidence", () => {
    const html = dashboardHtml({ runId: "run_123" });

    expect(html).toContain("resolvedBlockedTaskIdsFor");
    expect(html).toContain("effectiveTaskStatus");
    expect(html).toContain("repaired block");
    expect(html).toContain("blocked verifier task was repaired and is now historical evidence");
    expect(html).toContain('task.status === "blocked" && !group.resolvedBlockedTaskIds.has(task.id)');
  });

  test("does not resolve a blocked task when only the repair worker is done", () => {
    const resolved = dashboardResolvedBlockedTaskIdsForTest([
      {
        id: "task_blocked_verifier",
        role: "verifier",
        status: "blocked",
        parentId: "task_worker",
        dependsOn: ["task_worker"],
      },
      {
        id: "task_repair_worker",
        role: "worker",
        status: "done",
        parentId: "task_blocked_verifier",
        dependsOn: [],
      },
    ]);

    expect(resolved.has("task_blocked_verifier")).toBe(false);
  });

  test("resolves a blocked task only after a repair worker has a done verifier", () => {
    const resolved = dashboardResolvedBlockedTaskIdsForTest([
      {
        id: "task_blocked_verifier",
        role: "verifier",
        status: "blocked",
        parentId: "task_worker",
        dependsOn: ["task_worker"],
      },
      {
        id: "task_repair_worker",
        role: "worker",
        status: "done",
        parentId: "task_blocked_verifier",
        dependsOn: [],
      },
      {
        id: "task_repair_verifier",
        role: "verifier",
        status: "done",
        parentId: "task_repair_worker",
        dependsOn: ["task_repair_worker"],
      },
    ]);

    expect(resolved.has("task_blocked_verifier")).toBe(true);
  });

  test("renders project metadata in the dashboard header", () => {
    const html = dashboardHtml({ runId: "run_123" });

    expect(html).toContain('data-project-header');
    expect(html).toContain('data-project-name');
    expect(html).toContain('data-project-root');
    expect(html).toContain('id="project-title"');
    expect(html).toContain("Project Workspace");
    expect(html).toContain("overview.project");
    expect(html).toContain("projectTitle");
    expect(html).toContain("projectName");
    expect(html).toContain("projectRoot");
  });

  test("renders changed-file tree controls and diff inspection hooks for the selected goal", () => {
    const html = dashboardHtml({ runId: "run_123" });

    expect(html).toContain("Changed Files");
    expect(html).toContain("changedFilesForGroup");
    expect(html).toContain("changedFilesTree");
    expect(html).toContain("renderChangedFilesTree");
    expect(html).toContain("selectedChangedFilePath");
    expect(html).toContain('data-changed-files-section');
    expect(html).toContain('data-changed-file-tree');
    expect(html).toContain('data-changed-file-node');
    expect(html).toContain('data-changed-file-path');
    expect(html).toContain('data-selected-changed-file');
    expect(html).toContain('data-diff-panel');
    expect(html).toContain('data-diff-path');
    expect(html).toContain('data-diff-header');
    expect(html).toContain("data-diff-state");
    expect(html).toContain('"empty-selection"');
    expect(html).toContain('"loading"');
    expect(html).toContain('"error"');
    expect(html).toContain('"no-diff"');
    expect(html).toContain('data-diff-row');
    expect(html).toContain("data-diff-row-type");
    expect(html).toContain(".diff-row.added");
    expect(html).toContain(".diff-row.removed");
    expect(html).toContain(".diff-row.hunk");
    expect(html).toContain(".diff-row.context");
    expect(html).toContain("renderDiffRows");
    expect(html).toContain("diffLineType");
    expect(html).toContain('aria-current="true"');
    expect(html).toContain('/api/runs/" + encodeURIComponent(runId) + "/diff?path=" + encodeURIComponent(path)');
    expect(html).toContain("fetchDiffForChangedFile");
  });

  test("renders Canvas and Flow workspace modes for the selected task graph", () => {
    const html = dashboardHtml({ runId: "run_123" });

    expect(html).toContain('data-workspace-mode="canvas"');
    expect(html).toContain('data-workspace-mode="flow"');
    expect(html).toContain('id="dashboard-canvas-root"');
    expect(html).toContain("/assets/dashboard-canvas.js");
    expect(html).toContain("/assets/dashboard-canvas.css");
    expect(html).toContain("mountReactFlowCanvas");
    expect(html).toContain("workspaceMode");
    expect(html).toContain("renderCanvasWorkspace");
    expect(html).toContain("renderFlowWorkspace");
    expect(html).toContain("data-canvas-task-id");
    expect(html).toContain("dependsOn");
    expect(html).toContain("parentId");
    expect(html).toContain("created");
    expect(html).toContain("reviews");
    expect(html).toContain("canvas-workspace");
    expect(html).toContain("task.cycleId");
    expect(html).toContain("transcript");
    expect(html).toContain("stream-output");
  });

  test("persists selected goal workspace mode and title expansion in run-scoped browser storage", () => {
    const html = dashboardHtml({ runId: "run_123" });

    expect(html).toContain('const dashboardStorageKey = "ouroboros:dashboard:" + runId;');
    expect(html).toContain("readDashboardState");
    expect(html).toContain("writeDashboardState");
    expect(html).toContain("const restoredDashboardState = readDashboardState();");
    expect(html).toContain("let selectedGoalId = restoredDashboardState.selectedGoalId || null;");
    expect(html).toContain('let workspaceMode = restoredDashboardState.workspaceMode || "flow";');
    expect(html).toContain("let workspaceTitleExpanded = restoredDashboardState.workspaceTitleExpanded === true;");
    expect(html).toContain("workspaceTitleExpanded: parsed.workspaceTitleExpanded === true");
    expect(html).toContain("workspaceTitleExpanded: state.workspaceTitleExpanded === true");
    expect(html).toContain("writeDashboardState({ selectedGoalId, workspaceMode, workspaceTitleExpanded });");
    expect(html).toContain("selectedGoalId = payload.runId || payload.taskId || selectedGoalId;");
    expect(html).toContain("workspaceTitleExpanded = false;");
    expect(html).not.toContain('localStorage.setItem("selectedGoalId"');
    expect(html).not.toContain('localStorage.getItem("selectedGoalId"');
  });

  test("keeps sidebar goal row titles shrink-safe and truncated", () => {
    const html = dashboardHtml({ runId: "run_123" });

    expect(html).toContain("grid-template-columns: 12px minmax(0, 1fr) minmax(0, 72px);");
    expect(html).toContain(".task-row-text");
    expect(html).toContain("min-width: 0;");
    expect(html).toContain("overflow: hidden;");
    expect(html).toContain('<span class="task-row-text"><strong>');
    expect(html).toContain(".task-row strong");
    expect(html).toContain(".task-row .row-meta");
    expect(html).toContain("text-overflow: ellipsis;");
    expect(html).toContain("white-space: nowrap;");
  });

  test("truncates workspace title by default and exposes an accessible expander", () => {
    const html = dashboardHtml({ runId: "run_123" });

    expect(html).toContain('class="workspace-title is-collapsed" id="workspace-title"');
    expect(html).toContain('id="workspace-title-toggle"');
    expect(html).toContain('data-workspace-title-toggle');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="workspace-title"');
    expect(html).toContain('aria-label="Expand workspace title"');
    expect(html).toContain("-webkit-line-clamp: 2;");
    expect(html).toContain("workspaceTitleExpanded");
  });

  test("updates workspace title expander aria state without replacing selected goal or mode", () => {
    const html = dashboardHtml({ runId: "run_123" });

    expect(html).toContain("const syncWorkspaceTitle = (title) =>");
    expect(html).toContain('titleNode.classList.toggle("is-expanded", workspaceTitleExpanded);');
    expect(html).toContain('titleNode.classList.toggle("is-collapsed", !workspaceTitleExpanded);');
    expect(html).toContain('toggle.setAttribute("aria-expanded", workspaceTitleExpanded ? "true" : "false");');
    expect(html).toContain('toggle.setAttribute("aria-label", workspaceTitleExpanded ? "Collapse workspace title" : "Expand workspace title");');
    expect(html).toContain('toggle.textContent = workspaceTitleExpanded ? "Collapse" : "Expand";');
    expect(html).toContain("workspaceTitleExpanded = !workspaceTitleExpanded;");
    expect(html).toContain("writeDashboardState({ selectedGoalId, workspaceMode, workspaceTitleExpanded });");
    expect(html).toContain("selectedGoalId, workspaceMode, workspaceTitleExpanded");
  });

  test("provides a reusable long-text dashboard overflow fixture", () => {
    const fixture = longTextDashboardFixture();
    const graph = buildDashboardTaskGraph(fixture as never, "cycle_long_text");

    expect(fixture.run.goal).toContain(pathologicalText.token);
    expect(fixture.tasks[0].goal).toContain(pathologicalText.token);
    expect(fixture.tasks[0].prompt).toContain(pathologicalText.token);
    expect(fixture.tasks[0].doneWhen[0]).toContain(pathologicalText.token);
    expect(fixture.sessions[0].taskGoal).toContain(pathologicalText.token);
    expect(fixture.sessions[0].sessionName).toContain(pathologicalText.token);
    expect(fixture.sessions[0].latestText).toContain(pathologicalText.token);
    expect(fixture.sessions[0].events[1]!.payload!.delta).toContain(pathologicalText.token);
    expect(fixture.lessons[0].summary).toContain(pathologicalText.prose.trim().slice(0, 40));
    expect(pathologicalText.projectRoot).toContain("deeply_nested_segment_");
    expect(pathologicalText.filePath).toContain("diff-inspection-contract-");
    expect(graph.nodes).toHaveLength(2);
    expect(graph.nodes[0].data.goal.length).toBeLessThanOrEqual(118);
    expect(graph.nodes[0].data.latestSession?.latestText).toContain(pathologicalText.token);
    expect(graph.nodes[0].data.latestSession?.sessionName).toContain(pathologicalText.token);
    expect(graph.edges).toContainEqual(expect.objectContaining({ source: fixture.tasks[0].id, target: fixture.tasks[1].id }));
  });

  test("surfaces resolved model metadata in dashboard flow and canvas data", () => {
    const fixture = longTextDashboardFixture();
    (fixture.sessions[0] as Record<string, unknown>).model = {
      model: "gpt-5.4-mini",
      source: "role-default",
      role: "worker",
      provider: "openai",
      profile: "fast",
      base_url: "https://api.example.test/v1",
      env_key: "OPENAI_API_KEY",
    };
    const graph = buildDashboardTaskGraph(fixture as never, "cycle_long_text");
    const html = dashboardHtml({ runId: "run_123" });

    const sessionModel = (fixture.sessions[0] as unknown as { model: Record<string, unknown> }).model;
    expect(graph.nodes[0].data.latestSession?.model).toEqual(sessionModel);
    expect(html).toContain("modelMetaForSession");
    expect(html).toContain("session.model");
    expect(html).toContain("Model ");
    expect(html).toContain("latestSession.model");
    expect(html).toContain("model.source");
  });

  test("defines reusable static overflow contracts for dashboard long text surfaces", () => {
    const html = dashboardHtml({ runId: "run_123" });

    expectCssRule(html, "body", ["overflow: hidden;"]);
    expectCssRule(html, ".app-shell", ["height: 100dvh;", "display: grid;", "grid-template-columns: 300px minmax(0, 1fr) clamp(380px, 30vw, 520px);", "overflow-x: hidden;"]);
    expectCssRule(html, ".task-sidebar", ["height: 100dvh;", "min-width: 0;", "min-height: 0;", "overflow: hidden;"]);
    expectCssRule(html, ".project-header", ["min-width: 0;", "overflow: hidden;"]);
    expectCssRule(html, ".project-name", ["overflow: hidden;", "text-overflow: ellipsis;", "white-space: nowrap;"]);
    expectCssRule(html, ".project-root", ["overflow: hidden;", "text-overflow: ellipsis;", "white-space: nowrap;"]);
    expectCssRule(html, ".task-nav", ["width: 100%;", "min-width: 0;", "max-width: 100%;", "min-height: 0;", "overflow-x: hidden;", "overflow-y: auto;", "scrollbar-gutter: stable;"]);
    expectCssRule(html, ".nav-section", ["width: 100%;", "min-width: 0;", "max-width: 100%;", "overflow-x: hidden;"]);
    expectCssRule(html, ".task-list", ["width: 100%;", "min-width: 0;", "max-width: 100%;", "overflow-x: hidden;"]);
    expectCssRule(html, ".workspace", ["min-width: 0;", "overflow: hidden;"]);
    expectCssRule(html, ".workspace-title-block", ["min-width: 0;"]);
    expectCssRule(html, ".workspace-title-row", ["grid-template-columns: minmax(0, 1fr) auto;"]);
    expectCssRule(html, ".workspace-title", ["min-width: 0;", "overflow-wrap: anywhere;"]);
    expectCssRule(html, ".workspace-title.is-collapsed", ["-webkit-line-clamp: 2;", "overflow: hidden;"]);
    expectCssRule(html, ".task-row", ["min-width: 0;", "grid-template-columns: 12px minmax(0, 1fr) minmax(0, 72px);", "overflow: hidden;"]);
    expectCssRule(html, ".task-row-text", ["min-width: 0;", "overflow: hidden;"]);
    expectCssRule(html, ".task-row strong", ["text-overflow: ellipsis;", "white-space: nowrap;"]);
    expectCssRule(html, ".task-row .row-meta", ["text-overflow: ellipsis;", "white-space: nowrap;"]);
    expectCssRule(html, ".status-text", ["width: 100%;", "max-width: 100%;", "overflow: hidden;", "text-overflow: ellipsis;", "white-space: nowrap;"]);
    expectCssRule(html, ".plain-button", ["min-width: 0;", "overflow: hidden;", "text-overflow: ellipsis;", "white-space: nowrap;"]);
    expectCssRule(html, ".workspace-flow", ["min-height: 0;", "overflow: auto;"]);
    expectCssRule(html, ".flow-inner", ["min-width: 0;"]);
    expectCssRule(html, ".turn", ["grid-template-columns: 34px minmax(0, 1fr);"]);
    expectCssRule(html, ".turn-body", ["min-width: 0;"]);
    expectCssRule(html, ".turn-author", ["overflow-wrap: anywhere;"]);
    expectCssRule(html, ".turn-summary", ["overflow-wrap: anywhere;"]);
    expectCssRule(html, ".turn-text", ["white-space: pre-wrap;", "overflow-wrap: anywhere;"]);
    expectCssRule(html, ".conversation-evidence", ["display: grid;", "gap: 12px;"]);
    expectCssRule(html, ".evidence-item", ["font-size: 12px;", "overflow-wrap: anywhere;"]);
    expectCssRule(html, ".raw-stream", ["font-size: 11px;"]);
    expectCssRule(html, ".stream-output", ["overflow: auto;", "white-space: pre-wrap;", "overflow-wrap: anywhere;"]);
    expectCssRule(html, ".inspector-panel", ["width: clamp(380px, 30vw, 520px);", "min-width: 380px;", "max-width: 520px;", "overflow-y: auto;", "overflow-x: hidden;", "scrollbar-gutter: stable;"]);
    expectCssRule(html, ".inspector-card", ["min-width: 0;", "border-radius: 0;", "background: transparent;"]);
    expectCssRule(html, ".current-task-title", ["overflow-wrap: anywhere;"]);
    expectCssRule(html, ".current-task-meta", ["overflow-wrap: anywhere;"]);
    expectCssRule(html, ".todo-list, .lesson-list, .info-list", ["gap: 9px;"]);
    expectCssRule(html, ".todo-item", ["grid-template-columns: 18px minmax(0, 1fr);", "gap: 9px;", "font-size: 13px;", "line-height: 1.42;"]);
    expectCssRule(html, ".todo-text", ["min-width: 0;", "overflow-wrap: anywhere;"]);
    expectCssRule(html, ".meta", ["overflow-wrap: anywhere;"]);
    expectCssRule(html, ".changed-files-section", ["min-width: 0;"]);
    expectCssRule(html, ".changed-file-tree", ["min-width: 0;", "overflow-x: hidden;"]);
    expectCssRule(html, ".changed-file-node", ["min-width: 0;", "grid-template-columns: 28px minmax(0, 1fr);"]);
    expectCssRule(html, ".changed-file-name", ["min-width: 0;", "overflow: hidden;", "text-overflow: ellipsis;", "white-space: nowrap;"]);
    expectCssRule(html, ".changed-file-type", ["color: var(--muted-2);", "font-family: var(--mono);"]);
    expectCssRule(html, ".diff-panel", ["min-width: 0;", "max-width: 100%;", "overflow: hidden;"]);
    expectCssRule(html, ".diff-header", ["position: sticky;", "top: 0;", "overflow: hidden;"]);
    expectCssRule(html, ".diff-path", ["overflow-wrap: anywhere;"]);
    expectCssRule(html, ".diff-output", ["overflow-x: auto;", "overflow-y: auto;", "white-space: pre;", "overflow-wrap: normal;"]);
    expectCssRule(html, ".diff-row", ["display: grid;", "grid-template-columns: 42px max-content;", "min-width: max-content;"]);
    expectCssRule(html, ".diff-line", ["white-space: pre;", "font-family: var(--mono);"]);
    expectCssRule(html, ".diff-row.added", ["background: rgba(111, 160, 122, 0.12);"]);
    expectCssRule(html, ".diff-row.removed", ["background: rgba(184, 113, 111, 0.12);"]);
    expectCssRule(html, ".diff-row.hunk", ["background: rgba(255, 255, 255, 0.055);"]);
    expectCssRule(html, ".diff-row.context", ["background: transparent;"]);
    expect(html).toContain("grid-template-columns: minmax(0, 1fr);");
    expect(html).toContain(".inspector-panel { width: auto; min-width: 0; max-width: none; }");
    expect(html).toContain(".task-sidebar { min-width: 0; overflow-x: hidden; overflow-y: visible; }");
  });

  test("defines reusable static overflow contracts for canvas node surfaces", () => {
    const html = dashboardHtml({ runId: "run_123" });

    expectCssRule(html, ".workspace-flow.canvas-workspace", ["overflow: hidden;"]);
    expectCssRule(html, ".canvas-inner", ["overflow: hidden;"]);
    expectCssRule(html, "#dashboard-canvas-root", ["width: 100%;", "height: 100%;"]);
    expectCssRule(html, ".of-node", ["width: 250px;"]);
    expectCssRule(html, ".of-node-head", ["min-width: 0;"]);
    expectCssRule(html, ".of-node-head span", ["min-width: 0;", "overflow: hidden;", "text-overflow: ellipsis;", "white-space: nowrap;"]);
    expectCssRule(html, ".of-node-goal", ["overflow-wrap: anywhere;"]);
    expectCssRule(html, ".of-node-meta", ["overflow-wrap: anywhere;"]);
  });

  test("documents browser overflow measurement for dashboard verifiers without adding dependencies", () => {
    expect(browserOverflowVerifierSnippet).toContain(".task-sidebar");
    expect(browserOverflowVerifierSnippet).toContain(".workspace-head");
    expect(browserOverflowVerifierSnippet).toContain(".changed-file-tree");
    expect(browserOverflowVerifierSnippet).toContain(".diff-panel");
    expect(browserOverflowVerifierSnippet).toContain(".diff-output");
    expect(browserOverflowVerifierSnippet).toContain("inspectorClientWidth");
    expect(browserOverflowVerifierSnippet).toContain("diffScrollContained");
    expect(browserOverflowVerifierSnippet).toContain("mobileStacked");
    expect(browserOverflowVerifierSnippet).toContain("scrollWidth <= node.clientWidth");
    expect(browserOverflowVerifierSnippet).toContain("desktop and mobile widths");
  });

  test("preserves flow scroll position across refresh patches unless already near bottom", () => {
    const html = dashboardHtml({ runId: "run_123" });

    expect(html).toContain("captureFlowScrollState");
    expect(html).toContain("restoreFlowScrollState");
    expect(html).toContain("shouldFollowBottom");
    expect(html).toContain("distanceFromBottom <= 48");
    expect(html).toContain("node.scrollTop = scrollState.shouldFollowBottom ? node.scrollHeight : scrollState.scrollTop;");
    expect(html).toContain("stream.scrollTop = streamScroll.shouldFollowBottom ? stream.scrollHeight : streamScroll.scrollTop;");
    expect(html).not.toContain("node.scrollTop = node.scrollHeight;");
  });

  test("patches dashboard refreshes without replacing major visible panels", () => {
    const html = dashboardHtml({ runId: "run_123" });

    expect(html).toContain("patchKeyedChildren");
    expect(html).toContain("patchInspectorPanel");
    expect(html).toContain('data-inspector-section="progress"');
    expect(html).toContain('data-inspector-section="runner"');
    expect(html).toContain('patchKeyedChildren("inspector-panel"');
    expect(html).not.toContain('setHtmlIfChanged("inspector-panel", renderInspector(overview, selectedGroup) + renderRunner(overview));');
  });

  test("explains when queued work is waiting for an idle runner", () => {
    const html = dashboardHtml({ runId: "run_123" });

    expect(html).toContain("stalledQueue");
    expect(html).toContain("Queue waiting for runner");
    expect(html).toContain("dashboard is only observing because the runner is");
    expect(html).toContain("next ");
    expect(html).toContain('status !== "running" && hasQueuedWork');
  });

  test("patches stream output in place instead of replacing the whole flow turn", () => {
    const html = dashboardHtml({ runId: "run_123" });

    expect(html).toContain("patchWorkspaceTurn");
    expect(html).toContain("patchStreamOutput");
    expect(html).toContain("[data-event-index]");
    expect(html).toContain("<summary>Raw output</summary>");
    expect(html).toContain("currentStream.appendChild(nextLine.cloneNode(true));");
    expect(html).not.toContain("currentTurn.replaceWith(nextTurn.cloneNode(true));");
  });

  test("serves bundled React Flow canvas assets", async () => {
    const dashboardInput = {
      runId: "run_123",
      overview: () => ({ run: null, project: null, tasks: [], sessions: [], threads: [], lessons: [] }),
      renderTaskPrompt: () => "",
    };

    const jsResponse = await handleDashboardRequest(
      new Request("http://localhost/assets/dashboard-canvas.js"),
      dashboardInput,
    );
    const jsBody = await jsResponse.text();
    expect(jsResponse.status).toBe(200);
    expect(jsResponse.headers.get("content-type")).toContain("text/javascript");
    expect(jsBody).toContain("ReactFlow");

    const cssResponse = await handleDashboardRequest(
      new Request("http://localhost/assets/dashboard-canvas.css"),
      dashboardInput,
    );
    const cssBody = await cssResponse.text();
    expect(cssResponse.status).toBe(200);
    expect(cssResponse.headers.get("content-type")).toContain("text/css");
    expect(cssBody).toContain("react-flow");
  });

  test("builds React Flow graph data for planner worker verifier relationships", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ouroboros-dashboard-graph-"));
    const harness = new Harness(join(dir, "ouroboros.db"));
    harness.init();
    const runId = harness.createRun({ goal: "Render planner worker verifier graph" });
    const plannerId = harness.createTask({
      runId,
      role: "planner",
      goal: "Plan a graph",
      prompt: "Plan the work.",
      doneWhen: ["plan emitted"],
    });
    harness.recordAttempt({
      taskId: plannerId,
      input: { sessionName: "planner-session", codexSessionId: "codex_planner" },
      output: {
        status: "done",
        summary: "Planner created worker",
        changedFiles: [],
        checks: [],
        artifacts: [],
        problems: [],
      },
    });
    const workerId = harness.createTask({
      runId,
      role: "worker",
      goal: "Implement graph island",
      prompt: "Build it.",
      dependsOn: [plannerId],
      doneWhen: ["canvas mounts", "graph renders"],
    });
    harness.recordAttempt({
      taskId: workerId,
      input: { sessionName: "worker-session", codexSessionId: "codex_worker" },
      output: {
        status: "done",
        summary: "Worker implemented graph",
        changedFiles: ["packages/cli/src/dashboard.ts"],
        checks: [],
        artifacts: [],
        problems: [],
      },
    });
    const verifierId = harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify graph island",
      prompt: "Verify it.",
      dependsOn: [workerId],
      parentId: workerId,
      doneWhen: ["verified"],
    });
    harness.startAttempt({
      taskId: verifierId,
      input: { sessionName: "verifier-session", codexSessionId: "codex_verifier" },
    });

    try {
      const graph = buildDashboardTaskGraph(harness.getRunOverview({ runId }), plannerId);

      expect(graph.nodes.map((node) => node.id)).toEqual([plannerId, workerId, verifierId]);
      expect(graph.nodes.find((node) => node.id === plannerId)?.data.role).toBe("planner");
      expect(graph.nodes.find((node) => node.id === workerId)?.data.status).toBe("done");
      expect(graph.nodes.find((node) => node.id === workerId)?.data.doneWhenCount).toBe(2);
      expect(graph.nodes.find((node) => node.id === verifierId)?.data.latestSession?.status).toBe("running");
      expect(graph.edges).toContainEqual(
        expect.objectContaining({ source: plannerId, target: workerId, label: "dependsOn" }),
      );
      expect(graph.edges).toContainEqual(
        expect.objectContaining({ source: workerId, target: verifierId, label: "dependsOn" }),
      );
      expect(graph.edges).toContainEqual(
        expect.objectContaining({ source: workerId, target: verifierId, label: "parentId" }),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("builds Canvas graph with every planner-created worker participant", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ouroboros-dashboard-created-graph-"));
    const harness = new Harness(join(dir, "ouroboros.db"));
    harness.init();
    const runId = harness.createRun({ goal: "Render every planner-created worker" });
    const plannerId = harness.createTask({
      runId,
      role: "planner",
      goal: "Plan parallel workers",
      prompt: "Plan the work.",
    });
    const workerAId = harness.createTask({
      runId,
      role: "worker",
      goal: "Implement left branch",
      prompt: "Build left.",
      id: "task_worker_a",
    });
    const workerBId = harness.createTask({
      runId,
      role: "worker",
      goal: "Implement right branch",
      prompt: "Build right.",
      id: "task_worker_b",
    });
    const verifierId = harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify left branch",
      prompt: "Verify left.",
      dependsOn: [workerAId],
    });
    harness.recordAttempt({
      taskId: plannerId,
      input: { sessionName: "planner-session" },
      output: {
        status: "done",
        summary: "Planner created two workers",
        artifacts: [
          { kind: "created_task", sourceTaskId: plannerId, taskId: workerAId },
          { kind: "created_task", sourceTaskId: plannerId, taskId: workerBId },
        ],
      },
    });

    try {
      const graph = buildDashboardTaskGraph(harness.getRunOverview({ runId }), plannerId);

      expect(graph.nodes.map((node) => node.id)).toEqual([plannerId, workerAId, workerBId, verifierId]);
      expect(graph.nodes.filter((node) => node.data.role === "worker")).toHaveLength(2);
      expect(graph.edges).toContainEqual(
        expect.objectContaining({ source: plannerId, target: workerAId, label: "created" }),
      );
      expect(graph.edges).toContainEqual(
        expect.objectContaining({ source: plannerId, target: workerBId, label: "created" }),
      );
      expect(graph.edges).toContainEqual(
        expect.objectContaining({ source: workerAId, target: verifierId, label: "dependsOn" }),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("renders task doneWhen items in the todo inspector", () => {
    const html = dashboardHtml({ runId: "run_123" });

    expect(html).toContain("todo-list");
    expect(html).toContain("doneWhen");
    expect(html).toContain("checkbox");
    expect(html).toContain(".todo-item.done");
    expect(html).toContain("font-size: 13px;");
    expect(html).toContain("font-size: 10.5px;");
    expect(html).toContain("current-task");
    expect(html).toContain("aria-hidden");
    expect(html).toContain("Progress");
    expect(html).not.toContain("<h2>Lessons</h2>");
    expect(html).not.toContain("<h2>Queue</h2>");
    expect(html).not.toContain("<h2>Run Info</h2>");
  });

  test("polls overview through a worker instead of a main-thread interval", () => {
    const html = dashboardHtml({ runId: "run_123" });

    expect(html).toContain("overviewWorkerSource");
    expect(html).toContain("new Worker");
    expect(html).toContain("new Blob");
    expect(html).toContain('overview.runner?.status === "running"');
    expect(html).toContain('overview.supervisor?.status === "running"');
    expect(html).toContain("overview.globalRuns?.todo");
    expect(html).not.toContain("overview.tasks.some((task) => task.status === \"todo\" || task.status === \"running\")");
    expect(html).not.toContain("setInterval");
  });

  test("serves a rendered task prompt preview as plain text", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ouroboros-dashboard-"));
    const harness = new Harness(join(dir, "ouroboros.db"));
    harness.init();
    const runId = harness.createRun({ goal: "Bootstrap dashboard prompt previews" });
    const dependencyId = harness.createTask({
      runId,
      role: "worker",
      goal: "Implement dependency",
      prompt: "Build the upstream piece.",
    });
    harness.recordAttempt({
      taskId: dependencyId,
      input: {},
      output: {
        status: "done",
        summary: "Dependency implemented summary",
        changedFiles: ["src/dependency.ts"],
        checks: [],
        artifacts: [],
        problems: [],
      },
    });
    const taskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Preview rendered dashboard prompts",
      prompt: "Render the current task prompt.",
      dependsOn: [dependencyId],
    });

    const response = await handleDashboardRequest(
      new Request(`http://localhost/tasks/${taskId}/prompt`),
      {
        runId,
        overview: () => harness.getRunOverview({ runId }),
        renderTaskPrompt: (requestedTaskId) => {
          const task = harness.getTask(requestedTaskId);
          if (!task) throw new Error(`task not found: ${requestedTaskId}`);
          const run = harness.getRun(task.runId);
          if (!run) throw new Error(`run not found: ${task.runId}`);
          return buildTaskPrompt({
            run,
            task,
            dependencyAttempts: task.dependsOn.length > 0 ? harness.listLatestAttemptsForTasks(task.dependsOn) : [],
            lessons: harness.listLessons({ runId: run.id }),
            template: harness.getPromptTemplate("task")?.contentMd,
          });
        },
      },
    );
    try {
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/plain");
      expect(body).toContain("Goal: Preview rendered dashboard prompts");
      expect(body).toContain("Dependency implemented summary");
      expect(body).toContain("src/dependency.ts");
      expect(body).toContain("Run Lessons");
      expect(body).toContain("Dependency implemented summary");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("auto-starts an idle runner when overview has ready work", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ouroboros-dashboard-autostart-"));
    const harness = new Harness(join(dir, "ouroboros.db"));
    harness.init();
    const runId = harness.createRun({ goal: "Drain queued work" });
    harness.createTask({
      runId,
      role: "worker",
      goal: "Ready work",
      prompt: "Run the ready task.",
    });
    let runnerStatus: { status: "idle" | "running" | "exited"; pid: number | null } = {
      status: "idle",
      pid: null,
    };
    let starts = 0;

    try {
      const response = await handleDashboardRequest(
        new Request(`http://localhost/api/runs/${runId}/overview`),
        {
          runId,
          overview: () => harness.getRunOverview({ runId }),
          runnerStatus: () => runnerStatus,
          autoStartRunner: () => true,
          renderTaskPrompt: () => "",
          actions: {
            startRunner: () => {
              starts += 1;
              runnerStatus = { status: "running", pid: 4321 };
              return { status: "running", pid: 4321 };
            },
          },
        },
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(starts).toBe(1);
      expect(body.runner).toEqual({ status: "running", pid: 4321 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("does not auto-start an idle runner while the supervisor is running", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ouroboros-dashboard-supervisor-autostart-"));
    const harness = new Harness(join(dir, "ouroboros.db"));
    harness.init();
    const runId = harness.createRun({ goal: "Observe queued work" });
    harness.createTask({
      runId,
      role: "worker",
      goal: "Ready work",
      prompt: "Run the ready task.",
    });
    let starts = 0;

    try {
      const response = await handleDashboardRequest(
        new Request(`http://localhost/api/runs/${runId}/overview`),
        {
          runId,
          overview: () => harness.getRunOverview({ runId }),
          runnerStatus: () => ({ status: "idle", pid: null }),
          supervisorStatus: () => ({ status: "running", pid: 2468, lastOutput: "supervising runs" }),
          autoStartRunner: () => true,
          renderTaskPrompt: () => "",
          actions: {
            startRunner: () => {
              starts += 1;
              return { status: "running", pid: 4321 };
            },
          },
        },
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(starts).toBe(0);
      expect(body.runner).toEqual({ status: "idle", pid: null });
      expect(body.supervisor).toEqual({ status: "running", pid: 2468, lastOutput: "supervising runs" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("aggregates child run activity into a root dashboard overview", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ouroboros-dashboard-child-overview-"));
    const harness = new Harness(join(dir, "ouroboros.db"));
    harness.init();
    const rootRunId = harness.createRun({ goal: "Root intake" });
    harness.updateRunStatus({ runId: rootRunId, status: "done" });
    const childRunId = harness.createRun({
      goal: "Child implementation goal",
      context: { parentRunId: rootRunId },
    });
    const childTaskId = harness.createTask({
      runId: childRunId,
      role: "worker",
      goal: "Implement child work",
      prompt: "Do the child work.",
    });
    const childAttemptId = harness.startAttempt({ taskId: childTaskId, input: {} });
    harness.upsertExecutionThread({
      id: `thread_${childAttemptId}`,
      runId: childRunId,
      taskId: childTaskId,
      attemptId: childAttemptId,
      ownerType: "runner",
      role: "worker",
      status: "running",
      pid: 12345,
    });

    try {
      const response = await handleDashboardRequest(
        new Request(`http://localhost/api/runs/${rootRunId}/overview`),
        {
          runId: rootRunId,
          overview: () => harness.getRunOverview({ runId: rootRunId }),
          childOverviews: () => [harness.getRunOverview({ runId: childRunId })],
          globalRunCounts: () => harness.countRunsByStatus(),
          runnerStatus: () => ({ status: "idle", pid: null }),
          supervisorStatus: () => ({ status: "idle", pid: null, lastOutput: "" }),
          renderTaskPrompt: () => "",
        },
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.run.status).toBe("running");
      expect(body.tasks.map((task: { id: string }) => task.id)).toContain(childTaskId);
      expect(body.sessions.map((session: { attemptId: string }) => session.attemptId)).toContain(childAttemptId);
      expect(body.threads.map((thread: { id: string }) => thread.id)).toContain(`thread_${childAttemptId}`);
      expect(body.supervisor).toMatchObject({
        status: "running",
        pid: 12345,
        externallyManaged: true,
      });
      expect(body.runner).toMatchObject({ status: "idle" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("serves global supervisor overview state and intake actions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ouroboros-dashboard-supervisor-"));
    const harness = new Harness(join(dir, "ouroboros.db"));
    harness.init();
    const runId = harness.createRun({ goal: "Observe global supervision" });
    harness.createRun({ goal: "Queued sibling run" });
    const runningRunId = harness.createRun({ goal: "Running sibling run" });
    harness.updateRunStatus({ runId: runningRunId, status: "running" });
    let supervisorStatus: { status: "idle" | "running" | "exited"; pid: number | null; lastOutput: string } = {
      status: "idle",
      pid: null,
      lastOutput: "waiting for work",
    };
    let intakeDocument = "";
    let intakeTitle = "";
    let supervisorStarts = 0;
    let supervisorStops = 0;
    const dashboardInput = {
      runId,
      overview: () => harness.getRunOverview({ runId }),
      renderTaskPrompt: () => "",
      globalRunCounts: () => harness.countRunsByStatus(),
      supervisorStatus: () => supervisorStatus,
      actions: {
        startSupervisor: () => {
          supervisorStarts += 1;
          supervisorStatus = { status: "running", pid: 2468, lastOutput: "supervising runs" };
          return { status: "running", pid: 2468 };
        },
        stopSupervisor: () => {
          supervisorStops += 1;
          supervisorStatus = { status: "exited", pid: 2468, lastOutput: "stopped by dashboard" };
          return { status: "stopped", pid: 2468 };
        },
        createIntake: (document: string, title?: string) => {
          intakeDocument = document;
          intakeTitle = title || "";
          return { runId: "run_intake_child", status: "todo" };
        },
      },
    };

    try {
      const overviewResponse = await handleDashboardRequest(
        new Request(`http://localhost/api/runs/${runId}/overview`),
        dashboardInput,
      );
      const overviewBody = await overviewResponse.json();
      expect(overviewResponse.status).toBe(200);
      expect(overviewBody.globalRuns).toEqual({ todo: 2, running: 1, done: 0, blocked: 0 });
      expect(overviewBody.supervisor).toEqual({ status: "idle", pid: null, lastOutput: "waiting for work" });

      const intakeResponse = await handleDashboardRequest(
        new Request(`http://localhost/api/runs/${runId}/intake`, {
          method: "POST",
          body: JSON.stringify({
            prompt: "Plan a React dashboard migration",
            attachments: [
              {
                name: "notes.md",
                type: "text/markdown",
                size: 128,
                content: "# Notes\nUse one composer.",
              },
            ],
          }),
        }),
        dashboardInput,
      );
      const intakeBody = await intakeResponse.json();
      expect(intakeResponse.status).toBe(200);
      expect(intakeBody.runId).toBe("run_intake_child");
      expect(intakeTitle).toBe("Plan a React dashboard migration");
      expect(intakeDocument).toContain("Plan a React dashboard migration");
      expect(intakeDocument).toContain("Attachment: notes.md");
      expect(intakeDocument).toContain("type: text/markdown");
      expect(intakeDocument).toContain("size: 128");
      expect(intakeDocument).toContain("# Notes");

      const startResponse = await handleDashboardRequest(
        new Request(`http://localhost/api/supervisor/start`, {
          method: "POST",
          body: JSON.stringify({}),
        }),
        dashboardInput,
      );
      const startBody = await startResponse.json();
      expect(startResponse.status).toBe(200);
      expect(startBody).toEqual({ status: "running", pid: 2468 });
      expect(supervisorStarts).toBe(1);

      const stopResponse = await handleDashboardRequest(
        new Request(`http://localhost/api/supervisor/stop`, {
          method: "POST",
          body: JSON.stringify({}),
        }),
        dashboardInput,
      );
      const stopBody = await stopResponse.json();
      expect(stopResponse.status).toBe(200);
      expect(stopBody).toEqual({ status: "stopped", pid: 2468 });
      expect(supervisorStops).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("serves changed files for a run as flat entries and a tree payload", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ouroboros-dashboard-files-"));
    const harness = new Harness(join(dir, "ouroboros.db"));
    harness.init();
    const projectId = harness.createProject({ name: "Files Project", rootPath: dir });
    const runId = harness.createRun({ goal: "Track changed files", projectId });
    const taskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Change files",
      prompt: "Change files.",
    });
    const attemptId = harness.recordAttempt({
      taskId,
      input: {},
      output: {
        status: "done",
        summary: "Changed files",
        changedFiles: ["src/app.ts", "./src/app.ts", "README.md"],
        checks: [],
        artifacts: [],
        problems: [],
      },
    });

    try {
      const response = await handleDashboardRequest(
        new Request(`http://localhost/api/runs/${runId}/changed-files`),
        {
          runId,
          overview: () => harness.getRunOverview({ runId }),
          renderTaskPrompt: () => "",
        },
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.files).toEqual([
        { path: "README.md", taskId, attemptId, worktreePath: null },
        { path: "src/app.ts", taskId, attemptId, worktreePath: null },
      ]);
      expect(body.tree).toEqual([
        { name: "README.md", path: "README.md", type: "file" },
        {
          name: "src",
          path: "src",
          type: "directory",
          children: [{ name: "app.ts", path: "src/app.ts", type: "file" }],
        },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("serves git diff for tracked changed files and rejects traversal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ouroboros-dashboard-diff-"));
    const harness = new Harness(join(dir, "ouroboros.db"));
    harness.init();
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src/app.ts"), "export const value = 1;\n");
    Bun.spawnSync({ cmd: ["git", "init"], cwd: dir, stdout: "ignore", stderr: "ignore" });
    Bun.spawnSync({ cmd: ["git", "add", "src/app.ts"], cwd: dir, stdout: "ignore", stderr: "ignore" });
    Bun.spawnSync({
      cmd: ["git", "-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "initial"],
      cwd: dir,
      stdout: "ignore",
      stderr: "ignore",
    });
    await writeFile(join(dir, "src/app.ts"), "export const value = 2;\n");
    const projectId = harness.createProject({ name: "Diff Project", rootPath: dir });
    const runId = harness.createRun({ goal: "View diff", projectId });
    const taskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Change app",
      prompt: "Change app.",
    });
    harness.recordAttempt({
      taskId,
      input: {},
      output: {
        status: "done",
        summary: "Changed app",
        changedFiles: ["src/app.ts"],
        checks: [],
        artifacts: [],
        problems: [],
      },
    });
    const dashboardInput = {
      runId,
      overview: () => harness.getRunOverview({ runId }),
      renderTaskPrompt: () => "",
    };

    try {
      const diffResponse = await handleDashboardRequest(
        new Request(`http://localhost/api/runs/${runId}/diff?path=src%2Fapp.ts`),
        dashboardInput,
      );
      const diffBody = await diffResponse.text();
      expect(diffResponse.status).toBe(200);
      expect(diffResponse.headers.get("content-type")).toContain("text/plain");
      expect(diffBody).toContain("-export const value = 1;");
      expect(diffBody).toContain("+export const value = 2;");

      const traversalResponse = await handleDashboardRequest(
        new Request(`http://localhost/api/runs/${runId}/diff?path=..%2Fsecret.txt&format=json`),
        dashboardInput,
      );
      const traversalBody = await traversalResponse.json();
      expect(traversalResponse.status).toBe(400);
      expect(traversalBody.error).toContain("path traversal");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("serves changed-file diffs from the task worktree that reported the file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ouroboros-dashboard-worktree-diff-"));
    const harness = new Harness(join(dir, "ouroboros.db"));
    const worktreeA = join(dir, "worktree-a");
    const worktreeB = join(dir, "worktree-b");
    harness.init();
    for (const root of [worktreeA, worktreeB]) {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "src/app.ts"), "export const value = 1;\n");
      Bun.spawnSync({ cmd: ["git", "init"], cwd: root, stdout: "ignore", stderr: "ignore" });
      Bun.spawnSync({ cmd: ["git", "add", "src/app.ts"], cwd: root, stdout: "ignore", stderr: "ignore" });
      Bun.spawnSync({
        cmd: ["git", "-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "initial"],
        cwd: root,
        stdout: "ignore",
        stderr: "ignore",
      });
    }
    await writeFile(join(worktreeA, "src/app.ts"), "export const value = 2;\n");
    await writeFile(join(worktreeB, "src/app.ts"), "export const value = 99;\n");
    const runId = harness.createRun({ goal: "View worktree diff" });
    const taskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Change app in worktree A",
      prompt: "Change app.",
    });
    harness.leaseReadyTasks({
      runId,
      limit: 1,
      sessionForTask: (task) => `task-${task.id}`,
      worktreeForTask: () => worktreeA,
    });
    const attemptId = harness.recordAttempt({
      taskId,
      input: {},
      output: {
        status: "done",
        summary: "Changed app",
        changedFiles: ["src/app.ts"],
        checks: [],
        artifacts: [],
        problems: [],
      },
    });
    const dashboardInput = {
      runId,
      overview: () => harness.getRunOverview({ runId }),
      renderTaskPrompt: () => "",
    };

    try {
      const changedResponse = await handleDashboardRequest(
        new Request(`http://localhost/api/runs/${runId}/changed-files`),
        dashboardInput,
      );
      const changedBody = await changedResponse.json();
      const diffResponse = await handleDashboardRequest(
        new Request(`http://localhost/api/runs/${runId}/diff?path=src%2Fapp.ts`),
        dashboardInput,
      );
      const diffBody = await diffResponse.text();

      expect(changedBody.files).toEqual([{ path: "src/app.ts", taskId, attemptId, worktreePath: worktreeA }]);
      expect(diffResponse.status).toBe(200);
      expect(diffBody).toContain("+export const value = 2;");
      expect(diffBody).not.toContain("+export const value = 99;");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("handles dashboard goal interrupt and resume actions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ouroboros-dashboard-actions-"));
    const harness = new Harness(join(dir, "ouroboros.db"));
    harness.init();
    const runId = harness.createRun({ goal: "Bootstrap interactive control" });
    const runningTaskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Long running task",
      prompt: "Keep working.",
    });
    const runningAttemptId = harness.startAttempt({
      taskId: runningTaskId,
      input: { sessionName: "task-long-running", codexSessionId: "codex_123" },
    });
    const runningThreadId = harness.upsertExecutionThread({
      runId,
      taskId: runningTaskId,
      attemptId: runningAttemptId,
      ownerType: "runner",
      ownerId: "dashboard",
      role: "worker",
      status: "running",
      pid: 1234,
      sessionName: "task-long-running",
      agentSessionId: "codex_123",
      worktreePath: "/tmp/dashboard-task",
    });
    const dashboardInput = {
      runId,
      overview: () => harness.getRunOverview({ runId }),
      renderTaskPrompt: () => "",
      runnerStatus: () => ({ status: "idle" as const, pid: null }),
      actions: {
        startRunner: () => ({ status: "running", pid: 1234 }),
        stopRunner: () => ({ status: "blocked", pid: 1234 }),
        createGoal: (goal: string) => ({
          taskId: harness.createTask({
            runId,
            role: "planner",
            goal: `Plan user goal: ${goal}`,
            prompt: goal,
            doneWhen: ["planned"],
          }),
          status: "todo",
        }),
        interruptAndCreateGoal: (goal: string) => {
          const running = harness.listRunningAttempts({ runId });
          if (running.length === 0) {
            return {
              taskId: harness.createTask({
                runId,
                role: "planner",
                goal: `Replan after user interruption: ${goal}`,
                prompt: goal,
                doneWhen: ["replanned"],
              }),
              status: "todo",
              interrupted: 0,
            };
          }
          const [primaryAttempt] = running;
          const actionResult = applyHarnessAction(harness, {
            type: "interruptAttemptAndCreateTask",
            attemptId: primaryAttempt.id,
            reason: goal,
            followUpTask: {
              role: "planner",
              goal: `Replan after user interruption: ${goal}`,
              prompt: goal,
              doneWhen: ["replanned"],
            },
          });
          const followUpTaskId = createdTaskIdFromActionResult(actionResult);
          return {
            taskId: followUpTaskId,
            status: "todo",
            interrupted: running.length,
          };
        },
        resumeTask: (taskId: string) => {
          harness.retryTask({ taskId });
          return { taskId, status: "todo" };
        },
        rerunTask: (taskId: string) => {
          harness.retryTask({ taskId });
          return { taskId, status: "todo" };
        },
        stopAttempt: (attemptId: string) => {
          const attempt = harness.getAttempt(attemptId);
          if (!attempt) throw new Error(`attempt not found: ${attemptId}`);
          const task = harness.getTask(attempt.taskId);
          if (!task) throw new Error(`task not found: ${attempt.taskId}`);
          const actionResult = applyHarnessAction(harness, {
            type: "interruptAttemptAndCreateTask",
            attemptId,
            reason: "user stopped the current task from the dashboard",
            followUpTask: {
              role: "worker",
              goal: `Repair interrupted work: ${task.goal}`,
              prompt: "Inspect the interrupted task and repair it.",
              doneWhen: ["repair emitted"],
            },
          });
          const followUpTaskId = createdTaskIdFromActionResult(actionResult);
          return { attemptId, taskId: attempt.taskId, followUpTaskId, status: "blocked" };
        },
      },
    };

    try {
      const overviewResponse = await handleDashboardRequest(
        new Request(`http://localhost/api/runs/${runId}/overview`),
        dashboardInput,
      );
      const overviewBody = await overviewResponse.json();
      expect(overviewBody.runner).toEqual({ status: "idle", pid: null });

      const startRunnerResponse = await handleDashboardRequest(
        new Request(`http://localhost/api/runs/${runId}/runner/start`, {
          method: "POST",
          body: JSON.stringify({}),
        }),
        dashboardInput,
      );
      const startRunnerBody = await startRunnerResponse.json();
      expect(startRunnerResponse.status).toBe(200);
      expect(startRunnerBody.status).toBe("running");

      const stopRunnerResponse = await handleDashboardRequest(
        new Request(`http://localhost/api/runs/${runId}/runner/stop`, {
          method: "POST",
          body: JSON.stringify({}),
        }),
        dashboardInput,
      );
      const stopRunnerBody = await stopRunnerResponse.json();
      expect(stopRunnerResponse.status).toBe(200);
      expect(stopRunnerBody.status).toBe("blocked");

      const stopResponse = await handleDashboardRequest(
        new Request(`http://localhost/api/attempts/${runningAttemptId}/stop`, {
          method: "POST",
          body: JSON.stringify({}),
        }),
        dashboardInput,
      );
      const stopBody = await stopResponse.json();
      expect(stopResponse.status).toBe(200);
      expect(stopBody.status).toBe("blocked");
      expect(harness.getAttempt(runningAttemptId)?.status).toBe("blocked");
      expect(harness.getTask(runningTaskId)?.status).toBe("blocked");
      expect(harness.listExecutionThreads({ runId })[0]).toMatchObject({
        id: runningThreadId,
        status: "interrupted",
        interruptReason: "user stopped the current task from the dashboard",
      });
      expect(harness.getRunOverview({ runId }).tasks).toContainEqual(
        expect.objectContaining({ role: "worker", status: "todo", parentId: runningTaskId }),
      );

      const rerunResponse = await handleDashboardRequest(
        new Request(`http://localhost/api/tasks/${runningTaskId}/rerun`, {
          method: "POST",
          body: JSON.stringify({}),
        }),
        dashboardInput,
      );
      const rerunBody = await rerunResponse.json();
      expect(rerunResponse.status).toBe(200);
      expect(rerunBody.status).toBe("todo");
      expect(harness.getTask(runningTaskId)?.status).toBe("todo");

      const rerunAttemptId = harness.startAttempt({
        taskId: runningTaskId,
        input: { sessionName: "task-long-running-again", codexSessionId: "codex_456" },
      });
      const rerunThreadId = harness.upsertExecutionThread({
        runId,
        taskId: runningTaskId,
        attemptId: rerunAttemptId,
        ownerType: "runner",
        ownerId: "dashboard",
        role: "worker",
        status: "running",
        pid: 1235,
        sessionName: "task-long-running-again",
        agentSessionId: "codex_456",
        worktreePath: "/tmp/dashboard-task",
      });

      const addResponse = await handleDashboardRequest(
        new Request(`http://localhost/api/runs/${runId}/goals`, {
          method: "POST",
          body: JSON.stringify({ goal: "Add a new dashboard control" }),
        }),
        dashboardInput,
      );
      const addBody = await addResponse.json();
      expect(addResponse.status).toBe(200);
      expect(harness.getTask(addBody.taskId)?.role).toBe("planner");

      const interruptResponse = await handleDashboardRequest(
        new Request(`http://localhost/api/runs/${runId}/interrupt`, {
          method: "POST",
          body: JSON.stringify({ goal: "Change direction now" }),
        }),
        dashboardInput,
      );
      const interruptBody = await interruptResponse.json();
      expect(interruptResponse.status).toBe(200);
      expect(interruptBody.interrupted).toBe(1);
      expect(harness.getTask(runningTaskId)?.status).toBe("blocked");
      expect(rerunThreadId).toBeTruthy();
      expect(harness.listExecutionThreads({ runId }).find((thread) => thread.id === rerunThreadId)).toMatchObject({
        id: rerunThreadId,
        status: "interrupted",
        interruptReason: "Change direction now",
      });
      expect(harness.getRunOverview({ runId }).tasks).toContainEqual(
        expect.objectContaining({ role: "planner", status: "todo", parentId: runningTaskId }),
      );

      const resumeResponse = await handleDashboardRequest(
        new Request(`http://localhost/api/tasks/${runningTaskId}/resume`, {
          method: "POST",
          body: JSON.stringify({}),
        }),
        dashboardInput,
      );
      const resumeBody = await resumeResponse.json();
      expect(resumeResponse.status).toBe(200);
      expect(resumeBody.status).toBe("todo");
      expect(harness.getTask(runningTaskId)?.status).toBe("todo");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
