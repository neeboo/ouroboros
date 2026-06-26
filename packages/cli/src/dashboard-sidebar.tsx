import { IntakeComposerControls } from "./dashboard-controls";
import { Panel, ScrollArea } from "./dashboard-ui/primitives";
import { renderStaticNode } from "./dashboard-static-render";
import type { DashboardComposerState, DashboardGoalSummary, DashboardRunHistoryEntry } from "./dashboard-types";

function GoalRow({ goal }: { goal: DashboardGoalSummary }) {
  return (
    <button className={`task-row ${goal.selected ? "selected" : ""}`} data-goal-id={goal.id}>
      <span className={`status-dot ${goal.status}`} />
      <span className="task-row-text">
        <strong>{goal.title}</strong>
        <span className="row-meta">
          {goal.taskCount} tasks - {goal.roleSummary}
        </span>
      </span>
      <span className={`status-text ${goal.status}`}>{goal.status}</span>
    </button>
  );
}

export function DashboardSidebar({
  runTitle,
  runStatus,
  projectName,
  projectRoot,
  composer,
  activeGoals,
  historyGoals,
}: {
  runTitle: string;
  runStatus: string;
  projectName: string;
  projectRoot?: string;
  composer: DashboardComposerState;
  activeGoals: DashboardGoalSummary[];
  historyGoals: DashboardGoalSummary[];
}) {
  return (
    <Panel as="aside" className="task-sidebar">
      <div className="sidebar-head">
        <div className="brand-row">
          <h1>Ouroboros</h1>
          <div className="run-status" id="run-status">
            {runStatus}
          </div>
        </div>
        <section className="sidebar-context" data-sidebar-context aria-label="Run context">
          <div className="run-title" id="run-title">
            {runTitle}
          </div>
          <div className="project-title project-header" id="project-title" data-project-header>
            <div className="project-name" data-project-name>
              {projectName}
            </div>
            <div className="project-root" data-project-root>
              {projectRoot || ""}
            </div>
          </div>
        </section>
        <IntakeComposerControls composer={composer} />
      </div>
      <ScrollArea as="nav" className="task-nav" aria-label="Goals and run history">
        <section className="nav-section">
          <h2 className="section-label">Active Goals</h2>
          <div className="task-list" id="active-goal-list">
            {activeGoals.map((goal) => (
              <GoalRow goal={goal} key={goal.id} />
            ))}
          </div>
        </section>
        <section className="nav-section">
          <h2 className="section-label">History</h2>
          <div className="task-list" id="history-goal-list">
            {historyGoals.map((goal) => (
              <GoalRow goal={goal} key={goal.id} />
            ))}
          </div>
        </section>
        <section className="nav-section history-rail" data-history-runs aria-label="Run history">
          <div className="history-rail-head">
            <div>
              <h2 className="section-label">Run history</h2>
              <div className="section-note">Active run pinned above recent runs.</div>
            </div>
          </div>
          <div className="history-run-group" data-history-run-group="active">
            <div className="history-run-group-label">Active run</div>
            <div
              className="task-list history-run-list"
              id="active-run-list"
              data-history-source="GET /api/runs"
              data-history-run-selected="true"
              aria-live="polite"
            >
              Loading active run...
            </div>
          </div>
          <div className="history-run-group" data-history-run-group="recent">
            <div className="history-run-group-label">Recent runs</div>
            <div
              className="task-list history-run-list"
              id="recent-runs-list"
              data-history-runs-list
              data-history-source="GET /api/runs"
              aria-live="polite"
            >
              Loading recent runs...
            </div>
          </div>
        </section>
      </ScrollArea>
    </Panel>
  );
}

export function DashboardRunHistoryRows({
  runs,
  activeRunId,
}: {
  runs: DashboardRunHistoryEntry[];
  activeRunId: string;
}) {
  return (
    <>
      {runs.map((entry) => (
        <DashboardRunHistoryRow entry={entry} activeRunId={activeRunId} key={entry.id} />
      ))}
    </>
  );
}

export function renderDashboardRunHistoryRows(runs: DashboardRunHistoryEntry[], activeRunId: string) {
  return renderStaticNode(<DashboardRunHistoryRows runs={runs} activeRunId={activeRunId} />);
}

function DashboardRunHistoryRow({ entry, activeRunId }: { entry: DashboardRunHistoryEntry; activeRunId: string }) {
  const isActive = entry.id === activeRunId;
  const goal = entry.goal && entry.goal.trim() ? entry.goal : "(no goal)";

  return (
    <button
      type="button"
      className={`history-run-row${isActive ? " is-active" : ""}`}
      data-react-run-history="true"
      data-history-run-id={entry.id}
      data-active-run-id={activeRunId}
      data-history-run-selected={isActive ? "true" : "false"}
      aria-current={isActive ? "true" : "false"}
      title={entry.goal || entry.id}
    >
      <span className={`history-run-status status-${entry.status}`}>{entry.status}</span>
      <span className="history-run-goal">{goal}</span>
      <span className="history-run-id code-meta">{entry.id}</span>
    </button>
  );
}
