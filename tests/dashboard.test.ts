import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyHarnessAction, Harness } from "../packages/harness/src";
import { buildTaskPrompt } from "../packages/runner/src";
import {
  buildDashboardTaskGraph,
  DASHBOARD_ROUTE_NEXT_MILESTONE,
  DASHBOARD_ROUTES,
  dashboardRoutePaths,
  dashboardCodexEventPartsForTest,
  dashboardCssSourceForTest,
  dashboardEventLineForTest,
  dashboardEvidenceItemTextForTest,
  dashboardHtml,
  dashboardRunHistoryRowsHtmlForTest,
  handleDashboardRequest,
  serveDashboard,
  shouldRetryDashboardBind,
} from "../packages/cli/src/dashboard";
import { DASHBOARD_REACT_MODULES } from "../packages/cli/src/dashboard-app";
import { buildDashboardWorkspaceModel } from "../packages/cli/src/dashboard-workspace-model";

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

function dashboardCss() {
  return dashboardCssSourceForTest();
}

function cssRule(css: string, selector: string) {
  const flattenedCss = css.replace(/@layer\s+\w+\s*\{\n/g, "");
  for (const block of flattenedCss.split("}")) {
    const [rawSelector, rule] = block.split("{");
    if (!rawSelector || !rule) continue;
    if (rawSelector.trim() === selector) return rule;
  }
  throw new Error(`CSS rule not found: ${selector}`);
}

function expectCssRule(css: string, selector: string, declarations: string[]) {
  const rule = cssRule(css, selector);
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
  test("defines a shadcn-compatible neutral dashboard component boundary", async () => {
    const components = JSON.parse(await readFile(join(import.meta.dir, "../components.json"), "utf8"));
    const primitives = await readFile(join(import.meta.dir, "../packages/cli/src/dashboard-ui/primitives.tsx"), "utf8");

    expect(components).toMatchObject({
      style: "new-york",
      rsc: false,
      tsx: true,
      tailwind: {
        baseColor: "neutral",
        cssVariables: true,
      },
    });
    expect(primitives).toContain("export function Button");
    expect(primitives).toContain("export function Tabs");
    expect(primitives).toContain("export function Panel");
    expect(primitives).toContain("export function Separator");
    expect(primitives).toContain("export function ScrollArea");
    expect(primitives).not.toContain("useState");
    expect(primitives).not.toContain("useEffect");
    expect(primitives).not.toContain("window.");
    await expect(stat(join(import.meta.dir, "../packages/cli/src/dashboard-ui"))).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });

  test("defines a TanStack-ready dashboard route manifest without adding TanStack dependencies", async () => {
    const packageJson = JSON.parse(await readFile(join(import.meta.dir, "../package.json"), "utf8"));
    const cliPackageJson = JSON.parse(await readFile(join(import.meta.dir, "../packages/cli/package.json"), "utf8"));
    const dependencyNames = [
      ...Object.keys(packageJson.dependencies ?? {}),
      ...Object.keys(packageJson.devDependencies ?? {}),
      ...Object.keys(cliPackageJson.dependencies ?? {}),
      ...Object.keys(cliPackageJson.devDependencies ?? {}),
    ];

    expect(dependencyNames.filter((name) => name.startsWith("@tanstack/"))).toEqual([]);
    expect(DASHBOARD_ROUTE_NEXT_MILESTONE).toContain("Vite dashboard app boundary");
    expect(DASHBOARD_ROUTE_NEXT_MILESTONE).toContain("generated routeTree");
    expect(DASHBOARD_ROUTE_NEXT_MILESTONE).toContain("TanStack Router");
    expect(DASHBOARD_ROUTES.map((route) => route.name)).toEqual([
      "dashboard.document",
      "dashboard.asset.canvasScript",
      "dashboard.asset.canvasCss",
      "dashboard.asset.dashboardCss",
      "dashboard.api.recentRuns",
      "dashboard.api.runOverview",
      "dashboard.api.changedFiles",
      "dashboard.api.diff",
      "dashboard.api.guardrailAccept",
      "dashboard.api.runnerStart",
      "dashboard.api.runnerStop",
      "dashboard.api.supervisorStart",
      "dashboard.api.supervisorStop",
      "dashboard.api.intake",
      "dashboard.api.goalCreate",
      "dashboard.api.goalInterrupt",
      "dashboard.api.taskResume",
      "dashboard.api.taskRerun",
      "dashboard.api.attemptStop",
      "dashboard.taskPrompt",
    ]);
    expect(dashboardRoutePaths()).toEqual([
      "/",
      "/assets/dashboard-canvas.js",
      "/assets/dashboard-canvas.css",
      "/assets/dashboard.css",
      "/api/runs",
      "/api/runs/:runId/overview",
      "/api/runs/:runId/changed-files",
      "/api/runs/:runId/diff",
      "/api/runs/:runId/guardrails/:proposalId/accept",
      "/api/runs/:runId/runner/start",
      "/api/runs/:runId/runner/stop",
      "/api/supervisor/start",
      "/api/supervisor/stop",
      "/api/runs/:runId/intake",
      "/api/runs/:runId/goals",
      "/api/runs/:runId/interrupt",
      "/api/tasks/:taskId/resume",
      "/api/tasks/:taskId/rerun",
      "/api/attempts/:attemptId/stop",
      "/tasks/:taskId/prompt",
    ]);
  });

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

  test("serves the dashboard shell through the React server-rendered boundary", async () => {
    const dashboardSource = await readFile(join(import.meta.dir, "../packages/cli/src/dashboard.ts"), "utf8");
    const html = dashboardHtml({ runId: "run_123" });

    expect(dashboardSource).toContain('import { renderDashboardShell } from "./dashboard-shell"');
    expect(dashboardSource).toContain("${renderDashboardShell(input)}");
    expect(dashboardSource).not.toContain('<div class="app-shell">');
    expect(html).toContain('data-react-dashboard-shell="true"');
    expect(html).toContain('class="app-shell"');
    expect(html).toContain('/assets/dashboard.css');
    expect(html).toContain('id="active-run-list"');
    expect(html).toContain('data-history-source="GET /api/runs"');
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
    expect(html).toContain("ui-button");
    expect(html).toContain("ui-panel");
    expect(html).toContain("ui-scroll-area");
    expect(html).toContain("ui-tabs");
    expect(html).toContain("ui-separator");
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
    expect(html).toContain("data-resume-task-id");
    expect(html).toContain("Resume selected task");
    expect(html).toContain("data-rerun-task-id");
    expect(html).toContain("Rerun selected task");
    expect(html).toContain("Task actions");
    expect(html).toContain("These controls affect only the selected task.");
    expect(html).toContain("data-start-runner");
    expect(html).toContain("data-stop-runner");
    expect(html).toContain("data-start-supervisor");
    expect(html).toContain("data-stop-supervisor");
    expect(html).toContain("Runner actions");
    expect(html).toContain("These controls affect the run-level runner or supervisor process.");
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
    expect(html).toContain("dashboardWorkspaceHtml");
    expect(html).toContain("dashboardInspectorHtml");
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
    const styles = dashboardCss();

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
    expect(styles).toContain(".diff-row.added");
    expect(styles).toContain(".diff-row.removed");
    expect(styles).toContain(".diff-row.hunk");
    expect(styles).toContain(".diff-row.context");
    expect(html).toContain("renderDiffRows");
    expect(html).toContain("diffLineType");
    expect(html).toContain('aria-current="true"');
    expect(html).toContain('/api/runs/" + encodeURIComponent(runId) + "/diff?path=" + encodeURIComponent(path)');
    expect(html).toContain("fetchDiffForChangedFile");
  });

  test("renders active guardrails and a harness-routed Accept control for pending guardrail proposals", () => {
    const html = dashboardHtml({ runId: "run_123" });
    const styles = dashboardCss();

    expect(html).toContain("renderGuardrailsSection");
    expect(html).toContain("guardrailRecords");
    expect(html).toContain("overview.run?.context?.guardrails");
    expect(html).toContain("overview.run?.context?.guardrailProposals");
    expect(html).toContain("Active Guardrails");
    expect(html).toContain("Pending Guardrail Proposals");
    expect(html).toContain('data-inspector-section="guardrails"');
    expect(html).toContain('data-guardrail-state="active"');
    expect(html).toContain('data-guardrail-state="proposed"');
    expect(html).toContain("guardrailSource");
    expect(html).toContain("guardrailRoles");
    expect(html).toContain("guardrailCount");
    expect(html).toContain("compact(record.summary, 220)");
    expect(styles).toContain(".guardrail-summary");
    expect(styles).toContain(".guardrail-id");
    expect(styles).toContain(".guardrail-meta");
    expect(html).toContain('data-accept-guardrail="');
    expect(html).toContain('data-accept-guardrail-run="');
    expect(html).toContain("escapeHtml(proposalId)");
    expect(html).toContain("escapeHtml(runId)");
    expect(html).toContain('"/api/runs/" + encodeURIComponent(proposalRunId) + "/guardrails/" + encodeURIComponent(proposalId) + "/accept"');
    expect(html).toContain("acceptGuardrailProposal");
    expect(html).toContain("delegates to the harness-owned acceptGuardrailProposal action");
  });

  test("renders Canvas and Flow workspace modes for the selected task graph", () => {
    const html = dashboardHtml({ runId: "run_123" });

    expect(html).toContain('data-workspace-mode="canvas"');
    expect(html).toContain('data-workspace-mode="flow"');
    expect(html).toContain('id="dashboard-canvas-root"');
    expect(html).toContain('class="canvas-shell"');
    expect(html).toContain("canvas-fallback");
    expect(html).toContain("data-canvas-task-count");
    expect(html).toContain("data-canvas-edge-count");
    expect(html).toContain("/assets/dashboard.css");
    expect(html).toContain("/assets/dashboard-canvas.js");
    expect(html).toContain("/assets/dashboard-canvas.css");
    expect(html).toContain("mountReactFlowCanvas");
    expect(html).toContain("workspaceMode");
    expect(html).toContain("renderCanvasWorkspace");
    expect(html).toContain("renderFlowWorkspace");
    expect(html).toContain("data-canvas-task-id");
    expect(html).toContain("data-canvas-task-session-count");
    expect(html).toContain("data-canvas-task-evidence-count");
    expect(html).toContain("data-canvas-task-todo-count");
    expect(html).toContain("data-canvas-task-diff-count");
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

    expect(html).toContain('let dashboardStorageKey = "ouroboros:dashboard:" + runId;');
    expect(html).toContain("readDashboardState");
    expect(html).toContain("writeDashboardState");
    expect(html).toContain("const restoredDashboardState = readDashboardState();");
    expect(html).toContain("let selectedGoalId = restoredDashboardState.selectedGoalId || null;");
    expect(html).toContain('let workspaceMode = restoredDashboardState.workspaceMode || "flow";');
    expect(html).toContain("let workspaceTitleExpanded = restoredDashboardState.workspaceTitleExpanded === true;");
    expect(html).toContain("workspaceTitleExpanded: parsed.workspaceTitleExpanded === true");
    expect(html).toContain("workspaceTitleExpanded: state.workspaceTitleExpanded === true");
    expect(html).toContain("persistDashboardState");
    expect(html).toContain("selectedGoalId = payload.runId || payload.taskId || selectedGoalId;");
    expect(html).toContain("workspaceTitleExpanded = false;");
    expect(html).not.toContain('localStorage.setItem("selectedGoalId"');
    expect(html).not.toContain('localStorage.getItem("selectedGoalId"');
  });

  test("persists changed-file selection and flow scroll in run-scoped browser storage", () => {
    const html = dashboardHtml({ runId: "run_123" });

    expect(html).toContain("selectedChangedFilePath: typeof parsed.selectedChangedFilePath === \"string\" ? parsed.selectedChangedFilePath : null");
    expect(html).toContain("flowScroll: parsed.flowScroll && typeof parsed.flowScroll === \"object\" ? parsed.flowScroll : null");
    expect(html).toContain("let selectedChangedFilePath = restoredDashboardState.selectedChangedFilePath || null;");
    expect(html).toContain("let restoredFlowScrollState = restoredDashboardState.flowScroll || null;");
    expect(html).toContain("selectedChangedFilePath: typeof state.selectedChangedFilePath === \"string\" ? state.selectedChangedFilePath : null");
    expect(html).toContain("flowScroll: state.flowScroll && typeof state.flowScroll === \"object\" ? state.flowScroll : null");
    expect(html).toContain("persistDashboardState();");
    expect(html).toContain("persistFlowScrollState");
    expect(html).toContain("restoredFlowScrollState = null;");
    expect(html).toContain("writeDashboardState({ selectedGoalId, workspaceMode, workspaceTitleExpanded, selectedChangedFilePath, flowScroll: captureFlowScrollState() });");
    expect(html).not.toContain("ouroboros:dashboard:changedFile:");
  });

  test("renders active run and database-backed history with semantic labels", () => {
    const html = dashboardHtml({ runId: "run_123" });

    expect(html).toContain("Active run");
    expect(html).toContain("Run history");
    expect(html).toContain("renderRecentRunsList(recentRunsCache);");
    expect(html).toContain('data-history-source="GET /api/runs"');
    expect(html).toContain('data-active-run-id=\\"');
    expect(html).toContain('data-history-run-selected="true"');
    expect(html).toContain("const activeRun = runs.find((entry) => entry?.id === runId);");
    expect(html).toContain("const historyRuns = runs.filter((entry) => entry?.id !== runId);");
    expect(html).toContain("renderRunHistorySection(\"active-run-list\", activeRun ? [activeRun] : [], \"Active run\")");
    expect(html).toContain("renderRunHistorySection(\"recent-runs-list\", historyRuns, \"Run history\")");
    expect(html).toContain("const runHistoryRowTemplate = document.createElement(\"template\")");
    expect(html).toContain("runHistoryRowTemplate.content.cloneNode(true)");
    expect(html).toContain("runs.map(renderReactRunHistoryRow).join(\"\")");
    expect(html).not.toContain("reactRunHistoryRow");
  });

  test("renders run history rows through the React dashboard boundary", () => {
    const rows = dashboardRunHistoryRowsHtmlForTest([
      { id: "run_123", status: "running", goal: "Current run", projectId: null, createdAt: null },
      { id: "run_done", status: "done", goal: "Earlier run", projectId: null, createdAt: null },
    ], "run_123");

    expect(rows).toContain('data-react-run-history="true"');
    expect(rows).toContain('data-history-run-id="run_123"');
    expect(rows).toContain('data-history-run-selected="true"');
    expect(rows).toContain('class="history-run-row is-active"');
    expect(rows).toContain('class="history-run-status status-running"');
    expect(rows).toContain("Earlier run");
  });

  test("uses a restrained neutral dashboard palette without saturated status colors or gradients", () => {
    const html = dashboardHtml({ runId: "run_123" });
    const styles = dashboardCss();

    expect(html).toContain('<link rel="stylesheet" href="/assets/dashboard.css">');
    expect(html).not.toContain("<style>");
    expect(styles).toContain('@import "tailwindcss";');
    expect(styles).toContain("@theme");
    expect(styles).toContain("@layer base");
    expect(styles).toContain("@layer components");
    expect(styles).toContain("--app: #fafafa;");
    expect(styles).toContain("--sidebar: #ffffff;");
    expect(styles).toContain("--ink: #09090b;");
    expect(styles).toContain("--muted: #71717a;");
    expect(styles).toContain("--status-ink: #18181b;");
    expect(styles).not.toContain("linear-gradient");
    expect(styles).not.toContain("#b8d4c2");
    expect(styles).not.toContain("#d4c7a8");
    expect(styles).not.toContain("#d2aaa8");
    expect(styles).not.toContain("rgba(111, 160, 122");
    expect(styles).not.toContain("rgba(184, 113, 111");
    expect(styles).not.toContain("#d8d7d0");
    expect(styles).not.toContain("#b9b8b1");
    expect(styles).not.toContain("#ecebe5");
    expect(styles).not.toContain("#d3d2cc");
    expect(styles).not.toContain("#efefea");
    expect(styles).not.toContain("#c9c9c4");
    expect(styles).not.toContain("#d9d8d1");
    expect(styles).not.toContain("#deddd7");
    expect(styles).not.toContain("#d6d5cf");
    expect(styles).not.toContain("#d9d9d4");
  });

  test("keeps sidebar goal row titles shrink-safe and truncated", () => {
    const html = dashboardHtml({ runId: "run_123" });
    const styles = dashboardCss();

    expect(styles).toContain("grid-template-columns: 12px minmax(0, 1fr) minmax(0, 72px);");
    expect(styles).toContain(".task-row-text");
    expect(styles).toContain("min-width: 0;");
    expect(styles).toContain("overflow: hidden;");
    expect(html).toContain('<span class="task-row-text"><strong>');
    expect(styles).toContain(".task-row strong");
    expect(styles).toContain(".task-row .row-meta");
    expect(styles).toContain("text-overflow: ellipsis;");
    expect(styles).toContain("white-space: nowrap;");
  });

  test("truncates workspace title by default and exposes an accessible expander", () => {
    const html = dashboardHtml({ runId: "run_123" });

    expect(html).toContain('class="workspace-title is-collapsed" id="workspace-title"');
    expect(html).toContain('id="workspace-title-toggle"');
    expect(html).toContain('data-workspace-title-toggle');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="workspace-title"');
    expect(html).toContain('aria-label="Expand workspace title"');
    expect(dashboardCss()).toContain("-webkit-line-clamp: 2;");
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
    expect(html).toContain("persistDashboardState();");
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
    const styles = dashboardCss();

    expectCssRule(styles, "body", ["overflow: hidden;"]);
    expectCssRule(styles, ".app-shell", ["height: 100dvh;", "display: grid;", "grid-template-columns: 300px minmax(0, 1fr) clamp(380px, 30vw, 520px);", "overflow-x: hidden;"]);
    expectCssRule(styles, ".task-sidebar", ["height: 100dvh;", "min-width: 0;", "min-height: 0;", "overflow: hidden;"]);
    expectCssRule(styles, ".project-header", ["min-width: 0;", "overflow: hidden;"]);
    expectCssRule(styles, ".project-name", ["overflow: hidden;", "text-overflow: ellipsis;", "white-space: nowrap;"]);
    expectCssRule(styles, ".project-root", ["overflow: hidden;", "text-overflow: ellipsis;", "white-space: nowrap;"]);
    expectCssRule(styles, ".task-nav", ["width: 100%;", "min-width: 0;", "max-width: 100%;", "min-height: 0;", "overflow-x: hidden;", "overflow-y: auto;", "scrollbar-gutter: stable;"]);
    expectCssRule(styles, ".nav-section", ["width: 100%;", "min-width: 0;", "max-width: 100%;", "overflow-x: hidden;"]);
    expectCssRule(styles, ".task-list", ["width: 100%;", "min-width: 0;", "max-width: 100%;", "overflow-x: hidden;"]);
    expectCssRule(styles, ".workspace", ["min-width: 0;", "overflow: hidden;"]);
    expectCssRule(styles, ".workspace-title-block", ["min-width: 0;"]);
    expectCssRule(styles, ".workspace-title-row", ["grid-template-columns: minmax(0, 1fr) auto;"]);
    expectCssRule(styles, ".workspace-title", ["min-width: 0;", "overflow-wrap: anywhere;"]);
    expectCssRule(styles, ".workspace-title.is-collapsed", ["-webkit-line-clamp: 2;", "overflow: hidden;"]);
    expectCssRule(styles, ".task-row", ["min-width: 0;", "grid-template-columns: 12px minmax(0, 1fr) minmax(0, 72px);", "overflow: hidden;"]);
    expectCssRule(styles, ".task-row-text", ["min-width: 0;", "overflow: hidden;"]);
    expectCssRule(styles, ".task-row strong", ["text-overflow: ellipsis;", "white-space: nowrap;"]);
    expectCssRule(styles, ".task-row .row-meta", ["text-overflow: ellipsis;", "white-space: nowrap;"]);
    expectCssRule(styles, ".status-text", ["width: 100%;", "max-width: 100%;", "overflow: hidden;", "text-overflow: ellipsis;", "white-space: nowrap;"]);
    expectCssRule(styles, ".plain-button", ["min-width: 0;", "overflow: hidden;", "text-overflow: ellipsis;", "white-space: nowrap;"]);
    expectCssRule(styles, ".workspace-flow", ["min-height: 0;", "overflow: auto;"]);
    expectCssRule(styles, ".flow-inner", ["min-width: 0;"]);
    expectCssRule(styles, ".turn", ["grid-template-columns: 34px minmax(0, 1fr);"]);
    expectCssRule(styles, ".turn-body", ["min-width: 0;"]);
    expectCssRule(styles, ".turn-author", ["overflow-wrap: anywhere;"]);
    expectCssRule(styles, ".turn-summary", ["overflow-wrap: anywhere;"]);
    expectCssRule(styles, ".turn-text", ["white-space: pre-wrap;", "overflow-wrap: anywhere;"]);
    expectCssRule(styles, ".conversation-evidence", ["display: grid;", "gap: 12px;"]);
    expectCssRule(styles, ".evidence-item", ["font-size: 12px;", "overflow-wrap: anywhere;"]);
    expectCssRule(styles, ".raw-stream", ["font-size: 11px;"]);
    expectCssRule(styles, ".stream-output", ["overflow: auto;", "white-space: pre-wrap;", "overflow-wrap: anywhere;"]);
    expectCssRule(styles, ".inspector-panel", ["width: clamp(380px, 30vw, 520px);", "min-width: 380px;", "max-width: 520px;", "overflow-y: auto;", "overflow-x: hidden;", "scrollbar-gutter: stable;"]);
    expectCssRule(styles, ".inspector-card", ["min-width: 0;", "border-radius: 0;", "background: transparent;"]);
    expectCssRule(styles, ".current-task-title", ["overflow-wrap: anywhere;"]);
    expectCssRule(styles, ".current-task-meta", ["overflow-wrap: anywhere;"]);
    expectCssRule(styles, ".todo-list, .lesson-list, .info-list", ["gap: 9px;"]);
    expectCssRule(styles, ".todo-item", ["grid-template-columns: 18px minmax(0, 1fr);", "gap: 9px;", "font-size: 13px;", "line-height: 1.42;"]);
    expectCssRule(styles, ".todo-text", ["min-width: 0;", "overflow-wrap: anywhere;"]);
    expectCssRule(styles, ".meta", ["overflow-wrap: anywhere;"]);
    expectCssRule(styles, ".changed-files-section", ["min-width: 0;"]);
    expectCssRule(styles, ".changed-file-tree", ["min-width: 0;", "overflow-x: hidden;"]);
    expectCssRule(styles, ".changed-file-node", ["min-width: 0;", "grid-template-columns: 28px minmax(0, 1fr);"]);
    expectCssRule(styles, ".changed-file-name", ["min-width: 0;", "overflow: hidden;", "text-overflow: ellipsis;", "white-space: nowrap;"]);
    expectCssRule(styles, ".changed-file-type", ["color: var(--muted-2);", "font-family: var(--mono);"]);
    expectCssRule(styles, ".diff-panel", ["min-width: 0;", "max-width: 100%;", "overflow: hidden;"]);
    expectCssRule(styles, ".diff-header", ["position: sticky;", "top: 0;", "overflow: hidden;"]);
    expectCssRule(styles, ".diff-path", ["overflow-wrap: anywhere;"]);
    expectCssRule(styles, ".diff-output", ["overflow-x: auto;", "overflow-y: auto;", "white-space: pre;", "overflow-wrap: normal;"]);
    expectCssRule(styles, ".diff-row", ["display: grid;", "grid-template-columns: 42px max-content;", "min-width: max-content;"]);
    expectCssRule(styles, ".diff-line", ["white-space: pre;", "font-family: var(--mono);"]);
    expectCssRule(styles, ".diff-row.added", ["background: #f4f4f5;"]);
    expectCssRule(styles, ".diff-row.removed", ["background: #f4f4f5;"]);
    expectCssRule(styles, ".diff-row.hunk", ["background: #f4f4f5;"]);
    expectCssRule(styles, ".diff-row.context", ["background: transparent;"]);
    expect(styles).toContain("grid-template-columns: minmax(0, 1fr);");
    expect(styles).toContain(".inspector-panel { width: auto; min-width: 0; max-width: none; }");
    expect(styles).toContain(".task-sidebar { min-width: 0; overflow-x: hidden; overflow-y: visible; }");
  });

  test("defines reusable static overflow contracts for canvas node surfaces", () => {
    const styles = dashboardCss();

    expectCssRule(styles, ".workspace-flow.canvas-workspace", ["overflow: hidden;"]);
    expectCssRule(styles, ".canvas-inner", ["overflow: hidden;"]);
    expectCssRule(styles, ".canvas-inner", ["display: grid;", "background: var(--canvas);"]);
    expectCssRule(styles, "#dashboard-canvas-root", ["width: 100%;", "height: 100%;", "min-height: 0;", "overflow: hidden;"]);
    expectCssRule(styles, ".canvas-shell", ["width: 100%;", "height: 100%;", "overflow: hidden;"]);
    expectCssRule(styles, ".canvas-fallback", ["height: 100%;", "display: grid;", "background: var(--canvas);"]);
    expectCssRule(styles, ".canvas-fallback-list", ["grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));"]);
    expectCssRule(styles, ".of-node", ["width: 250px;"]);
    expectCssRule(styles, ".of-node-head", ["min-width: 0;"]);
    expectCssRule(styles, ".of-node-head span", ["min-width: 0;", "overflow: hidden;", "text-overflow: ellipsis;", "white-space: nowrap;"]);
    expectCssRule(styles, ".of-node-goal", ["overflow-wrap: anywhere;"]);
    expectCssRule(styles, ".of-node-meta", ["overflow-wrap: anywhere;"]);
    expect(styles).not.toContain("#f6f6f3");
    expect(styles).not.toContain("linear-gradient");
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
    expect(html).not.toContain("const setHtmlIfChanged =");
    expect(html).not.toContain("setHtmlIfChanged(");
  });

  test("renders harness-managed subsession threads inside the inspector panel", () => {
    const html = dashboardHtml({ runId: "run_123" });
    const styles = dashboardCss();

    expect(html).toContain("renderSubsessionThreadsSection");
    expect(html).toContain('data-inspector-section="subsessions"');
    expect(html).toContain("subsessionSummaryByThread");
    expect(html).toContain('thread.ownerType === "subsession"');
    expect(styles).toContain(".subsession-list");
    expect(styles).toContain(".subsession-row");
    expect(styles).toContain(".subsession-summary");
    expect(html).toContain("Child sessions come from the run overview payload.");
    expect(html).toContain("formatHeartbeat");
    expect(html).toContain('data-subsession-thread=');
    expect(html).toContain('data-subsession-status=');
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

  test("renders structured codex-json event payloads as readable session stream lines", () => {
    const html = dashboardHtml({ runId: "run_123" });
    const styles = dashboardCss();

    expect(html).toContain("codexEventParts");
    expect(html).toContain("summarizeToolArguments");
    expect(html).toContain("rawEventDump");
    expect(html).toContain("Raw JSON payloads");
    expect(styles).toContain(".stream-line.event-message .stream-line-label");
    expect(styles).toContain(".stream-line.event-tool .stream-line-label");
    expect(styles).toContain(".stream-line.event-session .stream-line-label");
    expect(html).toContain('"stream-line event-\' + escapeHtml(line.category)');
    expect(html).toContain('<span class="stream-line-label">');
    expect(html).toContain('<span class="stream-line-text">');
  });

  test("formats structured codex-json payloads as categorized readable lines", () => {
    const sessionCreated = dashboardCodexEventPartsForTest({ type: "session.created" });
    expect(sessionCreated).toEqual({ category: "session", label: "session", text: "created" });

    const assistantMessage = dashboardCodexEventPartsForTest({
      type: "item.created",
      item: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Adding the new dashboard test." }],
      },
    });
    expect(assistantMessage).toEqual({
      category: "message",
      label: "assistant",
      text: "Adding the new dashboard test.",
    });

    const toolCall = dashboardCodexEventPartsForTest({
      type: "item.created",
      item: {
        type: "function_call",
        name: "shell",
        arguments: JSON.stringify({ command: ["bun", "test", "tests/dashboard.test.ts"] }),
      },
    });
    expect(toolCall?.category).toBe("tool");
    expect(toolCall?.label).toBe("shell");
    expect(toolCall?.text).toContain("bun");
    expect(toolCall?.text).toContain("tests/dashboard.test.ts");

    const toolOutput = dashboardCodexEventPartsForTest({
      type: "item.created",
      item: { type: "function_call_output", output: "1 test passed." },
    });
    expect(toolOutput?.category).toBe("tool-output");
    expect(toolOutput?.text).toBe("1 test passed.");

    const reasoning = dashboardCodexEventPartsForTest({
      type: "item.created",
      item: { type: "reasoning", summary: [{ type: "summary_text", text: "Planning the next step." }] },
    });
    expect(reasoning?.category).toBe("thinking");
    expect(reasoning?.text).toBe("Planning the next step.");

    const error = dashboardCodexEventPartsForTest({ error: "API Error: 529 Overloaded" });
    expect(error?.category).toBe("error");

    const unknown = dashboardCodexEventPartsForTest({ unrelated: "field" });
    expect(unknown).toBeNull();
  });

  test("falls back to plain text for non-codex stdout streams", () => {
    const stdout = dashboardEventLineForTest({ stream: "stdout", text: "[client] initialize (running)" });
    expect(stdout?.category).toBe("other");
    expect(stdout?.label).toBe("log");
    expect(stdout?.text).toBe("[client] initialize (running)");

    const stderr = dashboardEventLineForTest({ stream: "stderr", text: "child process exited" });
    expect(stderr?.category).toBe("error");
    expect(stderr?.label).toBe("stderr");
    expect(stderr?.text).toBe("child process exited");

    const plainDelta = dashboardEventLineForTest({ stream: "codex-json", payload: { delta: "Composing response." } });
    expect(plainDelta?.category).toBe("message");
    expect(plainDelta?.text).toBe("Composing response.");

    const empty = dashboardEventLineForTest({ stream: "codex-json", payload: { unrelated: "field" } });
    expect(empty).toBeNull();
  });

  test("serves dashboard CSS and bundled React Flow canvas assets", async () => {
    const dashboardInput = {
      runId: "run_123",
      overview: () => ({ run: null, project: null, tasks: [], sessions: [], threads: [], lessons: [] }),
      renderTaskPrompt: () => "",
    };

    const dashboardCssResponse = await handleDashboardRequest(
      new Request("http://localhost/assets/dashboard.css"),
      dashboardInput,
    );
    const dashboardCssBody = await dashboardCssResponse.text();
    expect(dashboardCssResponse.status).toBe(200);
    expect(dashboardCssResponse.headers.get("content-type")).toContain("text/css");
    expect(dashboardCssBody).toContain("--app: #fafafa");
    expect(dashboardCssBody).toContain(".app-shell");
    expect(dashboardCssBody).not.toContain("linear-gradient");

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

  test("serves the Tailwind dashboard CSS boundary as a neutral asset", async () => {
    const dashboardInput = {
      runId: "run_123",
      overview: () => ({ run: null, project: null, tasks: [], sessions: [], threads: [], lessons: [] }),
      renderTaskPrompt: () => "",
    };

    const response = await handleDashboardRequest(
      new Request("http://localhost/assets/dashboard.css"),
      dashboardInput,
    );
    const css = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/css");
    expect(css).toContain('@import "tailwindcss"');
    expect(css).toContain("--color-dashboard-ink: #09090b;");
    expect(css).toContain(".ui-button");
    expect(css).not.toContain("linear-gradient");
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
        checks: [{ name: "graph test", status: "passed" }],
        artifacts: [{ kind: "diff", path: "packages/cli/src/dashboard.ts" }],
        problems: ["No open graph issues"],
        changedFiles: ["packages/cli/src/dashboard.ts", "packages/cli/src/dashboard.css"],
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
      expect(graph.nodes.find((node) => node.id === workerId)?.data.sessionCount).toBe(1);
      expect(graph.nodes.find((node) => node.id === workerId)?.data.evidenceCount).toBe(5);
      expect(graph.nodes.find((node) => node.id === workerId)?.data.todoCount).toBe(2);
      expect(graph.nodes.find((node) => node.id === workerId)?.data.changedFileCount).toBe(2);
      expect(graph.nodes.find((node) => node.id === workerId)?.data.diffCount).toBe(2);
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

  test("builds a chronological agent workspace timeline across sessions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ouroboros-dashboard-workspace-timeline-"));
    const harness = new Harness(join(dir, "ouroboros.db"));
    harness.init();
    const runId = harness.createRun({ goal: "Review cross-session chronological turns" });
    const olderTaskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Emit older event",
      prompt: "Emit older session event.",
    });
    const newerTaskId = harness.createTask({
      runId,
      role: "verifier",
      goal: "Emit newer event",
      prompt: "Emit newer session event.",
    });
    const olderAttemptId = harness.startAttempt({ taskId: olderTaskId, input: { sessionName: "older-session" } });
    const newerAttemptId = harness.startAttempt({ taskId: newerTaskId, input: { sessionName: "newer-session" } });
    harness.recordAttemptEvent({ attemptId: newerAttemptId, stream: "stdout", sequence: 1, text: "newer message" });
    harness.recordAttemptEvent({ attemptId: olderAttemptId, stream: "stdout", sequence: 2, text: "older message" });

    try {
      const overview = harness.getRunOverview({ runId });
      const olderSession = overview.sessions.find((session) => session.taskId === olderTaskId);
      const newerSession = overview.sessions.find((session) => session.taskId === newerTaskId);
      if (!olderSession?.events[0] || !newerSession?.events[0]) {
        throw new Error("expected both timeline fixture sessions to have one event");
      }
      olderSession.events[0].createdAt = "2026-01-01T00:00:01.000Z";
      newerSession.events[0].createdAt = "2026-01-01T00:00:02.000Z";

      const workspace = buildDashboardWorkspaceModel(overview, { selectedRunId: runId });

      expect(workspace.timeline.newestAtBottom).toBe(true);
      expect(workspace.timeline.turns.map((turn) => turn.text)).toEqual(["older message", "newer message"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("builds an agentic canvas workspace model with task session evidence todo and diff metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ouroboros-dashboard-workspace-canvas-"));
    const harness = new Harness(join(dir, "ouroboros.db"));
    harness.init();
    const projectId = harness.createProject({ name: "Canvas Project", rootPath: dir });
    const runId = harness.createRun({ goal: "Build agent canvas", projectId });
    const workerId = harness.createTask({
      runId,
      role: "worker",
      goal: "Implement canvas workspace model",
      prompt: "Build the typed model.",
      doneWhen: ["model covers task", "model covers todo"],
    });
    const verifierId = harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify canvas workspace model",
      prompt: "Verify the typed model.",
      dependsOn: [workerId],
      parentId: workerId,
    });
    const workerAttemptId = harness.recordAttempt({
      taskId: workerId,
      input: { sessionName: "worker-session", codexSessionId: "codex_worker" },
      output: {
        status: "done",
        summary: "Worker changed dashboard workspace model",
        changedFiles: ["packages/cli/src/dashboard-workspace-model.ts"],
        checks: [{ name: "workspace model test", status: "passed" }],
        artifacts: [{ kind: "diff", path: "packages/cli/src/dashboard-workspace-model.ts", additions: 12 }],
      },
    });

    try {
      const overview = harness.getRunOverview({ runId });
      overview.lessons.push({
        id: "lesson_workspace_model",
        runId,
        taskId: workerId,
        attemptId: workerAttemptId,
        kind: "experience",
        summary: "Workspace model evidence should stay attached to the node.",
        evidence: {},
      });
      const workspace = buildDashboardWorkspaceModel(overview, { selectedGroupId: workerId, selectedRunId: runId });
      const workerNode = workspace.canvas.nodes.find((node) => node.id === workerId);

      expect(workspace.project).toMatchObject({ id: projectId, name: "Canvas Project", rootPath: dir });
      expect(workspace.run).toMatchObject({ id: runId, goal: "Build agent canvas", selected: true });
      expect(workspace.canvas.nodes.map((node) => node.id)).toEqual([workerId, verifierId]);
      expect(workspace.canvas.edges).toContainEqual(
        expect.objectContaining({ source: workerId, target: verifierId, label: "dependsOn" }),
      );
      expect(workerNode?.metadata.sessions).toContainEqual(expect.objectContaining({ name: "worker-session" }));
      expect(workerNode?.metadata.todos).toEqual([
        expect.objectContaining({ text: "model covers task" }),
        expect.objectContaining({ text: "model covers todo" }),
      ]);
      expect(workerNode?.metadata.changedFiles).toEqual([
        expect.objectContaining({ path: "packages/cli/src/dashboard-workspace-model.ts" }),
      ]);
      expect(workerNode?.metadata.diffs).toEqual([
        expect.objectContaining({ path: "packages/cli/src/dashboard-workspace-model.ts" }),
      ]);
      expect(workerNode?.metadata.evidence.map((item) => item.label)).toEqual(
        expect.arrayContaining(["summary", "check", "artifact", "lesson"]),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("renders task doneWhen items in the todo inspector", () => {
    const html = dashboardHtml({ runId: "run_123" });
    const styles = dashboardCss();

    expect(html).toContain("todo-list");
    expect(html).toContain("doneWhen");
    expect(html).toContain("checkbox");
    expect(styles).toContain(".todo-item.done");
    expect(styles).toContain("font-size: 13px;");
    expect(styles).toContain("font-size: 10.5px;");
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

  test("keeps a completed root dashboard overview done when only stale child threads remain", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ouroboros-dashboard-stale-thread-"));
    const harness = new Harness(join(dir, "ouroboros.db"));
    harness.init();
    const rootRunId = harness.createRun({ goal: "Root intake" });
    harness.updateRunStatus({ runId: rootRunId, status: "done" });
    const childRunId = harness.createRun({
      goal: "Completed child goal",
      context: { parentRunId: rootRunId },
    });
    const childTaskId = harness.createTask({
      runId: childRunId,
      role: "worker",
      goal: "Implement child work",
      prompt: "Do the child work.",
    });
    const childAttemptId = harness.recordAttempt({
      taskId: childTaskId,
      input: { executor: "test" },
      output: {
        status: "done",
        summary: "Child work completed.",
        changedFiles: [],
        checks: [{ name: "child work", status: "passed" }],
        artifacts: [],
        problems: [],
      },
    });
    harness.updateRunStatus({ runId: childRunId, status: "done" });
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
      expect(body.run.status).toBe("done");
      expect(body.globalRuns).toEqual({ todo: 0, running: 0, done: 2, blocked: 0 });
      expect(body.threads.map((thread: { id: string }) => thread.id)).toContain(`thread_${childAttemptId}`);
      expect(body.supervisor).toEqual({ status: "idle", pid: null, lastOutput: "" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("ignores retired child runs when aggregating the root dashboard overview", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ouroboros-dashboard-retired-child-"));
    const harness = new Harness(join(dir, "ouroboros.db"));
    harness.init();
    const rootRunId = harness.createRun({ goal: "Root intake" });
    harness.updateRunStatus({ runId: rootRunId, status: "done" });
    const retiredRunId = harness.createRun({
      goal: "Retired child goal",
      context: {
        parentRunId: rootRunId,
        retired: true,
        retiredAt: "2026-06-18T00:00:00.000Z",
        retiredReason: "superseded by integrated run",
      },
    });
    const retiredTaskId = harness.createTask({
      runId: retiredRunId,
      role: "worker",
      goal: "Old blocked worker",
      prompt: "Old work.",
    });
    harness.recordAttempt({
      taskId: retiredTaskId,
      input: { executor: "test" },
      output: {
        status: "blocked",
        summary: "Superseded old work",
        changedFiles: [],
        checks: [{ name: "retired", status: "failed" }],
        artifacts: [],
        problems: ["superseded"],
      },
    });
    harness.updateRunStatus({ runId: retiredRunId, status: "blocked" });

    try {
      const response = await handleDashboardRequest(
        new Request(`http://localhost/api/runs/${rootRunId}/overview`),
        {
          runId: rootRunId,
          overview: () => harness.getRunOverview({ runId: rootRunId }),
          childOverviews: () => [harness.getRunOverview({ runId: retiredRunId })],
          globalRunCounts: () => harness.countRunsByStatus(),
          runnerStatus: () => ({ status: "idle", pid: null }),
          supervisorStatus: () => ({ status: "idle", pid: null, lastOutput: "" }),
          renderTaskPrompt: () => "",
        },
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.run.status).toBe("done");
      expect(body.tasks.some((task: { id: string }) => task.id === retiredTaskId)).toBe(false);
      expect(body.globalRuns).toEqual({ todo: 0, running: 0, done: 1, blocked: 0 });
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

  test("changed files endpoint filters Ouroboros runtime control paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ouroboros-dashboard-runtime-files-"));
    const harness = new Harness(join(dir, "ouroboros.db"));
    harness.init();
    const runId = harness.createRun({ goal: "Filter runtime files" });
    const taskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Report changed files",
      prompt: "Report files.",
    });
    const attemptId = harness.recordAttempt({
      taskId,
      input: {},
      output: {
        status: "done",
        summary: "Reported files",
        changedFiles: [
          "packages/cli/src/dashboard.ts",
          ".ouroboros/worktrees/task_123/state.json",
          ".orbs/runtime.json",
          ".git/orbs/lease.json",
        ],
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
        { path: "packages/cli/src/dashboard.ts", taskId, attemptId, worktreePath: null },
      ]);
      expect(JSON.stringify(body)).not.toContain(".ouroboros");
      expect(JSON.stringify(body)).not.toContain(".orbs");
      expect(JSON.stringify(body)).not.toContain(".git/orbs");
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

  test("renders a recent runs sidebar section that drives history navigation", () => {
    const html = dashboardHtml({ runId: "run_123" });

    expect(html).toContain("Recent runs");
    expect(html).toContain('data-history-runs');
    expect(html).toContain('data-history-runs-list');
    expect(html).toContain('id="recent-runs-list"');
    expect(html).toContain('data-history-run-id');
    expect(html).toContain('ouroboros:dashboard:activeRun');
    expect(html).toContain('/api/runs?limit=" + encodeURIComponent(RECENT_RUNS_LIMIT)');
    expect(html).toContain('setSelectedRun');
    expect(html).toContain('"#run=" + encodeURIComponent(runId)');
    expect(html).toContain('parseRunIdFromHash');
    expect(html).toContain('window.addEventListener("hashchange"');
  });

  test("GET /api/runs returns id status goal projectId and createdAt summaries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ouroboros-dashboard-recent-runs-"));
    const harness = new Harness(join(dir, "ouroboros.db"));
    harness.init();
    const firstRunId = harness.createRun({ goal: "First run goal" });
    harness.updateRunStatus({ runId: firstRunId, status: "done" });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const longGoal = "Second run goal that is longer than the dashboard summary truncation limit of one hundred forty characters so it should be truncated with an ellipsis at the end";
    const secondRunId = harness.createRun({ goal: longGoal });

    try {
      const summaries = harness
        .listRuns({ limit: 10 })
        .slice()
        .sort((left, right) => {
          const leftCreated = left.createdAt ?? "";
          const rightCreated = right.createdAt ?? "";
          if (leftCreated !== rightCreated) return rightCreated.localeCompare(leftCreated);
          return right.id.localeCompare(left.id);
        })
        .map((run) => ({
          id: run.id,
          status: run.status,
          goal: run.goal,
          projectId: run.projectId ?? null,
          createdAt: run.createdAt ?? null,
        }));

      const recentRunsInput = {
        runId: secondRunId,
        overview: () => harness.getRunOverview({ runId: secondRunId }),
        renderTaskPrompt: () => "",
        recentRuns: (limit: number) => summaries.slice(0, limit),
      };

      const response = await handleDashboardRequest(
        new Request("http://localhost/api/runs?limit=2"),
        recentRunsInput,
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(Array.isArray(body.runs)).toBe(true);
      expect(body.runs).toHaveLength(2);
      for (const summary of body.runs) {
        expect(typeof summary.id).toBe("string");
        expect(typeof summary.status).toBe("string");
        expect(typeof summary.goal).toBe("string");
        expect(summary.projectId === null || typeof summary.projectId === "string").toBe(true);
        expect(summary.createdAt === null || typeof summary.createdAt === "string").toBe(true);
        expect(summary.id.startsWith("run_")).toBe(true);
      }
      expect(body.runs[0].id).toBe(secondRunId);
      expect(body.runs[1].id).toBe(firstRunId);
      expect(body.runs[0].status).toBe("todo");
      expect(body.runs[1].status).toBe("done");
      expect(body.runs[0].goal.endsWith("…")).toBe(true);
      expect(body.runs[0].goal.length).toBeLessThanOrEqual(140);
      expect(body.runs[1].goal).toBe("First run goal");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("GET /api/runs rejects unknown query params and defaults to ten rows", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ouroboros-dashboard-recent-runs-params-"));
    const harness = new Harness(join(dir, "ouroboros.db"));
    harness.init();
    const runId = harness.createRun({ goal: "Default limit run" });
    let observedLimit = 0;

    try {
      const unknownResponse = await handleDashboardRequest(
        new Request("http://localhost/api/runs?bogus=1"),
        {
          runId,
          overview: () => harness.getRunOverview({ runId }),
          renderTaskPrompt: () => "",
          recentRuns: (limit: number) => {
            observedLimit = limit;
            return [];
          },
        },
      );
      expect(unknownResponse.status).toBe(400);
      const unknownBody = await unknownResponse.json();
      expect(unknownBody.error).toMatch(/unknown query parameter/);

      const defaultResponse = await handleDashboardRequest(
        new Request("http://localhost/api/runs"),
        {
          runId,
          overview: () => harness.getRunOverview({ runId }),
          renderTaskPrompt: () => "",
          recentRuns: (limit: number) => {
            observedLimit = limit;
            return [
              {
                id: runId,
                status: "todo",
                goal: "Default limit run",
                projectId: null,
                createdAt: null,
              },
            ];
          },
        },
      );
      expect(defaultResponse.status).toBe(200);
      expect(observedLimit).toBe(10);
      const defaultBody = await defaultResponse.json();
      expect(defaultBody.runs).toHaveLength(1);
      expect(defaultBody.runs[0].id).toBe(runId);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("serveDashboard returns JSON diagnostics for API database errors", async () => {
    const server = serveDashboard({
      runId: "run_broken",
      port: 0,
      overview: () => {
        throw new Error("Ouroboros database is missing schema: /tmp/ouroboros.db");
      },
      renderTaskPrompt: () => "",
    });

    try {
      const response = await fetch(`http://localhost:${server.port}/api/runs/run_broken/overview`);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body).toEqual({
        error: "Ouroboros database is missing schema: /tmp/ouroboros.db",
        kind: "db_missing_schema",
      });
    } finally {
      server.stop(true);
    }
  });

  test("shouldRetryDashboardBind only retries bounded ephemeral port conflicts", () => {
    const busy = Object.assign(new Error("Address already in use"), { code: "EADDRINUSE" });

    expect(shouldRetryDashboardBind({ port: 0, error: busy, attempt: 1 })).toBe(true);
    expect(shouldRetryDashboardBind({ port: 7331, error: busy, attempt: 1 })).toBe(false);
    expect(shouldRetryDashboardBind({ port: 0, error: new Error("Permission denied"), attempt: 1 })).toBe(false);
    expect(shouldRetryDashboardBind({ port: 0, error: "not an error", attempt: 1 })).toBe(false);
    expect(shouldRetryDashboardBind({ port: 0, error: busy, attempt: Number.POSITIVE_INFINITY })).toBe(false);
    expect(shouldRetryDashboardBind({ port: 0, error: busy, attempt: 5 })).toBe(true);
    expect(shouldRetryDashboardBind({ port: 0, error: busy, attempt: 10 })).toBe(false);
  });

  test("serveDashboard retries ephemeral port allocation on transient EADDRINUSE", () => {
    const observedPorts: number[] = [];
    const originalServe = Bun.serve;
    let callCount = 0;
    const stubServer = {
      stop: () => undefined,
      port: 0,
      hostname: "localhost",
      ref: () => stubServer,
      unref: () => stubServer,
      reload: () => stubServer,
      fetch: () => new Response("ok"),
      pendingRequests: 0,
      upgrade: () => false,
      publish: () => false,
      subscribe: () => undefined,
      unsubscribe: () => undefined,
    } as unknown as ReturnType<typeof Bun.serve>;
    try {
      (Bun as unknown as { serve: typeof Bun.serve }).serve = ((options: Parameters<typeof Bun.serve>[0]) => {
        callCount += 1;
        if (typeof options.port === "number") {
          observedPorts.push(options.port);
        }
        if (callCount <= 2) {
          throw Object.assign(new Error("listen EADDRINUSE: bind"), { code: "EADDRINUSE" });
        }
        return stubServer;
      }) as typeof Bun.serve;

      const server = serveDashboard({
        runId: "run_retry",
        port: 0,
        overview: () => ({
          run: {
            id: "run_retry",
            projectId: null,
            projectRoot: null,
            goal: "Retry goal",
            status: "running" as const,
            context: {},
            createdAt: null,
          },
          project: null,
          tasks: [],
          sessions: [],
          threads: [],
          lessons: [],
        }),
        renderTaskPrompt: () => "",
      });

      try {
        expect(server).toBe(stubServer);
        expect(callCount).toBe(3);
        expect(observedPorts).toHaveLength(3);
        expect(new Set(observedPorts).size).toBe(3);
        expect(observedPorts.every((port) => port > 0)).toBe(true);
      } finally {
        server.stop(true);
      }
    } finally {
      (Bun as unknown as { serve: typeof Bun.serve }).serve = originalServe;
    }
  });

  test("serveDashboard does not retry fixed port conflicts", () => {
    const originalServe = Bun.serve;
    let callCount = 0;
    const busy = Object.assign(new Error("listen EADDRINUSE: bind"), { code: "EADDRINUSE" });
    try {
      (Bun as unknown as { serve: typeof Bun.serve }).serve = (() => {
        callCount += 1;
        throw busy;
      }) as typeof Bun.serve;

      expect(() =>
        serveDashboard({
          runId: "run_fixed",
          port: 7331,
          overview: () => ({
            run: null,
            project: null,
            tasks: [],
            sessions: [],
            threads: [],
            lessons: [],
          }),
          renderTaskPrompt: () => "",
        }),
      ).toThrow(busy);
      expect(callCount).toBe(1);
    } finally {
      (Bun as unknown as { serve: typeof Bun.serve }).serve = originalServe;
    }
  });

  test("serves overview, changed-files, and diff for a non-primary run via runOverview", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ouroboros-dashboard-multi-run-"));
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
    const projectId = harness.createProject({ name: "Multi-run Project", rootPath: dir });
    const primaryRunId = harness.createRun({ goal: "Primary dashboard run", projectId });
    const otherRunId = harness.createRun({ goal: "Other historical run", projectId });
    const otherTaskId = harness.createTask({
      runId: otherRunId,
      role: "worker",
      goal: "Edit a file",
      prompt: "Edit src/app.ts.",
      worktreePath: dir,
    });
    harness.recordAttempt({
      taskId: otherTaskId,
      input: {},
      output: {
        status: "done",
        summary: "Edited app.",
        changedFiles: ["src/app.ts"],
        checks: [],
        artifacts: [],
        problems: [],
      },
    });

    try {
      const input = {
        runId: primaryRunId,
        overview: () => harness.getRunOverview({ runId: primaryRunId }),
        runOverview: (runId: string) => harness.getRunOverview({ runId }),
        renderTaskPrompt: () => "",
      };

      const overviewResponse = await handleDashboardRequest(
        new Request(`http://localhost/api/runs/${otherRunId}/overview`),
        input,
      );
      expect(overviewResponse.status).toBe(200);
      const overviewBody = await overviewResponse.json();
      expect(overviewBody.run?.id).toBe(otherRunId);
      expect(overviewBody.tasks.some((task: { id: string }) => task.id === otherTaskId)).toBe(true);

      const changedResponse = await handleDashboardRequest(
        new Request(`http://localhost/api/runs/${otherRunId}/changed-files`),
        input,
      );
      expect(changedResponse.status).toBe(200);
      const changedBody = await changedResponse.json();
      expect(changedBody.files.map((file: { path: string }) => file.path)).toContain("src/app.ts");

      const diffResponse = await handleDashboardRequest(
        new Request(`http://localhost/api/runs/${otherRunId}/diff?path=src%2Fapp.ts`),
        input,
      );
      expect(diffResponse.status).toBe(200);
      const diffBody = await diffResponse.text();
      expect(diffBody).toContain("-export const value = 1;");
      expect(diffBody).toContain("+export const value = 2;");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns 404 for non-primary overview when runOverview is not configured", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ouroboros-dashboard-no-run-overview-"));
    const harness = new Harness(join(dir, "ouroboros.db"));
    harness.init();
    const primaryRunId = harness.createRun({ goal: "Primary dashboard run" });
    const otherRunId = harness.createRun({ goal: "Other historical run" });

    try {
      const response = await handleDashboardRequest(
        new Request(`http://localhost/api/runs/${otherRunId}/overview`),
        {
          runId: primaryRunId,
          overview: () => harness.getRunOverview({ runId: primaryRunId }),
          renderTaskPrompt: () => "",
        },
      );
      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toMatch(/run overview provider is not configured/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects POST actions targeted at a non-primary run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ouroboros-dashboard-action-non-primary-"));
    const harness = new Harness(join(dir, "ouroboros.db"));
    harness.init();
    const primaryRunId = harness.createRun({ goal: "Primary dashboard run" });
    const otherRunId = harness.createRun({ goal: "Other historical run" });

    try {
      const response = await handleDashboardRequest(
        new Request(`http://localhost/api/runs/${otherRunId}/runner/start`, {
          method: "POST",
          body: "{}",
        }),
        {
          runId: primaryRunId,
          overview: () => harness.getRunOverview({ runId: primaryRunId }),
          runOverview: (runId: string) => harness.getRunOverview({ runId }),
          renderTaskPrompt: () => "",
          actions: {
            startRunner: () => ({ status: "running" }),
          },
        },
      );
      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error).toMatch(/dashboard actions are only available on the primary run/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("accepts pending guardrail proposals through the scoped dashboard route and blocks unknown ids", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ouroboros-dashboard-guardrail-accept-"));
    const harness = new Harness(join(dir, "ouroboros.db"));
    harness.init();
    const runId = harness.createRun({
      goal: "Promote a pending guardrail proposal via the dashboard",
      context: {
        guardrails: [{ id: "guardrail_existing", summary: "Preserve accepted guardrails.", active: true }],
        guardrailProposals: [
          {
            id: "guardrail_pending",
            summary: "Repeated lesson summary.",
            count: 2,
            source: "lesson",
            active: false,
            accepted: false,
          },
        ],
      },
    });

    const dashboardInput = {
      runId,
      overview: () => harness.getRunOverview({ runId }),
      renderTaskPrompt: () => "",
      actions: {
        acceptGuardrailProposal: (proposalId: string, acceptedBy = "dashboard") => {
          const actionResult = applyHarnessAction(harness, {
            type: "acceptGuardrailProposal",
            runId,
            proposalId,
            acceptedBy,
            reason: "dashboard accept control",
          });
          if (actionResult.status === "blocked") {
            throw new Error(actionResult.problems.join("; ") || "guardrail proposal was not accepted");
          }
          return { runId, proposalId, status: actionResult.status };
        },
      },
    };

    try {
      const acceptResponse = await handleDashboardRequest(
        new Request(`http://localhost/api/runs/${runId}/guardrails/guardrail_pending/accept`, {
          method: "POST",
          body: JSON.stringify({ acceptedBy: "dashboard" }),
        }),
        dashboardInput,
      );
      const acceptBody = await acceptResponse.json();
      expect(acceptResponse.status).toBe(200);
      expect(acceptBody).toMatchObject({
        runId,
        proposalId: "guardrail_pending",
        status: "done",
      });

      const overview = harness.getRunOverview({ runId });
      expect(overview.run?.context.guardrails).toEqual([
        expect.objectContaining({ id: "guardrail_existing" }),
        expect.objectContaining({ id: "guardrail_pending", active: true, accepted: true, acceptedBy: "dashboard" }),
      ]);
      expect((overview.run?.context.guardrailProposals as Array<Record<string, unknown>>)?.[0]).toMatchObject({
        id: "guardrail_pending",
        accepted: true,
        active: false,
      });

      const unknownResponse = await handleDashboardRequest(
        new Request(`http://localhost/api/runs/${runId}/guardrails/guardrail_missing/accept`, {
          method: "POST",
          body: JSON.stringify({}),
        }),
        dashboardInput,
      );
      expect(unknownResponse.status).toBe(400);
      const unknownBody = await unknownResponse.json();
      expect(unknownBody.error).toMatch(/guardrail proposal not found: guardrail_missing/);

      const nonPrimaryResponse = await handleDashboardRequest(
        new Request(`http://localhost/api/runs/run_other/guardrails/guardrail_pending/accept`, {
          method: "POST",
          body: JSON.stringify({}),
        }),
        dashboardInput,
      );
      expect(nonPrimaryResponse.status).toBe(404);
      const nonPrimaryBody = await nonPrimaryResponse.json();
      expect(nonPrimaryBody.error).toMatch(/dashboard actions are only available on the primary run/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("rejects guardrail accept control when the action is not configured", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ouroboros-dashboard-guardrail-accept-unconfigured-"));
    const harness = new Harness(join(dir, "ouroboros.db"));
    harness.init();
    const runId = harness.createRun({
      goal: "Reject dashboard accept without wiring",
      context: {
        guardrailProposals: [
          { id: "guardrail_pending", summary: "x", count: 2, source: "lesson", active: false, accepted: false },
        ],
      },
    });

    try {
      const response = await handleDashboardRequest(
        new Request(`http://localhost/api/runs/${runId}/guardrails/guardrail_pending/accept`, {
          method: "POST",
          body: JSON.stringify({}),
        }),
        {
          runId,
          overview: () => harness.getRunOverview({ runId }),
          renderTaskPrompt: () => "",
        },
      );
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toMatch(/dashboard guardrail acceptance is not configured/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("overseer diagnosis endpoint returns draining state and evidence for a running attempt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ouroboros-dashboard-overseer-draining-"));
    const harness = new Harness(join(dir, "ouroboros.db"));
    harness.init();
    const runId = harness.createRun({ goal: "Draining overseer dashboard run" });
    const taskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Draining work",
      prompt: "Keep running.",
    });
    const attemptId = harness.startAttempt({
      taskId,
      input: {
        codexSessionId: "codex_draining",
        sessionName: "task-draining",
        cwd: "/tmp/draining-worktree",
        backend: { id: "claude-code", kind: "acpx", agent: "claude" },
      },
    });
    harness.upsertExecutionThread({
      runId,
      taskId,
      attemptId,
      ownerType: "runner",
      role: "worker",
      status: "running",
      sessionName: "task-draining",
      agentSessionId: "codex_draining",
    });

    try {
      const response = await handleDashboardRequest(
        new Request(`http://localhost/api/runs/${runId}/overview`),
        {
          runId,
          overview: () => harness.getRunOverview({ runId }),
          renderTaskPrompt: () => "",
        },
      );
      const body = await response.json();
      expect(body.diagnosis).toMatchObject({
        state: "draining",
        activeWork: expect.objectContaining({
          readyTaskIds: [],
          runningTaskIds: [taskId],
        }),
      });
      expect(body.diagnosis.reason).toMatch(/1 running attempt/);
      expect(body.diagnosis.runningAttempts).toEqual([
        expect.objectContaining({
          attemptId,
          taskId,
          role: "worker",
          codexSessionId: "codex_draining",
          backend: expect.objectContaining({ kind: "acpx", agent: "claude" }),
          cwd: "/tmp/draining-worktree",
        }),
      ]);
      expect(body.diagnosis.orphanedLeases).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("overseer diagnosis endpoint surfaces orphaned lease when a running task has no running attempt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ouroboros-dashboard-overseer-orphaned-"));
    const harness = new Harness(join(dir, "ouroboros.db"));
    harness.init();
    const runId = harness.createRun({ goal: "Orphaned overseer dashboard run" });
    const taskId = harness.createTask({
      runId,
      role: "worker",
      goal: "Orphaned work",
      prompt: "Stuck running.",
      worktreePath: "/tmp/orphaned-worktree",
    });
    // The task is marked running without a corresponding running attempt, which the
    // overseer classifies as an orphaned lease.
    const Database = (await import("bun:sqlite")).default;
    const connection = new Database(join(dir, "ouroboros.db"));
    connection.query("update tasks set status = 'running' where id = ?").run(taskId);
    connection.close();

    try {
      const response = await handleDashboardRequest(
        new Request(`http://localhost/api/runs/${runId}/overview`),
        {
          runId,
          overview: () => harness.getRunOverview({ runId }),
          renderTaskPrompt: () => "",
        },
      );
      const body = await response.json();
      expect(body.diagnosis.state).toBe("orphaned");
      expect(body.diagnosis.orphanedLeases).toEqual([
        expect.objectContaining({
          taskId,
          worktreePath: "/tmp/orphaned-worktree",
          reason: "running task has no running attempt",
        }),
      ]);
      expect(body.diagnosis.reason).toMatch(/running task has no running attempt/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("dashboard HTML renders the overseer diagnosis panel near runner and supervisor status", () => {
    const html = dashboardHtml({ runId: "run_overseer_panel" });

    expect(html).toContain('data-inspector-section="diagnosis"');
    expect(html).toContain("Overseer diagnosis");
    expect(html).toContain("Run supervisor state");
    expect(html).toContain("renderDiagnosis(overview)");
    expect(html).toContain("renderSupervisor(overview)");
    expect(html).toContain("renderRunner(overview)");
    // The inspector panel render call composes the diagnosis, supervisor, and runner
    // sections in that order so the overseer state is visible alongside runner/supervisor
    // status without hiding task, session, or evidence panels.
    expect(html).toContain(
      "renderGuardrailsSection(overview) + renderDiagnosis(overview) + renderSupervisor(overview) + renderRunner(overview)",
    );
  });

  test("self-iteration run overview exposes active goal, task graph, ready work, runner, and supervisor/diagnosis evidence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ouroboros-dashboard-self-iteration-evidence-"));
    const harness = new Harness(join(dir, "ouroboros.db"));
    harness.init();
    const goal = "Use Ouroboros to plan its own next self-iteration cycle";
    const runId = harness.createRun({
      goal,
      context: {
        source: "self-iterate",
        planDoc: "docs/self-iteration-plan.md",
        goalContract: {
          desiredState: "Ouroboros can plan and drain its own next improvement cycle before it asks for human intervention.",
          successCriteria: [
            "a new Ouroboros run exists for self-iteration",
            "its planner has produced a fine-grained task graph or a justified verifier task",
            "the dashboard shows the active goal, task stream, todos, and runner state for that run",
          ],
          constraints: [
            "Do not change database schema or dependency sets in this slice",
            "Do not start implementation from a vague task",
          ],
          requiredEvidence: [
            "orbs run-overview --run-id <run_id>",
            "orbs list-lessons --run-id <run_id>",
          ],
          budget: { maxRounds: 8, maxAttemptsPerTask: 3 },
        },
        agentDefaults: {
          global: "claude-code",
          roles: {
            planner: "codex-resumable",
            verifier: "codex-resumable",
            "goal-review": "codex-resumable",
          },
        },
        agentBackends: {
          "claude-code": { kind: "acpx", agent: "claude", approval: "approve-all" },
          "codex-resumable": { kind: "codex-resumable" },
        },
      },
    });
    const plannerId = harness.createTask({
      runId,
      role: "planner",
      goal: "Plan the next self-iteration slice",
      prompt: "Inspect docs/self-iteration-plan.md and return a small nextTasks graph.",
      doneWhen: [
        "Planner output contains a small nextTasks graph",
        "Every planned task has one role, one concrete goal, and one prompt with exact files or commands to inspect first",
      ],
    });
    harness.recordAttempt({
      taskId: plannerId,
      input: { sessionName: "planner-session", codexSessionId: "codex_planner" },
      output: {
        status: "done",
        summary: "Planner emitted worker + verifier",
        changedFiles: [],
        checks: [{ status: "passed", command: "bun test tests/dashboard.test.ts" }],
        artifacts: [],
        problems: [],
      },
    });
    const workerId = harness.createTask({
      runId,
      role: "worker",
      goal: "Tighten dashboard evidence for self-iteration supervision",
      prompt:
        "Inspect docs/self-iteration-plan.md, packages/cli/src/dashboard.ts, packages/cli/src/dashboard-canvas.tsx, packages/cli/src/main.ts, tests/dashboard.test.ts, and tests/cli.test.ts around self-iterate-launch.",
      dependsOn: [plannerId],
      doneWhen: [
        "Dashboard HTML or /api/runs/<run_id>/overview tests cover active goal, task stream or task graph, todos or ready work, runner status, and supervisor or diagnosis state.",
        "Any UI copy or API shape changed is backed by existing dashboard conventions and does not disrupt recent-runs or child-run aggregation behavior.",
        "Long goals, task titles, and runner output remain bounded or covered by existing overflow/truncation tests.",
        "The attempt output cites exactly how a verifier should inspect the dashboard evidence for a self-iteration run.",
        "bun test tests/dashboard.test.ts passes.",
      ],
    });
    const verifierId = harness.createTask({
      runId,
      role: "verifier",
      goal: "Verify self-iteration dashboard evidence covers all five required signals",
      prompt:
        "Run orbs run-overview --run-id <run_id> and orbs list-lessons --run-id <run_id> and confirm the dashboard evidence covers active goal, task stream, todos, runner, and supervisor/diagnosis state.",
      dependsOn: [workerId],
      parentId: workerId,
      doneWhen: ["All five dashboard evidence signals are present in the overview response."],
    });
    harness.updateRunStatus({ runId, status: "running" });

    try {
      const response = await handleDashboardRequest(
        new Request(`http://localhost/api/runs/${runId}/overview`),
        {
          runId,
          overview: () => harness.getRunOverview({ runId }),
          globalRunCounts: () => harness.countRunsByStatus(),
          runnerStatus: () => ({ status: "running", pid: 4321, lastOutput: "draining self-iteration tasks" }),
          supervisorStatus: () => ({ status: "running", pid: 2468, lastOutput: "supervising self-iteration runs" }),
          renderTaskPrompt: () => "",
        },
      );
      expect(response.status).toBe(200);
      const body = await response.json();

      // Active goal evidence: the run goal is returned with the full self-iteration context
      // (goalContract, agentDefaults, agentBackends) so a verifier can confirm the recovered
      // backend policy and the iteration contract from a single overview fetch.
      expect(body.run).toMatchObject({ id: runId, goal, status: "running" });
      expect(body.run.context.source).toBe("self-iterate");
      expect(body.run.context.planDoc).toBe("docs/self-iteration-plan.md");
      expect(body.run.context.goalContract.desiredState).toContain("plan and drain its own next improvement cycle");
      expect(body.run.context.goalContract.successCriteria).toContain(
        "the dashboard shows the active goal, task stream, todos, and runner state for that run",
      );
      expect(body.run.context.goalContract.requiredEvidence).toContain("orbs run-overview --run-id <run_id>");
      expect(body.run.context.agentDefaults.roles).toEqual({
        planner: "codex-resumable",
        verifier: "codex-resumable",
        "goal-review": "codex-resumable",
      });

      // Task stream evidence: every planner worker verifier task is returned with role, goal,
      // status, dependsOn, and doneWhen so the dashboard task stream reflects the generated graph.
      expect(body.tasks).toHaveLength(3);
      const taskById = new Map(body.tasks.map((task: { id: string; role: string; goal: string; status: string; dependsOn: string[]; doneWhen: string[] }) => [task.id, task]));
      expect(taskById.get(plannerId)).toMatchObject({
        id: plannerId,
        role: "planner",
        status: "done",
        dependsOn: [],
        doneWhen: expect.arrayContaining([expect.stringContaining("small nextTasks graph")]),
      });
      expect(taskById.get(workerId)).toMatchObject({
        id: workerId,
        role: "worker",
        status: "todo",
        dependsOn: [plannerId],
        doneWhen: expect.arrayContaining([
          expect.stringContaining("/api/runs/<run_id>/overview tests cover active goal"),
          expect.stringContaining("runner status"),
          expect.stringContaining("supervisor or diagnosis state"),
        ]),
      });
      expect(taskById.get(verifierId)).toMatchObject({
        id: verifierId,
        role: "verifier",
        status: "todo",
        dependsOn: [workerId],
        parentId: workerId,
      });

      // Task graph evidence: buildDashboardTaskGraph turns the overview into concrete nodes and
      // edges that point at the planned worker and its verifier, so the UI can render the
      // generated graph without re-deriving relationships.
      const graph = buildDashboardTaskGraph(harness.getRunOverview({ runId }), plannerId);
      expect(graph.nodes.map((node) => node.id)).toEqual([plannerId, workerId, verifierId]);
      expect(graph.edges).toContainEqual(
        expect.objectContaining({ source: plannerId, target: workerId, label: "dependsOn" }),
      );
      expect(graph.edges).toContainEqual(
        expect.objectContaining({ source: workerId, target: verifierId, label: "dependsOn" }),
      );
      expect(graph.edges).toContainEqual(
        expect.objectContaining({ source: workerId, target: verifierId, label: "parentId" }),
      );

      // Ready-work evidence: the overseer diagnosis lists ready and running task ids so a
      // verifier can confirm what the runner is supposed to drain next. The diagnosis is
      // derived from sessions/threads rather than the reported runner status, so when the
      // worker task is ready but no attempt is live yet, the diagnosis correctly classifies
      // the run as orphaned while the reported runner status shows the supervisor is active.
      // Together, those two signals tell a verifier that the runner is up but has not yet
      // picked up the queued self-iteration work.
      expect(body.diagnosis.activeWork.readyTaskIds).toContain(workerId);
      expect(body.diagnosis.activeWork.runningTaskIds).toEqual([]);
      expect(body.diagnosis.state).toBe("orphaned");
      expect(body.diagnosis.reason).toMatch(/ready work has no live runner/);
      expect(body.diagnosis.queueStarvation).toBe(true);
      expect(body.diagnosis.orphanedLeases).toEqual([]);

      // Runner evidence: the runner status is returned alongside the diagnosis so a verifier
      // can confirm the runner is active while the queue is non-empty.
      expect(body.runner).toEqual({ status: "running", pid: 4321, lastOutput: "draining self-iteration tasks" });

      // Supervisor evidence: the supervisor status is returned alongside the runner status so
      // the dashboard can render both signals in the inspector panel.
      expect(body.supervisor).toEqual({
        status: "running",
        pid: 2468,
        lastOutput: "supervising self-iteration runs",
      });
      expect(body.globalRuns).toMatchObject({ running: 1 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("self-iteration run overview exposes draining diagnosis and runner evidence while a worker attempt is live", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ouroboros-dashboard-self-iteration-draining-"));
    const harness = new Harness(join(dir, "ouroboros.db"));
    harness.init();
    const goal = "Use Ouroboros to plan its own next self-iteration cycle";
    const runId = harness.createRun({
      goal,
      context: {
        source: "self-iterate",
        planDoc: "docs/self-iteration-plan.md",
        goalContract: {
          desiredState: "Ouroboros can plan and drain its own next improvement cycle before it asks for human intervention.",
          successCriteria: [
            "a new Ouroboros run exists for self-iteration",
            "the dashboard shows the active goal, task stream, todos, and runner state for that run",
          ],
          constraints: ["Do not change database schema or dependency sets in this slice"],
          requiredEvidence: ["orbs run-overview --run-id <run_id>", "orbs list-lessons --run-id <run_id>"],
          budget: { maxRounds: 8, maxAttemptsPerTask: 3 },
        },
        agentDefaults: {
          global: "claude-code",
          roles: {
            planner: "codex-resumable",
            verifier: "codex-resumable",
            "goal-review": "codex-resumable",
          },
        },
        agentBackends: {
          "claude-code": { kind: "acpx", agent: "claude", approval: "approve-all" },
          "codex-resumable": { kind: "codex-resumable" },
        },
      },
    });
    const plannerId = harness.createTask({
      runId,
      role: "planner",
      goal: "Plan the next self-iteration slice",
      prompt: "Inspect docs/self-iteration-plan.md and return a small nextTasks graph.",
      doneWhen: ["Planner output contains a small nextTasks graph"],
    });
    harness.recordAttempt({
      taskId: plannerId,
      input: { sessionName: "planner-session", codexSessionId: "codex_planner" },
      output: {
        status: "done",
        summary: "Planner emitted worker + verifier",
        changedFiles: [],
        checks: [],
        artifacts: [],
        problems: [],
      },
    });
    const workerId = harness.createTask({
      runId,
      role: "worker",
      goal: "Tighten dashboard evidence for self-iteration supervision",
      prompt: "Inspect docs/self-iteration-plan.md and packages/cli/src/dashboard.ts.",
      dependsOn: [plannerId],
      doneWhen: ["Dashboard evidence is testable from /api/runs/<run_id>/overview."],
    });
    const attemptId = harness.startAttempt({
      taskId: workerId,
      input: { sessionName: "worker-session", codexSessionId: "codex_worker" },
    });
    harness.upsertExecutionThread({
      runId,
      taskId: workerId,
      attemptId,
      ownerType: "runner",
      role: "worker",
      status: "running",
      sessionName: "worker-session",
      agentSessionId: "codex_worker",
    });
    harness.updateRunStatus({ runId, status: "running" });

    try {
      const response = await handleDashboardRequest(
        new Request(`http://localhost/api/runs/${runId}/overview`),
        {
          runId,
          overview: () => harness.getRunOverview({ runId }),
          globalRunCounts: () => harness.countRunsByStatus(),
          runnerStatus: () => ({ status: "running", pid: 4321, lastOutput: "draining self-iteration worker" }),
          supervisorStatus: () => ({ status: "running", pid: 2468, lastOutput: "supervising self-iteration run" }),
          renderTaskPrompt: () => "",
        },
      );
      expect(response.status).toBe(200);
      const body = await response.json();

      // Active goal and recovered backend policy are visible from the overview response.
      expect(body.run).toMatchObject({ id: runId, goal, status: "running" });
      expect(body.run.context.agentDefaults.roles.verifier).toBe("codex-resumable");
      expect(body.run.context.goalContract.requiredEvidence).toContain("orbs run-overview --run-id <run_id>");

      // Task stream evidence: planner is done, worker is running.
      type DashboardTask = { id: string; role: string; status: string };
      const taskById = new Map<string, DashboardTask>(
        body.tasks.map((task: DashboardTask) => [task.id, task] as const),
      );
      expect(taskById.get(plannerId)?.status).toBe("done");
      expect(taskById.get(workerId)).toMatchObject({ role: "worker", status: "running" });

      // Diagnosis evidence: the overseer classifies the live worker attempt as draining and
      // surfaces the running attempt so a verifier can confirm the runner is making progress.
      expect(body.diagnosis.state).toBe("draining");
      expect(body.diagnosis.reason).toMatch(/1 running attempt/);
      expect(body.diagnosis.activeWork.runningTaskIds).toEqual([workerId]);
      expect(body.diagnosis.activeWork.readyTaskIds).toEqual([]);
      expect(body.diagnosis.runningAttempts).toEqual([
        expect.objectContaining({ attemptId, taskId: workerId, role: "worker", codexSessionId: "codex_worker" }),
      ]);
      expect(body.diagnosis.orphanedLeases).toEqual([]);

      // Runner and supervisor evidence: both are returned alongside the diagnosis so the
      // inspector panel can render all three signals.
      expect(body.runner).toEqual({ status: "running", pid: 4321, lastOutput: "draining self-iteration worker" });
      expect(body.supervisor).toEqual({
        status: "running",
        pid: 2468,
        lastOutput: "supervising self-iteration run",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("dashboard HTML composes self-iteration evidence in the inspector panel for verifier review", () => {
    const html = dashboardHtml({ runId: "run_self_iteration" });

    // The inspector panel renders the active goal title, the workspace flow/task stream,
    // the todo list of doneWhen items, the runner section, and the supervisor/diagnosis
    // sections in a single compose call so a verifier can confirm every evidence signal
    // from one dashboard fetch.
    expect(html).toContain('data-inspector-section="progress"');
    expect(html).toContain('data-inspector-section="runner"');
    expect(html).toContain('data-inspector-section="supervisor"');
    expect(html).toContain('data-inspector-section="diagnosis"');
    expect(html).toContain('id="workspace-flow"');
    expect(html).toContain("dashboardWorkspaceHtml(selectedGroup)");
    expect(html).toContain("dashboardInspectorHtml(overview, selectedGroup)");
    expect(html).toContain("patchInspectorPanel(dashboardInspectorHtml(overview, selectedGroup)");
    expect(html).toContain("dashboardRunStatusHtml(overview)");
    // The runner section explicitly flags queued work waiting for a runner so a verifier can
    // tell self-iteration is paused on the runner rather than on missing work.
    expect(html).toContain("Queue waiting for runner");
    expect(html).toContain("Background runner");
    // The diagnosis section explicitly surfaces ready + running counts and orphaned lease
    // reasoning so a verifier can confirm supervisor state from the inspector panel.
    expect(html).toContain("Run supervisor state");
    expect(html).toContain("Running attempts");
    expect(html).toContain("Orphaned leases");
  });
});
