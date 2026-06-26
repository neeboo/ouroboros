import { DashboardFlowView } from "./dashboard-flow-view";
import { DashboardInspector } from "./dashboard-inspector";
import { DashboardSidebar } from "./dashboard-sidebar";
import type { DashboardAppState, DashboardReactModule } from "./dashboard-types";

export const DASHBOARD_REACT_MODULES: DashboardReactModule[] = [
  {
    id: "shell",
    label: "Dashboard shell",
    status: "active",
    owns: ["app-shell", "project-header", "run-status"],
  },
  {
    id: "sidebar",
    label: "Goal sidebar",
    status: "active",
    owns: ["active-goal-list", "history-goal-list", "intake-composer"],
  },
  {
    id: "flow-view",
    label: "Flow and canvas workspace",
    status: "active",
    owns: ["workspace-flow", "dashboard-canvas-root", "flow-transcript"],
  },
  {
    id: "inspector",
    label: "Run inspector",
    status: "active",
    owns: ["inspector-panel", "changed-files", "diff-panel"],
  },
  {
    id: "controls",
    label: "Dashboard controls",
    status: "active",
    owns: ["supervisor-controls", "runner-controls", "workspace-mode-controls"],
  },
];

export function DashboardApp({ state }: { state: DashboardAppState }) {
  const overview = state.overview;
  const runTitle = overview?.run?.goal || state.runId;
  const runStatus = overview?.run?.status || "loading";
  const projectName = overview?.project?.name || "Project Workspace";
  const projectRoot = overview?.project?.rootPath || "";
  const title = state.activeGoals.find((goal) => goal.selected)?.title || runTitle;

  return (
    <div className="app-shell" data-react-dashboard-modules={DASHBOARD_REACT_MODULES.map((module) => module.id).join(",")}>
      <DashboardSidebar
        runTitle={runTitle}
        runStatus={runStatus}
        projectName={projectName}
        projectRoot={projectRoot}
        composer={state.composer}
        activeGoals={state.activeGoals}
        historyGoals={state.historyGoals}
      />
      <DashboardFlowView title={title} kicker="Conversation timeline" mode={state.workspaceMode} titleExpanded={false} />
      <DashboardInspector
        supervisor={state.supervisor}
        changedFiles={state.changedFiles}
        selectedChangedFilePath={state.selectedChangedFilePath}
      />
    </div>
  );
}
