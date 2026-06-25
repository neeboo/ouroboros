import { IntakeComposerControls } from "./dashboard-controls";
import type { DashboardComposerState, DashboardGoalSummary } from "./dashboard-types";

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
    <aside className="task-sidebar">
      <div className="sidebar-head">
        <div className="brand-row">
          <h1>Ouroboros</h1>
          <div className="run-status" id="run-status">
            {runStatus}
          </div>
        </div>
        <div id="run-title">{runTitle}</div>
        <div className="project-title project-header" id="project-title" data-project-header>
          <div className="project-name" data-project-name>
            {projectName}
          </div>
          <div className="project-root" data-project-root>
            {projectRoot || ""}
          </div>
        </div>
        <IntakeComposerControls composer={composer} />
      </div>
      <section className="sidebar-stats" id="sidebar-stats" />
      <nav className="task-nav" aria-label="Goals">
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
        <section className="nav-section" data-history-runs>
          <h2 className="section-label">Recent runs</h2>
          <h2 className="section-label">Active run</h2>
          <div
            className="task-list"
            id="active-run-list"
            data-history-source="GET /api/runs"
            data-history-run-selected="true"
            aria-live="polite"
          >
            Loading active run...
          </div>
          <h2 className="section-label">Run history</h2>
          <div
            className="task-list"
            id="recent-runs-list"
            data-history-runs-list
            data-history-source="GET /api/runs"
            aria-live="polite"
          >
            Loading recent runs...
          </div>
        </section>
      </nav>
    </aside>
  );
}
