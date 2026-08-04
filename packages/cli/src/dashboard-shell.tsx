import { DashboardFlowView } from "./dashboard-flow-view";
import { DashboardInspector } from "./dashboard-inspector";
import { DashboardSidebar } from "./dashboard-sidebar";
import { renderStaticNode } from "./dashboard-static-render";
import type { DashboardComposerState } from "./dashboard-types";

function DashboardShell({ runId }: { runId: string }) {
  const composer: DashboardComposerState = { prompt: "", attachments: [] };

  return (
    <div className="app-shell" data-rail="expanded" data-react-dashboard-shell="true">
      <DashboardSidebar
        runTitle={`Loading ${runId}`}
        runStatus="Loading"
        projectName="Project Workspace"
        projectRoot=""
        composer={composer}
      />
      <DashboardFlowView title="Loading" kicker="Conversation timeline" titleExpanded={false} />
      <DashboardInspector />
    </div>
  );
}

export function renderDashboardShell(input: { runId: string }) {
  return renderStaticNode(<DashboardShell runId={input.runId} />);
}
