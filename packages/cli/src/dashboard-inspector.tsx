import { SupervisorControls } from "./dashboard-controls";
import type { DashboardChangedFile, DashboardSupervisorState } from "./dashboard-types";

export function ChangedFilesInspector({
  files,
  selectedPath,
}: {
  files: DashboardChangedFile[];
  selectedPath?: string | null;
}) {
  return (
    <section className="inspector-card changed-files-section" data-inspector-section="changed-files" data-changed-files-section>
      <h2>Changed Files</h2>
      <div className="changed-file-tree" data-changed-file-tree>
        {files.map((file) => (
          <button
            type="button"
            className={`changed-file-node ${file.selected || file.path === selectedPath ? "selected" : ""}`}
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
          </button>
        ))}
      </div>
      <div className="diff-panel" data-diff-panel data-diff-state={selectedPath ? "loading" : "empty-selection"}>
        <div className="diff-header" data-diff-header>
          <span className="diff-path" data-diff-path>
            {selectedPath || "Select a changed file"}
          </span>
        </div>
      </div>
    </section>
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
    <aside className="inspector-panel" id="inspector-panel">
      {children}
      <SupervisorControls supervisor={supervisor} />
      <ChangedFilesInspector files={changedFiles} selectedPath={selectedChangedFilePath} />
    </aside>
  );
}
