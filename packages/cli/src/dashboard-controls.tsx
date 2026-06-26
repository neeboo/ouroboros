import { Button, Panel, Separator, Tabs, TabsTrigger } from "./dashboard-ui/primitives";
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
        <Button variant="ghost" type="button" aria-label="Remove attachment" data-remove-attachment={index}>
          x
        </Button>
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
        <Button className="plain-button secondary" variant="secondary" type="button" data-attach-files>
          +
        </Button>
        <Button className="plain-button secondary" variant="secondary" type="button" data-clear-attachments>
          Clear
        </Button>
        <div className="form-status" id="intake-form-status">
          {composer.status || ""}
        </div>
        <Button className="plain-button" type="submit" data-send-intake>
          Send
        </Button>
      </div>
    </form>
  );
}

export function WorkspaceModeControls({ mode }: { mode: DashboardWorkspaceMode }) {
  return (
    <Tabs className="workspace-toggle" aria-label="Workspace view">
      <TabsTrigger type="button" data-workspace-mode="canvas" active={mode === "canvas"}>
        Canvas
      </TabsTrigger>
      <TabsTrigger type="button" data-workspace-mode="flow" active={mode === "flow"}>
        Flow
      </TabsTrigger>
    </Tabs>
  );
}

export function SupervisorControls({ supervisor }: { supervisor: DashboardSupervisorState }) {
  const todoRuns = supervisor.globalRuns?.todo ?? 0;
  const runningRuns = supervisor.globalRuns?.running ?? 0;
  const canStart = supervisor.status !== "running" && (todoRuns > 0 || runningRuns > 0);
  const canStop = supervisor.status === "running" && !supervisor.externallyManaged;

  return (
    <Panel className="inspector-card" data-inspector-section="supervisor">
      <h2>Supervisor</h2>
      <div className="current-task">
        <div className="current-task-title">Global supervisor</div>
        <div className="current-task-meta">
          {todoRuns} todo runs · {runningRuns} running runs ·{" "}
          <span className={`status-text ${supervisor.status}`}>{supervisor.status}</span>
          {supervisor.externallyManaged ? <span className="code-meta"> external supervisor observed</span> : null}
        </div>
      </div>
      <Separator className="inspector-separator" />
      {supervisor.lastOutput ? <div className="stream-output">{supervisor.lastOutput}</div> : null}
      {canStart || canStop ? (
        <div className="control-row">
          {canStart ? (
            <Button className="plain-button" data-start-supervisor>
              Start supervisor
            </Button>
          ) : null}
          {canStop ? (
            <Button className="plain-button danger" variant="danger" data-stop-supervisor>
              Stop supervisor
            </Button>
          ) : null}
        </div>
      ) : null}
    </Panel>
  );
}
