import type { DashboardComposerState, DashboardSupervisorState, DashboardWorkspaceMode } from "./dashboard-types";

export function IntakeComposerControls({ composer }: { composer: DashboardComposerState }) {
  return (
    <form className="intake-composer" id="intake-composer">
      <label className="intake-label" htmlFor="intake-input">
        New intake
      </label>
      <input id="attachment-input" type="file" multiple hidden />
      <div className="attachment-chips" id="attachment-chips" aria-live="polite">
        {composer.attachments.map((attachment, index) => (
          <div className="attachment-chip" data-attachment-index={index} key={`${attachment.name}:${index}`}>
            <span title={attachment.name}>{attachment.name}</span>
            <button type="button" aria-label="Remove attachment" data-remove-attachment={index}>
              x
            </button>
          </div>
        ))}
      </div>
      <textarea
        className="intake-input"
        id="intake-input"
        name="prompt"
        placeholder="Describe the next goal or change request"
        defaultValue={composer.prompt}
      />
      <div className="intake-actions">
        <button className="plain-button secondary" type="button" data-attach-files>
          +
        </button>
        <button className="plain-button secondary" type="button" data-clear-attachments>
          Clear
        </button>
        <div className="form-status" id="intake-form-status">
          {composer.status || ""}
        </div>
        <button className="plain-button" type="submit" data-send-intake>
          Send
        </button>
      </div>
    </form>
  );
}

export function WorkspaceModeControls({ mode }: { mode: DashboardWorkspaceMode }) {
  return (
    <div className="workspace-toggle" aria-label="Workspace view">
      <button type="button" data-workspace-mode="canvas" aria-pressed={mode === "canvas"} className={mode === "canvas" ? "active" : ""}>
        Canvas
      </button>
      <button type="button" data-workspace-mode="flow" aria-pressed={mode === "flow"} className={mode === "flow" ? "active" : ""}>
        Flow
      </button>
    </div>
  );
}

export function SupervisorControls({ supervisor }: { supervisor: DashboardSupervisorState }) {
  const todoRuns = supervisor.globalRuns?.todo ?? 0;
  const runningRuns = supervisor.globalRuns?.running ?? 0;
  const canStart = supervisor.status !== "running" && (todoRuns > 0 || runningRuns > 0);
  const canStop = supervisor.status === "running";

  return (
    <section className="inspector-card" data-inspector-section="supervisor">
      <h2>Supervisor</h2>
      <div className="current-task">
        <div className="current-task-title">Global supervisor</div>
        <div className="current-task-meta">
          {todoRuns} todo runs - {runningRuns} running runs -{" "}
          <span className={`status-text ${supervisor.status}`}>{supervisor.status}</span>
        </div>
      </div>
      {supervisor.lastOutput ? <div className="stream-output">{supervisor.lastOutput}</div> : null}
      {canStart || canStop ? (
        <div className="control-row">
          {canStart ? (
            <button className="plain-button" data-start-supervisor>
              Start supervisor
            </button>
          ) : null}
          {canStop ? (
            <button className="plain-button danger" data-stop-supervisor>
              Stop supervisor
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
