export type Status = "todo" | "running" | "done" | "blocked";

export interface Run {
  id: string;
  projectId: string | null;
  projectRoot: string | null;
  goal: string;
  status: Status;
  context: Record<string, unknown>;
}

export interface ModelPreference {
  model: string;
  reason?: string;
}

export interface TaskConfig {
  modelPreference?: ModelPreference;
  [key: string]: unknown;
}

export interface Project {
  id: string;
  name: string;
  rootPath: string;
  context: Record<string, unknown>;
}

export interface Task {
  id: string;
  runId: string;
  parentId: string | null;
  cycleId: string;
  status: Status;
  role: string;
  goal: string;
  prompt: string;
  dependsOn: string[];
  doneWhen: string[];
  config?: TaskConfig;
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

export type AttemptEventStream = "stdout" | "stderr" | "codex-json" | "system";

export interface AttemptEvent {
  id: string;
  attemptId: string;
  sequence: number;
  stream: AttemptEventStream;
  text: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface ListRunsInput {
  statuses?: Status[];
  limit?: number;
}

export type RunStatusCounts = Record<Status, number>;

export interface HarnessActionEvent {
  id: string;
  actionType: string;
  status: "done" | "blocked";
  request: Record<string, unknown>;
  result: Record<string, unknown>;
  createdAt: string;
}

export type ExecutionThreadStatus = "running" | "done" | "blocked" | "interrupted" | "orphaned";

export interface ExecutionThread {
  id: string;
  runId: string;
  taskId: string | null;
  attemptId: string | null;
  parentThreadId: string | null;
  ownerType: string;
  ownerId: string | null;
  role: string;
  status: ExecutionThreadStatus;
  pid: number | null;
  sessionName: string | null;
  agentSessionId: string | null;
  worktreePath: string | null;
  heartbeatAt: string;
  interruptedAt: string | null;
  interruptReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AttemptOutput {
  status: "done" | "blocked";
  runDecision?: "complete" | "continue" | "verify";
  summary: string;
  changedFiles?: string[];
  checks?: unknown[];
  artifacts?: unknown[];
  problems?: string[];
  nextTasks?: PlannedTask[];
  nextRuns?: PlannedRun[];
}

export interface DependencyAttempt {
  taskId: string;
  attemptId: string;
  status: AttemptOutput["status"];
  summary: string;
  changedFiles: string[];
  checks: unknown[];
  artifacts: unknown[];
  problems: string[];
}

export interface PlannedTask {
  role: string;
  goal: string;
  prompt: string;
  dependsOn?: string[];
  doneWhen?: string[];
  modelPreference?: ModelPreference;
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

export type LessonKind = "experience" | "lesson";

export interface Lesson {
  id: string;
  runId: string;
  taskId: string;
  attemptId: string;
  kind: LessonKind;
  summary: string;
  evidence: Record<string, unknown>;
}

export interface PromptTemplate {
  key: string;
  contentMd: string;
}

export interface CreateRunInput {
  goal: string;
  context?: Record<string, unknown>;
  projectId?: string | null;
  projectRoot?: string | null;
  id?: string;
}

export interface CreateProjectInput {
  name: string;
  rootPath: string;
  context?: Record<string, unknown>;
  id?: string;
}

export interface UpdateRunStatusInput {
  runId: string;
  status: Status;
}

export interface CreateTaskInput {
  runId: string;
  role: string;
  goal: string;
  prompt: string;
  dependsOn?: string[];
  doneWhen?: string[];
  worktreePath?: string | null;
  config?: TaskConfig;
  parentId?: string | null;
  cycleId?: string | null;
  id?: string;
}

export interface RecordAttemptInput {
  taskId: string;
  input: Record<string, unknown>;
  output: AttemptOutput;
  id?: string;
}

export interface StartAttemptInput {
  taskId: string;
  input: Record<string, unknown>;
  id?: string;
}

export interface FinishAttemptInput {
  attemptId: string;
  output: AttemptOutput;
}

export interface UpdateAttemptInputInput {
  attemptId: string;
  input: Record<string, unknown>;
}

export interface RecordAttemptEventInput {
  attemptId: string;
  stream: AttemptEventStream;
  sequence: number;
  text?: string | null;
  payload?: Record<string, unknown>;
  id?: string;
}

export interface GetRunOverviewInput {
  runId: string;
  eventLimit?: number;
}

export interface ObservableSession {
  role: string;
  taskId: string;
  taskGoal: string;
  attemptId: string;
  status: Exclude<Status, "todo">;
  output: Partial<AttemptOutput>;
  sessionName: string | null;
  codexSessionId: string | null;
  worktreePath: string | null;
  startedAt: string | null;
  latestText: string;
  events: AttemptEvent[];
}

export interface RunOverview {
  run: Run | null;
  project: Project | null;
  tasks: Task[];
  sessions: ObservableSession[];
  threads: ExecutionThread[];
  lessons: Lesson[];
}

export interface PlannedRun {
  goal: string;
  prompt: string;
  doneWhen?: string[];
  context?: Record<string, unknown>;
  modelPreference?: ModelPreference;
}

export interface ListRunningAttemptsInput {
  runId: string;
}

export interface ReclaimRunningTasksInput {
  runId: string;
}

export interface ReclaimedRunningTask {
  taskId: string;
  sessionRef: string | null;
  worktreePath: string | null;
  reason: string;
}

export interface LeaseReadyTasksInput {
  runId: string;
  limit: number;
  sessionForTask: (task: Task) => string;
  worktreeForTask?: (task: Task) => string | null;
}

export interface RetryTaskInput {
  taskId: string;
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

export interface ListLessonsInput {
  runId: string;
  limit?: number;
}

export interface SetPromptTemplateInput {
  key: string;
  contentMd: string;
}

export interface UpsertExecutionThreadInput {
  id?: string;
  runId: string;
  taskId?: string | null;
  attemptId?: string | null;
  parentThreadId?: string | null;
  ownerType: string;
  ownerId?: string | null;
  role: string;
  status?: ExecutionThreadStatus;
  pid?: number | null;
  sessionName?: string | null;
  agentSessionId?: string | null;
  worktreePath?: string | null;
  interruptReason?: string | null;
}

export interface UpdateExecutionThreadInput {
  id: string;
  status?: ExecutionThreadStatus;
  ownerId?: string | null;
  pid?: number | null;
  sessionName?: string | null;
  agentSessionId?: string | null;
  worktreePath?: string | null;
  interruptReason?: string | null;
  heartbeat?: boolean;
}

export interface ListExecutionThreadsInput {
  runId: string;
}

export interface RecordHarnessActionEventInput {
  actionType: string;
  status: "done" | "blocked";
  request: Record<string, unknown>;
  result: Record<string, unknown>;
  id?: string;
}

export interface ListHarnessActionEventsInput {
  limit?: number;
}

export interface GetHarnessActionEventInput {
  id: string;
}
