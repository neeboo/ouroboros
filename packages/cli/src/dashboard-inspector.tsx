import { SupervisorControls } from "./dashboard-controls";
import { Button, Panel, ScrollArea } from "./dashboard-ui/primitives";
import type { DashboardChangedFile, DashboardSupervisorState } from "./dashboard-types";

export function ConversationTimeline({
  children,
}: {
  children?: React.ReactNode;
}) {
  return (
    <Panel
      className="inspector-card conversation-timeline-section"
      data-inspector-section="conversation"
      id="conversation-timeline"
      data-conversation-timeline
    >
      <h2>Conversation</h2>
      <div className="conversation-timeline-meta">Chronological session timeline · oldest first.</div>
      <ScrollArea className="conversation-timeline-scroll" data-conversation-timeline-scroll>
        {children}
      </ScrollArea>
    </Panel>
  );
}

export function InspectorComposer() {
  return (
    <Panel
      className="inspector-card inspector-composer-section"
      data-inspector-section="composer"
      id="inspector-composer-section"
      data-inspector-composer-section
    >
      <h2>Composer</h2>
      <form className="inspector-composer" id="inspector-composer" data-inspector-composer-form>
        <textarea
          id="inspector-composer-input"
          name="prompt"
          className="inspector-composer-input"
          rows={2}
          placeholder="Reply or direct the next step"
          aria-label="Inspector composer"
        />
        <div className="inspector-composer-actions">
          <span className="inspector-composer-hint">Enter sends via the intake planner.</span>
          <Button type="submit" data-inspector-composer-send>
            Send
          </Button>
        </div>
      </form>
    </Panel>
  );
}

export function ChangedFilesInspector({
  files,
  selectedPath,
}: {
  files: DashboardChangedFile[];
  selectedPath?: string | null;
}) {
  return (
    <Panel className="inspector-card changed-files-section" data-inspector-section="changed-files" data-changed-files-section>
      <h2>Files</h2>
      <ScrollArea className="changed-file-tree" data-changed-file-tree>
        {files.map((file) => (
          <Button
            type="button"
            className={`changed-file-node ${file.selected || file.path === selectedPath ? "selected" : ""}`}
            variant="ghost"
            data-changed-file-node="file"
            data-changed-file-path={file.path}
            data-selected-changed-file={file.selected || file.path === selectedPath ? "true" : undefined}
            aria-current={file.selected || file.path === selectedPath ? "true" : undefined}
            title={file.path}
            key={file.path}
          >
            <span className="changed-file-type" aria-hidden="true">
              file
            </span>
            <span className="changed-file-name">{file.path}</span>
          </Button>
        ))}
      </ScrollArea>
      <Panel as="div" className="diff-panel" data-diff-panel data-diff-state={selectedPath ? "loading" : "empty-selection"}>
        <div className="diff-header" data-diff-header>
          <span className="diff-path" data-diff-path>
            {selectedPath || "Select a changed file"}
          </span>
        </div>
      </Panel>
    </Panel>
  );
}

export function DashboardInspector({
  supervisor,
  changedFiles,
  selectedChangedFilePath,
  children,
}: {
  supervisor: DashboardSupervisorState;
  changedFiles: DashboardChangedFile[];
  selectedChangedFilePath?: string | null;
  children?: React.ReactNode;
}) {
  return (
    <ScrollArea as="aside" className="inspector-panel" id="inspector-panel">
      <ConversationTimeline />
      {children}
      <SupervisorControls supervisor={supervisor} />
      <ChangedFilesInspector files={changedFiles} selectedPath={selectedChangedFilePath} />
      <InspectorComposer />
    </ScrollArea>
  );
}
