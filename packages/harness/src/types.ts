export type Status = "todo" | "running" | "done" | "blocked";

export interface Run {
  id: string;
  goal: string;
  status: Status;
  context: Record<string, unknown>;
}

export interface Task {
  id: string;
  runId: string;
  parentId: string | null;
  status: Status;
  role: string;
  goal: string;
  prompt: string;
  dependsOn: string[];
  doneWhen: string[];
  worktreePath: string | null;
  sessionRef: string | null;
  contextVersion: number;
}

export interface Attempt {
  id: string;
  taskId: string;
  status: Exclude<Status, "todo">;
  input: Record<string, unknown>;
  output: AttemptOutput;
  checks: unknown[];
  artifacts: unknown[];
  error: string | null;
}

export interface AttemptOutput {
  status: "done" | "blocked";
  summary: string;
  changedFiles?: string[];
  checks?: unknown[];
  artifacts?: unknown[];
  problems?: string[];
}

export interface ExternalRef {
  id: string;
  localType: string;
  localId: string;
  provider: string;
  externalType: string;
  externalId: string;
  externalUrl: string | null;
}

export interface CreateRunInput {
  goal: string;
  context?: Record<string, unknown>;
  id?: string;
}

export interface CreateTaskInput {
  runId: string;
  role: string;
  goal: string;
  prompt: string;
  dependsOn?: string[];
  doneWhen?: string[];
  parentId?: string | null;
  id?: string;
}

export interface RecordAttemptInput {
  taskId: string;
  input: Record<string, unknown>;
  output: AttemptOutput;
  id?: string;
}

export interface CreateExternalRefInput {
  localType: string;
  localId: string;
  provider: string;
  externalType: string;
  externalId: string;
  externalUrl?: string | null;
  id?: string;
}

export interface ListExternalRefsInput {
  localType: string;
  localId: string;
}
