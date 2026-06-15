import { WorkspaceModeControls } from "./dashboard-controls";
import type { DashboardWorkspaceMode } from "./dashboard-types";

export function DashboardFlowView({
  title,
  kicker,
  mode,
  titleExpanded,
  children,
}: {
  title: string;
  kicker: string;
  mode: DashboardWorkspaceMode;
  titleExpanded: boolean;
  children?: React.ReactNode;
}) {
  return (
    <main className="workspace">
      <header className="workspace-head">
        <div className="workspace-head-row">
          <div className="workspace-title-block">
            <div className="workspace-kicker" id="workspace-kicker">
              {kicker}
            </div>
            <div className="workspace-title-row">
              <div
                className={`workspace-title ${titleExpanded ? "is-expanded" : "is-collapsed"}`}
                id="workspace-title"
                title={title}
              >
                {title}
              </div>
              <button
                className="workspace-title-toggle"
                id="workspace-title-toggle"
                type="button"
                data-workspace-title-toggle
                aria-expanded={titleExpanded}
                aria-controls="workspace-title"
                aria-label={titleExpanded ? "Collapse workspace title" : "Expand workspace title"}
              >
                {titleExpanded ? "Collapse" : "Expand"}
              </button>
            </div>
          </div>
          <WorkspaceModeControls mode={mode} />
        </div>
      </header>
      <section className={`workspace-flow ${mode === "canvas" ? "canvas-workspace" : ""}`} id="workspace-flow">
        {children}
      </section>
    </main>
  );
}

export function DashboardCanvasMount({ graphJson }: { graphJson: string }) {
  return (
    <div className="canvas-inner">
      <div id="dashboard-canvas-root" data-canvas-graph={graphJson} />
    </div>
  );
}
