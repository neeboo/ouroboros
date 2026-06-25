import type { RunOverview, RunStatusCounts } from "@ouroboros/harness";

export type DashboardWorkspaceMode = "canvas" | "flow";

export interface DashboardReactModule {
  id: "shell" | "sidebar" | "flow-view" | "inspector" | "controls";
  label: string;
  status: "active";
  owns: string[];
}

export interface DashboardComposerAttachment {
  name: string;
  type: string;
  size: number;
}

export interface DashboardComposerState {
  prompt: string;
  attachments: DashboardComposerAttachment[];
  status?: string;
}

export interface DashboardSupervisorState {
  status: "idle" | "running" | "exited";
  pid?: number | null;
  exitCode?: number | null;
  lastOutput?: string;
  globalRuns?: RunStatusCounts;
  externallyManaged?: boolean;
}

export interface DashboardGoalSummary {
  id: string;
  title: string;
  status: string;
  roleSummary: string;
  taskCount: number;
  selected?: boolean;
}

export interface DashboardChangedFile {
  path: string;
  selected?: boolean;
}

export interface DashboardRunHistoryEntry {
  id: string;
  status: string;
  goal: string;
  projectId?: string | null;
  createdAt?: string | null;
}

export interface DashboardAppState {
  runId: string;
  overview: RunOverview | null;
  workspaceMode: DashboardWorkspaceMode;
  composer: DashboardComposerState;
  supervisor: DashboardSupervisorState;
  activeGoals: DashboardGoalSummary[];
  historyGoals: DashboardGoalSummary[];
  changedFiles: DashboardChangedFile[];
  selectedGoalId?: string | null;
  selectedChangedFilePath?: string | null;
}
