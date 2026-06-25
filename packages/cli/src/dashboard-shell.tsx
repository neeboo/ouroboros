import { DashboardFlowView } from "./dashboard-flow-view";
import { DashboardInspector } from "./dashboard-inspector";
import { DashboardSidebar } from "./dashboard-sidebar";
import { renderStaticNode } from "./dashboard-static-render";
import type { DashboardChangedFile, DashboardComposerState, DashboardGoalSummary, DashboardSupervisorState } from "./dashboard-types";

function DashboardShell({ runId }: { runId: string }) {
  const composer: DashboardComposerState = { prompt: "", attachments: [] };
  const goals: DashboardGoalSummary[] = [];
  const supervisor: DashboardSupervisorState = { status: "idle" };
  const changedFiles: DashboardChangedFile[] = [];

  return (
    <div className="app-shell" data-react-dashboard-shell="true">
      <DashboardSidebar
        runTitle={`Loading ${runId}`}
        runStatus="Loading"
        projectName="Project Workspace"
        projectRoot=""
        composer={composer}
        activeGoals={goals}
        historyGoals={goals}
      />
      <DashboardFlowView title="Loading" kicker="Task Flow" mode="flow" titleExpanded={false} />
      <DashboardInspector supervisor={supervisor} changedFiles={changedFiles} />
    </div>
  );
}

export function renderDashboardShell(input: { runId: string }) {
  return renderStaticNode(<DashboardShell runId={input.runId} />);
}
