import { DashboardFlowView } from "./dashboard-flow-view";
import { DashboardInspector } from "./dashboard-inspector";
import { DashboardSidebar } from "./dashboard-sidebar";
import { renderStaticNode } from "./dashboard-static-render";
import type { DashboardComposerState, DashboardGoalSummary } from "./dashboard-types";

function DashboardShell({ runId }: { runId: string }) {
  const composer: DashboardComposerState = { prompt: "", attachments: [] };
  const goals: DashboardGoalSummary[] = [];

  return (
    <div className="app-shell" data-rail="collapsed" data-react-dashboard-shell="true">
      <DashboardSidebar
        runTitle={`Loading ${runId}`}
        runStatus="Loading"
        projectName="Project Workspace"
        projectRoot=""
        composer={composer}
        activeGoals={goals}
        historyGoals={goals}
      />
      <DashboardFlowView title="Loading" kicker="Conversation timeline" mode="flow" titleExpanded={false} />
      <DashboardInspector />
    </div>
  );
}

export function renderDashboardShell(input: { runId: string }) {
  return renderStaticNode(<DashboardShell runId={input.runId} />);
}
