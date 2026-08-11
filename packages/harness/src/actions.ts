import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { acceptGuardrailProposal, proposeGuardrailsFromLessons } from "./guardrails";
import type { HarnessDatabase } from "./database";
import {
  GOAL_REVIEW_TASK_DONE_WHEN,
  GOAL_REVIEW_TASK_GOAL,
  GOAL_REVIEW_TASK_PROMPT,
  inferExplicitRunDecision,
  resolveRunDecision,
} from "./goal-review";
import { Harness } from "./harness";
import { makeId } from "./ids";
import { filterOuroborosRuntimePaths, isOuroborosRuntimePath } from "./runtime-paths";
import {
  advanceAfterRepair,
  blockAfterRepair,
  normalizeWatchdogState,
  observeWatchdogTree,
  readWatchdogState,
  recordReconciliationOutcome,
  repairIdentity,
  transitionWatchdogState,
  WATCHDOG_COOLDOWN_MS,
  WATCHDOG_RECONCILE_LEASE_MS,
  WATCHDOG_STALL_MIN_INTERVAL_MS,
  WATCHDOG_STALL_TICK_THRESHOLD,
  WATCHDOG_STATE_VERSION,
} from "./watchdog";
import type { WatchdogObservationSnapshot, WatchdogSnapshotInput } from "./watchdog";
import {
  canonicalEvolutionRecordSha256,
  canonicalEvolutionValueSha256,
  parseEvolutionCausalHypothesis,
  parseEvolutionComparison,
  parseEvolutionInstance,
  parseEvolutionPackV1,
  parseEvolutionProfile,
  parseHarnessVariant,
  parseMatchedExperiment,
  parseProductionEpisode,
} from "./target-evolution";
import type {
  AttemptOutput,
  ControlPlaneWatchdogState,
  EvolutionComparison,
  EvolutionPackV1,
  EvolutionProfile,
  ExecutionThread,
  HarnessVariant,
  HarnessActionEvent,
  MatchedExperiment,
  ProductionEpisode,
  ReclaimedRunningTask,
  Run,
  RunOverview,
  Task,
} from "./types";

type WatchdogSnapshotInboxEvents = WatchdogSnapshotInput["inboxEvents"];
type WatchdogSnapshotScheduledReviews = WatchdogSnapshotInput["scheduledReviews"];

export interface UnintegratedVerifiedWorker {
  taskId: string;
  role: string;
  verifierTaskId: string;
  changedFiles: string[];
}

export interface IntegrationReadiness {
  unintegrated: UnintegratedVerifiedWorker[];
  integratedWorkerTaskIds: ReadonlySet<string>;
}

export type HarnessAction =
  | { type: "reclaimRunningTasks"; runId: string; reason?: string }
  | { type: "retryTask"; taskId: string; reason?: string }
  | { type: "markRunTodo"; runId: string; reason?: string }
  | {
      type: "updateRunContext";
      runId: string;
      contextPatch: Record<string, unknown>;
      goal?: string;
      status?: "todo" | "running" | "done" | "blocked";
      reason?: string;
    }
  | { type: "retireRun"; runId: string; reason: string }
  | { type: "prepareRunDrain"; runId: string; maxTries?: number; reason?: string }
  | { type: "completeSystemTask"; taskId: string; actionEventId: string; reason?: string }
  | {
      type: "integrateVerifiedRun";
      runId: string;
      workerTaskId?: string;
      repoPath?: string;
      targetBranch?: string;
      commitMessage?: string;
      push?: boolean;
      integrationClosure?: Record<string, unknown>;
      reason?: string;
      /** Treat the linked design proposal's outcome review as due immediately. */
      immediateOutcomeReview?: boolean;
    }
  | {
      type: "pushExactGitRef";
      runId: string;
      contractId: string;
      repoPath: string;
      remoteHost: string;
      repository: string;
      ref: string;
      expectedOldSha: string;
      newSha: string;
      reason?: string;
    }
  | {
      type: "createExactGitRef";
      runId: string;
      contractId: string;
      repoPath: string;
      remoteHost: string;
      repository: string;
      ref: string;
      newSha: string;
      expectedAbsent: true;
    }
  | {
      type: "commitExactGitIndex";
      contractId: string;
      runId: string;
      taskId: string;
      repoPath: string;
      branch: string;
      expectedParentSha: string;
      commitMessage: string;
      files: ExactGitIndexFile[];
    }
  | { type: "registerEvolutionProfile"; runId: string; profile: EvolutionProfile }
  | { type: "recordProductionEpisode"; runId: string; episode: ProductionEpisode }
  | { type: "registerHarnessVariant"; runId: string; variant: HarnessVariant }
  | { type: "freezeMatchedExperiment"; runId: string; experiment: MatchedExperiment }
  | {
      type: "interruptAttemptAndCreateTask";
      attemptId: string;
      reason: string;
      followUpTask: {
        role: string;
        goal: string;
        prompt: string;
        doneWhen?: string[];
      };
    }
  | {
      type: "interruptRunningAttemptsAndCreateTask";
      attemptIds: string[];
      reason: string;
      followUpTask: {
        role: string;
        goal: string;
        prompt: string;
        doneWhen?: string[];
      };
    }
  | {
      type: "acceptGuardrailProposal";
      runId: string;
      proposalId: string;
      acceptedBy: string;
      reason?: string;
    }
  | {
      type: "amendRunContract";
      runId: string;
      contractKey: string;
      value: unknown;
      version: number;
      expectedVersion?: number;
      reason?: string;
    }
  | {
      type: "startSubsession";
      parentTaskId: string;
      purpose: string;
      prompt: string;
      role?: string;
      backend?: string;
      sessionName?: string;
      timeoutMs?: number;
      idleTimeoutMs?: number;
    }
  | {
      type: "collectSubsessions";
      parentTaskId: string;
      status?: ExecutionThreadStatusFilter;
      reason?: string;
    }
  | {
      type: "cancelSubsessions";
      parentTaskId: string;
      threadIds?: string[];
      reason: string;
    }
  | {
      type: "runWatchdogPass";
      rootRunId: string;
      now?: number;
      daemonIntervalMs?: number;
      inboxEvents?: Array<{ id: string; status: string; provider: string; eventType: string }>;
      scheduledReviews?: Array<{ runId: string; reviewAt: string | null }>;
      reason?: string;
    };

export type ExecutionThreadStatusFilter = "running" | "done" | "blocked" | "interrupted" | "orphaned";

export type SubsessionAction = Extract<HarnessAction, { type: "startSubsession" | "collectSubsessions" | "cancelSubsessions" }>;

export interface ContractAmendmentEntry {
  contractKey: string;
  version: number;
  previousValue: unknown;
  value: unknown;
  reason: string | null;
  amendedAt: string;
}

export interface SubsessionRunnerStartInput {
  threadId: string;
  parentTaskId: string;
  parentAttemptId: string | null;
  parentThreadId: string | null;
  runId: string;
  worktreePath: string;
  sessionName: string;
  purpose: string;
  prompt: string;
  role: string;
  backend: ResolvedSubsessionBackend;
  timeoutMs: number;
  idleTimeoutMs: number;
}

export interface SubsessionRunnerStartResult {
  threadId: string;
  sessionName: string;
  agentSessionId?: string | null;
  pid?: number | null;
  status: ExecutionThreadStatusFilter;
  summary?: string;
  message?: string;
  checks?: HarnessActionResult["checks"];
  artifacts?: HarnessActionResult["artifacts"];
  problems?: string[];
}

export interface SubsessionRunnerCollectChild {
  threadId: string;
  sessionName: string | null;
  agentSessionId: string | null;
  backend: ResolvedSubsessionBackend;
  worktreePath: string;
}

export interface SubsessionRunnerCollectResult {
  threadId: string;
  status: ExecutionThreadStatusFilter;
  summary: string;
  agentSessionId?: string | null;
}

export interface SubsessionRunnerCancelChild {
  threadId: string;
  sessionName: string | null;
  agentSessionId: string | null;
  backend: ResolvedSubsessionBackend;
  worktreePath: string;
}

export interface SubsessionRunnerCancelResult {
  threadId: string;
  canceled: boolean;
  message?: string;
}

export interface ResolvedSubsessionBackend {
  id: string;
  kind: string;
  agent?: string;
  agentCommand?: string;
  approval?: string;
  format?: string;
}

export interface SubsessionRunner {
  start(input: SubsessionRunnerStartInput): SubsessionRunnerStartResult;
  collect(children: SubsessionRunnerCollectChild[]): SubsessionRunnerCollectResult[];
  cancel(children: SubsessionRunnerCancelChild[], reason: string): SubsessionRunnerCancelResult[];
}

export interface HarnessActionResult {
  status: "done" | "blocked";
  actionType: HarnessAction["type"] | "invalid";
  summary: string;
  checks: Array<{ name: string; status: "passed" | "failed"; evidence?: string }>;
  artifacts: Array<Record<string, unknown>>;
  problems: string[];
}

export interface HarnessActionOptions {
  runGit?: GitRunner;
  runCommand?: CommandRunner;
  subsessionRunner?: SubsessionRunner;
}

interface GitCommandInput {
  cwd: string;
  args: string[];
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

interface GitCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

type GitRunner = (input: GitCommandInput) => GitCommandResult;

interface CommandRunnerInput {
  cwd: string;
  command: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

interface CommandRunnerResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

type CommandRunner = (input: CommandRunnerInput) => CommandRunnerResult;

interface IntegrationClosureState {
  receipt?: Record<string, unknown>;
  materializedFiles?: Array<{ path: string; content: Buffer; mode: number }>;
  git?: GitRunner;
}

const MAX_INTEGRATION_CLOSURE_PATHS = 256;
const MAX_INTEGRATION_CLOSURE_FILE_BYTES = 8 * 1024 * 1024;
const MAX_INTEGRATION_CLOSURE_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_INTEGRATION_CLOSURE_COMMANDS = 32;
const MAX_INTEGRATION_CLOSURE_COMMAND_BYTES = 4096;
const INTEGRATION_CLOSURE_FIELDS = new Set([
  "targetBaseSha",
  "sourceTaskIds",
  "sourceAttemptIds",
  "paths",
  "pathHashes",
  "verifierTaskId",
  "frozenCommands",
  "evaluationContract",
  "evaluationContractSha256",
  "manifestHash",
]);

interface ExactGitIndexFile {
  status: "A";
  path: string;
  mode: "100644";
  blobOid: string;
}

const EXACT_GIT_INDEX_MAX_FILES = 256;
const EXACT_GIT_INDEX_MAX_PATH_BYTES = 1024;
const EXACT_GIT_INDEX_MAX_COMMIT_MESSAGE_BYTES = 4096;
const EXACT_GIT_REMOTE_TIMEOUT_MS = 30_000;
const EXACT_GIT_REMOTE_MAX_OUTPUT_BYTES = 24 * 1024;
const FROZEN_DESIGN_CONTEXT_KEYS = new Set([
  "source",
  "projectId",
  "designProposalId",
  "designDecisionId",
  "designProposal",
  "designCharterId",
  "evolutionPack",
  "causalHypothesis",
  "comparison",
  "evolutionComparison",
  "evolutionInstance",
  "evaluationContract",
  "designEvaluationContract",
  "linearIntake",
]);

function frozenDesignContextKeys(keys: Iterable<string>): string[] {
  return [...keys].filter((key) => FROZEN_DESIGN_CONTEXT_KEYS.has(key)).sort();
}

// Bump when integration preflight semantics change so a previously converged
// blocked action is re-evaluated under the new contract.
const INTEGRATION_CONTRACT_VERSION = 3;

export function parseHarnessAction(value: unknown): HarnessAction {
  const record = objectRecord(value, "harness action");
  const type = stringField(record, "type");
  if (type === "reclaimRunningTasks") {
    return { type, runId: stringField(record, "runId"), reason: optionalStringField(record, "reason") };
  }
  if (type === "retryTask") {
    return { type, taskId: stringField(record, "taskId"), reason: optionalStringField(record, "reason") };
  }
  if (type === "markRunTodo") {
    return { type, runId: stringField(record, "runId"), reason: optionalStringField(record, "reason") };
  }
  if (type === "updateRunContext") {
    return {
      type,
      runId: stringField(record, "runId"),
      contextPatch: objectRecord(record["contextPatch"], "contextPatch"),
      goal: optionalStringField(record, "goal"),
      status: optionalStatusField(record, "status"),
      reason: optionalStringField(record, "reason"),
    };
  }
  if (type === "retireRun") {
    return { type, runId: stringField(record, "runId"), reason: stringField(record, "reason") };
  }
  if (type === "prepareRunDrain") {
    return {
      type,
      runId: stringField(record, "runId"),
      maxTries: optionalPositiveInteger(record, "maxTries"),
      reason: optionalStringField(record, "reason"),
    };
  }
  if (type === "completeSystemTask") {
    return {
      type,
      taskId: stringField(record, "taskId"),
      actionEventId: stringField(record, "actionEventId"),
      reason: optionalStringField(record, "reason"),
    };
  }
  if (type === "integrateVerifiedRun") {
    const push = optionalBooleanField(record, "push");
    if (push === true) {
      throw new Error("integrateVerifiedRun push is disabled; freeze and invoke pushExactGitRef instead");
    }
    return {
      type,
      runId: stringField(record, "runId"),
      workerTaskId: optionalStringField(record, "workerTaskId"),
      repoPath: optionalStringField(record, "repoPath"),
      targetBranch: optionalStringField(record, "targetBranch"),
      commitMessage: optionalStringField(record, "commitMessage"),
      push,
      integrationClosure: optionalObjectField(record, "integrationClosure"),
      reason: optionalStringField(record, "reason"),
      immediateOutcomeReview: optionalBooleanField(record, "immediateOutcomeReview"),
    };
  }
  if (type === "pushExactGitRef") {
    assertOnlyFields(record, type, [
      "type",
      "runId",
      "contractId",
      "repoPath",
      "remoteHost",
      "repository",
      "ref",
      "expectedOldSha",
      "newSha",
      "reason",
    ]);
    return {
      type,
      runId: stringField(record, "runId"),
      contractId: safeIdentifierField(record, "contractId"),
      repoPath: absolutePathField(record, "repoPath"),
      remoteHost: gitRemoteHostField(record, "remoteHost"),
      repository: gitRepositoryField(record, "repository"),
      ref: gitBranchRefField(record, "ref"),
      expectedOldSha: gitCommitShaField(record, "expectedOldSha"),
      newSha: gitCommitShaField(record, "newSha"),
      reason: optionalStringField(record, "reason"),
    };
  }
  if (type === "createExactGitRef") {
    assertOnlyFields(record, type, [
      "type",
      "runId",
      "contractId",
      "repoPath",
      "remoteHost",
      "repository",
      "ref",
      "newSha",
      "expectedAbsent",
    ]);
    if (record.expectedAbsent !== true) {
      throw new Error("expectedAbsent must be true");
    }
    return {
      type,
      runId: exactNonEmptyStringField(record, "runId"),
      contractId: exactSafeIdentifierField(record, "contractId"),
      repoPath: exactAbsolutePathField(record, "repoPath"),
      remoteHost: exactGitRemoteHostField(record, "remoteHost"),
      repository: exactGitRepositoryField(record, "repository"),
      ref: exactCreatableBranchRefField(record, "ref"),
      newSha: exactGitCommitShaField(record, "newSha"),
      expectedAbsent: true,
    };
  }
  if (type === "commitExactGitIndex") {
    assertOnlyFields(record, type, [
      "type",
      "contractId",
      "runId",
      "taskId",
      "repoPath",
      "branch",
      "expectedParentSha",
      "commitMessage",
      "files",
    ]);
    return {
      type,
      contractId: exactSafeIdentifierField(record, "contractId"),
      runId: exactNonEmptyStringField(record, "runId"),
      taskId: exactNonEmptyStringField(record, "taskId"),
      repoPath: exactAbsolutePathField(record, "repoPath"),
      branch: exactGitBranchField(record, "branch"),
      expectedParentSha: exactGitCommitShaField(record, "expectedParentSha"),
      commitMessage: exactCommitMessageField(record, "commitMessage"),
      files: exactGitIndexFilesField(record, "files"),
    };
  }
  if (type === "registerEvolutionProfile") {
    assertOnlyFields(record, type, ["type", "runId", "profile"]);
    const runId = exactNonEmptyStringField(record, "runId");
    const profileRecord = objectRecord(record.profile, "profile");
    const projectId = exactNonEmptyStringField(profileRecord, "projectId");
    return { type, runId, profile: parseEvolutionProfile(profileRecord, projectId, "profile") };
  }
  if (type === "recordProductionEpisode") {
    assertOnlyFields(record, type, ["type", "runId", "episode"]);
    const runId = exactNonEmptyStringField(record, "runId");
    const episodeRecord = objectRecord(record.episode, "episode");
    const projectId = exactNonEmptyStringField(episodeRecord, "projectId");
    return { type, runId, episode: parseProductionEpisode(episodeRecord, projectId, "episode") };
  }
  if (type === "registerHarnessVariant") {
    assertOnlyFields(record, type, ["type", "runId", "variant"]);
    const runId = exactNonEmptyStringField(record, "runId");
    const variantRecord = objectRecord(record.variant, "variant");
    const projectId = exactNonEmptyStringField(variantRecord, "projectId");
    return { type, runId, variant: parseHarnessVariant(variantRecord, projectId, "variant") };
  }
  if (type === "freezeMatchedExperiment") {
    assertOnlyFields(record, type, ["type", "runId", "experiment"]);
    const runId = exactNonEmptyStringField(record, "runId");
    const experimentRecord = objectRecord(record.experiment, "experiment");
    const projectId = exactNonEmptyStringField(experimentRecord, "projectId");
    return { type, runId, experiment: parseMatchedExperiment(experimentRecord, projectId, "experiment") };
  }
  if (type === "interruptAttemptAndCreateTask") {
    return {
      type,
      attemptId: stringField(record, "attemptId"),
      reason: stringField(record, "reason"),
      followUpTask: followUpTaskField(record, "followUpTask"),
    };
  }
  if (type === "interruptRunningAttemptsAndCreateTask") {
    return {
      type,
      attemptIds: stringArrayField(record, "attemptIds"),
      reason: stringField(record, "reason"),
      followUpTask: followUpTaskField(record, "followUpTask"),
    };
  }
  if (type === "acceptGuardrailProposal") {
    return {
      type,
      runId: stringField(record, "runId"),
      proposalId: stringField(record, "proposalId"),
      acceptedBy: stringField(record, "acceptedBy"),
      reason: optionalStringField(record, "reason"),
    };
  }
  if (type === "amendRunContract") {
    return {
      type,
      runId: stringField(record, "runId"),
      contractKey: stringField(record, "contractKey"),
      value: requiredValueField(record, "value"),
      version: positiveIntegerField(record, "version"),
      expectedVersion: optionalNonNegativeIntegerField(record, "expectedVersion"),
      reason: optionalStringField(record, "reason"),
    };
  }
  if (type === "startSubsession") {
    return {
      type,
      parentTaskId: stringField(record, "parentTaskId"),
      purpose: stringField(record, "purpose"),
      prompt: stringField(record, "prompt"),
      role: optionalStringField(record, "role"),
      backend: optionalStringField(record, "backend"),
      sessionName: optionalStringField(record, "sessionName"),
      timeoutMs: optionalPositiveInteger(record, "timeoutMs"),
      idleTimeoutMs: optionalPositiveInteger(record, "idleTimeoutMs"),
    };
  }
  if (type === "collectSubsessions") {
    return {
      type,
      parentTaskId: stringField(record, "parentTaskId"),
      status: optionalThreadStatusFilter(record, "status"),
      reason: optionalStringField(record, "reason"),
    };
  }
  if (type === "cancelSubsessions") {
    return {
      type,
      parentTaskId: stringField(record, "parentTaskId"),
      threadIds: optionalStringArrayField(record, "threadIds"),
      reason: stringField(record, "reason"),
    };
  }
  if (type === "runWatchdogPass") {
    return {
      type,
      rootRunId: stringField(record, "rootRunId"),
      now: optionalPositiveInteger(record, "now") ?? undefined,
      daemonIntervalMs: optionalPositiveInteger(record, "daemonIntervalMs") ?? undefined,
      inboxEvents: optionalWatchdogEventsField(record["inboxEvents"]),
      scheduledReviews: optionalWatchdogReviewsField(record["scheduledReviews"]),
      reason: optionalStringField(record, "reason"),
    };
  }
  throw new Error(
    "harness action type must be reclaimRunningTasks, retryTask, markRunTodo, updateRunContext, amendRunContract, retireRun, prepareRunDrain, completeSystemTask, integrateVerifiedRun, pushExactGitRef, createExactGitRef, commitExactGitIndex, registerEvolutionProfile, recordProductionEpisode, registerHarnessVariant, freezeMatchedExperiment, interruptAttemptAndCreateTask, interruptRunningAttemptsAndCreateTask, acceptGuardrailProposal, startSubsession, collectSubsessions, cancelSubsessions, or runWatchdogPass",
  );
}

export function applyHarnessAction(
  harness: Harness,
  rawAction: unknown,
  options: HarnessActionOptions = {},
): HarnessActionResult & { eventId: string } {
  let action: HarnessAction;
  try {
    action = parseHarnessAction(rawAction);
  } catch (error) {
    const result = blockedResult("invalid", `Invalid harness action: ${errorMessage(error)}`, [errorMessage(error)]);
    const eventId = harness.recordHarnessActionEvent({
      actionType: "invalid",
      status: result.status,
      request: safeRequest(rawAction),
      result: resultToRecord(result),
    });
    return { ...result, eventId };
  }

  if (action.type === "startSubsession" || action.type === "collectSubsessions" || action.type === "cancelSubsessions") {
    const result = applySubsessionAction(harness, action, options);
    const eventId = recordSubsessionEvent(harness, action, result);
    return { ...result, eventId };
  }

  if (isEvolutionAction(action)) {
    return applyEvolutionActionAtomically(harness, action);
  }

  if (action.type === "integrateVerifiedRun") {
    const replay = findIntegrationReplay(harness, action, options);
    if (replay) {
      return replay;
    }
  }

  const result = applyParsedHarnessAction(harness, action, options);
  const eventId = harness.recordHarnessActionEvent({
    actionType: action.type,
    status: result.status,
    request: safeRequest(action),
    result: resultToRecord(result),
  });
  if (action.type === "integrateVerifiedRun") {
    if (result.status === "blocked") {
      recordIntegrationConvergence(harness, action, options, eventId);
    } else if (result.artifacts.some((artifact) => artifact.kind === "integration")) {
      recordIntegrationConvergence(harness, action, options, eventId);
    }
  }
  return { ...result, eventId };
}

type EvolutionAction = Extract<
  HarnessAction,
  {
    type:
      | "registerEvolutionProfile"
      | "recordProductionEpisode"
      | "registerHarnessVariant"
      | "freezeMatchedExperiment";
  }
>;

function isEvolutionAction(action: HarnessAction): action is EvolutionAction {
  return action.type === "registerEvolutionProfile"
    || action.type === "recordProductionEpisode"
    || action.type === "registerHarnessVariant"
    || action.type === "freezeMatchedExperiment";
}

function applyEvolutionActionAtomically(
  harness: Harness,
  action: EvolutionAction,
): HarnessActionResult & { eventId: string } {
  const recordValidatedSuccess = (
    db: HarnessDatabase,
    applied: { result: HarnessActionResult; frozen: FrozenEvolutionActionContext },
  ) => {
    if (action.type === "recordProductionEpisode") {
      throw new Error("recordProductionEpisode is not eligible to mint an evolution action receipt");
    }
    if (applied.result.status !== "done" || applied.result.actionType !== action.type) {
      throw new Error(`${action.type} validated result is not eligible to mint an evolution action receipt`);
    }
    const eventId = makeId("action");
    const record = evolutionActionRecord(action);
    const recordKind = evolutionActionEntityKind(action);
    if (recordKind === "episode") {
      throw new Error("production episodes are not eligible to mint evolution action receipts");
    }
    const recordSha256 = canonicalEvolutionRecordSha256(record);
    db.query(`
      insert into harness_action_events (id, action_type, status, request_json, result_json)
      values ($id, $actionType, 'done', $requestJson, $resultJson)
    `).run({
      $id: eventId,
      $actionType: action.type,
      $requestJson: JSON.stringify(evolutionActionAuditRequest(action)),
      $resultJson: JSON.stringify(resultToRecord(applied.result)),
    });
    db.query(`
      insert into evolution_action_receipts (
        action_event_id, action_type, source_run_id, project_id,
        design_proposal_id, design_decision_id, design_charter_id,
        record_kind, record_id, record_sha256,
        profile_id, episode_id, variant_id, experiment_id
      ) values (
        $actionEventId, $actionType, $sourceRunId, $projectId,
        $designProposalId, $designDecisionId, $designCharterId,
        $recordKind, $recordId, $recordSha256,
        $profileId, null, $variantId, $experimentId
      )
    `).run({
      $actionEventId: eventId,
      $actionType: action.type,
      $sourceRunId: action.runId,
      $projectId: record.projectId,
      $designProposalId: applied.frozen.proposalId,
      $designDecisionId: applied.frozen.authorityDecisionId,
      $designCharterId: applied.frozen.charter.id,
      $recordKind: recordKind,
      $recordId: record.id,
      $recordSha256: recordSha256,
      $profileId: recordKind === "profile" ? record.id : null,
      $variantId: recordKind === "variant" ? record.id : null,
      $experimentId: recordKind === "experiment" ? record.id : null,
    });
    return eventId;
  };
  try {
    return harness.runInTransaction((db) => {
      const applied = applyEvolutionActionWithDb(harness, db, action);
      const result = applied.result;
      const eventId = recordValidatedSuccess(db, applied);
      return { ...result, eventId };
    });
  } catch (error) {
    const problem = limitUtf8Output(sanitizeEvolutionErrorText(errorMessage(error)), 4_096);
    const result = blockedResult(action.type, `${action.type} blocked: ${problem}`, [problem]);
    const eventId = harness.recordHarnessActionEvent({
      actionType: action.type,
      status: "blocked",
      request: evolutionActionAuditRequest(action),
      result: resultToRecord(result),
    });
    return { ...result, eventId };
  }
}

function sanitizeEvolutionErrorText(value: string) {
  return sanitizeGitRemoteText(value)
    .replace(/\b(?:lin_api|lin_oauth)[_-][A-Za-z0-9._-]+\b/gi, "[REDACTED]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(
      /(\b(?:api[\s_-]*key|access[\s_-]*token|refresh[\s_-]*token|token|secret|password|credential)\b\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\])]+)/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(\b(?:access[\s_-]*token|refresh[\s_-]*token|token|secret|password|credential)\b\s+)(?=[^\s,;}\])]*[._~+\/-])[^\s,;}\])]+/gi,
      "$1[REDACTED]",
    );
}

function applyEvolutionActionWithDb(
  harness: Harness,
  db: HarnessDatabase,
  action: EvolutionAction,
): { result: HarnessActionResult; frozen: FrozenEvolutionActionContext } {
  const run = harness.getRunWithDb(db, action.runId);
  if (!run) {
    throw new Error(`run not found: ${action.runId}`);
  }
  if (!run.projectId) {
    throw new Error(`evolution action requires a project-bound run: ${action.runId}`);
  }
  const record = evolutionActionRecord(action);
  if (record.projectId !== run.projectId) {
    throw new Error(
      `evolution action project mismatch: run ${action.runId} belongs to ${run.projectId}; record belongs to ${record.projectId}`,
    );
  }
  const frozen = frozenEvolutionContext(harness, db, run, action.type);
  if (action.type !== "recordProductionEpisode") {
    validateEvolutionActionReplayReceipt(harness, db, action, frozen);
  }

  let entityKind: "profile" | "episode" | "variant" | "experiment";
  let artifactKind: "evolution_profile" | "production_episode" | "harness_variant" | "matched_experiment";
  let stored: EvolutionProfile | ProductionEpisode | HarnessVariant | MatchedExperiment;
  let replayed: boolean;

  if (action.type === "registerEvolutionProfile") {
    validateRegisterEvolutionProfileAction(action.profile, frozen);
    const write = harness.recordEvolutionProfileWithDb(db, action.profile);
    entityKind = "profile";
    artifactKind = "evolution_profile";
    stored = write.record;
    replayed = write.reused;
  } else if (action.type === "recordProductionEpisode") {
    validateProductionEpisodeAction(harness, db, action.episode, frozen);
    const write = harness.recordProductionEpisodeWithDb(db, action.episode);
    entityKind = "episode";
    artifactKind = "production_episode";
    stored = write.record;
    replayed = write.reused;
  } else if (action.type === "registerHarnessVariant") {
    validateHarnessVariantAction(harness, db, action.variant, frozen);
    const write = harness.recordHarnessVariantWithDb(db, action.variant);
    entityKind = "variant";
    artifactKind = "harness_variant";
    stored = write.record;
    replayed = write.reused;
  } else {
    validateMatchedExperimentAction(harness, db, action.experiment, frozen);
    const write = harness.recordMatchedExperimentWithDb(db, action.experiment);
    entityKind = "experiment";
    artifactKind = "matched_experiment";
    stored = write.record;
    replayed = write.reused;
  }

  const transactionalReadback = evolutionActionReadback(harness, db, action);
  if (!transactionalReadback) {
    throw new Error(`${action.type} transactional readback missing for ${record.id}`);
  }
  stored = transactionalReadback;
  const recordSha256 = canonicalEvolutionRecordSha256(stored);
  const expectedSha256 = canonicalEvolutionRecordSha256(record);
  if (recordSha256 !== expectedSha256 || stored.id !== record.id) {
    throw new Error(`${action.type} transactional readback mismatch for ${record.id}`);
  }
  return {
    frozen,
    result: doneResult(
      action.type,
      `${replayed ? "Reused" : "Recorded"} ${entityKind} ${stored.id}.`,
      [
        { name: "source run project", status: "passed", evidence: run.projectId },
        { name: "accepted design proposal", status: "passed", evidence: frozen.proposalId },
        { name: "approved authority decision", status: "passed", evidence: frozen.authorityDecisionId },
        { name: "transactional record readback", status: "passed", evidence: recordSha256 },
      ],
      [{
        kind: artifactKind,
        entityKind,
        recordId: stored.id,
        recordSha256,
        projectId: run.projectId,
        runId: run.id,
        sourceRunId: run.id,
        replayed,
        externalEffectsApplied: false,
        promotionApplied: false,
      }],
    ),
  };
}

function validateEvolutionActionReplayReceipt(
  harness: Harness,
  db: HarnessDatabase,
  action: EvolutionAction,
  frozen: FrozenEvolutionActionContext,
) {
  const existing = evolutionActionReadback(harness, db, action);
  if (!existing) return;
  const record = evolutionActionRecord(action);
  const recordSha256 = canonicalEvolutionRecordSha256(existing);
  if (recordSha256 !== canonicalEvolutionRecordSha256(record)) {
    throw new Error(`${action.type} existing record digest mismatch for ${record.id}`);
  }
  requireEvolutionActionReceipt(db, {
    projectId: record.projectId,
    recordKind: evolutionActionEntityKind(action),
    recordId: record.id,
    recordSha256,
  }, frozen);
}

function evolutionActionReadback(harness: Harness, db: HarnessDatabase, action: EvolutionAction) {
  const record = evolutionActionRecord(action);
  const input = { projectId: record.projectId, id: record.id };
  if (action.type === "registerEvolutionProfile") return harness.getEvolutionProfileWithDb(db, input);
  if (action.type === "recordProductionEpisode") return harness.getProductionEpisodeWithDb(db, input);
  if (action.type === "registerHarnessVariant") return harness.getHarnessVariantWithDb(db, input);
  return harness.getMatchedExperimentWithDb(db, input);
}

function evolutionActionRecord(action: EvolutionAction) {
  if (action.type === "registerEvolutionProfile") return action.profile;
  if (action.type === "recordProductionEpisode") return action.episode;
  if (action.type === "registerHarnessVariant") return action.variant;
  return action.experiment;
}

function evolutionActionAuditRequest(action: EvolutionAction) {
  const record = evolutionActionRecord(action);
  return {
    type: action.type,
    runId: action.runId,
    entityKind: evolutionActionEntityKind(action),
    recordId: record.id,
    recordSha256: canonicalEvolutionRecordSha256(record),
  };
}

function evolutionActionEntityKind(action: EvolutionAction): "profile" | "episode" | "variant" | "experiment" {
  if (action.type === "registerEvolutionProfile") return "profile";
  if (action.type === "recordProductionEpisode") return "episode";
  if (action.type === "registerHarnessVariant") return "variant";
  return "experiment";
}

interface FrozenEvolutionActionContext {
  pack: EvolutionPackV1;
  comparison: EvolutionComparison;
  proposalId: string;
  authorityDecisionId: string;
  charter: {
    id: string;
    version: number;
    contentSha256: string;
  };
}

function frozenEvolutionContext(
  harness: Harness,
  db: HarnessDatabase,
  run: NonNullable<ReturnType<Harness["getRunWithDb"]>>,
  actionType: EvolutionAction["type"],
): FrozenEvolutionActionContext {
  const projectId = run.projectId;
  if (!projectId) {
    throw new Error(`${actionType} requires a project-bound run`);
  }
  if (run.context.source !== "design") {
    throw new Error(`${actionType} requires run.context.source=design`);
  }
  const proposalId = exactContextId(run.context.designProposalId, `${actionType} designProposalId`);
  const charterId = exactContextId(run.context.designCharterId, `${actionType} designCharterId`);
  const proposal = harness.getDesignProposalWithDb(db, { id: proposalId });
  if (!proposal || proposal.status !== "accepted") {
    throw new Error(`${actionType} requires a stored accepted design proposal: ${proposalId}`);
  }
  if (proposal.projectId !== projectId || proposal.charterId !== charterId) {
    throw new Error(`${actionType} proposal project or charter does not match the frozen run binding`);
  }
  const activeCharter = harness.getActiveFounderCharterWithDb(db, { projectId });
  if (!activeCharter || activeCharter.id !== charterId) {
    throw new Error(`${actionType} active charter does not match the frozen designCharterId`);
  }
  const authorityDecision = db.query(`
    select id, charter_id, decision
    from design_decisions
    where proposal_id = $proposalId
    order by rowid desc
    limit 1
  `).get({ $proposalId: proposalId }) as {
    id: string;
    charter_id: string | null;
    decision: string;
  } | null;
  if (!authorityDecision || authorityDecision.decision !== "approved") {
    throw new Error(`${actionType} latest authority decision must be approved`);
  }
  if (authorityDecision.charter_id !== charterId) {
    throw new Error(`${actionType} authority decision charter does not match the frozen design charter`);
  }
  const pack = parseEvolutionPackV1(
    proposal.proposal.evolutionPack,
    projectId,
    `${actionType} accepted proposal evolutionPack`,
  );
  if (pack.objective.charterId !== charterId) {
    throw new Error(`${actionType} pack objective charter does not match the accepted proposal charter`);
  }
  const comparison = parseEvolutionComparison(
    proposal.proposal.evaluationContract.comparison,
    `${actionType} accepted proposal comparison`,
  );
  const causalHypothesis = parseEvolutionCausalHypothesis(
    proposal.proposal.causalHypothesis,
    `${actionType} accepted proposal causalHypothesis`,
  );
  if (run.context.designDecisionId !== authorityDecision.id) {
    throw new Error(`${actionType} designDecisionId does not match the latest approved authority decision`);
  }
  const contextPack = parseEvolutionPackV1(
    run.context.evolutionPack,
    projectId,
    `${actionType} run evolutionPack`,
  );
  if (!sameCanonicalValue(contextPack, pack)) {
    throw new Error(`${actionType} run evolutionPack differs from the accepted proposal`);
  }
  const contextCausalHypothesis = parseEvolutionCausalHypothesis(
    run.context.causalHypothesis,
    `${actionType} run causalHypothesis`,
  );
  if (!sameCanonicalValue(contextCausalHypothesis, causalHypothesis)) {
    throw new Error(`${actionType} run causalHypothesis differs from the accepted proposal`);
  }
  for (const [label, value] of [
    ["comparison", run.context.comparison],
    ["evolutionComparison", run.context.evolutionComparison],
  ] as const) {
    const contextComparison = parseEvolutionComparison(value, `${actionType} run ${label}`);
    if (!sameCanonicalValue(contextComparison, comparison)) {
      throw new Error(`${actionType} run ${label} differs from the accepted proposal`);
    }
  }
  const designEvaluationContract = objectRecord(
    run.context.designEvaluationContract,
    `${actionType} run designEvaluationContract`,
  );
  const contractComparison = parseEvolutionComparison(
    designEvaluationContract.comparison,
    `${actionType} run designEvaluationContract.comparison`,
  );
  if (!sameCanonicalValue(contractComparison, comparison)) {
    throw new Error(`${actionType} run designEvaluationContract comparison differs from the accepted proposal`);
  }
  if (run.context.evaluationContract !== undefined) {
    const evaluationContract = objectRecord(run.context.evaluationContract, `${actionType} run evaluationContract`);
    const duplicateComparison = parseEvolutionComparison(
      evaluationContract.comparison,
      `${actionType} run evaluationContract.comparison`,
    );
    if (!sameCanonicalValue(duplicateComparison, comparison)) {
      throw new Error(`${actionType} run evaluationContract comparison differs from the accepted proposal`);
    }
  }
  const designProposal = objectRecord(run.context.designProposal, `${actionType} run designProposal`);
  if (
    !sameCanonicalValue(
      parseEvolutionPackV1(designProposal.evolutionPack, projectId, `${actionType} run designProposal.evolutionPack`),
      pack,
    )
    || !sameCanonicalValue(
      parseEvolutionCausalHypothesis(designProposal.causalHypothesis, `${actionType} run designProposal.causalHypothesis`),
      causalHypothesis,
    )
  ) {
    throw new Error(`${actionType} run designProposal differs from the stored accepted proposal`);
  }
  const designProposalContract = objectRecord(
    designProposal.evaluationContract,
    `${actionType} run designProposal.evaluationContract`,
  );
  if (!sameCanonicalValue(
    parseEvolutionComparison(
      designProposalContract.comparison,
      `${actionType} run designProposal.evaluationContract.comparison`,
    ),
    comparison,
  )) {
    throw new Error(`${actionType} run designProposal comparison differs from the stored accepted proposal`);
  }
  const instance = parseEvolutionInstance(run.context.evolutionInstance, `${actionType} run evolutionInstance`);
  const packSha256 = canonicalEvolutionValueSha256(pack);
  if (
    instance.targetProjectId !== projectId
    || !instance.pack
    || instance.pack.id !== pack.id
    || instance.pack.version !== pack.version
    || instance.pack.contentSha256 !== packSha256
  ) {
    throw new Error(`${actionType} evolutionInstance does not match the accepted proposal pack and target project`);
  }
  return {
    pack,
    comparison,
    proposalId,
    authorityDecisionId: authorityDecision.id,
    charter: {
      id: activeCharter.id,
      version: activeCharter.version,
      contentSha256: canonicalEvolutionValueSha256(activeCharter.charter),
    },
  };
}

function exactContextId(value: unknown, label: string) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`${label} must be a non-empty exact string`);
  }
  return value;
}

function validateRegisterEvolutionProfileAction(
  profile: EvolutionProfile,
  frozen: FrozenEvolutionActionContext,
) {
  if (profile.runtimeMaturity !== "declared") {
    throw new Error("registerEvolutionProfile accepts only declared runtimeMaturity");
  }
  const expectedPack = {
    id: frozen.pack.id,
    version: frozen.pack.version,
    contentSha256: canonicalEvolutionValueSha256(frozen.pack),
  };
  if (!sameCanonicalValue(profile.pack, expectedPack)) {
    throw new Error("EvolutionProfile pack does not match the frozen run pack");
  }
  if (!sameCanonicalValue(profile.charter, frozen.charter)) {
    throw new Error("EvolutionProfile charter does not match the accepted proposal's active founder charter");
  }
  const expectedSurfaces = frozen.pack.mutationSurfaces.map((surface) => surface.id);
  if (!sameCanonicalValue(profile.allowedSurfaceIds, expectedSurfaces)) {
    throw new Error("EvolutionProfile allowedSurfaceIds must exactly match the frozen pack surfaces");
  }
}

function validateProductionEpisodeAction(
  harness: Harness,
  db: HarnessDatabase,
  episode: ProductionEpisode,
  frozen: FrozenEvolutionActionContext,
) {
  requireEvolutionProfileScope(harness, db, episode.projectId, episode.profileId, frozen);
  const allowedSourceRefs = new Set([
    ...frozen.comparison.developmentEvidenceRefs,
    ...frozen.comparison.holdoutEvidenceRefs,
    ...frozen.comparison.unrelatedEvidenceRefs,
  ]);
  if (!allowedSourceRefs.has(episode.sourceRef)) {
    throw new Error(`ProductionEpisode sourceRef is outside the frozen comparison: ${episode.sourceRef}`);
  }
  if (frozen.comparison.holdoutEvidenceRefs.includes(episode.sourceRef)) {
    if (Object.keys(episode.metrics).length !== 0) {
      throw new Error("heldout ProductionEpisode metrics must remain empty before independent evaluation");
    }
    const expectedReceiptRefs = [episode.privacyReview.reviewerRef];
    if (
      !sameCanonicalValue(episode.evidenceRefs, expectedReceiptRefs)
      || !sameCanonicalValue(episode.privacyReview.evidenceRefs, expectedReceiptRefs)
    ) {
      throw new Error("heldout ProductionEpisode evidence may contain only its privacy review receipt reference");
    }
  }
  throw new Error(
    "recordProductionEpisode requires a host-owned privacy receipt capability that is not implemented",
  );
}

function validateHarnessVariantAction(
  harness: Harness,
  db: HarnessDatabase,
  variant: HarnessVariant,
  frozen: FrozenEvolutionActionContext,
) {
  const profile = requireEvolutionProfileScope(harness, db, variant.projectId, variant.profileId, frozen);
  const surfaceById = new Map(frozen.pack.mutationSurfaces.map((surface) => [surface.id, surface]));
  const selected = variant.mutationSurfaceIds.map((surfaceId) => {
    if (!profile.allowedSurfaceIds.includes(surfaceId)) {
      throw new Error(`HarnessVariant surface is outside the active profile: ${surfaceId}`);
    }
    const surface = surfaceById.get(surfaceId);
    if (!surface) {
      throw new Error(`HarnessVariant surface is outside the frozen pack: ${surfaceId}`);
    }
    return surface;
  });
  const expectedTargets = [...new Set(selected.map((surface) => surface.evolutionTarget))];
  if (!sameCanonicalValue(variant.evolutionTargets, expectedTargets)) {
    throw new Error("HarnessVariant evolutionTargets must match its frozen mutation surfaces");
  }
  for (const path of variant.changedPaths) {
    if (frozen.pack.mutationSurfaces.some((surface) => surface.forbiddenPaths.some((pattern) => evolutionPathMatches(pattern, path)))) {
      throw new Error(`HarnessVariant changed path is forbidden by the frozen pack: ${path}`);
    }
    if (!selected.some((surface) => surface.allowedPaths.some((pattern) => evolutionPathMatches(pattern, path)))) {
      throw new Error(`HarnessVariant changed path is outside selected mutation surfaces: ${path}`);
    }
  }
  if (variant.toolPolicySha256 !== frozen.comparison.equalBudget.toolPolicySha256) {
    throw new Error("HarnessVariant toolPolicySha256 must match the frozen equal budget");
  }
  const allowedEvidence = variant.role === "candidate"
    ? new Set(frozen.comparison.developmentEvidenceRefs)
    : new Set([frozen.comparison.controlRef, ...frozen.comparison.developmentEvidenceRefs]);
  if (variant.createdFromEvidenceRefs.some((reference) => !allowedEvidence.has(reference))) {
    throw new Error(`${variant.role} HarnessVariant may use only its frozen control or development evidence`);
  }
}

function validateMatchedExperimentAction(
  harness: Harness,
  db: HarnessDatabase,
  experiment: MatchedExperiment,
  frozen: FrozenEvolutionActionContext,
) {
  requireEvolutionProfileScope(harness, db, experiment.projectId, experiment.profileId, frozen);
  if (experiment.outcome !== "pending") {
    throw new Error("freezeMatchedExperiment accepts only pending outcome");
  }
  const control = harness.getHarnessVariantWithDb(db, {
    projectId: experiment.projectId,
    id: experiment.controlVariantId,
  });
  const candidate = harness.getHarnessVariantWithDb(db, {
    projectId: experiment.projectId,
    id: experiment.candidateVariantId,
  });
  if (!control || control.profileId !== experiment.profileId || control.role !== "control") {
    throw new Error("MatchedExperiment control variant is missing or invalid");
  }
  if (!candidate || candidate.profileId !== experiment.profileId || candidate.role !== "candidate") {
    throw new Error("MatchedExperiment candidate variant is missing or invalid");
  }
  for (const variant of [control, candidate]) {
    requireEvolutionActionReceipt(db, {
      projectId: experiment.projectId,
      recordKind: "variant",
      recordId: variant.id,
      recordSha256: canonicalEvolutionRecordSha256(variant),
    }, frozen);
  }
  validateExperimentSplit(harness, db, experiment, "development", frozen.comparison.developmentEvidenceRefs, frozen);
  validateExperimentSplit(harness, db, experiment, "heldout", frozen.comparison.holdoutEvidenceRefs, frozen);
  validateExperimentSplit(harness, db, experiment, "unrelated", frozen.comparison.unrelatedEvidenceRefs, frozen);
  validateExperimentLeakageIsolation(harness, db, experiment);
  if (experiment.corpusSnapshotSha256 !== frozen.comparison.corpusSnapshotSha256) {
    throw new Error("MatchedExperiment corpusSnapshotSha256 must match the frozen comparison");
  }
  if (!sameCanonicalValue(experiment.equalBudget, frozen.comparison.equalBudget)) {
    throw new Error("MatchedExperiment equalBudget must match the frozen comparison");
  }
  if (experiment.primaryMetric !== frozen.comparison.primaryMetric) {
    throw new Error("MatchedExperiment primaryMetric must match the frozen comparison");
  }
  if (!sameCanonicalValue(experiment.guardMetrics, frozen.pack.promotionPolicy.guardMetrics)) {
    throw new Error("MatchedExperiment guardMetrics must match the frozen pack");
  }
}

function requireEvolutionProfileScope(
  harness: Harness,
  db: HarnessDatabase,
  projectId: string,
  profileId: string,
  frozen: FrozenEvolutionActionContext,
) {
  const profile = harness.getEvolutionProfileWithDb(db, { projectId, id: profileId });
  if (!profile) {
    throw new Error(`EvolutionProfile not found for project ${projectId}: ${profileId}`);
  }
  requireEvolutionActionReceipt(db, {
    projectId,
    recordKind: "profile",
    recordId: profile.id,
    recordSha256: canonicalEvolutionRecordSha256(profile),
  }, frozen);
  return profile;
}

function requireEvolutionActionReceipt(
  db: HarnessDatabase,
  input: {
    projectId: string;
    recordKind: "profile" | "episode" | "variant" | "experiment";
    recordId: string;
    recordSha256: string;
  },
  frozen: FrozenEvolutionActionContext,
) {
  const expectedActionType = {
    profile: "registerEvolutionProfile",
    episode: "recordProductionEpisode",
    variant: "registerHarnessVariant",
    experiment: "freezeMatchedExperiment",
  }[input.recordKind];
  const receipts = db.query(`
    select receipts.record_sha256 as record_sha256,
           receipts.action_type as receipt_action_type,
           receipts.design_proposal_id as design_proposal_id,
           receipts.design_decision_id as design_decision_id,
           receipts.design_charter_id as design_charter_id,
           events.action_type as event_action_type,
           events.status as event_status
    from evolution_action_receipts receipts
    join harness_action_events events on events.id = receipts.action_event_id
    where receipts.project_id = $projectId
      and receipts.record_kind = $recordKind
      and receipts.record_id = $recordId
    order by receipts.created_at, receipts.action_event_id
  `).all({
    $projectId: input.projectId,
    $recordKind: input.recordKind,
    $recordId: input.recordId,
  }) as Array<{
    record_sha256: string;
    receipt_action_type: string;
    design_proposal_id: string;
    design_decision_id: string;
    design_charter_id: string;
    event_action_type: string;
    event_status: string;
  }>;
  if (receipts.length === 0) {
    throw new Error(
      `${input.recordKind} ${input.recordId} lacks an immutable done evolution action receipt`,
    );
  }
  for (const receipt of receipts) {
    if (
      receipt.receipt_action_type !== expectedActionType
      || receipt.event_action_type !== expectedActionType
      || receipt.event_status !== "done"
    ) {
      throw new Error(
        `${input.recordKind} ${input.recordId} has an invalid evolution action receipt`,
      );
    }
    if (receipt.record_sha256 !== input.recordSha256) {
      throw new Error(
        `${input.recordKind} ${input.recordId} evolution action receipt digest mismatch`,
      );
    }
    if (
      receipt.design_proposal_id !== frozen.proposalId
      || receipt.design_decision_id !== frozen.authorityDecisionId
      || receipt.design_charter_id !== frozen.charter.id
    ) {
      throw new Error(
        `${input.recordKind} ${input.recordId} evolution action receipt authorization provenance mismatch`,
      );
    }
  }
}

function validateExperimentSplit(
  harness: Harness,
  db: HarnessDatabase,
  experiment: MatchedExperiment,
  split: "development" | "heldout" | "unrelated",
  expectedSourceRefs: string[],
  frozen: FrozenEvolutionActionContext,
) {
  const episodeIds = split === "development"
    ? experiment.developmentEpisodeRefs
    : split === "heldout"
      ? experiment.heldoutEpisodeRefs
      : experiment.unrelatedEpisodeRefs;
  const episodes = episodeIds.map((id) => {
    const episode = harness.getProductionEpisodeWithDb(db, { projectId: experiment.projectId, id });
    if (!episode || episode.profileId !== experiment.profileId) {
      throw new Error(`MatchedExperiment ${split} episode is missing or outside the profile: ${id}`);
    }
    requireEvolutionActionReceipt(db, {
      projectId: experiment.projectId,
      recordKind: "episode",
      recordId: episode.id,
      recordSha256: canonicalEvolutionRecordSha256(episode),
    }, frozen);
    return episode;
  });
  if (!sameCanonicalValue(episodes.map((episode) => episode.sourceRef), expectedSourceRefs)) {
    throw new Error(`MatchedExperiment ${split} episode sources must exactly match the frozen comparison`);
  }
}

function validateExperimentLeakageIsolation(
  harness: Harness,
  db: HarnessDatabase,
  experiment: MatchedExperiment,
) {
  const observed = new Map<string, string>();
  const splits = [
    ["development", experiment.developmentEpisodeRefs],
    ["heldout", experiment.heldoutEpisodeRefs],
    ["unrelated", experiment.unrelatedEpisodeRefs],
  ] as const;
  for (const [split, ids] of splits) {
    for (const id of ids) {
      const episode = harness.getProductionEpisodeWithDb(db, { projectId: experiment.projectId, id });
      if (!episode) throw new Error(`MatchedExperiment episode not found: ${id}`);
      for (const [kind, value] of [
        ["snapshot", episode.inputSnapshotSha256],
        ["snapshot", episode.outcomeSnapshotSha256],
        ["leakage group", episode.leakageGroupId],
      ] as const) {
        const key = `${kind}:${value}`;
        const prior = observed.get(key);
        if (prior && prior !== split) {
          throw new Error(`MatchedExperiment ${kind} crosses ${prior} and ${split} splits`);
        }
        observed.set(key, split);
      }
    }
  }
}

function evolutionPathMatches(pattern: string, path: string): boolean {
  return new Bun.Glob(pattern).match(path);
}

function sameCanonicalValue(left: unknown, right: unknown): boolean {
  return canonicalEvolutionValueSha256(left) === canonicalEvolutionValueSha256(right);
}

type IntegrationConvergenceRecord = {
  operationKey: string;
  actionEventId: string;
  recordedAt: string;
};

function findIntegrationReplay(
  harness: Harness,
  action: Extract<HarnessAction, { type: "integrateVerifiedRun" }>,
  options: HarnessActionOptions,
): (HarnessActionResult & { eventId: string }) | null {
  const operation = integrationOperationKey(harness, action, options.runGit ?? defaultGitRunner);
  if (!operation) {
    return null;
  }
  const records = integrationConvergenceRecords(harness, action.runId);
  const record = records[operation.slot];
  if (!record || record.operationKey !== operation.key) {
    return null;
  }
  const event = harness.getHarnessActionEvent({ id: record.actionEventId });
  if (!event || (event.status !== "blocked" && event.status !== "done") || event.actionType !== "integrateVerifiedRun") {
    return null;
  }
  const result = event.result as unknown as HarnessActionResult;
  if (event.status !== "done") {
    return { ...result, eventId: event.id };
  }
  return {
    ...result,
    summary: `Verified task ${action.workerTaskId ?? "worker"} is already integrated into ${action.targetBranch ?? "main"}.`,
    artifacts: result.artifacts.map((artifact) =>
      artifact.kind === "integration" ? { ...artifact, alreadyMerged: true } : artifact,
    ),
    eventId: event.id,
  };
}

function recordIntegrationConvergence(
  harness: Harness,
  action: Extract<HarnessAction, { type: "integrateVerifiedRun" }>,
  options: HarnessActionOptions,
  actionEventId: string,
) {
  const operation = integrationOperationKey(harness, action, options.runGit ?? defaultGitRunner);
  if (!operation) {
    return;
  }
  const records = integrationConvergenceRecords(harness, action.runId);
  harness.updateRun({
    runId: action.runId,
    contextPatch: {
      integrationConvergence: {
        ...records,
        [operation.slot]: {
          operationKey: operation.key,
          actionEventId,
          recordedAt: new Date().toISOString(),
        },
      },
    },
  });
}

function integrationConvergenceRecords(harness: Harness, runId: string) {
  const raw = harness.getRun(runId)?.context.integrationConvergence;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {} as Record<string, IntegrationConvergenceRecord>;
  }
  return raw as Record<string, IntegrationConvergenceRecord>;
}

function applyParsedHarnessAction(
  harness: Harness,
  action: Exclude<HarnessAction, SubsessionAction | EvolutionAction>,
  options: HarnessActionOptions,
): HarnessActionResult {
  if (action.type === "reclaimRunningTasks") {
    const run = harness.getRun(action.runId);
    if (!run) {
      return blockedResult(action.type, `Run not found: ${action.runId}`, [`run not found: ${action.runId}`]);
    }
    const reclaimed = harness.reclaimRunningTasksWithoutAttempts({ runId: action.runId });
    return doneResult(action.type, `Reclaimed ${reclaimed.length} running task lease${reclaimed.length === 1 ? "" : "s"}.`, [
      { name: "run exists", status: "passed", evidence: action.runId },
      { name: "orphaned leases reclaimed", status: "passed", evidence: String(reclaimed.length) },
    ], reclaimedArtifacts(reclaimed));
  }

  if (action.type === "retryTask") {
    const task = harness.getTask(action.taskId);
    if (!task) {
      return blockedResult(action.type, `Task not found: ${action.taskId}`, [`task not found: ${action.taskId}`]);
    }
    harness.retryTask({ taskId: action.taskId });
    return doneResult(action.type, `Task ${action.taskId} returned to todo.`, [
      { name: "task exists", status: "passed", evidence: action.taskId },
      { name: "task status", status: "passed", evidence: "todo" },
    ], [{ kind: "task", taskId: action.taskId, runId: task.runId, status: "todo", reason: action.reason ?? null }]);
  }

  if (action.type === "markRunTodo") {
    const run = harness.getRun(action.runId);
    if (!run) {
      return blockedResult(action.type, `Run not found: ${action.runId}`, [`run not found: ${action.runId}`]);
    }
    harness.clearRunPause(action.runId);
    harness.updateRunStatus({ runId: action.runId, status: "todo" });
    return doneResult(action.type, `Run ${action.runId} marked todo.`, [
      { name: "run exists", status: "passed", evidence: action.runId },
      { name: "run status", status: "passed", evidence: "todo" },
    ], [{ kind: "run", runId: action.runId, previousStatus: run.status, status: "todo", reason: action.reason ?? null }]);
  }

  if (action.type === "updateRunContext") {
    const run = harness.getRun(action.runId);
    if (!run) {
      return blockedResult(action.type, `Run not found: ${action.runId}`, [`run not found: ${action.runId}`]);
    }
    const frozenKeys = frozenDesignContextKeys(Object.keys(action.contextPatch));
    if (frozenKeys.length > 0) {
      return blockedResult(
        action.type,
        `Run ${action.runId} frozen design context cannot be overwritten.`,
        [`frozen context keys: ${frozenKeys.join(",")}`],
      );
    }
    const updated = harness.updateRun({
      runId: action.runId,
      goal: action.goal,
      status: action.status,
      contextPatch: action.contextPatch,
    });
    if (!updated) {
      return blockedResult(action.type, `Run not found: ${action.runId}`, [`run not found: ${action.runId}`]);
    }
    const patchedKeys = Object.keys(action.contextPatch).sort();
    return doneResult(action.type, `Run ${action.runId} context updated.`, [
      { name: "run exists", status: "passed", evidence: action.runId },
      { name: "patched context keys", status: "passed", evidence: patchedKeys.join(",") || "none" },
      { name: "run status", status: "passed", evidence: updated.status },
    ], [
      {
        kind: "run_context_update",
        runId: action.runId,
        previousGoal: run.goal,
        goal: updated.goal,
        previousStatus: run.status,
        status: updated.status,
        patchedKeys,
        reason: action.reason ?? null,
      },
    ]);
  }

  if (action.type === "retireRun") {
    const run = harness.getRun(action.runId);
    if (!run) {
      return blockedResult(action.type, `Run not found: ${action.runId}`, [`run not found: ${action.runId}`]);
    }
    const blockedTasks = harness.blockUnfinishedTasksForRun({ runId: action.runId, reason: action.reason });
    harness.updateRun({
      runId: action.runId,
      status: "blocked",
      contextPatch: {
        retired: true,
        retiredAt: new Date().toISOString(),
        retiredReason: action.reason,
      },
    });
    return doneResult(action.type, `Run ${action.runId} retired from the active queue.`, [
      { name: "run exists", status: "passed", evidence: action.runId },
      { name: "previous run status", status: "passed", evidence: run.status },
      { name: "retired run status", status: "passed", evidence: "blocked" },
      { name: "retired context", status: "passed", evidence: "retired=true" },
      { name: "unfinished tasks blocked", status: "passed", evidence: String(blockedTasks.length) },
    ], [
      {
        kind: "run",
        runId: action.runId,
        previousStatus: run.status,
        status: "blocked",
        retired: true,
        reason: action.reason,
        unfinishedTasksBlocked: blockedTasks.length,
      },
      ...blockedTasks.map((task) => ({
        kind: "blocked_task",
        taskId: task.taskId,
        role: task.role,
        previousStatus: task.previousStatus,
        reason: task.reason,
      })),
    ]);
  }

  if (action.type === "completeSystemTask") {
    return completeSystemTask(harness, action);
  }

  if (action.type === "integrateVerifiedRun") {
    const closureState: IntegrationClosureState = {};
    const integration = attachVerifierCommandReceipt(
      harness,
      action,
      integrateVerifiedRun(harness, action, options, closureState),
    );
    return finalizeIntegrationOutcomeReview(
      harness,
      action,
      attachIntegrationClosureReceipt(integration, closureState),
    );
  }

  if (action.type === "pushExactGitRef") {
    return pushExactGitRef(harness, action, options);
  }

  if (action.type === "createExactGitRef") {
    return createExactGitRef(harness, action, options);
  }

  if (action.type === "commitExactGitIndex") {
    return commitExactGitIndex(harness, action, options);
  }

  if (action.type === "interruptAttemptAndCreateTask") {
    return interruptAttemptAndCreateTask(harness, action);
  }

  if (action.type === "interruptRunningAttemptsAndCreateTask") {
    return interruptRunningAttemptsAndCreateTask(harness, action);
  }

  if (action.type === "acceptGuardrailProposal") {
    return acceptGuardrailProposalAction(harness, action);
  }

  if (action.type === "amendRunContract") {
    return amendRunContract(harness, action);
  }

  if (action.type === "runWatchdogPass") {
    return runWatchdogPass(harness, action);
  }

  return prepareRunDrain(harness, action);
}

const SUBSESSION_DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const SUBSESSION_MAX_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const SUBSESSION_DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const SUBSESSION_MAX_IDLE_TIMEOUT_MS = 60 * 60 * 1000;
const SUBSESSION_MAX_PER_TASK = 3;
const SUBSESSION_MIN_PROMPT_LENGTH = 24;
const SUBSESSION_BUILT_IN_BACKEND_IDS = new Set([
  "claude-code",
  "codex",
  "codex-resumable",
  "codex-cli",
  "acpx-codex",
  "noop",
]);

function applySubsessionAction(
  harness: Harness,
  action: Extract<HarnessAction, { type: "startSubsession" | "collectSubsessions" | "cancelSubsessions" }>,
  options: HarnessActionOptions,
): HarnessActionResult {
  if (action.type === "startSubsession") {
    return applyStartSubsession(harness, action, options);
  }
  if (action.type === "collectSubsessions") {
    return applyCollectSubsessions(harness, action, options);
  }
  return applyCancelSubsessions(harness, action, options);
}

function recordSubsessionEvent(
  harness: Harness,
  action: Extract<HarnessAction, { type: "startSubsession" | "collectSubsessions" | "cancelSubsessions" }>,
  result: HarnessActionResult,
) {
  return harness.recordHarnessActionEvent({
    actionType: action.type,
    status: result.status,
    request: safeRequest(action),
    result: resultToRecord(result),
  });
}

interface SubsessionValidationContext {
  task: NonNullable<ReturnType<Harness["getTask"]>>;
  run: NonNullable<ReturnType<Harness["getRun"]>>;
  worktreePath: string;
  backend: ResolvedSubsessionBackend;
  checks: HarnessActionResult["checks"];
}

function resolveParentTaskWithRun(harness: Harness, parentTaskId: string, actionType: string) {
  const task = harness.getTask(parentTaskId);
  if (!task) {
    return {
      ok: false as const,
      result: blockedResult(actionType, `Parent task not found: ${parentTaskId}`, [`parent task not found: ${parentTaskId}`]),
    };
  }
  const run = harness.getRun(task.runId);
  if (!run) {
    return {
      ok: false as const,
      result: blockedResult(actionType, `Run not found for parent task: ${parentTaskId}`, [`run not found for parent task: ${parentTaskId}`]),
    };
  }
  return { ok: true as const, task, run };
}

function resolveParentWorktree(task: Task, run: NonNullable<ReturnType<Harness["getRun"]>>): string | null {
  if (task.worktreePath) {
    return task.worktreePath;
  }
  const projectRoot = run.projectRoot ?? null;
  return projectRoot;
}

function normalizeSubsessionName(taskId: string, suggestion: string | undefined): string {
  const slug = safeSlug(suggestion ?? "child");
  return `${taskId}__${slug}`;
}

function safeSlug(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return cleaned || "child";
}

function enforceSubsessionLimit(existing: ExecutionThread[], actionType: string): { ok: true } | { ok: false; result: HarnessActionResult } {
  const running = existing.filter((thread) => thread.status === "running");
  if (running.length >= SUBSESSION_MAX_PER_TASK) {
    return {
      ok: false,
      result: blockedResult(
        actionType,
        `Parent task already has ${running.length} running subsession${running.length === 1 ? "" : "s"} (max ${SUBSESSION_MAX_PER_TASK}).`,
        [`subsession limit reached: ${running.length}/${SUBSESSION_MAX_PER_TASK}`],
      ),
    };
  }
  return { ok: true };
}

function resolveSubsessionBackend(
  run: NonNullable<ReturnType<Harness["getRun"]>>,
  requested: string | undefined,
  actionType: string,
): { ok: true; backend: ResolvedSubsessionBackend } | { ok: false; result: HarnessActionResult } {
  const id = requested ?? "claude-code";
  const fromContext = readSubsessionBackendDefinition(run.context, id);
  if (fromContext) {
    return { ok: true, backend: fromContext };
  }
  if (SUBSESSION_BUILT_IN_BACKEND_IDS.has(id)) {
    return { ok: true, backend: builtInSubsessionBackend(id) };
  }
  return {
    ok: false,
    result: blockedResult(
      actionType,
      `Unknown subsession backend: ${id}`,
      [`backend ${id} is not declared in run.context.agentBackends and is not a built-in backend`],
    ),
  };
}

function readSubsessionBackendDefinition(
  context: Record<string, unknown>,
  id: string,
): ResolvedSubsessionBackend | null {
  const map = context.agentBackends;
  if (!map || typeof map !== "object" || Array.isArray(map)) {
    return null;
  }
  const definition = (map as Record<string, unknown>)[id];
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
    return null;
  }
  const record = definition as Record<string, unknown>;
  const kind = typeof record.kind === "string" ? record.kind : null;
  if (kind !== "acpx" && kind !== "codex-cli" && kind !== "codex-resumable" && kind !== "noop") {
    return null;
  }
  const backend: ResolvedSubsessionBackend = { id, kind };
  if (typeof record.agent === "string") {
    backend.agent = record.agent;
  }
  if (typeof record.agentCommand === "string") {
    backend.agentCommand = record.agentCommand;
  }
  if (typeof record.approval === "string") {
    backend.approval = record.approval;
  }
  if (typeof record.format === "string") {
    backend.format = record.format;
  }
  return backend;
}

function builtInSubsessionBackend(id: string): ResolvedSubsessionBackend {
  if (id === "claude-code") {
    return { id, kind: "acpx", agent: "claude", approval: "approve-reads" };
  }
  if (id === "codex" || id === "acpx-codex") {
    return { id, kind: "acpx", agent: "codex", approval: "approve-reads" };
  }
  if (id === "codex-resumable") {
    return { id, kind: "codex-resumable" };
  }
  if (id === "codex-cli") {
    return { id, kind: "codex-cli" };
  }
  return { id, kind: "noop" };
}

function clampSubsessionTimeouts(timeoutMs: number | undefined, idleTimeoutMs: number | undefined) {
  const timeout = clampPositive(timeoutMs, SUBSESSION_DEFAULT_TIMEOUT_MS, SUBSESSION_MAX_TIMEOUT_MS);
  const idle = clampPositive(idleTimeoutMs, SUBSESSION_DEFAULT_IDLE_TIMEOUT_MS, SUBSESSION_MAX_IDLE_TIMEOUT_MS);
  return { timeout, idle };
}

function clampPositive(value: number | undefined, defaultValue: number, maxValue: number) {
  if (!value || !Number.isFinite(value) || value <= 0) {
    return defaultValue;
  }
  return Math.min(Math.floor(value), maxValue);
}

function listSubsessionThreadsForTask(harness: Harness, parentTaskId: string): ExecutionThread[] {
  const task = harness.getTask(parentTaskId);
  if (!task) {
    return [];
  }
  return harness
    .listExecutionThreads({ runId: task.runId })
    .filter((thread) => thread.ownerType === "subsession" && thread.taskId === parentTaskId);
}

function findParentAttemptThread(harness: Harness, task: Task): ExecutionThread | null {
  const threads = harness.listExecutionThreads({ runId: task.runId });
  const attempt = task.id ? harness.listLatestAttemptsForTasks([task.id])[0] : null;
  if (attempt) {
    const byAttempt = threads.find((thread) => thread.attemptId === attempt.attemptId && thread.ownerType !== "subsession");
    if (byAttempt) {
      return byAttempt;
    }
  }
  const byTask = threads.find((thread) => thread.taskId === task.id && thread.ownerType !== "subsession");
  return byTask ?? null;
}

function applyStartSubsession(
  harness: Harness,
  action: Extract<HarnessAction, { type: "startSubsession" }>,
  options: HarnessActionOptions,
): HarnessActionResult {
  const actionType = action.type;
  const checks: HarnessActionResult["checks"] = [];
  const validation = validateParentTaskForSubsession(harness, action.parentTaskId, actionType, checks);
  if (!validation.ok) {
    return validation.result;
  }
  const { task, run } = validation;

  const worktreePath = resolveParentWorktree(task, run);
  if (!worktreePath) {
    return blockedResult(actionType, `Parent task ${task.id} has no resolvable worktree cwd.`, [
      `parent task ${task.id} has no worktreePath and run has no projectRoot`,
    ]);
  }
  checks.push({ name: "parent worktree", status: "passed", evidence: worktreePath });

  if (action.prompt.trim().length < SUBSESSION_MIN_PROMPT_LENGTH) {
    return blockedResult(
      actionType,
      `Subsession prompt must be at least ${SUBSESSION_MIN_PROMPT_LENGTH} characters.`,
      [`prompt too short: ${action.prompt.trim().length}/${SUBSESSION_MIN_PROMPT_LENGTH}`],
    );
  }
  checks.push({ name: "prompt length", status: "passed", evidence: `${action.prompt.trim().length} chars` });

  const backendResult = resolveSubsessionBackend(run, action.backend, actionType);
  if (!backendResult.ok) {
    return backendResult.result;
  }
  const backend = backendResult.backend;
  checks.push({ name: "backend resolved", status: "passed", evidence: `${backend.id} (${backend.kind})` });

  const existing = listSubsessionThreadsForTask(harness, task.id);
  const limit = enforceSubsessionLimit(existing, actionType);
  if (!limit.ok) {
    return limit.result;
  }
  checks.push({
    name: "subsession limit",
    status: "passed",
    evidence: `${existing.filter((thread) => thread.status === "running").length}/${SUBSESSION_MAX_PER_TASK} running`,
  });

  const { timeout, idle } = clampSubsessionTimeouts(action.timeoutMs, action.idleTimeoutMs);
  checks.push({ name: "timeout policy", status: "passed", evidence: `${timeout}ms/${idle}ms idle` });

  const sessionName = normalizeSubsessionName(task.id, action.sessionName ?? action.purpose);
  const parentThread = findParentAttemptThread(harness, task);
  const latestAttempt = harness.listLatestAttemptsForTasks([task.id])[0] ?? null;
  const threadId = harness.upsertExecutionThread({
    runId: run.id,
    taskId: task.id,
    attemptId: latestAttempt?.attemptId ?? null,
    parentThreadId: parentThread?.id ?? null,
    ownerType: "subsession",
    ownerId: null,
    role: action.role ?? "subsession",
    status: "running",
    sessionName,
    agentSessionId: sessionName,
    worktreePath,
  });
  harness.updateExecutionThread({ id: threadId, ownerId: threadId, heartbeat: true });
  checks.push({ name: "thread recorded", status: "passed", evidence: threadId });

  const runner = options.subsessionRunner;
  if (!runner) {
    harness.updateExecutionThread({
      id: threadId,
      status: "blocked",
      interruptReason: "no subsessionRunner injected",
    });
    const result: HarnessActionResult = {
      status: "blocked",
      actionType,
      summary: `Subsession ${threadId} recorded but no runner was injected to start acpx.`,
      checks: [...checks, { name: "subsession runner", status: "failed", evidence: "no subsessionRunner provided" }],
      artifacts: [{
        kind: "subsession_thread",
        threadId,
        sessionName,
        parentTaskId: task.id,
        runId: run.id,
        backend,
        worktreePath,
        status: "blocked",
        reason: "no subsessionRunner injected",
      }],
      problems: ["no subsessionRunner injected; harness cannot start acpx child sessions in this process"],
    };
    return result;
  }

  let startResult: SubsessionRunnerStartResult;
  try {
    startResult = runner.start({
      threadId,
      parentTaskId: task.id,
      parentAttemptId: latestAttempt?.attemptId ?? null,
      parentThreadId: parentThread?.id ?? null,
      runId: run.id,
      worktreePath,
      sessionName,
      purpose: action.purpose,
      prompt: action.prompt,
      role: action.role ?? "subsession",
      backend,
      timeoutMs: timeout,
      idleTimeoutMs: idle,
    });
  } catch (error) {
    harness.updateExecutionThread({
      id: threadId,
      status: "blocked",
      interruptReason: errorMessage(error),
    });
    return {
      status: "blocked",
      actionType,
      summary: `Subsession start threw: ${errorMessage(error)}`,
      checks: [...checks, { name: "subsession runner start", status: "failed", evidence: errorMessage(error) }],
      artifacts: [{
        kind: "subsession_thread",
        threadId,
        sessionName,
        parentTaskId: task.id,
        runId: run.id,
        backend,
        worktreePath,
        status: "blocked",
        reason: errorMessage(error),
      }],
      problems: [`subsessionRunner.start threw: ${errorMessage(error)}`],
    };
  }

  harness.updateExecutionThread({
    id: threadId,
    status: startResult.status,
    agentSessionId: startResult.agentSessionId ?? startResult.sessionName,
    pid: startResult.pid ?? null,
  });

  const runnerReturnedDifferentThreadId = Boolean(startResult.threadId && startResult.threadId !== threadId);

  return {
    status: "done",
    actionType,
    summary: startResult.summary ?? startResult.message ?? `Subsession ${threadId} started as ${sessionName}.`,
    checks: [
      ...checks,
      {
        name: "harness thread id retained",
        status: "passed",
        evidence: runnerReturnedDifferentThreadId
          ? `ignored runner thread id ${startResult.threadId}; persisted ${threadId}`
          : threadId,
      },
      { name: "subsession started", status: "passed", evidence: startResult.sessionName },
      ...(startResult.checks ?? []),
    ],
    artifacts: [
      {
        kind: "subsession_thread",
        threadId,
        runnerThreadId: runnerReturnedDifferentThreadId ? startResult.threadId : null,
        sessionName: startResult.sessionName,
        agentSessionId: startResult.agentSessionId ?? null,
        parentTaskId: task.id,
        parentThreadId: parentThread?.id ?? null,
        runId: run.id,
        backend,
        worktreePath,
        status: startResult.status,
        timeoutMs: timeout,
        idleTimeoutMs: idle,
      },
      ...(startResult.artifacts ?? []),
    ],
    problems: startResult.problems ?? [],
  };
}

function validateParentTaskForSubsession(
  harness: Harness,
  parentTaskId: string,
  actionType: string,
  checks: HarnessActionResult["checks"],
): { ok: true; task: Task; run: NonNullable<ReturnType<Harness["getRun"]>> } | { ok: false; result: HarnessActionResult } {
  const resolved = resolveParentTaskWithRun(harness, parentTaskId, actionType);
  if (!resolved.ok) {
    return resolved;
  }
  checks.push({ name: "parent task exists", status: "passed", evidence: resolved.task.id });
  checks.push({ name: "parent run exists", status: "passed", evidence: resolved.run.id });
  return { ok: true, task: resolved.task, run: resolved.run };
}

function applyCollectSubsessions(
  harness: Harness,
  action: Extract<HarnessAction, { type: "collectSubsessions" }>,
  options: HarnessActionOptions,
): HarnessActionResult {
  const actionType = action.type;
  const checks: HarnessActionResult["checks"] = [];
  const validation = validateParentTaskForSubsession(harness, action.parentTaskId, actionType, checks);
  if (!validation.ok) {
    return validation.result;
  }
  const { task, run } = validation;

  const allChildren = listSubsessionThreadsForTask(harness, task.id);
  if (allChildren.length === 0) {
    return blockedResult(actionType, `Parent task ${task.id} has no recorded subsession threads.`, [
      `no subsession threads recorded for parent task ${task.id}`,
    ]);
  }
  checks.push({ name: "child threads", status: "passed", evidence: String(allChildren.length) });

  const filtered = action.status ? allChildren.filter((thread) => thread.status === action.status) : allChildren;
  if (filtered.length === 0) {
    return blockedResult(actionType, `No child threads matched status filter ${action.status}.`, [
      `no child threads matched status=${action.status ?? "(any)"}`,
    ]);
  }

  const backendByThread = collectSubsessionBackends(harness, filtered);
  const runner = options.subsessionRunner;
  if (!runner) {
    const artifacts = filtered.map((thread) => buildCollectedArtifactWithoutRunner(thread));
    return {
      status: "done",
      actionType,
      summary: `Collected ${filtered.length} subsession thread(s) without a runner.`,
      checks: [...checks, { name: "subsession runner", status: "failed", evidence: "no subsessionRunner provided" }],
      artifacts,
      problems: ["no subsessionRunner injected; collection is best-effort from thread state only"],
    };
  }

  const children: SubsessionRunnerCollectChild[] = filtered.map((thread) => ({
    threadId: thread.id,
    sessionName: thread.sessionName,
    agentSessionId: thread.agentSessionId,
    backend: backendByThread.get(thread.id) ?? { id: thread.role || "subsession", kind: "noop" },
    worktreePath: thread.worktreePath ?? run.projectRoot ?? "",
  }));

  let collected: SubsessionRunnerCollectResult[];
  try {
    collected = runner.collect(children);
  } catch (error) {
    return {
      status: "blocked",
      actionType,
      summary: `Subsession collect threw: ${errorMessage(error)}`,
      checks: [...checks, { name: "subsession runner collect", status: "failed", evidence: errorMessage(error) }],
      artifacts: [],
      problems: [`subsessionRunner.collect threw: ${errorMessage(error)}`],
    };
  }

  const artifacts: HarnessActionResult["artifacts"] = [];
  for (const result of collected) {
    harness.updateExecutionThread({
      id: result.threadId,
      status: result.status,
      agentSessionId: result.agentSessionId ?? null,
      heartbeat: true,
    });
    artifacts.push({
      kind: "subsession_summary",
      threadId: result.threadId,
      status: result.status,
      summary: result.summary,
      collectedAt: new Date().toISOString(),
    });
  }

  return {
    status: "done",
    actionType,
    summary: `Collected ${collected.length} subsession thread(s).`,
    checks: [...checks, { name: "subsession summaries", status: "passed", evidence: String(collected.length) }],
    artifacts,
    problems: [],
  };
}

function applyCancelSubsessions(
  harness: Harness,
  action: Extract<HarnessAction, { type: "cancelSubsessions" }>,
  options: HarnessActionOptions,
): HarnessActionResult {
  const actionType = action.type;
  const checks: HarnessActionResult["checks"] = [];
  const validation = validateParentTaskForSubsession(harness, action.parentTaskId, actionType, checks);
  if (!validation.ok) {
    return validation.result;
  }
  const { run } = validation;

  const allChildren = listSubsessionThreadsForTask(harness, action.parentTaskId);
  if (allChildren.length === 0) {
    return blockedResult(actionType, `Parent task ${action.parentTaskId} has no recorded subsession threads.`, [
      `no subsession threads recorded for parent task ${action.parentTaskId}`,
    ]);
  }
  checks.push({ name: "child threads", status: "passed", evidence: String(allChildren.length) });

  const idFilter = action.threadIds ? new Set(action.threadIds) : null;
  const targets = idFilter
    ? allChildren.filter((thread) => idFilter.has(thread.id))
    : allChildren.filter((thread) => thread.status === "running" || thread.status === "blocked");
  if (targets.length === 0) {
    return blockedResult(actionType, `No matching child threads to cancel for parent task ${action.parentTaskId}.`, [
      `no child threads matched threadIds=${idFilter ? [...idFilter].join(",") : "(running/blocked)"}`,
    ]);
  }
  checks.push({ name: "cancel targets", status: "passed", evidence: String(targets.length) });

  const runner = options.subsessionRunner;
  const problems: string[] = [];
  const artifacts: HarnessActionResult["artifacts"] = [];

  if (!runner) {
    for (const thread of targets) {
      harness.updateExecutionThread({
        id: thread.id,
        status: "interrupted",
        interruptReason: action.reason,
        heartbeat: true,
      });
      artifacts.push({
        kind: "subsession_cancel",
        threadId: thread.id,
        canceled: false,
        status: "interrupted",
        reason: action.reason,
        message: "no subsessionRunner injected; acpx cancel signal not sent",
      });
    }
    problems.push("no subsessionRunner injected; acpx cancel signal was not sent");
    return {
      status: "done",
      actionType,
      summary: `Marked ${targets.length} subsession thread(s) interrupted without acpx cancel.`,
      checks: [...checks, { name: "subsession runner", status: "failed", evidence: "no subsessionRunner provided" }],
      artifacts,
      problems,
    };
  }

  const backendByThread = collectSubsessionBackends(harness, targets);
  const children: SubsessionRunnerCancelChild[] = targets.map((thread) => ({
    threadId: thread.id,
    sessionName: thread.sessionName,
    agentSessionId: thread.agentSessionId,
    backend: backendByThread.get(thread.id) ?? { id: thread.role || "subsession", kind: "noop" },
    worktreePath: thread.worktreePath ?? run.projectRoot ?? "",
  }));

  let canceled: SubsessionRunnerCancelResult[];
  try {
    canceled = runner.cancel(children, action.reason);
  } catch (error) {
    for (const child of children) {
      harness.updateExecutionThread({
        id: child.threadId,
        status: "interrupted",
        interruptReason: action.reason,
        heartbeat: true,
      });
    }
    return {
      status: "blocked",
      actionType,
      summary: `Subsession cancel threw: ${errorMessage(error)}`,
      checks: [...checks, { name: "subsession runner cancel", status: "failed", evidence: errorMessage(error) }],
      artifacts,
      problems: [`subsessionRunner.cancel threw: ${errorMessage(error)}`],
    };
  }

  for (const result of canceled) {
    harness.updateExecutionThread({
      id: result.threadId,
      status: "interrupted",
      interruptReason: action.reason,
      heartbeat: true,
    });
    artifacts.push({
      kind: "subsession_cancel",
      threadId: result.threadId,
      canceled: result.canceled,
      reason: action.reason,
      message: result.message ?? null,
    });
    if (!result.canceled) {
      problems.push(`cancel reported failure for ${result.threadId}${result.message ? `: ${result.message}` : ""}`);
    }
  }

  return {
    status: "done",
    actionType,
    summary: `Canceled ${canceled.length} subsession thread(s).`,
    checks: [...checks, { name: "subsession cancels", status: "passed", evidence: String(canceled.length) }],
    artifacts,
    problems,
  };
}

function collectSubsessionBackends(harness: Harness, threads: ExecutionThread[]): Map<string, ResolvedSubsessionBackend> {
  const byThread = new Map<string, ResolvedSubsessionBackend>();
  const events = harness.listHarnessActionEvents({ limit: 500 });
  for (const thread of threads) {
    const event = events.find((candidate) => {
      if (candidate.actionType !== "startSubsession" || candidate.status !== "done") {
        return false;
      }
      const artifacts = Array.isArray(candidate.result.artifacts) ? candidate.result.artifacts : [];
      return artifacts.some((artifact) => {
        if (!artifact || typeof artifact !== "object") {
          return false;
        }
        const record = artifact as Record<string, unknown>;
        return record.kind === "subsession_thread" && record.threadId === thread.id;
      });
    });
    if (event) {
      const artifacts = Array.isArray(event.result.artifacts) ? event.result.artifacts : [];
      for (const artifact of artifacts) {
        const record = artifact as Record<string, unknown> | null;
        if (!record || record.kind !== "subsession_thread" || record.threadId !== thread.id) {
          continue;
        }
        const backend = record.backend as Record<string, unknown> | undefined;
        if (!backend) continue;
        byThread.set(thread.id, {
          id: typeof backend.id === "string" ? backend.id : thread.role || "subsession",
          kind: typeof backend.kind === "string" ? backend.kind : "noop",
          agent: typeof backend.agent === "string" ? backend.agent : undefined,
          agentCommand: typeof backend.agentCommand === "string" ? backend.agentCommand : undefined,
          approval: typeof backend.approval === "string" ? backend.approval : undefined,
        });
        break;
      }
    }
  }
  return byThread;
}

function buildCollectedArtifactWithoutRunner(thread: ExecutionThread) {
  return {
    kind: "subsession_summary",
    threadId: thread.id,
    status: thread.status,
    summary: thread.interruptReason ?? `thread status ${thread.status}`,
    collectedAt: new Date().toISOString(),
  };
}

function completeSystemTask(
  harness: Harness,
  action: Extract<HarnessAction, { type: "completeSystemTask" }>,
): HarnessActionResult {
  const task = harness.getTask(action.taskId);
  if (!task) {
    return blockedResult(action.type, `Task not found: ${action.taskId}`, [`task not found: ${action.taskId}`]);
  }
  const event = harness.getHarnessActionEvent({ id: action.actionEventId });
  if (!event) {
    return blockedResult(action.type, `Harness action event not found: ${action.actionEventId}`, [
      `harness action event not found: ${action.actionEventId}`,
    ]);
  }
  const resultSummary = typeof event.result.summary === "string" ? event.result.summary : `${event.actionType} ${event.status}`;
  const eventChecks = Array.isArray(event.result.checks) ? event.result.checks : [];
  const eventArtifacts = Array.isArray(event.result.artifacts) ? event.result.artifacts : [];
  const eventProblems = Array.isArray(event.result.problems)
    ? event.result.problems.filter((problem): problem is string => typeof problem === "string")
    : [];
  const output = {
    status: event.status,
    summary: `System task completed from harness action ${event.id}: ${resultSummary}`,
    changedFiles: [],
    checks: [
      { name: "harness action event", status: "passed", evidence: event.id },
      { name: "harness action type", status: "passed", evidence: event.actionType },
      ...eventChecks,
    ],
    artifacts: [
      { kind: "harness_action_event", actionEventId: event.id, actionType: event.actionType, reason: action.reason ?? null },
      ...eventArtifacts,
    ],
    problems: event.status === "blocked" ? eventProblems.length > 0 ? eventProblems : [resultSummary] : [],
  };
  const attemptId = harness.recordAttempt({
    taskId: action.taskId,
    input: {
      executor: "harness-action",
      actionType: action.type,
      actionEventId: event.id,
      reason: action.reason ?? null,
    },
    output,
  });
  return doneResult(action.type, `Recorded ${event.status} system attempt ${attemptId} for task ${action.taskId}.`, [
    { name: "task exists", status: "passed", evidence: action.taskId },
    { name: "harness action event exists", status: "passed", evidence: event.id },
    { name: "system attempt recorded", status: "passed", evidence: attemptId },
  ], [
    { kind: "attempt", attemptId, taskId: action.taskId, status: event.status },
    { kind: "harness_action_event", actionEventId: event.id, actionType: event.actionType },
  ]);
}

function integrateVerifiedRun(
  harness: Harness,
  action: Extract<HarnessAction, { type: "integrateVerifiedRun" }>,
  options: HarnessActionOptions,
  closureState: IntegrationClosureState = {},
): HarnessActionResult {
  const overview = harness.getRunOverview({ runId: action.runId, eventLimit: 0 });
  const run = overview.run;
  if (!run) {
    return blockedResult(action.type, `Run not found: ${action.runId}`, [`run not found: ${action.runId}`]);
  }

  const checks: HarnessActionResult["checks"] = [
    { name: "run exists", status: "passed", evidence: action.runId },
  ];
  const isExplicitWorkerIntegration = action.workerTaskId !== undefined;
  const completedGoalReview = selectCompletedGoalReview(overview);
  const isPreCompletionIntegration = run.status !== "done" && isExplicitWorkerIntegration && !completedGoalReview;
  const isTerminalDesignIntegration = !isPreCompletionIntegration &&
    run.context.source === "design" && typeof run.context.designProposalId === "string";
  if (run.status !== "done" && !isExplicitWorkerIntegration) {
    return blockedIntegration(action.type, "Run is not complete.", checks, [`run status is ${run.status}`]);
  }
  checks.push({
    name: "run status",
    status: "passed",
    evidence: isPreCompletionIntegration ? `pre-completion explicit worker integration from ${run.status}` : "done",
  });

  const selectedWorker = selectIntegrationWorker(overview, action.workerTaskId);
  if (!selectedWorker) {
    return blockedIntegration(action.type, "No completed execution task with a worktree was found.", checks, [
      action.workerTaskId ? `worker task not integration-ready: ${action.workerTaskId}` : "no integration-ready worker task",
    ]);
  }
  let worker = selectedWorker;
  checks.push({ name: "execution task", status: "passed", evidence: worker.id });

  const workerSession = latestSessionForTask(overview, worker.id);
  let changedFiles = filterOuroborosRuntimePaths(
    Array.isArray(workerSession?.output.changedFiles) ? workerSession.output.changedFiles : [],
  );
  if (changedFiles.length === 0) {
    return blockedIntegration(action.type, `Worker task ${worker.id} has no changedFiles evidence.`, checks, [
      `worker ${worker.id} has no changedFiles evidence`,
    ]);
  }
  checks.push({ name: "worker changed files", status: "passed", evidence: changedFiles.join(",") });

  const verifier = selectVerifierForWorker(overview, worker.id);
  if (!verifier) {
    return blockedIntegration(action.type, `Worker task ${worker.id} has no completed verifier evidence.`, checks, [
      `worker ${worker.id} has no completed verifier evidence`,
    ]);
  }
  checks.push({ name: "verifier evidence", status: "passed", evidence: verifier.id });

  const verifierBinding = verifyIntegrationVerifierCommands({
    action,
    runContext: run.context,
    verifier,
  });
  if (!verifierBinding.ok) {
    return blockedIntegration(action.type, verifierBinding.reason, checks, [verifierBinding.reason]);
  }
  if (verifierBinding.commands) {
    checks.push({
      name: "verifier commands bound",
      status: "passed",
      evidence: `${verifier.id}:${stableFingerprint(verifierBinding.commands)}`,
    });
  }

  const goalReview = isPreCompletionIntegration ? null : completedGoalReview;
  if (!isPreCompletionIntegration && !goalReview) {
    return blockedIntegration(action.type, "Run has no completed goal-review decision.", checks, [
      "missing goal-review runDecision complete",
    ]);
  }
  checks.push({
    name: "goal review",
    status: "passed",
    evidence: goalReview?.id ?? "deferred until run completion",
  });

  const repoPath = action.repoPath ?? run.projectRoot ?? overview.project?.rootPath;
  if (!repoPath) {
    return blockedIntegration(action.type, "No repository path was provided for integration.", checks, [
      "repoPath or run projectRoot is required",
    ]);
  }
  if (!existsSync(repoPath)) {
    return blockedIntegration(action.type, `Repository path does not exist: ${repoPath}`, checks, [
      `repo path does not exist: ${repoPath}`,
    ]);
  }
  let worktreePath = resolveWorktreePath(repoPath, worker.worktreePath);
  if (!worktreePath || !existsSync(worktreePath)) {
    return blockedIntegration(action.type, `Worker worktree does not exist: ${worker.worktreePath ?? "missing"}`, checks, [
      `worker worktree does not exist: ${worker.worktreePath ?? "missing"}`,
    ]);
  }
  checks.push({ name: "repository path", status: "passed", evidence: repoPath });
  checks.push({ name: "worktree path", status: "passed", evidence: worktreePath });

  const git = options.runGit ?? defaultGitRunner;
  closureState.git = git;
  const redirectedFromRepair = redirectRepairWorkerToSource({
    overview,
    worker,
    worktreePath,
    repoPath,
    git,
    changedFiles,
  });
  if (redirectedFromRepair) {
    worktreePath = redirectedFromRepair.worktreePath;
    checks.push({
      name: "repair redirected to source worktree",
      status: "passed",
      evidence: `${worker.id} -> ${redirectedFromRepair.sourceWorkerId} (${worktreePath})`,
    });
    worker = { ...worker, worktreePath };
  }

  const targetBranch = action.targetBranch ?? "main";
  if (targetBranch !== "main") {
    return blockedIntegration(action.type, "Integration boundary is frozen to targetBranch=main.", checks, [
      `targetBranch ${targetBranch} is not allowed; expected main`,
    ]);
  }
  const commitMessage = action.commitMessage ?? `Integrate verified task ${worker.id}`;
  const targetBranchResult = runGitStep(git, repoPath, ["branch", "--show-current"]);
  if (!targetBranchResult.ok) {
    return blockedCommand(action.type, "Could not read target repository branch.", checks, targetBranchResult);
  }
  const currentBranch = targetBranchResult.stdout.trim();
  if (currentBranch !== targetBranch) {
    return blockedIntegration(action.type, `Target repository is on ${currentBranch || "detached HEAD"}, not ${targetBranch}.`, checks, [
      `target repository branch is ${currentBranch || "detached HEAD"}`,
    ]);
  }
  checks.push({ name: "target branch", status: "passed", evidence: targetBranch });

  const targetStatus = runGitStep(git, repoPath, ["status", "--short"]);
  if (!targetStatus.ok) {
    return blockedCommand(action.type, "Could not inspect target repository status.", checks, targetStatus);
  }
  const mergeHeadCheck = runGitStep(git, repoPath, ["rev-parse", "--verify", "-q", "MERGE_HEAD"]);
  if (mergeHeadCheck.exitCode === 0) {
    return blockedIntegration(action.type, "Target repository has an unfinished merge (MERGE_HEAD).", checks, [
      `another integration is in progress on ${targetBranch}; MERGE_HEAD exists`,
    ]);
  }
  checks.push({ name: "no concurrent merge", status: "passed", evidence: "no MERGE_HEAD" });
  let preservedTargetSnapshot: DisjointSnapshot | null = null;

  const sourceBranchResult = runGitStep(git, worktreePath, ["branch", "--show-current"]);
  if (!sourceBranchResult.ok) {
    return blockedCommand(action.type, "Could not read worker worktree branch.", checks, sourceBranchResult);
  }
  const sourceBranch = sourceBranchResult.stdout.trim();
  if (!sourceBranch) {
    return blockedIntegration(action.type, "Worker worktree is not on an integration branch.", checks, [
      "source branch is detached HEAD",
    ]);
  }

  const targetCommonDirResult = runGitStep(git, repoPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!targetCommonDirResult.ok) {
    return blockedCommand(action.type, "Could not identify the target Git repository.", checks, targetCommonDirResult);
  }
  const workerCommonDirResult = runGitStep(git, worktreePath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!workerCommonDirResult.ok) {
    return blockedCommand(action.type, "Could not identify the worker Git repository.", checks, workerCommonDirResult);
  }
  let targetCommonDir: string;
  let workerCommonDir: string;
  try {
    targetCommonDir = realpathSync(targetCommonDirResult.stdout.trim());
    workerCommonDir = realpathSync(workerCommonDirResult.stdout.trim());
  } catch {
    return blockedIntegration(action.type, "Could not resolve Git repository identity.", checks, [
      "target and worker Git common directories must both resolve to existing directories",
    ]);
  }
  if (workerCommonDir !== targetCommonDir) {
    return blockedIntegration(action.type, "Worker worktree does not belong to the target repository.", checks, [
      "worker worktree does not belong to the target repository",
    ]);
  }
  checks.push({ name: "worker repository identity", status: "passed", evidence: targetCommonDir });

  const closurePreflight = prepareIntegrationClosure({
    action,
    run,
    overview,
    worker,
    verifier,
    repoPath,
    worktreePath,
    changedFiles,
    terminal: isTerminalDesignIntegration,
    git,
    runCommand: options.runCommand ?? defaultCommandRunner,
  });
  if (!closurePreflight.ok) {
    return blockedIntegration(action.type, closurePreflight.reason, checks, [closurePreflight.reason]);
  }
  if (closurePreflight.receipt) {
    closureState.receipt = closurePreflight.receipt;
    closureState.materializedFiles = closurePreflight.materializedFiles;
    const receiptPaths = Array.isArray(closurePreflight.receipt.paths)
      ? closurePreflight.receipt.paths.filter((path): path is string => typeof path === "string")
      : [];
    changedFiles = receiptPaths.length > 0 ? receiptPaths : changedFiles;
    checks.push({
      name: "clean candidate verifier",
      status: "passed",
      evidence: String(closurePreflight.receipt.candidateCommit),
    });
    checks.push({
      name: "integration closure",
      status: "passed",
      evidence: `${String(receiptPaths.length)} paths; ${String(closurePreflight.receipt.manifestHash)}`,
    });
  }
  const isContainedSameBranch = sourceBranch === targetBranch;

  if (targetStatus.stdout.trim().length > 0) {
    if (isContainedSameBranch) {
      return blockedIntegration(action.type, "Target repository is dirty during same-branch integration.", checks, [
        "target repository must be clean for same-branch integration",
      ]);
    }
    // Classify the target dirty paths against the verified worker output.
    // When at least one verified worker path is materialized in the target,
    // route through the materialized-target commit path (which preserves
    // disjoint operator edits). When all dirty paths are disjoint from the
    // worker output, fall through to the branch-merge path; git merge can
    // preserve disjoint uncommitted changes when the merge does not touch
    // those paths.
    const dirtyClassification = classifyTargetDirtyForWorker(git, repoPath, changedFiles, checks, action.type);
    if (dirtyClassification.result) {
      return dirtyClassification.result;
    }
    if (!dirtyClassification.hasMaterializedWorkerPath) {
      const preservedStatus = readTargetDirtyStatus(git, repoPath);
      if (!preservedStatus.ok) {
        return blockedCommand(action.type, "Could not snapshot disjoint target status before branch integration.", checks, preservedStatus.result);
      }
      preservedTargetSnapshot = snapshotDisjointTargetPaths(
        git,
        repoPath,
        preservedStatus.entries,
        dirtyClassification.disjointPaths,
      );
      if (preservedTargetSnapshot.incomplete) {
        return blockedIntegration(action.type, "Could not snapshot disjoint target paths before branch integration.", checks, [
          `incomplete snapshot for disjoint paths: ${preservedTargetSnapshot.incomplete.join(",")}`,
        ]);
      }
      checks.push({
        name: "disjoint target paths preserved",
        status: "passed",
        evidence: dirtyClassification.disjointPaths.join(","),
      });
      // Fall through to the branch-merge path with disjoint dirty state.
    } else {
      return integrateMaterializedTargetChanges({
        action,
        checks,
        changedFiles,
        commitMessage,
        git,
        goalReview,
        isPreCompletionIntegration,
        repoPath,
        targetBranch,
        verifier,
        worker,
        worktreePath,
      });
    }
  }
  checks.push({ name: "target repository clean", status: "passed", evidence: "clean" });
  checks.push({ name: "source branch", status: "passed", evidence: sourceBranch });

  if (preservedTargetSnapshot) {
    return integrateDirtyBranchChanges({
      action,
      checks,
      changedFiles,
      commitMessage,
      git,
      goalReview,
      isPreCompletionIntegration,
      repoPath,
      sourceBranch,
      targetBranch,
      verifier,
      worker,
      worktreePath,
      snapshot: preservedTargetSnapshot,
    });
  }

  const workerStatus = runGitStep(git, worktreePath, ["status", "--short"]);
  if (!workerStatus.ok) {
    return blockedCommand(action.type, "Could not inspect worker worktree status.", checks, workerStatus);
  }
  if (isContainedSameBranch) {
    if (workerStatus.stdout.trim().length > 0) {
      return blockedIntegration(action.type, "Same-branch worker worktree is dirty.", checks, [
        "same-branch worker worktree must be clean",
      ]);
    }
    checks.push({ name: "worker worktree clean", status: "passed", evidence: "no uncommitted changes" });
    return recordContainedWorkerCommitIntegration({
      action,
      checks,
      git,
      goalReview,
      isPreCompletionIntegration,
      overview,
      repoPath,
      sourceBranch,
      targetBranch,
      verifier,
      worker,
      worktreePath,
      changedFiles,
    });
  }
  let workerCommit: string | null = null;
  if (workerStatus.stdout.trim().length > 0) {
    const add = runGitStep(git, worktreePath, ["add", "-A"]);
    if (!add.ok) {
      return blockedCommand(action.type, "Could not stage worker changes.", checks, add);
    }
    const commit = runGitStep(git, worktreePath, ["commit", "-m", commitMessage]);
    if (!commit.ok) {
      return blockedCommand(action.type, "Could not commit worker changes.", checks, commit);
    }
    workerCommit = readGitStdout(git, worktreePath, ["rev-parse", "--short", "HEAD"]);
    checks.push({ name: "worker commit", status: "passed", evidence: workerCommit ?? "created" });
  } else {
    checks.push({ name: "worker worktree clean", status: "passed", evidence: "no uncommitted changes" });
  }

  const aheadResult = runGitStep(git, repoPath, ["rev-list", "--count", `${targetBranch}..${sourceBranch}`]);
  if (!aheadResult.ok) {
    return blockedCommand(action.type, "Could not compare source and target branches.", checks, aheadResult);
  }
  const ahead = Number.parseInt(aheadResult.stdout.trim(), 10);
  if (!Number.isFinite(ahead) || ahead < 1) {
    const ancestor = runGitStep(git, repoPath, ["merge-base", "--is-ancestor", sourceBranch, targetBranch]);
    if (ancestor.ok) {
      const mergeCommit = readGitStdout(git, repoPath, ["rev-parse", "--short", "HEAD"]);
      checks.push({
        name: "source already merged",
        status: "passed",
        evidence: `${sourceBranch} is ancestor of ${targetBranch}`,
      });
      return doneResult(action.type, `Verified task ${worker.id} is already integrated into ${targetBranch}.`, checks, [
        {
          kind: "integration",
          mode: "branch_merge",
          runId: action.runId,
          workerTaskId: worker.id,
          verifierTaskId: verifier.id,
          goalReviewTaskId: goalReview?.id ?? null,
          preCompletion: isPreCompletionIntegration,
          repoPath,
          worktreePath,
          targetBranch,
          sourceBranch,
          workerCommit,
          mergeCommit,
          pushed: false,
          changedFiles,
          reason: action.reason ?? null,
          alreadyMerged: true,
        },
      ]);
    }
    return blockedIntegration(action.type, `Source branch ${sourceBranch} has no commits to merge into ${targetBranch}.`, checks, [
      `source branch ${sourceBranch} has no commits ahead of ${targetBranch}`,
    ]);
  }
  checks.push({ name: "source commits ahead", status: "passed", evidence: String(ahead) });

  const merge = runGitStep(git, repoPath, ["merge", "--no-ff", sourceBranch, "-m", commitMessage]);
  if (!merge.ok) {
    const mergeHead = runGitStep(git, repoPath, ["rev-parse", "--verify", "-q", "MERGE_HEAD"]);
    if (mergeHead.exitCode === 0) {
      const abort = runGitStep(git, repoPath, ["merge", "--abort"]);
      if (!abort.ok) {
        return blockedCommand(action.type, "Merge failed and the target repository could not be restored.", checks, abort);
      }
      checks.push({
        name: "failed merge cleanup",
        status: "passed",
        evidence: `aborted conflicted merge on ${targetBranch}`,
      });
    }
    return blockedCommand(action.type, "Could not merge verified worker branch.", checks, merge);
  }
  const mergeCommit = readGitStdout(git, repoPath, ["rev-parse", "--short", "HEAD"]);
  checks.push({ name: "merge", status: "passed", evidence: mergeCommit ?? sourceBranch });

  let pushed = false;
  if (action.push === true) {
    const push = runGitStep(git, repoPath, ["push", "origin", targetBranch]);
    if (!push.ok) {
      return blockedCommand(action.type, "Could not push target branch.", checks, push);
    }
    pushed = true;
    checks.push({ name: "push", status: "passed", evidence: `origin ${targetBranch}` });
  }

  return doneResult(action.type, `Integrated verified task ${worker.id} into ${targetBranch}.`, checks, [
    {
      kind: "integration",
      mode: "branch_merge",
      runId: action.runId,
      workerTaskId: worker.id,
      verifierTaskId: verifier.id,
      goalReviewTaskId: goalReview?.id ?? null,
      preCompletion: isPreCompletionIntegration,
      repoPath,
      worktreePath,
      targetBranch,
      sourceBranch,
      workerCommit,
      mergeCommit,
      pushed,
      changedFiles,
      reason: action.reason ?? null,
    },
  ]);
}

function recordContainedWorkerCommitIntegration(input: {
  action: Extract<HarnessAction, { type: "integrateVerifiedRun" }>;
  checks: HarnessActionResult["checks"];
  changedFiles: string[];
  git: GitRunner;
  goalReview: Task | null;
  isPreCompletionIntegration: boolean;
  overview: RunOverview;
  repoPath: string;
  sourceBranch: string;
  targetBranch: string;
  verifier: Task;
  worker: Task;
  worktreePath: string;
}): HarnessActionResult {
  const workerSession = latestSessionForTask(input.overview, input.worker.id);
  const artifacts = Array.isArray(workerSession?.output.artifacts) ? workerSession.output.artifacts : [];
  const commitArtifacts = artifacts.filter((artifact) =>
    artifact !== null &&
    typeof artifact === "object" &&
    !Array.isArray(artifact) &&
    (artifact as Record<string, unknown>).kind === "git_commit"
  ) as Array<Record<string, unknown>>;
  if (commitArtifacts.length !== 1) {
    return blockedIntegration(
      input.action.type,
      `Worker task ${input.worker.id} must provide exactly one git_commit artifact.`,
      input.checks,
      [`latest done attempt has ${commitArtifacts.length} git_commit artifacts; expected exactly one git_commit artifact`],
    );
  }

  const artifact = commitArtifacts[0];
  const rawSha = artifact.sha;
  if (typeof rawSha !== "string" || !isGitCommitSha(rawSha) || /^0+$/.test(rawSha)) {
    return blockedIntegration(input.action.type, "Worker git_commit artifact has an invalid SHA.", input.checks, [
      "git_commit artifact sha must be a non-zero full 40-character SHA",
    ]);
  }
  const workerCommit = rawSha.toLowerCase();
  if (artifact.branch !== input.targetBranch) {
    return blockedIntegration(input.action.type, "Worker git_commit artifact branch does not match the target branch.", input.checks, [
      `git_commit artifact branch ${String(artifact.branch)} does not match target branch ${input.targetBranch}`,
    ]);
  }
  input.checks.push({ name: "worker commit artifact", status: "passed", evidence: workerCommit });

  const commitExists = runGitStep(input.git, input.repoPath, ["cat-file", "-e", `${workerCommit}^{commit}`]);
  if (!commitExists.ok) {
    return blockedIntegration(input.action.type, "Worker commit does not belong to the target repository.", input.checks, [
      `git_commit ${workerCommit} does not belong to the target repository`,
    ]);
  }
  input.checks.push({ name: "worker commit belongs to repository", status: "passed", evidence: workerCommit });

  const targetHeadResult = runGitStep(input.git, input.repoPath, ["rev-parse", "HEAD"]);
  if (!targetHeadResult.ok) {
    return blockedCommand(input.action.type, "Could not read target repository HEAD.", input.checks, targetHeadResult);
  }
  const targetHead = targetHeadResult.stdout.trim().toLowerCase();
  if (!isGitCommitSha(targetHead) || /^0+$/.test(targetHead)) {
    return blockedIntegration(input.action.type, "Target repository HEAD is not a full commit SHA.", input.checks, [
      "target HEAD must be a non-zero full 40-character SHA",
    ]);
  }
  const ancestor = runGitStep(input.git, input.repoPath, [
    "merge-base",
    "--is-ancestor",
    workerCommit,
    targetHead,
  ]);
  if (!ancestor.ok) {
    return blockedIntegration(input.action.type, "Worker commit is not contained by the target branch.", input.checks, [
      `git_commit ${workerCommit} is not an ancestor of target HEAD ${targetHead}`,
    ]);
  }
  input.checks.push({
    name: "worker commit contained by target HEAD",
    status: "passed",
    evidence: `${workerCommit}..${targetHead}`,
  });

  const commitFilesResult = runGitStep(input.git, input.repoPath, [
    "diff-tree",
    "--root",
    "--no-commit-id",
    "--name-only",
    "-r",
    "-z",
    workerCommit,
  ]);
  if (!commitFilesResult.ok) {
    return blockedCommand(input.action.type, "Could not read worker commit changed files.", input.checks, commitFilesResult);
  }
  const rawCommitFiles = commitFilesResult.stdout.split("\0").filter(Boolean);
  const evidenceFiles = normalizeRelativeFiles(input.changedFiles);
  const commitFiles = normalizeRelativeFiles(rawCommitFiles);
  const sortedEvidenceFiles = [...new Set(evidenceFiles)].sort();
  const sortedCommitFiles = [...new Set(commitFiles)].sort();
  if (
    evidenceFiles.length !== input.changedFiles.length ||
    commitFiles.length !== rawCommitFiles.length ||
    sortedEvidenceFiles.length !== input.changedFiles.length ||
    sortedCommitFiles.length !== rawCommitFiles.length ||
    sortedEvidenceFiles.join("\0") !== sortedCommitFiles.join("\0")
  ) {
    return blockedIntegration(input.action.type, "Worker changedFiles do not match the git_commit artifact.", input.checks, [
      `attempt changedFiles do not match git_commit ${workerCommit}`,
    ]);
  }
  input.checks.push({
    name: "worker changed files match commit",
    status: "passed",
    evidence: sortedCommitFiles.join(","),
  });

  return doneResult(
    input.action.type,
    `Verified task ${input.worker.id} commit is already integrated into ${input.targetBranch}.`,
    input.checks,
    [{
      kind: "integration",
      mode: "contained_worker_commit",
      runId: input.action.runId,
      workerTaskId: input.worker.id,
      verifierTaskId: input.verifier.id,
      goalReviewTaskId: input.goalReview?.id ?? null,
      preCompletion: input.isPreCompletionIntegration,
      repoPath: input.repoPath,
      worktreePath: input.worktreePath,
      targetBranch: input.targetBranch,
      sourceBranch: input.sourceBranch,
      workerCommit,
      mergeCommit: targetHead,
      pushed: false,
      changedFiles: input.changedFiles,
      reason: input.action.reason ?? null,
      alreadyMerged: true,
    }],
  );
}

function integrateDirtyBranchChanges(input: {
  action: Extract<HarnessAction, { type: "integrateVerifiedRun" }>;
  checks: HarnessActionResult["checks"];
  changedFiles: string[];
  commitMessage: string;
  git: GitRunner;
  goalReview: Task | null;
  isPreCompletionIntegration: boolean;
  repoPath: string;
  sourceBranch: string;
  targetBranch: string;
  verifier: Task;
  worker: Task;
  worktreePath: string;
  snapshot: DisjointSnapshot;
}): HarnessActionResult {
  const workerStatus = runGitStep(input.git, input.worktreePath, ["status", "--short"]);
  if (!workerStatus.ok) {
    return blockedCommand(input.action.type, "Could not inspect worker worktree status.", input.checks, workerStatus);
  }
  if (workerStatus.stdout.trim().length > 0) {
    const stage = runGitStep(input.git, input.worktreePath, ["add", "-A"]);
    if (!stage.ok) {
      return blockedCommand(input.action.type, "Could not stage worker changes for preserved-target branch integration.", input.checks, stage);
    }
    const commit = runGitStep(input.git, input.worktreePath, [
      "-c",
      "commit.gpgSign=false",
      "commit",
      "-m",
      input.commitMessage,
    ]);
    if (!commit.ok) {
      return blockedCommand(input.action.type, "Could not commit worker changes for preserved-target branch integration.", input.checks, commit);
    }
    input.checks.push({ name: "worker commit", status: "passed", evidence: readGitStdout(input.git, input.worktreePath, ["rev-parse", "--short", "HEAD"]) ?? "created" });
  }

  const targetHead = readGitStdout(input.git, input.repoPath, ["rev-parse", "HEAD"]);
  const sourceHead = readGitStdout(input.git, input.worktreePath, ["rev-parse", input.sourceBranch]);
  if (!targetHead || !sourceHead) {
    return blockedIntegration(input.action.type, "Could not read branch integration commits.", input.checks, [
      "target HEAD and source HEAD are required",
    ]);
  }
  const mergeTree = runGitStep(input.git, input.repoPath, [
    "merge-tree",
    "--write-tree",
    targetHead,
    sourceHead,
  ]);
  if (!mergeTree.ok) {
    return blockedIntegration(input.action.type, "Could not construct a conflict-free integration tree.", input.checks, [
      `verified worker branch merge is not conflict-free: ${mergeTree.stderr.trim() || mergeTree.stdout.trim()}`,
    ]);
  }
  const integratedTree = mergeTree.stdout.trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(integratedTree) || /^0+$/.test(integratedTree)) {
    return blockedIntegration(input.action.type, "Could not read the conflict-free integration tree.", input.checks, [
      "git merge-tree --write-tree must return one non-zero full tree SHA",
    ]);
  }
  const targetHeadBeforeCommit = readGitStdout(input.git, input.repoPath, ["rev-parse", "HEAD"]);
  if (targetHeadBeforeCommit !== targetHead) {
    return blockedIntegration(input.action.type, "Target HEAD drifted during integration preflight; no receipt was recorded.", input.checks, [
      `target HEAD drifted from ${targetHead}`,
    ]);
  }
  const aheadResult = runGitStep(input.git, input.repoPath, ["rev-list", "--count", `${input.targetBranch}..${input.sourceBranch}`]);
  if (!aheadResult.ok) {
    return blockedCommand(input.action.type, "Could not compare source and target branches.", input.checks, aheadResult);
  }
  const ahead = Number.parseInt(aheadResult.stdout.trim(), 10);
  if (!Number.isFinite(ahead) || ahead < 1) {
    const ancestor = runGitStep(input.git, input.repoPath, ["merge-base", "--is-ancestor", input.sourceBranch, input.targetBranch]);
    if (ancestor.ok) {
      const readback = readbackDisjointTargetPaths(input.git, input.repoPath, input.snapshot);
      if (!readback.ok) {
        return blockedIntegration(input.action.type, "Preserved target readback failed for an already integrated branch.", input.checks, readback.mismatched);
      }
      return doneResult(input.action.type, `Verified task ${input.worker.id} is already integrated into ${input.targetBranch}.`, input.checks, [{
        kind: "integration",
        mode: "branch_merge",
        runId: input.action.runId,
        workerTaskId: input.worker.id,
        verifierTaskId: input.verifier.id,
        goalReviewTaskId: input.goalReview?.id ?? null,
        preCompletion: input.isPreCompletionIntegration,
        repoPath: input.repoPath,
        worktreePath: input.worktreePath,
        targetBranch: input.targetBranch,
        sourceBranch: input.sourceBranch,
        workerCommit: sourceHead.slice(0, 7),
        mergeCommit: targetHead.slice(0, 7),
        pushed: false,
        changedFiles: input.changedFiles,
        alreadyMerged: true,
        reason: input.action.reason ?? null,
      }]);
    }
    return blockedIntegration(input.action.type, "Source branch has no commits ahead of target during preserved-target integration.", input.checks, [
      `source branch ${input.sourceBranch} has no commits ahead of ${input.targetBranch}`,
    ]);
  }

  const commit = runGitStep(input.git, input.repoPath, [
    "-c",
    "commit.gpgSign=false",
    "commit-tree",
    integratedTree,
    "-p",
    targetHead,
    "-p",
    sourceHead,
    "-m",
    input.commitMessage,
  ]);
  const mergeCommit = commit.stdout.trim();
  if (!commit.ok || !/^[0-9a-f]{40}$/i.test(mergeCommit)) {
    return blockedCommand(input.action.type, "Could not create an isolated branch integration commit.", input.checks, commit);
  }
  const update = runGitStep(input.git, input.repoPath, [
    "update-ref",
    `refs/heads/${input.targetBranch}`,
    mergeCommit,
    targetHead,
  ]);
  if (!update.ok) {
    return blockedCommand(input.action.type, "Target branch changed before preserved-target integration could be recorded.", input.checks, update);
  }
  if (!materializeWorkerFiles(input.repoPath, input.worktreePath, input.changedFiles)) {
    const rollback = rollbackMaterializedIntegration(input.git, input.repoPath, input.action.type, input.checks, targetHead);
    return rollback ?? blockedIntegration(input.action.type, "Could not materialize verified branch paths in the target worktree.", input.checks, [
      "worker files could not be copied without changing unrelated target paths",
    ]);
  }
  const indexSync = syncIndexToTree(input.git, input.repoPath, integratedTree, input.changedFiles);
  if (!indexSync.ok) {
    const rollback = rollbackMaterializedIntegration(input.git, input.repoPath, input.action.type, input.checks, targetHead);
    return rollback ?? blockedIntegration(input.action.type, "Could not synchronize verified branch paths in the target index.", input.checks, [
      "worker files were copied but target index synchronization failed",
    ]);
  }
  const readback = readbackDisjointTargetPaths(input.git, input.repoPath, input.snapshot);
  if (!readback.ok) {
    const rollback = rollbackMaterializedIntegration(input.git, input.repoPath, input.action.type, input.checks, targetHead);
    return rollback ?? blockedIntegration(input.action.type, "Preserved target readback failed after branch integration.", input.checks, readback.mismatched);
  }
  const integratedReadback = verifyIntegratedTargetPaths(
    input.git,
    input.repoPath,
    mergeCommit,
    input.changedFiles,
  );
  if (!integratedReadback.ok) {
    const rollback = rollbackMaterializedIntegration(input.git, input.repoPath, input.action.type, input.checks, targetHead);
    if (rollback) {
      return { ...rollback, problems: [integratedReadback.reason, ...rollback.problems] };
    }
    return blockedIntegration(input.action.type, "Independent target readback failed after branch integration.", input.checks, [
      integratedReadback.reason,
    ]);
  }
  input.checks.push({ name: "preserved target readback", status: "passed", evidence: input.snapshot.entries.map((entry) => entry.path).join(",") });
  return doneResult(input.action.type, `Integrated verified task ${input.worker.id} into ${input.targetBranch}.`, input.checks, [{
    kind: "integration",
    mode: "branch_merge",
    runId: input.action.runId,
    workerTaskId: input.worker.id,
    verifierTaskId: input.verifier.id,
    goalReviewTaskId: input.goalReview?.id ?? null,
    preCompletion: input.isPreCompletionIntegration,
    repoPath: input.repoPath,
    worktreePath: input.worktreePath,
    targetBranch: input.targetBranch,
    sourceBranch: input.sourceBranch,
    workerCommit: sourceHead.slice(0, 7),
    mergeCommit: mergeCommit.slice(0, 7),
    pushed: false,
    changedFiles: input.changedFiles,
    preservedDisjointFiles: input.snapshot.entries.map((entry) => entry.path),
    targetHeadBefore: targetHead,
    reason: input.action.reason ?? null,
  }]);
}

function materializeWorkerFiles(repoPath: string, worktreePath: string, paths: string[]) {
  try {
    for (const path of paths) {
      const source = join(worktreePath, path);
      const target = join(repoPath, path);
      if (!existsSync(source)) {
        if (existsSync(target)) {
          unlinkSync(target);
        }
        continue;
      }
      const sourceStat = lstatSync(source);
      if (!sourceStat.isFile()) {
        return false;
      }
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
      chmodSync(target, sourceStat.mode & 0o777);
    }
    return true;
  } catch {
    return false;
  }
}

function classifyTargetDirtyForWorker(
  git: GitRunner,
  repoPath: string,
  changedFiles: string[],
  checks: HarnessActionResult["checks"],
  actionType: Extract<HarnessAction, { type: "integrateVerifiedRun" }>["type"],
): { hasMaterializedWorkerPath: boolean; disjointPaths: string[]; result: HarnessActionResult | null } {
  const normalizedChangedFiles = normalizeRelativeFiles(changedFiles);
  if (normalizedChangedFiles.length !== changedFiles.length) {
    return {
      hasMaterializedWorkerPath: false,
      disjointPaths: [],
      result: blockedIntegration(actionType, "Worker changedFiles contain unsafe paths.", checks, [
        "changedFiles must be relative paths inside the repository",
      ]),
    };
  }
  const dirtyStatus = readTargetDirtyStatus(git, repoPath);
  if (!dirtyStatus.ok) {
    return {
      hasMaterializedWorkerPath: false,
      disjointPaths: [],
      result: blockedCommand(actionType, "Could not inspect target repository dirty status.", checks, dirtyStatus.result),
    };
  }
  for (const entry of dirtyStatus.entries) {
    if (entry.kind === "unsafe") {
      return {
        hasMaterializedWorkerPath: false,
        disjointPaths: [],
        result: blockedIntegration(actionType, "Target repository has unsafe or non-relative dirty paths.", checks, [
          `unsafe target path: ${entry.path}`,
        ]),
      };
    }
    if (entry.kind === "rename") {
      return {
        hasMaterializedWorkerPath: false,
        disjointPaths: [],
        result: blockedIntegration(actionType, "Target repository has a renamed path that the verified worker did not authorize.", checks, [
          `rename detected in target repository: ${entry.path}`,
        ]),
      };
    }
  }
  const changedFileSet = new Set(normalizedChangedFiles);
  const verifiedDirty: string[] = [];
  const disjointDirty: string[] = [];
  for (const entry of dirtyStatus.entries) {
    if (changedFileSet.has(entry.path)) {
      verifiedDirty.push(entry.path);
    } else {
      disjointDirty.push(entry.path);
    }
  }
  for (const verifiedPath of normalizedChangedFiles) {
    for (const disjointPath of disjointDirty) {
      if (pathContains(verifiedPath, disjointPath) || pathContains(disjointPath, verifiedPath)) {
        return {
          hasMaterializedWorkerPath: false,
          disjointPaths: disjointDirty,
          result: blockedIntegration(actionType, "Target repository dirty paths overlap verified worker output.", checks, [
            `overlap between verified ${verifiedPath} and disjoint ${disjointPath}`,
          ]),
        };
      }
    }
  }
  return {
    hasMaterializedWorkerPath: verifiedDirty.length > 0,
    disjointPaths: disjointDirty,
    result: null,
  };
}

function integrateMaterializedTargetChanges(input: {
  action: Extract<HarnessAction, { type: "integrateVerifiedRun" }>;
  checks: HarnessActionResult["checks"];
  changedFiles: string[];
  commitMessage: string;
  git: GitRunner;
  goalReview: Task | null;
  isPreCompletionIntegration: boolean;
  repoPath: string;
  targetBranch: string;
  verifier: Task;
  worker: Task;
  worktreePath: string;
}): HarnessActionResult {
  const normalizedChangedFiles = normalizeRelativeFiles(input.changedFiles);
  if (normalizedChangedFiles.length !== input.changedFiles.length) {
    return blockedIntegration(input.action.type, "Worker changedFiles contain unsafe paths.", input.checks, [
      "changedFiles must be relative paths inside the repository",
    ]);
  }

  // Read rich porcelain status (with rename detection) once, before any
  // mutation. This is the canonical preflight evidence used to classify
  // verified, disjoint, overlapping, renamed, or colliding target paths.
  const dirtyStatus = readTargetDirtyStatus(input.git, input.repoPath);
  if (!dirtyStatus.ok) {
    return blockedCommand(input.action.type, "Could not inspect target repository dirty status.", input.checks, dirtyStatus.result);
  }
  for (const entry of dirtyStatus.entries) {
    if (entry.kind === "unsafe") {
      return blockedIntegration(input.action.type, "Target repository has unsafe or non-relative dirty paths.", input.checks, [
        `unsafe target path: ${entry.path}`,
      ]);
    }
    if (entry.kind === "rename") {
      return blockedIntegration(input.action.type, "Target repository has a renamed path that the verified worker did not authorize.", input.checks, [
        `rename detected in target repository: ${entry.path}`,
      ]);
    }
  }

  const changedFileSet = new Set(normalizedChangedFiles);
  const verifiedDirty: string[] = [];
  const disjointDirty: string[] = [];
  for (const entry of dirtyStatus.entries) {
    if (changedFileSet.has(entry.path)) {
      verifiedDirty.push(entry.path);
    } else {
      disjointDirty.push(entry.path);
    }
  }

  // Reject overlap, ancestor/descendant, and file/directory collision between
  // verified worker paths and disjoint dirty paths. These cases are not safe
  // to preserve through a partial-target commit.
  for (const verifiedPath of normalizedChangedFiles) {
    for (const disjointPath of disjointDirty) {
      if (pathContains(verifiedPath, disjointPath) || pathContains(disjointPath, verifiedPath)) {
        return blockedIntegration(input.action.type, "Target repository dirty paths overlap verified worker output.", input.checks, [
          `overlap between verified ${verifiedPath} and disjoint ${disjointPath}`,
        ]);
      }
      if (pathCollidesAsFileAndDirectory(verifiedPath, disjointPath)) {
        return blockedIntegration(input.action.type, "Target repository has a file/directory collision with verified worker output.", input.checks, [
          `collision between verified ${verifiedPath} and disjoint ${disjointPath}`,
        ]);
      }
    }
    // Also detect file/directory collisions where both paths exist as actual
    // filesystem entries inside the repository (a verified file path whose
    // parent is a disjoint file, or vice versa).
    for (const otherVerified of normalizedChangedFiles) {
      if (verifiedPath !== otherVerified && pathCollidesAsFileAndDirectory(verifiedPath, otherVerified)) {
        return blockedIntegration(input.action.type, "Verified worker paths contain a file/directory collision.", input.checks, [
          `collision between verified ${verifiedPath} and verified ${otherVerified}`,
        ]);
      }
    }
  }

  // Verified dirty paths must already match the worker worktree byte-for-byte.
  const mismatched = verifiedDirty.filter((file) =>
    !sameMaterializedFile(input.repoPath, input.worktreePath, file)
  );
  if (mismatched.length > 0) {
    return blockedIntegration(input.action.type, "Target edits overlap verified worker output and do not match the verified worker worktree.", input.checks, [
      `overlapping target files do not match the verified worker worktree: ${mismatched.join(",")}`,
    ]);
  }

  // Snapshot disjoint dirty paths and HEAD before mutation. These snapshots
  // are the evidence used for post-integration readback and rollback.
  const disjointSnapshot = snapshotDisjointTargetPaths(input.git, input.repoPath, dirtyStatus.entries, disjointDirty);
  if (disjointSnapshot.incomplete) {
    return blockedIntegration(input.action.type, "Could not snapshot disjoint target paths before integration.", input.checks, [
      `incomplete snapshot for disjoint paths: ${disjointSnapshot.incomplete.join(",")}`,
    ]);
  }
  const headBeforeCommit = readGitStdout(input.git, input.repoPath, ["rev-parse", "HEAD"]);
  if (!headBeforeCommit) {
    return blockedIntegration(input.action.type, "Could not read target repository HEAD before integration.", input.checks, [
      "HEAD readback returned no SHA",
    ]);
  }
  const porcelainBeforeCommit = readGitStdout(input.git, input.repoPath, ["status", "--short"]);
  if (porcelainBeforeCommit === null) {
    return blockedIntegration(input.action.type, "Could not read target repository porcelain status before integration.", input.checks, [
      "porcelain status readback returned no output",
    ]);
  }

  const verifiedIndexBefore = snapshotIndexEntries(input.git, input.repoPath, verifiedDirty);
  if (!verifiedIndexBefore.ok) {
    return blockedIntegration(input.action.type, "Could not snapshot verified target index entries.", input.checks, [
      `failed to read verified index paths: ${verifiedDirty.join(",")}`,
    ]);
  }

  input.checks.push({
    name: "target path classification",
    status: "passed",
    evidence: `verified=${verifiedDirty.join(",") || "none"};preserved=${disjointDirty.join(",") || "none"}`,
  });
  input.checks.push({
    name: "target materialized worker changes",
    status: "passed",
    evidence: verifiedDirty.join(","),
  });
  if (disjointDirty.length > 0) {
    input.checks.push({
      name: "disjoint target paths preserved",
      status: "passed",
      evidence: disjointDirty.join(","),
    });
  }

  // Detect target HEAD drift between snapshot and commit. If a concurrent
  // actor moved HEAD, leave the snapshot intact and the working tree untouched,
  // and surface a blocked result without producing a receipt.
  const headAtCommit = readGitStdout(input.git, input.repoPath, ["rev-parse", "HEAD"]);
  if (!headAtCommit || headAtCommit !== headBeforeCommit) {
    return blockedIntegration(input.action.type, "Target repository HEAD drifted between snapshot and commit.", input.checks, [
      `HEAD moved from ${headBeforeCommit} to ${headAtCommit ?? "unknown"} before commit`,
    ]);
  }

  const temporaryTree = createMaterializedIntegrationTree(input.git, input.repoPath, headBeforeCommit, verifiedDirty);
  if (!temporaryTree.ok) {
    return blockedCommand(input.action.type, "Could not create an isolated integration tree.", input.checks, temporaryTree.result);
  }
  const commit = runGitStep(input.git, input.repoPath, [
    "-c",
    "commit.gpgSign=false",
    "commit-tree",
    temporaryTree.tree,
    "-p",
    headBeforeCommit,
    "-m",
    input.commitMessage,
  ]);
  if (!commit.ok) {
    return blockedCommand(input.action.type, "Could not commit materialized target changes.", input.checks, commit);
  }
  const mergeCommit = commit.stdout.trim();
  if (!/^[0-9a-f]{40}$/i.test(mergeCommit)) {
    return blockedCommand(input.action.type, "Git returned an invalid integration commit.", input.checks, commit);
  }
  const update = runGitStep(input.git, input.repoPath, [
    "update-ref",
    `refs/heads/${input.targetBranch}`,
    mergeCommit,
    headBeforeCommit,
  ]);
  if (!update.ok) {
    return blockedCommand(input.action.type, "Could not update the target branch with the verified integration commit.", input.checks, update);
  }
  input.checks.push({ name: "target commit", status: "passed", evidence: mergeCommit });

  const indexSync = syncIndexToTree(input.git, input.repoPath, temporaryTree.tree, verifiedDirty);
  if (!indexSync.ok) {
    const rollback = rollbackMaterializedIntegration(input.git, input.repoPath, input.action.type, input.checks, headBeforeCommit);
    restoreIndexEntries(input.git, input.repoPath, verifiedIndexBefore.entries);
    return rollback ?? blockedIntegration(input.action.type, "Could not synchronize the target index with the verified integration commit.", input.checks, [
      `failed to synchronize verified index paths: ${verifiedDirty.join(",")}`,
    ]);
  }

  // Independent post-integration readback of every preserved disjoint path.
  // Failed readback rolls back the integration commit so no success receipt
  // is emitted until disjoint operator edits are proven intact.
  const readback = readbackDisjointTargetPaths(input.git, input.repoPath, disjointSnapshot);
  if (!readback.ok) {
    const rollback = rollbackMaterializedIntegration(input.git, input.repoPath, input.action.type, input.checks, headBeforeCommit);
    restoreIndexEntries(input.git, input.repoPath, verifiedIndexBefore.entries);
    if (rollback) {
      restoreIndexEntries(input.git, input.repoPath, verifiedIndexBefore.entries);
      return rollback;
    }
    restoreIndexEntries(input.git, input.repoPath, verifiedIndexBefore.entries);
    return blockedIntegration(input.action.type, "Independent post-integration readback of preserved target paths failed.", input.checks, [
      `readback mismatch for disjoint paths: ${readback.mismatched.join(",")}`,
    ]);
  }
  const integratedReadback = verifyIntegratedTargetPaths(
    input.git,
    input.repoPath,
    mergeCommit,
    verifiedDirty,
  );
  if (!integratedReadback.ok) {
    const rollback = rollbackMaterializedIntegration(input.git, input.repoPath, input.action.type, input.checks, headBeforeCommit);
    restoreIndexEntries(input.git, input.repoPath, verifiedIndexBefore.entries);
    if (rollback) {
      return { ...rollback, problems: [integratedReadback.reason, ...rollback.problems] };
    }
    return blockedIntegration(input.action.type, "Independent post-integration readback of verified target paths failed.", input.checks, [
      integratedReadback.reason,
    ]);
  }
  input.checks.push({
    name: "preserved target readback",
    status: "passed",
    evidence: disjointDirty.length === 0 ? "no disjoint paths" : disjointDirty.join(","),
  });

  let pushed = false;
  if (input.action.push === true) {
    const push = runGitStep(input.git, input.repoPath, ["push", "origin", input.targetBranch]);
    if (!push.ok) {
      const rollback = rollbackMaterializedIntegration(input.git, input.repoPath, input.action.type, input.checks, headBeforeCommit);
      if (rollback) {
        return rollback;
      }
      return blockedCommand(input.action.type, "Could not push target branch.", input.checks, push);
    }
    pushed = true;
    input.checks.push({ name: "push", status: "passed", evidence: `origin ${input.targetBranch}` });
  }

  const sourceBranch = readGitStdout(input.git, input.worktreePath, ["branch", "--show-current"]);
  return doneResult(input.action.type, `Committed materialized verified task ${input.worker.id} on ${input.targetBranch}.`, input.checks, [
    {
      kind: "integration",
      mode: "materialized_target_commit",
      runId: input.action.runId,
      workerTaskId: input.worker.id,
      verifierTaskId: input.verifier.id,
      goalReviewTaskId: input.goalReview?.id ?? null,
      preCompletion: input.isPreCompletionIntegration,
      repoPath: input.repoPath,
      worktreePath: input.worktreePath,
      targetBranch: input.targetBranch,
      sourceBranch,
      workerCommit: null,
      mergeCommit,
      pushed,
      changedFiles: input.changedFiles,
      materializedFiles: verifiedDirty,
      preservedDisjointFiles: disjointDirty,
      targetHeadBefore: headBeforeCommit,
      porcelainBefore: porcelainBeforeCommit,
      reason: input.action.reason ?? null,
    },
  ]);
}

type ExactGitIndexCommitAction = Extract<HarnessAction, { type: "commitExactGitIndex" }>;

type ExactGitIndexCommitStatus =
  | "committed"
  | "reused"
  | "response_loss_recovered"
  | "scope_mismatch"
  | "task_invalid"
  | "verification_invalid"
  | "repo_invalid"
  | "index_mismatch"
  | "commit_failed"
  | "cas_failed"
  | "readback_mismatch";

function commitExactGitIndex(
  harness: Harness,
  action: ExactGitIndexCommitAction,
  options: HarnessActionOptions,
): HarnessActionResult {
  const checks: HarnessActionResult["checks"] = [];
  const run = harness.getRun(action.runId);
  if (!run) {
    return failedGitIndexCommit(action, "scope_mismatch", `Run not found: ${action.runId}`, checks);
  }
  checks.push({ name: "run exists", status: "passed", evidence: action.runId });

  const frozen = frozenGitIndexCommitContract(run.context, action.contractId);
  if (!frozen || !sameGitIndexCommitContract(frozen, action)) {
    return failedGitIndexCommit(
      action,
      "scope_mismatch",
      `Git index commit request does not match frozen contract ${action.contractId}.`,
      checks,
    );
  }
  checks.push({ name: "frozen contract", status: "passed", evidence: action.contractId });

  const task = harness.getTask(action.taskId);
  if (
    !task ||
    task.runId !== action.runId ||
    task.status !== "done" ||
    ["planner", "verifier", "goal-review"].includes(task.role)
  ) {
    return failedGitIndexCommit(
      action,
      "task_invalid",
      `Task ${action.taskId} is not a completed execution task in run ${action.runId}.`,
      checks,
    );
  }
  checks.push({ name: "execution task", status: "passed", evidence: action.taskId });

  const overview = harness.getRunOverview({ runId: action.runId, eventLimit: 0 });
  const attempt = latestSessionForTask(overview, action.taskId);
  const contractPaths = action.files.map((file) => file.path);
  const changedFiles = Array.isArray(attempt?.output.changedFiles) ? attempt.output.changedFiles : [];
  if (!attempt || !sameUniqueStrings(changedFiles, contractPaths)) {
    return failedGitIndexCommit(
      action,
      "task_invalid",
      `Task ${action.taskId} done attempt changedFiles do not exactly match the frozen files.`,
      checks,
    );
  }
  checks.push({ name: "worker changedFiles", status: "passed", evidence: contractPaths.join(",") });

  const verifierEvidence = exactCommitVerifierEvidence(overview, action.taskId);
  if (!verifierEvidence.ok) {
    return failedGitIndexCommit(
      action,
      "verification_invalid",
      `Task ${action.taskId} dependency verifier evidence is incomplete or failed: ${verifierEvidence.reason}.`,
      checks,
    );
  }
  checks.push({
    name: "all verifier evidence",
    status: "passed",
    evidence: verifierEvidence.verifiers.map((verifier) => verifier.id).join(","),
  });

  if (!existsSync(action.repoPath)) {
    return failedGitIndexCommit(action, "repo_invalid", "Repository path does not exist.", checks);
  }
  const taskWorktreePath = task.worktreePath
    ? resolveWorktreePath(action.repoPath, task.worktreePath)
    : null;
  if (!taskWorktreePath || !existsSync(taskWorktreePath)) {
    return failedGitIndexCommit(action, "task_invalid", `Task ${action.taskId} has no existing worktree.`, checks);
  }
  try {
    if (realpathSync(taskWorktreePath) !== realpathSync(action.repoPath)) {
      return failedGitIndexCommit(
        action,
        "task_invalid",
        `Task ${action.taskId} worktree does not match the frozen repository path.`,
        checks,
      );
    }
  } catch {
    return failedGitIndexCommit(action, "task_invalid", `Task ${action.taskId} worktree could not be resolved.`, checks);
  }
  checks.push({ name: "task worktree", status: "passed", evidence: action.repoPath });
  const git = options.runGit ?? defaultGitRunner;
  const topLevel = safeGitStep(git, action.repoPath, ["rev-parse", "--show-toplevel"]);
  if (!topLevel.ok) {
    return failedGitIndexCommit(action, "repo_invalid", "Could not read the repository top-level.", checks, topLevel);
  }
  let requestedTopLevel: string;
  let actualTopLevel: string;
  try {
    requestedTopLevel = realpathSync(action.repoPath);
    actualTopLevel = realpathSync(topLevel.stdout.trim());
  } catch {
    return failedGitIndexCommit(action, "repo_invalid", "Could not resolve the repository top-level.", checks);
  }
  if (requestedTopLevel !== actualTopLevel) {
    return failedGitIndexCommit(action, "repo_invalid", "repoPath must be the exact repository top-level.", checks);
  }
  checks.push({ name: "repository top-level", status: "passed", evidence: action.repoPath });

  const branch = safeGitStep(git, action.repoPath, ["branch", "--show-current"]);
  if (!branch.ok || branch.stdout.trim() !== action.branch) {
    return failedGitIndexCommit(action, "repo_invalid", `Repository is not on frozen branch ${action.branch}.`, checks, branch);
  }
  checks.push({ name: "branch", status: "passed", evidence: action.branch });

  const mergeHead = safeGitStep(git, action.repoPath, ["rev-parse", "--verify", "-q", "MERGE_HEAD"]);
  if (mergeHead.ok) {
    return failedGitIndexCommit(action, "repo_invalid", "Repository has an unfinished merge (MERGE_HEAD).", checks);
  }
  if (mergeHead.exitCode !== 1) {
    return failedGitIndexCommit(action, "repo_invalid", "Could not verify MERGE_HEAD absence.", checks, mergeHead);
  }
  checks.push({ name: "no MERGE_HEAD", status: "passed", evidence: "absent" });

  const initialWorktreeState = exactGitWorktreeState(git, action.repoPath);
  if (!initialWorktreeState.ok) {
    return failedGitIndexCommit(
      action,
      "repo_invalid",
      initialWorktreeState.summary,
      checks,
      initialWorktreeState.result,
    );
  }
  checks.push({ name: "worktree state", status: "passed", evidence: "no unstaged, untracked, or conflicted files" });

  const head = safeGitStep(git, action.repoPath, ["rev-parse", "HEAD"]);
  if (!head.ok || !/^[0-9a-f]{40}$/.test(head.stdout.trim())) {
    return failedGitIndexCommit(action, "repo_invalid", "Could not read repository HEAD.", checks, head);
  }
  const observedHead = head.stdout.trim();
  if (observedHead !== action.expectedParentSha) {
    const reusedTree = safeGitStep(git, action.repoPath, ["write-tree"]);
    if (!reusedTree.ok || !/^[0-9a-f]{40}$/.test(reusedTree.stdout.trim())) {
      return failedGitIndexCommit(action, "readback_mismatch", "Could not read the existing index tree.", checks, reusedTree);
    }
    const reusedReadback = verifyExactGitIndexCommit(git, action, observedHead, reusedTree.stdout.trim());
    if (!reusedReadback.ok) {
      return failedGitIndexCommit(
        action,
        "repo_invalid",
        `Repository HEAD does not equal expectedParentSha ${action.expectedParentSha}.`,
        checks,
        reusedReadback.result,
      );
    }
    checks.push(...reusedReadback.checks);
    return verifiedGitIndexCommit(
      action,
      verifierEvidence.verifiers.map((verifier) => verifier.id),
      observedHead,
      reusedTree.stdout.trim(),
      "reused",
      checks,
    );
  }
  checks.push({ name: "expected parent", status: "passed", evidence: action.expectedParentSha });

  const staged = safeGitStep(git, action.repoPath, [
    "diff",
    "--cached",
    "--name-status",
    "-z",
    "--diff-filter=ACDMRTUXB",
    action.expectedParentSha,
    "--",
  ]);
  if (!staged.ok) {
    return failedGitIndexCommit(action, "repo_invalid", "Could not inspect the staged index delta.", checks, staged);
  }
  const stagedFiles = parseNameStatusZ(staged.stdout);
  if (!stagedFiles || !sameExactIndexFileSet(stagedFiles, action.files)) {
    return failedGitIndexCommit(action, "index_mismatch", "Staged paths and statuses do not match the frozen additions.", checks);
  }

  for (const file of action.files) {
    const entry = safeGitStep(git, action.repoPath, ["ls-files", "--stage", "-z", "--", file.path]);
    if (!entry.ok || !sameExactIndexEntry(entry.stdout, file)) {
      return failedGitIndexCommit(
        action,
        "index_mismatch",
        `Staged mode or blob does not match the frozen addition ${file.path}.`,
        checks,
        entry,
      );
    }
    const blob = safeGitStep(git, action.repoPath, ["cat-file", "-e", `${file.blobOid}^{blob}`]);
    if (!blob.ok) {
      return failedGitIndexCommit(
        action,
        "index_mismatch",
        `Frozen blob OID is not a local blob for ${file.path}.`,
        checks,
        blob,
      );
    }
  }
  checks.push({ name: "exact staged index", status: "passed", evidence: contractPaths.join(",") });

  const tree = safeGitStep(git, action.repoPath, ["write-tree"]);
  if (!tree.ok || !/^[0-9a-f]{40}$/.test(tree.stdout.trim())) {
    return failedGitIndexCommit(action, "commit_failed", "Could not write the exact index tree.", checks, tree);
  }
  const treeOid = tree.stdout.trim();
  const exactTree = verifyExactGitIndexTree(git, action, treeOid);
  if (!exactTree.ok) {
    return failedGitIndexCommit(
      action,
      "index_mismatch",
      "Written index tree does not exactly match the frozen additions.",
      checks,
      exactTree.result,
    );
  }
  checks.push(...exactTree.checks);
  const commit = safeGitStep(git, action.repoPath, [
    "-c",
    "commit.gpgSign=false",
    "commit-tree",
    treeOid,
    "-p",
    action.expectedParentSha,
    "-m",
    action.commitMessage,
  ]);
  const commitSha = commit.stdout.trim();
  if (!commit.ok || !/^[0-9a-f]{40}$/.test(commitSha)) {
    return failedGitIndexCommit(action, "commit_failed", "Could not create the exact unsigned commit object.", checks, commit);
  }
  checks.push({ name: "commit object", status: "passed", evidence: commitSha });

  const lateIndexTree = safeGitStep(git, action.repoPath, ["write-tree"]);
  if (!lateIndexTree.ok || lateIndexTree.stdout.trim() !== treeOid) {
    return failedGitIndexCommit(
      action,
      "index_mismatch",
      "Repository index tree changed after commit creation; branch was not updated.",
      checks,
      lateIndexTree,
    );
  }
  const lateWorktreeState = exactGitWorktreeState(git, action.repoPath);
  if (!lateWorktreeState.ok) {
    return failedGitIndexCommit(
      action,
      "repo_invalid",
      `Repository state changed after commit creation; branch was not updated. ${lateWorktreeState.summary}`,
      checks,
      lateWorktreeState.result,
    );
  }
  checks.push({ name: "pre-CAS index and worktree", status: "passed", evidence: treeOid });

  const update = safeGitStep(git, action.repoPath, [
    "update-ref",
    `refs/heads/${action.branch}`,
    commitSha,
    action.expectedParentSha,
  ]);
  const headAfter = safeGitStep(git, action.repoPath, ["rev-parse", "HEAD"]);
  if (!headAfter.ok || headAfter.stdout.trim() !== commitSha) {
    return failedGitIndexCommit(
      action,
      update.ok ? "readback_mismatch" : "cas_failed",
      update.ok ? "CAS update returned success but HEAD readback mismatched." : "CAS update failed.",
      checks,
      update.ok ? headAfter : update,
    );
  }

  const readback = verifyExactGitIndexCommit(git, action, commitSha, treeOid);
  if (!readback.ok) {
    return failedGitIndexCommit(action, "readback_mismatch", "Independent commit readback failed.", checks, readback.result);
  }
  checks.push(...readback.checks);
  return verifiedGitIndexCommit(
    action,
    verifierEvidence.verifiers.map((verifier) => verifier.id),
    commitSha,
    treeOid,
    update.ok ? "committed" : "response_loss_recovered",
    checks,
  );
}

function frozenGitIndexCommitContract(context: Record<string, unknown>, contractId: string) {
  const contracts = context.gitIndexCommitContracts;
  if (!contracts || typeof contracts !== "object" || Array.isArray(contracts)) {
    return null;
  }
  const value = (contracts as Record<string, unknown>)[contractId];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function sameGitIndexCommitContract(frozen: Record<string, unknown>, action: ExactGitIndexCommitAction) {
  const fields = ["branch", "commitMessage", "expectedParentSha", "files", "repoPath", "runId", "taskId"];
  if (Object.keys(frozen).sort().join("\0") !== fields.join("\0")) {
    return false;
  }
  return frozen.runId === action.runId &&
    frozen.taskId === action.taskId &&
    frozen.repoPath === action.repoPath &&
    frozen.branch === action.branch &&
    frozen.expectedParentSha === action.expectedParentSha &&
    frozen.commitMessage === action.commitMessage &&
    JSON.stringify(frozen.files) === JSON.stringify(action.files);
}

function sameUniqueStrings(actual: unknown[], expected: string[]) {
  if (actual.some((value) => typeof value !== "string")) {
    return false;
  }
  const strings = actual as string[];
  return strings.length === new Set(strings).size &&
    strings.length === expected.length &&
    [...strings].sort().join("\0") === [...expected].sort().join("\0");
}

function exactCommitVerifierEvidence(
  overview: RunOverview,
  workerTaskId: string,
): { ok: true; verifiers: Task[] } | { ok: false; reason: string } {
  const verifiers = overview.tasks.filter((task) =>
    task.role === "verifier" && task.dependsOn.includes(workerTaskId)
  );
  if (verifiers.length === 0) {
    return { ok: false, reason: "no dependency verifier exists" };
  }
  for (const verifier of verifiers) {
    if (verifier.status !== "done") {
      return { ok: false, reason: `verifier ${verifier.id} task status is ${verifier.status}` };
    }
    const latestAttempt = [...overview.sessions].reverse().find((session) => session.taskId === verifier.id);
    if (!latestAttempt || latestAttempt.status !== "done" || latestAttempt.output.status !== "done") {
      return { ok: false, reason: `verifier ${verifier.id} latest attempt is not done` };
    }
    const checks = Array.isArray(latestAttempt.output.checks) ? latestAttempt.output.checks : [];
    if (checks.some(isFailedCheck)) {
      return { ok: false, reason: `verifier ${verifier.id} has failed checks` };
    }
  }
  return { ok: true, verifiers };
}

function parseNameStatusZ(value: string) {
  const fields = value.split("\0");
  if (fields[fields.length - 1] === "") {
    fields.pop();
  }
  if (fields.length % 2 !== 0) {
    return null;
  }
  const entries: Array<{ status: string; path: string }> = [];
  for (let index = 0; index < fields.length; index += 2) {
    entries.push({ status: fields[index]!, path: fields[index + 1]! });
  }
  return entries;
}

function sameExactIndexFileSet(actual: Array<{ status: string; path: string }>, expected: ExactGitIndexFile[]) {
  return actual.length === expected.length && expected.every((file) =>
    actual.some((entry) => entry.status === file.status && entry.path === file.path)
  );
}

function sameExactIndexEntry(value: string, file: ExactGitIndexFile) {
  const match = value.match(/^([0-9]{6}) ([0-9a-f]{40}) ([0-3])\t([^\0]+)\0$/);
  return Boolean(
    match &&
    match[1] === file.mode &&
    match[2] === file.blobOid &&
    match[3] === "0" &&
    match[4] === file.path,
  );
}

function exactGitWorktreeState(
  git: GitRunner,
  repoPath: string,
):
  | { ok: true }
  | { ok: false; summary: string; result: ReturnType<typeof safeGitStep> } {
  const unstaged = safeGitStep(git, repoPath, ["diff", "--name-only", "-z"]);
  if (!unstaged.ok || unstaged.stdout.length > 0) {
    return { ok: false, summary: "Repository has unstaged changes.", result: unstaged };
  }
  const untracked = safeGitStep(git, repoPath, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (!untracked.ok || untracked.stdout.length > 0) {
    return { ok: false, summary: "Repository has untracked files.", result: untracked };
  }
  const conflicts = safeGitStep(git, repoPath, ["ls-files", "--unmerged", "-z"]);
  if (!conflicts.ok || conflicts.stdout.length > 0) {
    return { ok: false, summary: "Repository index contains conflicts.", result: conflicts };
  }
  return { ok: true };
}

function verifyExactGitIndexTree(
  git: GitRunner,
  action: ExactGitIndexCommitAction,
  treeOid: string,
): { ok: true; checks: HarnessActionResult["checks"] } | { ok: false; result?: ReturnType<typeof safeGitStep> } {
  const changed = safeGitStep(git, action.repoPath, [
    "diff-tree",
    "--no-commit-id",
    "--name-status",
    "-r",
    "-z",
    action.expectedParentSha,
    treeOid,
    "--",
  ]);
  const changedFiles = changed.ok ? parseNameStatusZ(changed.stdout) : null;
  if (!changed.ok || !changedFiles || !sameExactIndexFileSet(changedFiles, action.files)) {
    return { ok: false, result: changed };
  }
  for (const file of action.files) {
    const entry = safeGitStep(git, action.repoPath, ["ls-tree", "-z", treeOid, "--", file.path]);
    const match = entry.stdout.match(/^([0-9]{6}) blob ([0-9a-f]{40})\t([^\0]+)\0$/);
    if (!entry.ok || !match || match[1] !== file.mode || match[2] !== file.blobOid || match[3] !== file.path) {
      return { ok: false, result: entry };
    }
  }
  return {
    ok: true,
    checks: [{
      name: "exact tree readback",
      status: "passed",
      evidence: `${treeOid}:${action.files.map((file) => file.path).join(",")}`,
    }],
  };
}

function verifyExactGitIndexCommit(
  git: GitRunner,
  action: ExactGitIndexCommitAction,
  commitSha: string,
  expectedTree: string,
): { ok: true; checks: HarnessActionResult["checks"] } | { ok: false; result?: ReturnType<typeof safeGitStep> } {
  const commit = safeGitStep(git, action.repoPath, ["cat-file", "-p", commitSha]);
  if (!commit.ok) {
    return { ok: false, result: commit };
  }
  const separator = commit.stdout.indexOf("\n\n");
  if (separator < 0) {
    return { ok: false, result: { ...commit, ok: false, exitCode: 1, stderr: "commit readback has no message separator" } };
  }
  const headers = commit.stdout.slice(0, separator).split("\n");
  const storedMessage = commit.stdout.slice(separator + 2);
  const treeHeaders = headers.filter((line) => line.startsWith("tree "));
  const parentHeaders = headers.filter((line) => line.startsWith("parent "));
  const hasSignature = headers.some((line) => line.startsWith("gpgsig "));
  if (
    treeHeaders.length !== 1 || treeHeaders[0] !== `tree ${expectedTree}` ||
    parentHeaders.length !== 1 || parentHeaders[0] !== `parent ${action.expectedParentSha}` ||
    hasSignature ||
    storedMessage !== `${action.commitMessage}\n`
  ) {
    return { ok: false, result: { ...commit, ok: false, exitCode: 1, stdout: "", stderr: "commit parent tree message or signature readback mismatch" } };
  }

  const exactTree = verifyExactGitIndexTree(git, action, expectedTree);
  if (!exactTree.ok) {
    return exactTree;
  }
  const clean = safeGitStep(git, action.repoPath, ["status", "--porcelain=v1", "-z"]);
  if (!clean.ok || clean.stdout.length > 0) {
    return { ok: false, result: clean };
  }
  return {
    ok: true,
    checks: [
      { name: "independent commit readback", status: "passed", evidence: commitSha },
      { name: "parent tree message signature", status: "passed", evidence: "exact unsigned commit" },
      ...exactTree.checks,
      { name: "worktree clean", status: "passed", evidence: "clean" },
    ],
  };
}

function verifiedGitIndexCommit(
  action: ExactGitIndexCommitAction,
  verifierTaskIds: string[],
  sha: string,
  tree: string,
  status: Extract<ExactGitIndexCommitStatus, "committed" | "reused" | "response_loss_recovered">,
  checks: HarnessActionResult["checks"],
) {
  const verifierTaskId = verifierTaskIds[verifierTaskIds.length - 1]!;
  return doneResult(action.type, `Exact Git index commit verified on ${action.branch}.`, checks, [
    {
      kind: "git_commit",
      status,
      runId: action.runId,
      taskId: action.taskId,
      contractId: action.contractId,
      repoPath: action.repoPath,
      branch: action.branch,
      sha,
      parentSha: action.expectedParentSha,
      tree,
      files: action.files,
      signed: false,
      verifiedBy: "independent_readback",
    },
    {
      kind: "integration",
      mode: "exact_git_index_commit",
      runId: action.runId,
      workerTaskId: action.taskId,
      verifierTaskId,
      verifierTaskIds,
      repoPath: action.repoPath,
      targetBranch: action.branch,
      mergeCommit: sha,
      changedFiles: action.files.map((file) => file.path),
      alreadyMerged: true,
      pushed: false,
    },
  ]);
}

function failedGitIndexCommit(
  action: ExactGitIndexCommitAction,
  status: Exclude<ExactGitIndexCommitStatus, "committed" | "reused" | "response_loss_recovered">,
  summary: string,
  checks: HarnessActionResult["checks"],
  result?: ReturnType<typeof safeGitStep>,
): HarnessActionResult {
  const error = sanitizeGitRemoteText(result?.stderr.trim() || summary);
  return {
    status: "blocked",
    actionType: action.type,
    summary,
    checks: [...checks, { name: "exact Git index commit", status: "failed", evidence: status }],
    artifacts: [{
      kind: "git_index_commit",
      outcome: "failed",
      status,
      runId: action.runId,
      taskId: action.taskId,
      contractId: action.contractId,
      repoPath: action.repoPath,
      branch: action.branch,
      error,
    }],
    problems: [error],
  };
}

type ExactGitRemoteWriteAction = Extract<HarnessAction, { type: "pushExactGitRef" }>;

type ExactGitRemoteWriteStatus =
  | "pushed"
  | "reused"
  | "response_loss_recovered"
  | "scope_mismatch"
  | "repo_invalid"
  | "remote_read_failed"
  | "remote_state_mismatch"
  | "non_fast_forward"
  | "push_failed"
  | "readback_mismatch";

function pushExactGitRef(
  harness: Harness,
  action: ExactGitRemoteWriteAction,
  options: HarnessActionOptions,
): HarnessActionResult {
  const checks: HarnessActionResult["checks"] = [];
  const run = harness.getRun(action.runId);
  if (!run) {
    return failedGitRemoteWrite(action, "scope_mismatch", `Run not found: ${action.runId}`, checks);
  }
  checks.push({ name: "run exists", status: "passed", evidence: action.runId });

  const frozen = frozenGitRemoteWriteContract(run.context, action.contractId);
  if (!frozen || !sameGitRemoteWriteContract(frozen, action)) {
    return failedGitRemoteWrite(
      action,
      "scope_mismatch",
      `Git remote write request does not match frozen contract ${action.contractId}.`,
      checks,
    );
  }
  checks.push({ name: "frozen write contract", status: "passed", evidence: action.contractId });

  if (!existsSync(action.repoPath)) {
    return failedGitRemoteWrite(action, "repo_invalid", `Repository path does not exist: ${action.repoPath}`, checks);
  }

  const git = options.runGit ?? defaultGitRunner;
  const remoteUrl = safeGitStep(git, action.repoPath, ["remote", "get-url", "--push", "origin"]);
  if (!remoteUrl.ok) {
    return failedGitRemoteWrite(action, "repo_invalid", "Could not read the origin push URL.", checks, remoteUrl);
  }
  const remoteIdentity = parseGitRemoteIdentity(remoteUrl.stdout.trim());
  if (
    !remoteIdentity ||
    remoteIdentity.host !== action.remoteHost ||
    remoteIdentity.repository !== action.repository
  ) {
    return failedGitRemoteWrite(
      action,
      "scope_mismatch",
      "Configured origin does not match the frozen host and repository.",
      checks,
    );
  }
  checks.push({
    name: "origin scope",
    status: "passed",
    evidence: `${action.remoteHost}/${action.repository}`,
  });

  const head = safeGitStep(git, action.repoPath, ["rev-parse", "HEAD"]);
  if (!head.ok || head.stdout.trim().toLowerCase() !== action.newSha) {
    return failedGitRemoteWrite(
      action,
      "repo_invalid",
      `Repository HEAD must equal frozen newSha ${action.newSha}.`,
      checks,
      head,
    );
  }
  const commit = safeGitStep(git, action.repoPath, ["cat-file", "-e", `${action.newSha}^{commit}`]);
  if (!commit.ok) {
    return failedGitRemoteWrite(action, "repo_invalid", "Frozen newSha is not a local commit.", checks, commit);
  }
  checks.push({ name: "local commit", status: "passed", evidence: action.newSha });

  const ancestor = safeGitStep(git, action.repoPath, [
    "merge-base",
    "--is-ancestor",
    action.expectedOldSha,
    action.newSha,
  ]);
  if (!ancestor.ok) {
    return failedGitRemoteWrite(
      action,
      "non_fast_forward",
      "Frozen newSha is not a fast-forward descendant of expectedOldSha.",
      checks,
    );
  }
  checks.push({
    name: "fast-forward ancestry",
    status: "passed",
    evidence: `${action.expectedOldSha}..${action.newSha}`,
  });

  const before = readExactRemoteRef(git, action);
  if (!before.ok) {
    return failedGitRemoteWrite(action, "remote_read_failed", "Could not read the exact remote ref.", checks, before.result);
  }
  if (before.sha === action.newSha) {
    checks.push({ name: "independent remote readback", status: "passed", evidence: action.newSha });
    return verifiedGitRemoteWrite(action, "reused", checks);
  }
  if (before.sha !== action.expectedOldSha) {
    return failedGitRemoteWrite(
      action,
      "remote_state_mismatch",
      `Remote ref does not equal expectedOldSha ${action.expectedOldSha}.`,
      checks,
      undefined,
      before.sha,
    );
  }
  checks.push({ name: "remote expected old SHA", status: "passed", evidence: before.sha });

  const push = safeGitStep(git, action.repoPath, [
    "push",
    "--no-verify",
    "--porcelain",
    "origin",
    `${action.newSha}:${action.ref}`,
  ]);
  const after = readExactRemoteRef(git, action);
  if (after.ok && after.sha === action.newSha) {
    checks.push({ name: "independent remote readback", status: "passed", evidence: after.sha });
    return verifiedGitRemoteWrite(action, push.ok ? "pushed" : "response_loss_recovered", checks);
  }
  if (!after.ok) {
    return failedGitRemoteWrite(
      action,
      push.ok ? "readback_mismatch" : "push_failed",
      push.ok
        ? "Push returned success but independent remote readback failed."
        : "Push failed and independent remote readback could not confirm recovery.",
      checks,
      push.ok ? after.result : push,
    );
  }
  if (!push.ok && after.sha !== action.expectedOldSha) {
    return failedGitRemoteWrite(
      action,
      "non_fast_forward",
      "Remote ref changed during the exact push.",
      checks,
      push,
      after.sha,
    );
  }
  return failedGitRemoteWrite(
    action,
    push.ok ? "readback_mismatch" : "push_failed",
    push.ok
      ? "Push returned success but independent remote readback did not match newSha."
      : "Push failed and the remote ref still equals expectedOldSha.",
    checks,
    push,
    after.sha,
  );
}

function frozenGitRemoteWriteContract(context: Record<string, unknown>, contractId: string) {
  const contracts = context.gitRemoteWriteContracts;
  if (!contracts || typeof contracts !== "object" || Array.isArray(contracts)) {
    return null;
  }
  const value = (contracts as Record<string, unknown>)[contractId];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function sameGitRemoteWriteContract(frozen: Record<string, unknown>, action: ExactGitRemoteWriteAction) {
  const fields = ["expectedOldSha", "newSha", "ref", "remoteHost", "repoPath", "repository"];
  if (Object.keys(frozen).sort().join("\0") !== fields.join("\0")) {
    return false;
  }
  return frozen.repoPath === action.repoPath &&
    frozen.remoteHost === action.remoteHost &&
    frozen.repository === action.repository &&
    frozen.ref === action.ref &&
    frozen.expectedOldSha === action.expectedOldSha &&
    frozen.newSha === action.newSha;
}

function parseGitRemoteIdentity(value: string): { host: string; repository: string } | null {
  let host = "";
  let path = "";
  try {
    if (value.includes("://")) {
      const url = new URL(value);
      host = url.hostname.toLowerCase();
      path = url.pathname;
    } else {
      const scp = value.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
      if (!scp) {
        return null;
      }
      host = scp[1].toLowerCase();
      path = scp[2];
    }
  } catch {
    return null;
  }
  const repository = path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, "");
  if (!isGitRemoteHost(host) || !isGitRepository(repository)) {
    return null;
  }
  return { host, repository };
}

function readExactRemoteRef(
  git: GitRunner,
  action: ExactGitRemoteWriteAction,
): { ok: true; sha: string } | { ok: false; result: ReturnType<typeof safeGitStep> } {
  const result = safeGitStep(git, action.repoPath, ["ls-remote", "--exit-code", "origin", action.ref]);
  if (!result.ok) {
    return { ok: false, result };
  }
  const rows = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields.length >= 2);
  if (rows.length !== 1 || rows[0][1] !== action.ref || !isGitCommitSha(rows[0][0])) {
    return {
      ok: false,
      result: {
        ...result,
        ok: false,
        exitCode: 1,
        stderr: "exact ls-remote readback returned an invalid or ambiguous ref",
      },
    };
  }
  return { ok: true, sha: rows[0][0].toLowerCase() };
}

function verifiedGitRemoteWrite(
  action: ExactGitRemoteWriteAction,
  status: Extract<ExactGitRemoteWriteStatus, "pushed" | "reused" | "response_loss_recovered">,
  checks: HarnessActionResult["checks"],
) {
  return doneResult(action.type, `Exact Git remote write verified for ${action.ref}.`, checks, [
    gitRemoteWriteArtifact(action, "verified", status),
  ]);
}

function failedGitRemoteWrite(
  action: ExactGitRemoteWriteAction,
  status: Exclude<ExactGitRemoteWriteStatus, "pushed" | "reused" | "response_loss_recovered">,
  summary: string,
  checks: HarnessActionResult["checks"],
  result?: ReturnType<typeof safeGitStep>,
  observedSha?: string,
): HarnessActionResult {
  const error = sanitizeGitRemoteText(
    result?.stderr.trim() || result?.stdout.trim() || summary,
  );
  return {
    status: "blocked",
    actionType: action.type,
    summary,
    checks: [
      ...checks,
      { name: "exact Git remote write", status: "failed", evidence: status },
    ],
    artifacts: [
      {
        ...gitRemoteWriteArtifact(action, "failed", status),
        ...(observedSha ? { observedSha } : {}),
        error,
      },
    ],
    problems: [error],
  };
}

function gitRemoteWriteArtifact(
  action: ExactGitRemoteWriteAction,
  outcome: "verified" | "failed",
  status: ExactGitRemoteWriteStatus,
) {
  return {
    kind: "git_remote_write",
    outcome,
    status,
    runId: action.runId,
    contractId: action.contractId,
    repoPath: action.repoPath,
    remoteHost: action.remoteHost,
    repository: action.repository,
    ref: action.ref,
    expectedOldSha: action.expectedOldSha,
    newSha: action.newSha,
    verifiedBy: outcome === "verified" ? "independent_readback" : null,
    reason: action.reason ?? null,
  };
}

type ExactGitRefCreationAction = Extract<HarnessAction, { type: "createExactGitRef" }>;

type ExactGitRefCreationStatus =
  | "created"
  | "reused"
  | "response_loss_recovered"
  | "scope_mismatch"
  | "repo_invalid"
  | "remote_read_failed"
  | "conflict"
  | "push_failed"
  | "readback_mismatch";

function createExactGitRef(
  harness: Harness,
  action: ExactGitRefCreationAction,
  options: HarnessActionOptions,
): HarnessActionResult {
  const checks: HarnessActionResult["checks"] = [];
  const run = harness.getRun(action.runId);
  if (!run) {
    return failedGitRefCreation(action, "scope_mismatch", `Run not found: ${action.runId}`, checks);
  }
  checks.push({ name: "run exists", status: "passed", evidence: action.runId });

  const frozen = frozenGitRefCreationContract(run.context, action.contractId);
  if (!frozen || !sameGitRefCreationContract(frozen, action)) {
    return failedGitRefCreation(
      action,
      "scope_mismatch",
      `Git ref creation request does not match frozen contract ${action.contractId}.`,
      checks,
    );
  }
  checks.push({ name: "frozen creation contract", status: "passed", evidence: action.contractId });

  if (!existsSync(action.repoPath)) {
    return failedGitRefCreation(action, "repo_invalid", `Repository path does not exist: ${action.repoPath}`, checks);
  }

  const git = options.runGit ?? defaultGitRunner;
  const remoteUrl = safeBoundedGitRemoteStep(git, action.repoPath, ["remote", "get-url", "--push", "origin"]);
  if (!remoteUrl.ok) {
    return failedGitRefCreation(action, "repo_invalid", "Could not read the origin push URL.", checks, remoteUrl);
  }
  const identity = parseGitRemoteIdentity(remoteUrl.stdout.trim());
  if (!identity || identity.host !== action.remoteHost || identity.repository !== action.repository) {
    return failedGitRefCreation(
      action,
      "scope_mismatch",
      "Configured origin does not match the frozen host and repository.",
      checks,
    );
  }
  checks.push({ name: "origin scope", status: "passed", evidence: `${action.remoteHost}/${action.repository}` });

  const head = safeBoundedGitRemoteStep(git, action.repoPath, ["rev-parse", "HEAD"]);
  if (!head.ok || head.stdout.trim().toLowerCase() !== action.newSha) {
    return failedGitRefCreation(
      action,
      "repo_invalid",
      `Repository HEAD must equal frozen newSha ${action.newSha}.`,
      checks,
      head,
    );
  }
  const commit = safeBoundedGitRemoteStep(git, action.repoPath, ["cat-file", "-e", `${action.newSha}^{commit}`]);
  if (!commit.ok) {
    return failedGitRefCreation(action, "repo_invalid", "Frozen newSha is not a local commit.", checks, commit);
  }
  checks.push({ name: "local commit", status: "passed", evidence: action.newSha });

  const before = readExactRemoteRefAllowAbsent(git, action);
  if (!before.ok) {
    return failedGitRefCreation(action, "remote_read_failed", "Could not read the exact remote ref.", checks, before.result);
  }
  if (before.sha === action.newSha) {
    checks.push({ name: "independent remote readback", status: "passed", evidence: action.newSha });
    return verifiedGitRefCreation(action, "reused", checks);
  }
  if (before.sha !== null) {
    return failedGitRefCreation(
      action,
      "conflict",
      "Remote ref already exists at a different SHA.",
      checks,
      undefined,
      before.sha,
    );
  }
  checks.push({ name: "remote ref absent", status: "passed", evidence: action.ref });

  const push = safeBoundedGitRemoteStep(git, action.repoPath, [
    "push",
    "--no-verify",
    "--porcelain",
    "origin",
    `${action.newSha}:${action.ref}`,
  ]);
  const after = readExactRemoteRefAllowAbsent(git, action);
  if (after.ok && after.sha === action.newSha) {
    checks.push({ name: "independent remote readback", status: "passed", evidence: action.newSha });
    return verifiedGitRefCreation(action, push.ok ? "created" : "response_loss_recovered", checks);
  }
  if (!after.ok) {
    return failedGitRefCreation(
      action,
      push.ok ? "readback_mismatch" : "push_failed",
      push.ok
        ? "Push returned success but independent remote readback failed."
        : "Push failed and independent remote readback could not confirm recovery.",
      checks,
      push.ok ? after.result : push,
    );
  }
  return failedGitRefCreation(
    action,
    push.ok ? "readback_mismatch" : "push_failed",
    push.ok
      ? "Push returned success but independent remote readback did not match newSha."
      : "Push failed and independent remote readback did not confirm newSha.",
    checks,
    push,
    after.sha ?? undefined,
  );
}

function frozenGitRefCreationContract(context: Record<string, unknown>, contractId: string) {
  const contracts = context.gitRefCreationContracts;
  if (!contracts || typeof contracts !== "object" || Array.isArray(contracts)) {
    return null;
  }
  const value = (contracts as Record<string, unknown>)[contractId];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function sameGitRefCreationContract(frozen: Record<string, unknown>, action: ExactGitRefCreationAction) {
  const fields = ["expectedAbsent", "newSha", "ref", "remoteHost", "repoPath", "repository"];
  if (Object.keys(frozen).sort().join("\0") !== fields.join("\0")) {
    return false;
  }
  return frozen.repoPath === action.repoPath &&
    frozen.remoteHost === action.remoteHost &&
    frozen.repository === action.repository &&
    frozen.ref === action.ref &&
    frozen.newSha === action.newSha &&
    frozen.expectedAbsent === true;
}

function readExactRemoteRefAllowAbsent(
  git: GitRunner,
  action: ExactGitRefCreationAction,
): { ok: true; sha: string | null } | { ok: false; result: ReturnType<typeof safeGitStep> } {
  const result = safeBoundedGitRemoteStep(git, action.repoPath, ["ls-remote", "--exit-code", "origin", action.ref]);
  if (!result.ok) {
    if (result.exitCode === 2 && result.stdout === "" && isExactBenignGitTransportSuccessNotice(result.stderr)) {
      return { ok: true, sha: null };
    }
    return { ok: false, result: { ...result, stderr: removeBenignGitTransportSuccessNotice(result.stderr) } };
  }
  const rows = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields.length >= 2);
  if (rows.length !== 1 || rows[0][1] !== action.ref || !isGitCommitSha(rows[0][0])) {
    return {
      ok: false,
      result: {
        ...result,
        ok: false,
        exitCode: 1,
        stderr: "exact ls-remote readback returned an invalid or ambiguous ref",
      },
    };
  }
  return { ok: true, sha: rows[0][0].toLowerCase() };
}

const BENIGN_GIT_TRANSPORT_SUCCESS_NOTICE = "Connection to ssh.github.com port 443 [tcp/https] succeeded!";

function isExactBenignGitTransportSuccessNotice(value: string) {
  return (
    value === "" ||
    value === BENIGN_GIT_TRANSPORT_SUCCESS_NOTICE ||
    value === `${BENIGN_GIT_TRANSPORT_SUCCESS_NOTICE}\n` ||
    value === `${BENIGN_GIT_TRANSPORT_SUCCESS_NOTICE}\r\n`
  );
}

function removeBenignGitTransportSuccessNotice(value: string) {
  return value
    .split(/\r?\n/)
    .filter((line) => line.trim() !== BENIGN_GIT_TRANSPORT_SUCCESS_NOTICE)
    .join("\n");
}

function verifiedGitRefCreation(
  action: ExactGitRefCreationAction,
  status: Extract<ExactGitRefCreationStatus, "created" | "reused" | "response_loss_recovered">,
  checks: HarnessActionResult["checks"],
) {
  return doneResult(action.type, `Exact Git ref creation verified for ${action.ref}.`, checks, [
    gitRefCreationArtifact(action, "verified", status),
  ]);
}

function failedGitRefCreation(
  action: ExactGitRefCreationAction,
  status: Exclude<ExactGitRefCreationStatus, "created" | "reused" | "response_loss_recovered">,
  summary: string,
  checks: HarnessActionResult["checks"],
  result?: ReturnType<typeof safeGitStep>,
  observedSha?: string,
): HarnessActionResult {
  const error = sanitizeGitRemoteText(result?.stderr.trim() || result?.stdout.trim() || summary);
  return {
    status: "blocked",
    actionType: action.type,
    summary,
    checks: [...checks, { name: "exact Git ref creation", status: "failed", evidence: status }],
    artifacts: [{
      ...gitRefCreationArtifact(action, "failed", status),
      ...(observedSha ? { observedSha } : {}),
      error,
    }],
    problems: [error],
  };
}

function gitRefCreationArtifact(
  action: ExactGitRefCreationAction,
  outcome: "verified" | "failed",
  status: ExactGitRefCreationStatus,
) {
  return {
    kind: "git_ref_creation",
    outcome,
    status,
    runId: action.runId,
    contractId: action.contractId,
    repoPath: action.repoPath,
    remoteHost: action.remoteHost,
    repository: action.repository,
    ref: action.ref,
    newSha: action.newSha,
    expectedAbsent: true,
    verifiedBy: outcome === "verified" ? "independent_readback" : null,
  };
}

function safeBoundedGitRemoteStep(git: GitRunner, cwd: string, args: string[]) {
  return safeGitStep(git, cwd, args, {
    timeoutMs: EXACT_GIT_REMOTE_TIMEOUT_MS,
    maxOutputBytes: EXACT_GIT_REMOTE_MAX_OUTPUT_BYTES,
  });
}

function safeGitStep(
  git: GitRunner,
  cwd: string,
  args: string[],
  limits: { timeoutMs?: number; maxOutputBytes?: number } = {},
) {
  try {
    const result = runGitStep(git, cwd, args, limits);
    const stdout = limitUtf8Output(result.stdout, limits.maxOutputBytes);
    const stderr = limitUtf8Output(result.stderr, limits.maxOutputBytes);
    return {
      ...result,
      stdout: sanitizeGitRemoteText(stdout),
      stderr: sanitizeGitRemoteText(stderr),
    };
  } catch (error) {
    return {
      ok: false,
      exitCode: -1,
      stdout: "",
      stderr: sanitizeGitRemoteText(errorMessage(error)),
      command: `git ${args.join(" ")}`,
      cwd,
    };
  }
}

function limitUtf8Output(value: string, maxBytes: number | undefined) {
  if (maxBytes === undefined || Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }
  return `${Buffer.from(value).subarray(0, maxBytes).toString("utf8")}\n[TRUNCATED]`;
}

function sanitizeGitRemoteText(value: string) {
  return value
    .replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, "$1[REDACTED]@")
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr|github_pat|glpat)[_-][A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(/(Authorization\s*:\s*(?:Bearer|Basic)\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/(x-access-token:)[^@\s]+/gi, "$1[REDACTED]");
}

function interruptAttemptAndCreateTask(
  harness: Harness,
  action: Extract<HarnessAction, { type: "interruptAttemptAndCreateTask" }>,
): HarnessActionResult {
  const prepared = prepareInterruptAttempt(harness, action.attemptId, action.type);
  if (!prepared.ok) {
    return prepared.result;
  }
  const followUpTaskId = applyInterruptAttempt(harness, prepared, action.reason, action.followUpTask);
  harness.updateRunStatus({ runId: prepared.run.id, status: "todo" });

  return doneResult(
    action.type,
    `Interrupted attempt ${prepared.attempt.id} and created follow-up task ${followUpTaskId}.`,
    [
      { name: "attempt exists", status: "passed", evidence: prepared.attempt.id },
      { name: "attempt status", status: "passed", evidence: "blocked" },
      { name: "task exists", status: "passed", evidence: prepared.task.id },
      { name: "run exists", status: "passed", evidence: prepared.run.id },
      {
        name: "execution thread coverage",
        status: "passed",
        evidence: prepared.matchingThreadIds.length > 0
          ? prepared.matchingThreadIds.join(",")
          : "no matching execution thread",
      },
      { name: "follow-up task created", status: "passed", evidence: followUpTaskId },
    ],
    [
      { kind: "attempt", attemptId: prepared.attempt.id, taskId: prepared.task.id, runId: prepared.run.id, status: "blocked", reason: action.reason },
      ...prepared.matchingThreadIds.map((threadId) => ({
        kind: "execution_thread",
        threadId,
        attemptId: prepared.attempt.id,
        taskId: prepared.task.id,
        runId: prepared.run.id,
        status: "interrupted",
        interruptReason: action.reason,
      })),
      {
        kind: "task",
        taskId: followUpTaskId,
        runId: prepared.run.id,
        parentTaskId: prepared.task.id,
        role: action.followUpTask.role,
        status: "todo",
        reason: action.reason,
      },
    ],
  );
}

function interruptRunningAttemptsAndCreateTask(
  harness: Harness,
  action: Extract<HarnessAction, { type: "interruptRunningAttemptsAndCreateTask" }>,
): HarnessActionResult {
  const uniqueAttemptIds = [...new Set(action.attemptIds)];
  if (uniqueAttemptIds.length === 0) {
    return blockedResult(action.type, "No attempts were provided.", ["attempt ids must not be empty"]);
  }

  const preparedAttempts: PreparedInterruptAttempt[] = [];
  for (const attemptId of uniqueAttemptIds) {
    const prepared = prepareInterruptAttempt(harness, attemptId, action.type);
    if (!prepared.ok) {
      return prepared.result;
    }
    if (preparedAttempts.length > 0 && prepared.run.id !== preparedAttempts[0]!.run.id) {
      return blockedResult(action.type, `Attempt ${attemptId} does not belong to run ${preparedAttempts[0]!.run.id}.`, [
        `attempt ${attemptId} does not belong to run ${preparedAttempts[0]!.run.id}`,
      ]);
    }
    preparedAttempts.push(prepared);
  }

  const primaryAttempt = preparedAttempts[0]!;
  const artifacts: Array<Record<string, unknown>> = [];
  const checks: HarnessActionResult["checks"] = [];
  const interruptedAttemptIds: string[] = [];
  let followUpTaskId: string | undefined;

  for (const [index, prepared] of preparedAttempts.entries()) {
    const createdFollowUpTask = index === 0;
    const taskFollowUpTaskId = applyInterruptAttempt(harness, prepared, action.reason, createdFollowUpTask ? action.followUpTask : undefined);
    interruptedAttemptIds.push(prepared.attempt.id);
    if (createdFollowUpTask) {
      followUpTaskId = taskFollowUpTaskId;
    }
    artifacts.push(
      { kind: "attempt", attemptId: prepared.attempt.id, taskId: prepared.task.id, runId: prepared.run.id, status: "blocked", reason: action.reason },
      ...prepared.matchingThreadIds.map((threadId) => ({
        kind: "execution_thread",
        threadId,
        attemptId: prepared.attempt.id,
        taskId: prepared.task.id,
        runId: prepared.run.id,
        status: "interrupted",
        interruptReason: action.reason,
      })),
    );
    checks.push(
      { name: "attempt exists", status: "passed", evidence: prepared.attempt.id },
      { name: "attempt status", status: "passed", evidence: "blocked" },
      { name: "task exists", status: "passed", evidence: prepared.task.id },
      { name: "run exists", status: "passed", evidence: prepared.run.id },
      {
        name: "execution thread coverage",
        status: "passed",
        evidence: prepared.matchingThreadIds.length > 0
          ? prepared.matchingThreadIds.join(",")
          : "no matching execution thread",
      },
    );
  }

  harness.updateRunStatus({ runId: primaryAttempt.run.id, status: "todo" });
  if (followUpTaskId !== undefined) {
    checks.push({ name: "follow-up task created", status: "passed", evidence: followUpTaskId });
    artifacts.push({
      kind: "task",
      taskId: followUpTaskId,
      runId: primaryAttempt.run.id,
      parentTaskId: primaryAttempt.task.id,
      role: action.followUpTask.role,
      status: "todo",
      reason: action.reason,
    });
  }

  return doneResult(
    action.type,
    `Interrupted ${interruptedAttemptIds.length} running attempt${interruptedAttemptIds.length === 1 ? "" : "s"} and created follow-up task ${followUpTaskId ?? "unknown"}.`,
    checks,
    artifacts,
  );
}

function acceptGuardrailProposalAction(
  harness: Harness,
  action: Extract<HarnessAction, { type: "acceptGuardrailProposal" }>,
): HarnessActionResult {
  const run = harness.getRun(action.runId);
  if (!run) {
    return blockedResult(action.type, `Run not found: ${action.runId}`, [`run not found: ${action.runId}`]);
  }
  const accepted = acceptGuardrailProposal({
    context: run.context,
    proposalId: action.proposalId,
    acceptedBy: action.acceptedBy,
  });
  if (!accepted) {
    return blockedResult(action.type, `Guardrail proposal not found: ${action.proposalId}`, [
      `guardrail proposal not found: ${action.proposalId} in run ${action.runId}`,
    ]);
  }

  const previousProposals = Array.isArray(run.context.guardrailProposals) ? run.context.guardrailProposals : [];
  const previousProposal = previousProposals.find((candidate) => {
    if (!candidate || typeof candidate !== "object") return false;
    const record = candidate as Record<string, unknown>;
    return record.id === action.proposalId;
  }) as Record<string, unknown> | undefined;
  const previousAcceptedFlag = previousProposal?.accepted === true;

  harness.updateRun({
    runId: action.runId,
    contextPatch: {
      guardrailProposals: accepted.nextProposals,
      guardrails: accepted.nextGuardrails,
    },
  });

  return doneResult(action.type, `Accepted guardrail proposal ${action.proposalId} for run ${action.runId}.`, [
    { name: "run exists", status: "passed", evidence: action.runId },
    { name: "proposal exists", status: "passed", evidence: action.proposalId },
    { name: "proposal previously accepted", status: "passed", evidence: String(previousAcceptedFlag) },
    { name: "accepted by", status: "passed", evidence: action.acceptedBy },
    { name: "guardrail active", status: "passed", evidence: "true" },
  ], [
    {
      kind: "guardrail_acceptance",
      runId: action.runId,
      proposalId: action.proposalId,
      guardrailId: accepted.guardrail.id,
      acceptedBy: action.acceptedBy,
      acceptedAt: accepted.guardrail.acceptedAt,
      previouslyAccepted: previousAcceptedFlag,
      reason: action.reason ?? null,
    },
  ]);
}

function prepareInterruptAttempt(
  harness: Harness,
  attemptId: string,
  actionType: HarnessAction["type"],
):
  | { ok: true; attempt: NonNullable<ReturnType<Harness["getAttempt"]>>; task: NonNullable<ReturnType<Harness["getTask"]>>; run: NonNullable<ReturnType<Harness["getRun"]>>; matchingThreadIds: string[] }
  | { ok: false; result: HarnessActionResult } {
  const attempt = harness.getAttempt(attemptId);
  if (!attempt) {
    return { ok: false, result: blockedResult(actionType, `Attempt not found: ${attemptId}`, [`attempt not found: ${attemptId}`]) };
  }
  if (attempt.status !== "running") {
    return {
      ok: false,
      result: blockedResult(actionType, `Attempt ${attemptId} is not running.`, [`attempt ${attemptId} is not running`]),
    };
  }
  const task = harness.getTask(attempt.taskId);
  if (!task) {
    return {
      ok: false,
      result: blockedResult(actionType, `Task not found for attempt: ${attemptId}`, [`task not found for attempt: ${attemptId}`]),
    };
  }
  const run = harness.getRun(task.runId);
  if (!run) {
    return { ok: false, result: blockedResult(actionType, `Run not found for task: ${task.id}`, [`run not found for task: ${task.id}`]) };
  }

  const matchingThreadIds = harness
    .listExecutionThreads({ runId: run.id })
    .filter((thread) => thread.status === "running" && (thread.attemptId === attempt.id || thread.taskId === task.id))
    .map((thread) => thread.id);

  return { ok: true, attempt, task, run, matchingThreadIds };
}

type PreparedInterruptAttempt = {
  attempt: NonNullable<ReturnType<Harness["getAttempt"]>>;
  task: NonNullable<ReturnType<Harness["getTask"]>>;
  run: NonNullable<ReturnType<Harness["getRun"]>>;
  matchingThreadIds: string[];
};

function applyInterruptAttempt(
  harness: Harness,
  prepared: PreparedInterruptAttempt,
  reason: string,
  followUpTask?: {
    role: string;
    goal: string;
    prompt: string;
    doneWhen?: string[];
  },
) {
  harness.finishAttempt({
    attemptId: prepared.attempt.id,
    output: {
      status: "blocked",
      summary: `Interrupted by overseer: ${reason}`,
      changedFiles: [],
      checks: [
        { name: "overseer interruption", status: "failed", evidence: reason },
        {
          name: "execution thread coverage",
          status: "passed",
          evidence: prepared.matchingThreadIds.length > 0 ? prepared.matchingThreadIds.join(",") : "no matching execution thread",
        },
      ],
      artifacts: [
        {
          kind: "overseer_interruption",
          attemptId: prepared.attempt.id,
          taskId: prepared.task.id,
          runId: prepared.run.id,
          reason,
          interruptedThreadIds: prepared.matchingThreadIds,
        },
      ],
      problems: [reason],
    },
  });

  for (const threadId of prepared.matchingThreadIds) {
    harness.updateExecutionThread({
      id: threadId,
      status: "interrupted",
      interruptReason: reason,
      heartbeat: true,
    });
  }

  if (!followUpTask) {
    return undefined;
  }

  return harness.createTask({
    runId: prepared.run.id,
    parentId: prepared.task.id,
    role: followUpTask.role,
    goal: followUpTask.goal,
    prompt: followUpTask.prompt,
    doneWhen: followUpTask.doneWhen ?? [],
  });
}

function prepareRunDrain(harness: Harness, action: Extract<HarnessAction, { type: "prepareRunDrain" }>): HarnessActionResult {
  const maxTries = action.maxTries ?? 3;
  const run = harness.getRun(action.runId);
  if (!run) {
    return blockedResult(action.type, `Run not found: ${action.runId}`, [`run not found: ${action.runId}`]);
  }
  if (run.status === "done") {
    return doneResult(action.type, `Run ${action.runId} is already done.`, [
      { name: "run status", status: "passed", evidence: "done" },
    ], [{ kind: "run", runId: action.runId, status: "done" }]);
  }

  const initialOverview = harness.getRunOverview({ runId: action.runId, eventLimit: 0 });
  const initialActive = initialOverview.tasks.some((task) => task.status === "todo" || task.status === "running");
  const initialGoalReviewInvalidated = initialOverview.run?.context.goalReviewInvalidatedByIntegration === true;
  const initialReviewSessions = currentGoalReviewSessions(initialOverview, initialGoalReviewInvalidated);
  const initialLatestReview = initialReviewSessions[initialReviewSessions.length - 1];
  const initialCompletedReview = initialGoalReviewInvalidated ? null : selectCompletedGoalReview(initialOverview);
  const terminalDisposition = currentGoalReviewTerminalDisposition(initialOverview);
  if (!initialGoalReviewInvalidated && terminalDisposition) {
    if (run.status !== "blocked") {
      harness.updateRunStatus({ runId: action.runId, status: "blocked" });
    }
    return {
      status: "blocked",
      actionType: action.type,
      summary: `Run ${action.runId} retains its terminal goal-review disposition.`,
      checks: [{
        name: "goal review terminal disposition",
        status: "failed",
        evidence: `${terminalDisposition.tries}/${terminalDisposition.maxTries}`,
      }],
      artifacts: [{ ...terminalDisposition, kind: "goal_review", status: "blocked" }],
      problems: [`goal-review terminal disposition already recorded for ${action.runId}`],
    };
  }
  const initialNonTerminalReviews = initialReviewSessions.filter((session) => {
    const decision = resolveRunDecision(session.output);
    return decision === "continue" || decision === "verify";
  });
  if (
    !initialActive &&
    !initialCompletedReview &&
    resolveRunDecision(initialLatestReview?.output ?? {}) !== "defer" &&
    initialNonTerminalReviews.length >= maxTries
  ) {
    return {
      ...goalReviewContinueLimitResult(harness, action.runId, initialNonTerminalReviews.length, maxTries),
      actionType: action.type,
    };
  }

  const reclaimed = harness.reclaimRunningTasksWithoutAttempts({ runId: action.runId });
  harness.clearRunPause(action.runId);
  harness.updateRunStatus({ runId: action.runId, status: "todo" });
  const sharedRootBlock = harness.blockTasksWithSharedRootCause({
    runId: action.runId,
    reason: "task dependencies are blocked",
  });
  const blockedDependencies = sharedRootBlock.blocked;
  const sharedRootCauses = sharedRootBlock.sharedRootCauses;
  if (sharedRootCauses.length > 0) {
    const existingSharedRootCauses = Array.isArray(run.context.sharedRootCauses)
      ? (run.context.sharedRootCauses as unknown[])
          .filter((value): value is Record<string, unknown> =>
            value != null && typeof value === "object" && !Array.isArray(value),
          )
          .map((value) => ({
            rootTaskId: typeof value.rootTaskId === "string" ? value.rootTaskId : "",
            rootAttemptId: typeof value.rootAttemptId === "string" ? value.rootAttemptId : undefined,
            reason: typeof value.reason === "string" ? value.reason : "",
            terminalReason: typeof value.terminalReason === "string" ? value.terminalReason : undefined,
            descendantTaskIds: Array.isArray(value.descendantTaskIds)
              ? value.descendantTaskIds.filter((item): item is string => typeof item === "string")
              : [],
            recordedAt: typeof value.recordedAt === "string" ? value.recordedAt : "",
          }))
          .filter((value) => value.rootTaskId.length > 0)
      : [];
    const keyedExisting = new Map(existingSharedRootCauses.map((cause) => [`${cause.rootTaskId}:${cause.recordedAt}`, cause]));
    for (const cause of sharedRootCauses) {
      const normalized: {
        rootTaskId: string;
        rootAttemptId: string | undefined;
        reason: string;
        terminalReason: string | undefined;
        descendantTaskIds: string[];
        recordedAt: string;
      } = {
        rootTaskId: cause.rootTaskId,
        rootAttemptId: cause.rootAttemptId,
        reason: cause.reason,
        terminalReason: cause.terminalReason,
        descendantTaskIds: cause.descendantTaskIds,
        recordedAt: cause.recordedAt,
      };
      keyedExisting.set(`${cause.rootTaskId}:${cause.recordedAt}`, normalized);
    }
    harness.updateRun({
      runId: action.runId,
      contextPatch: { sharedRootCauses: [...keyedExisting.values()] },
    });
  }
  const overview = harness.getRunOverview({ runId: action.runId, eventLimit: 0 });
  const active = overview.tasks.filter((task) => task.status === "todo" || task.status === "running");
  const checks: HarnessActionResult["checks"] = [
    { name: "run exists", status: "passed", evidence: action.runId },
    { name: "orphaned leases reclaimed", status: "passed", evidence: String(reclaimed.length) },
    { name: "run marked todo", status: "passed", evidence: "todo" },
  ];
  const artifacts: HarnessActionResult["artifacts"] = reclaimedArtifacts(reclaimed);
  if (sharedRootCauses.length > 0) {
    checks.push({ name: "shared root causes", status: "passed", evidence: String(sharedRootCauses.length) });
    artifacts.push(
      ...sharedRootCauses.map((cause) => ({
        kind: "shared_root_cause",
        rootTaskId: cause.rootTaskId,
        rootAttemptId: cause.rootAttemptId ?? null,
        terminalReason: cause.terminalReason ?? null,
        descendantTaskIds: cause.descendantTaskIds,
        reason: cause.reason,
        recordedAt: cause.recordedAt,
      })),
    );
  }
  if (blockedDependencies.length > 0) {
    checks.push({ name: "blocked dependency tasks", status: "passed", evidence: String(blockedDependencies.length) });
    artifacts.push(...blockedDependencies.map((task) => ({
      kind: "blocked_dependency_task",
      taskId: task.taskId,
      role: task.role,
      dependencyIds: task.dependencyIds,
      reason: task.reason,
    })));
  }
  artifacts.push({ kind: "run", runId: action.runId, previousStatus: run.status, status: "todo", reason: action.reason ?? null });

  if (active.length > 0) {
    checks.push({ name: "active work", status: "passed", evidence: `${active.length} todo/running task(s)` });
    artifacts.push(...active.map((task) => ({ kind: "active_task", taskId: task.id, role: task.role, status: task.status })));
    return doneResult(action.type, `Run ${action.runId} has ${active.length} active task${active.length === 1 ? "" : "s"} ready for a runner.`, checks, artifacts);
  }

  const proposals = proposeGuardrailsFromLessons({
    lessons: harness.listLessons({ runId: action.runId }),
    existingProposals: overview.run?.context.guardrailProposals,
  });
  harness.updateRun({
    runId: action.runId,
    contextPatch: { guardrailProposals: proposals.nextProposals },
  });
  checks.push({
    name: "guardrail proposals refreshed",
    status: "passed",
    evidence: `${proposals.proposed} proposal(s)`,
  });
  artifacts.push({
    kind: "guardrail_proposals",
    runId: action.runId,
    proposed: proposals.proposed,
    proposalIds: proposals.proposals.map((proposal) => proposal.id),
  });

  const goalReviewInvalidated = overview.run?.context.goalReviewInvalidatedByIntegration === true;
  if (goalReviewInvalidated) {
    checks.push({ name: "goal review invalidated", status: "passed", evidence: "integration" });
  }
  const completedReview = goalReviewInvalidated ? null : selectCompletedGoalReview(overview);
  if (completedReview) {
    const readiness = describeIntegrationReadiness(harness, action.runId);
    if (readiness.unintegrated.length > 0) {
      harness.updateRun({
        runId: action.runId,
        status: "blocked",
        contextPatch: {
          pendingIntegrationWorkerTaskIds: readiness.unintegrated.map((worker) => worker.taskId),
          pendingIntegrationReason: "verified worker changes are not integrated yet",
        },
      });
      checks.push({
        name: "pending integration",
        status: "failed",
        evidence: readiness.unintegrated.map((worker) => worker.taskId).join(","),
      });
      artifacts.push(...readiness.unintegrated.map((worker) => ({
        kind: "pending_integration",
        taskId: worker.taskId,
        role: worker.role,
        verifierTaskId: worker.verifierTaskId,
        changedFiles: worker.changedFiles,
      })));
      return {
        status: "blocked",
        actionType: action.type,
        summary: `Run ${action.runId} has unintegrated verified worker changes.`,
        checks,
        artifacts,
        problems: readiness.unintegrated.map((worker) =>
          `verified worker ${worker.taskId} has unintegrated changes verified by ${worker.verifierTaskId}`,
        ),
      };
    }
    harness.updateRunStatus({ runId: action.runId, status: "done" });
    checks.push({ name: "completed goal review", status: "passed", evidence: completedReview.id });
    artifacts.push({ kind: "run", runId: action.runId, previousStatus: run.status, status: "done", reviewTaskId: completedReview.id });
    return doneResult(action.type, `Run ${action.runId} marked done from existing complete goal-review.`, checks, artifacts);
  }

  const review = ensureGoalReviewTask(harness, action.runId, maxTries, overview, goalReviewInvalidated);
  if (goalReviewInvalidated) {
    const existingInvalidated = invalidatedGoalReviewTaskIds(overview);
    for (const task of overview.tasks) {
      if (task.role === "goal-review") {
        existingInvalidated.add(task.id);
      }
    }
    harness.updateRun({
      runId: action.runId,
      contextPatch: {
        goalReviewInvalidatedByIntegration: false,
        invalidatedGoalReviewTaskIds: [...existingInvalidated],
        goalReviewRefreshedAt: new Date().toISOString(),
        goalReviewTerminalDisposition: null,
      },
    });
    checks.push({ name: "goal review invalidation consumed", status: "passed", evidence: "integration" });
  }
  checks.push(...review.checks);
  artifacts.push(...review.artifacts);
  if (review.status === "blocked") {
    return {
      status: "blocked",
      actionType: action.type,
      summary: review.summary,
      checks,
      artifacts,
      problems: review.problems,
    };
  }
  return doneResult(action.type, review.summary, checks, artifacts);
}

function runWatchdogPass(
  harness: Harness,
  action: Extract<HarnessAction, { type: "runWatchdogPass" }>,
): HarnessActionResult {
  const rootRun = harness.getRun(action.rootRunId);
  if (!rootRun) {
    return blockedResult(action.type, `Run not found: ${action.rootRunId}`, [
      `run not found: ${action.rootRunId}`,
    ]);
  }
  const now = action.now ?? Date.now();
  const daemonIntervalMs = action.daemonIntervalMs ?? 1500;
  const overview = harness.getRunOverview({ runId: action.rootRunId, eventLimit: 0 });
  const observation = observeWatchdogTree({
    rootRunId: action.rootRunId,
    rootRun,
    overview,
    harness,
    now,
    daemonIntervalMs,
    inboxEvents: action.inboxEvents ?? [],
    scheduledReviews: action.scheduledReviews ?? [],
  });
  const previousState = readWatchdogState(rootRun.context);
  const { nextState, transition } = transitionWatchdogState({
    previous: previousState,
    observation,
    now,
    daemonIntervalMs,
  });

  const checks: HarnessActionResult["checks"] = [
    { name: "root run", status: "passed", evidence: action.rootRunId },
    { name: "fingerprint observed", status: "passed", evidence: observation.fingerprint.slice(0, 12) },
    {
      name: "eligibility",
      status: "passed",
      evidence: observation.eligibility.eligible
        ? "eligible"
        : observation.eligibility.reasons.join(",") || "ineligible",
    },
    {
      name: "watchdog state",
      status: "passed",
      evidence: nextState.state,
    },
  ];

  const artifacts: HarnessActionResult["artifacts"] = [
    {
      kind: "watchdog_observation",
      runId: action.rootRunId,
      fingerprint: observation.fingerprint,
      eligible: observation.eligibility.eligible,
      eligibilityReasons: observation.eligibility.reasons,
      state: nextState.state,
      recoveryStage: nextState.recoveryStage,
      unchangedEligibleTicks: nextState.unchangedEligibleTicks,
      attemptCount: nextState.attemptCount,
    },
  ];

  // Staged dispatch protocol. The frozen contract requires that the watchdog
  // never invokes a nested SQLite transaction: the fixed-action dispatch
  // opens its own transaction via applyHarnessAction, so it must run outside
  // any outer transaction. Phase 1 reserves the deterministic repair identity
  // and persists the pre-dispatch state inside a single transaction. Phase 2
  // dispatches the classified fixed action with applyHarnessAction outside
  // any transaction. Phase 3 records the linked completeSystemTask evidence
  // and advances the persisted watchdog state inside a final transaction.
  // Concurrent ticks and reopened Harness instances still produce exactly one
  // repair run and one repair action sequence per fingerprint because the
  // reservation re-checks the live state under the transaction and skips
  // dispatch when another caller has already advanced.
  let repairRunId: string | null = null;
  let repairTaskId: string | null = null;
  let persistedEventIds: string[] = [];
  let blockedSummary: string | null = null;
  let raceAdvanced = false;
  let raceTerminalBlocked = false;

  if (transition.kind === "reconcile" || previousState?.reconcileClaim) {
    // Claim the fingerprint before dispatch. The immediate transaction makes
    // the claim cross-process atomic; the fixed action still runs outside the
    // transaction so its own database work cannot nest. A stable reason lets
    // a restarted process recover a completed action event after response
    // loss without dispatching a second recovery chain.
    const reconcileReservation = claimWatchdogReconcile({
      harness,
      rootRunId: action.rootRunId,
      previousState,
      overview,
      now,
      daemonIntervalMs,
      inboxEvents: action.inboxEvents ?? [],
      scheduledReviews: action.scheduledReviews ?? [],
    });
    if (reconcileReservation.kind === "missing") {
      blockedSummary = reconcileReservation.summary;
    } else if (reconcileReservation.kind === "raced") {
      raceAdvanced = true;
      raceTerminalBlocked = reconcileReservation.terminalBlocked;
    } else {
      const claimed = reconcileReservation.claim;
      const reconcileReason = watchdogReconcileReason(
        action.rootRunId,
        claimed.fingerprint,
        claimed.fault.selectedAction,
      );
      let outcome: WatchdogReconcileOutcome;
      if (claimed.fault.selectedAction === "none") {
        outcome = {
          kind: "unsupported",
          actionEventId: null,
          summary: `unsupported fault: ${claimed.fault.kind}`,
        };
      } else {
        const applied = applyWatchdogReconcileAction(harness, {
          actionType: claimed.fault.selectedAction,
          targetRunId: claimed.targetRunId,
          reason: reconcileReason,
          actionEventId: claimed.actionEventId,
        });
        outcome = applied.status === "blocked"
          ? {
              kind: "blocked",
              actionEventId: applied.eventId,
              summary: applied.summary,
            }
          : {
              kind: "done",
              actionEventId: applied.eventId,
              summary: applied.summary,
            };
      }
      const finalized = finalizeWatchdogReconcile({
        harness,
        rootRunId: action.rootRunId,
        ownerId: claimed.ownerId,
        fingerprint: claimed.fingerprint,
        outcome,
        now,
      });
      if (finalized.kind === "missing") {
        blockedSummary = finalized.summary;
      } else {
        persistedEventIds = finalized.linkedEventIds;
        raceTerminalBlocked = finalized.terminalBlocked;
      }
    }
  } else if (transition.kind === "repair") {
    // Phase 1: reserve deterministic repair identity under a transaction.
    const reservationResult = reserveWatchdogRepair({
      harness,
      rootRunId: action.rootRunId,
      previousState,
      overview,
      now,
      daemonIntervalMs,
      inboxEvents: action.inboxEvents ?? [],
      scheduledReviews: action.scheduledReviews ?? [],
      reason: action.reason ?? "watchdog pass",
    });
    if (reservationResult.kind === "missing") {
      blockedSummary = reservationResult.summary;
    } else if (reservationResult.kind === "raced") {
      raceAdvanced = true;
      raceTerminalBlocked = reservationResult.terminalBlocked;
    } else if (reservationResult.kind === "reserved") {
      const reserved = reservationResult.reservation;
      // Phase 3: record the linked completeSystemTask evidence and advance
      // state inside a final transaction. The fixed action was already
      // dispatched during the prior reconcile transition; the repair run is
      // completed from that recorded evidence rather than dispatching a
      // second fixed action.
      const phase3 = finalizeWatchdogRepair({
        harness,
        rootRunId: action.rootRunId,
        reserved,
        fixedResult: null,
        observation,
        now,
      });
      if (phase3.kind === "missing") {
        blockedSummary = phase3.summary;
      } else {
        repairRunId = reserved.identity.runId;
        repairTaskId = reserved.identity.taskId;
        persistedEventIds = phase3.linkedEventIds;
      }
    }
  } else {
    harness.runInTransaction((db) => {
      const transactionRoot = harness.getRunWithDb(db, action.rootRunId);
      if (!transactionRoot) {
        blockedSummary = `Run not found: ${action.rootRunId}`;
        return;
      }
      persistWatchdogStateWithDb(harness, db, action.rootRunId, nextState);
    });
  }

  if (blockedSummary) {
    return blockedResult(action.type, blockedSummary, [blockedSummary]);
  }

  // Reload the persisted state so checks, artifacts, and the return result
  // reflect the post-dispatch watchdog (e.g., canary after a successful
  // repair or blocked after a failed/unsupported recovery).
  const reloadedRoot = harness.getRun(action.rootRunId);
  const reloadedState = reloadedRoot ? readWatchdogState(reloadedRoot.context) : null;
  const effectiveState = reloadedState ?? nextState;

  if (raceTerminalBlocked || effectiveState.state === "blocked" || transition.kind === "block") {
    checks.push({ name: "watchdog terminal", status: "passed", evidence: "blocked" });
    artifacts.push({
      kind: "watchdog_blocked",
      runId: action.rootRunId,
      fingerprint: observation.fingerprint,
      affectedRunIds: effectiveState.affectedRunIds,
      repairRunId: effectiveState.repairRunId ?? repairRunId,
      repairTaskId: effectiveState.repairTaskId ?? repairTaskId,
      actionEventIds: effectiveState.actionEventIds.length > 0 ? effectiveState.actionEventIds : persistedEventIds,
      cooldownUntil: effectiveState.cooldownUntil,
      failure: effectiveState.failure,
      canary: effectiveState.canary,
    });
    return {
      status: "blocked",
      actionType: action.type,
      summary: `Watchdog blocked for ${action.rootRunId} fingerprint ${observation.fingerprint.slice(0, 12)}.`,
      checks,
      artifacts,
      problems: [effectiveState.failure?.reason ?? "watchdog blocked"].filter(
        (value): value is string => Boolean(value),
      ),
    };
  }

  if (transition.kind === "repair" || repairRunId) {
    checks.push({ name: "repair run", status: "passed", evidence: repairRunId ?? "pending" });
  }
  artifacts.push({
    kind: "watchdog_state",
    runId: action.rootRunId,
    state: effectiveState.state,
    fingerprint: observation.fingerprint,
    firstSeenAt: effectiveState.firstSeenAt,
    lastMeaningfulProgressAt: effectiveState.lastMeaningfulProgressAt,
    lastObservationAt: effectiveState.lastObservationAt,
    unchangedEligibleTicks: effectiveState.unchangedEligibleTicks,
    recoveryStage: effectiveState.recoveryStage,
    repairFingerprint: effectiveState.repairFingerprint,
    repairRunId: effectiveState.repairRunId ?? repairRunId,
    repairTaskId: effectiveState.repairTaskId ?? repairTaskId,
    actionEventIds: effectiveState.actionEventIds.length > 0 ? effectiveState.actionEventIds : persistedEventIds,
    attemptCount: effectiveState.attemptCount,
    cooldownUntil: effectiveState.cooldownUntil,
    affectedRunIds: effectiveState.affectedRunIds,
    fault: effectiveState.fault,
    canary: effectiveState.canary,
    failure: effectiveState.failure,
    transition: transition.kind,
  });

  return doneResult(
    action.type,
    `Watchdog ${effectiveState.state} for ${action.rootRunId} (${transition.kind}).`,
    checks,
    artifacts,
  );
}

function persistWatchdogStateWithDb(
  harness: Harness,
  db: HarnessDatabase,
  rootRunId: string,
  state: ControlPlaneWatchdogState,
) {
  const existing = harness.getRunWithDb(db, rootRunId);
  if (!existing) {
    return;
  }
  const nextContext = { ...existing.context, controlPlaneWatchdog: normalizeWatchdogState(state) };
  db.query(
    `
    update runs
    set context_json = $contextJson, updated_at = current_timestamp
    where id = $runId
    `,
  ).run({
    $contextJson: JSON.stringify(nextContext),
    $runId: rootRunId,
  });
}

interface WatchdogRepairReservation {
  identity: { runId: string; taskId: string; attemptId: string; actionEventId: string };
  fault: NonNullable<ControlPlaneWatchdogState["fault"]>;
  preDispatchState: ControlPlaneWatchdogState;
  observationFingerprint: string;
}

type WatchdogReservationResult =
  | { kind: "missing"; summary: string }
  | { kind: "raced"; terminalBlocked: boolean }
  | { kind: "reserved"; reservation: WatchdogRepairReservation };

type WatchdogReconcileOutcome =
  | { kind: "done"; actionEventId: string; summary: string }
  | { kind: "blocked"; actionEventId: string; summary: string }
  | { kind: "unsupported"; actionEventId: null; summary: string };

interface WatchdogReconcileClaim {
  ownerId: string;
  fingerprint: string;
  targetRunId: string;
  actionEventId: string;
  fault: NonNullable<ControlPlaneWatchdogState["fault"]>;
}

type WatchdogReconcileClaimResult =
  | { kind: "missing"; summary: string }
  | { kind: "raced"; terminalBlocked: boolean }
  | { kind: "claimed"; claim: WatchdogReconcileClaim };

type WatchdogReconcileFinalizeResult =
  | { kind: "missing"; summary: string }
  | { kind: "advanced"; linkedEventIds: string[]; terminalBlocked: boolean };

/**
 * Reserve the reconcile fingerprint before a fixed action is dispatched.
 * BEGIN IMMEDIATE serializes competing writers before they read the live
 * watchdog state, preventing SQLITE_BUSY_SNAPSHOT and duplicate dispatch.
 */
function claimWatchdogReconcile(input: {
  harness: Harness;
  rootRunId: string;
  previousState: ControlPlaneWatchdogState | null;
  overview: RunOverview;
  now: number;
  daemonIntervalMs: number;
  inboxEvents: WatchdogSnapshotInboxEvents;
  scheduledReviews: WatchdogSnapshotScheduledReviews;
}): WatchdogReconcileClaimResult {
  interface Mutable {
    result: WatchdogReconcileClaimResult;
  }
  const mutable: Mutable = {
    result: { kind: "missing", summary: `Run not found: ${input.rootRunId}` },
  };
  input.harness.runInImmediateTransaction((db) => {
    const transactionRoot = input.harness.getRunWithDb(db, input.rootRunId);
    if (!transactionRoot) {
      mutable.result = { kind: "missing", summary: `Run not found: ${input.rootRunId}` };
      return;
    }
    const transactionPrevious = readWatchdogState(transactionRoot.context) ?? input.previousState;
    const liveObservation = observeWatchdogTree({
      rootRunId: input.rootRunId,
      rootRun: transactionRoot,
      overview: input.overview,
      harness: input.harness,
      now: input.now,
      daemonIntervalMs: input.daemonIntervalMs,
      inboxEvents: input.inboxEvents,
      scheduledReviews: input.scheduledReviews,
    });
    const priorClaim = transactionPrevious?.reconcileClaim ?? null;
    if (priorClaim) {
      const existingEvent = input.harness.getHarnessActionEventWithDb(db, {
        id: priorClaim.actionEventId,
      });
      if (existingEvent) {
        mutable.result = {
          kind: "claimed",
          claim: {
            ownerId: priorClaim.ownerId,
            fingerprint: priorClaim.fingerprint,
            targetRunId: priorClaim.targetRunId,
            actionEventId: priorClaim.actionEventId,
            fault: transactionPrevious?.fault ?? liveObservation.fault ?? unsupportedFaultForWatchdog(input.rootRunId),
          },
        };
        return;
      }
      if (
        priorClaim.fingerprint !== liveObservation.fingerprint ||
        Date.parse(priorClaim.leaseUntil) <= input.now
      ) {
        const blocked = recordReconciliationOutcome({
          previous: transactionPrevious!,
          outcome: {
            kind: "unsupported",
            actionEventId: null,
            summary: "reconcile dispatch outcome ambiguous without an action receipt",
          },
          now: input.now,
        });
        blocked.reconcileClaim = null;
        persistWatchdogStateWithDb(input.harness, db, input.rootRunId, blocked);
        mutable.result = { kind: "raced", terminalBlocked: true };
        return;
      }
      mutable.result = {
        kind: "raced",
        terminalBlocked: transactionPrevious?.state === "blocked",
      };
      return;
    }
    const live = transitionWatchdogState({
      previous: transactionPrevious,
      observation: liveObservation,
      now: input.now,
      daemonIntervalMs: input.daemonIntervalMs,
    });
    if (live.transition.kind !== "reconcile") {
      persistWatchdogStateWithDb(input.harness, db, input.rootRunId, live.nextState);
      mutable.result = {
        kind: "raced",
        terminalBlocked: live.nextState.state === "blocked" || live.transition.kind === "block",
      };
      return;
    }
    const fault = live.transition.fault;
    if (!fault) {
      mutable.result = { kind: "raced", terminalBlocked: false };
      return;
    }
    const ownerId = makeId("watchdog_claim");
    const targetRunId = [...fault.affectedRunIds]
      .sort((left, right) => left.localeCompare(right))[0] ?? input.rootRunId;
    const actionEventId = watchdogReconcileActionEventId(
      input.rootRunId,
      liveObservation.fingerprint,
      targetRunId,
      fault.selectedAction,
    );
    const claimedAt = new Date(input.now).toISOString();
    const leaseUntil = new Date(input.now + WATCHDOG_RECONCILE_LEASE_MS).toISOString();
    const claimedState: ControlPlaneWatchdogState = {
      ...live.nextState,
      state: "reconciling",
      recoveryStage: "reconcile",
      repairFingerprint: liveObservation.fingerprint,
      fault,
      reconcileClaim: {
        fingerprint: liveObservation.fingerprint,
        ownerId,
        actionType: fault.selectedAction,
        targetRunId,
        actionEventId,
        claimedAt,
        leaseUntil,
      },
    };
    persistWatchdogStateWithDb(input.harness, db, input.rootRunId, claimedState);
    mutable.result = {
      kind: "claimed",
      claim: { ownerId, fingerprint: liveObservation.fingerprint, targetRunId, actionEventId, fault },
    };
  });
  return mutable.result;
}

function watchdogReconcileReason(
  rootRunId: string,
  fingerprint: string,
  actionType: NonNullable<ControlPlaneWatchdogState["fault"]>["selectedAction"],
) {
  return `watchdog reconcile ${rootRunId}:${fingerprint}:${actionType}`;
}

function watchdogReconcileActionEventId(
  rootRunId: string,
  fingerprint: string,
  targetRunId: string,
  actionType: NonNullable<ControlPlaneWatchdogState["fault"]>["selectedAction"],
) {
  const digest = createHash("sha256")
    .update(`watchdog-reconcile:${WATCHDOG_STATE_VERSION}:${rootRunId}:${fingerprint}:${targetRunId}:${actionType}`)
    .digest("hex");
  return `action_watchdog_reconcile_${digest.slice(0, 24)}`;
}

function unsupportedFaultForWatchdog(
  rootRunId: string,
): NonNullable<ControlPlaneWatchdogState["fault"]> {
  return {
    kind: "unsupported",
    affectedRunIds: [rootRunId],
    selectedAction: "none",
    details: "reconcile claim lost its frozen fault classification",
  };
}

function applyWatchdogReconcileAction(
  harness: Harness,
  input: {
    actionType: Exclude<NonNullable<ControlPlaneWatchdogState["fault"]>["selectedAction"], "none">;
    targetRunId: string;
    reason: string;
    actionEventId: string;
  },
): { status: "done" | "blocked"; eventId: string; summary: string; problems: string[] } {
  const existing = harness.getHarnessActionEvent({ id: input.actionEventId });
  if (existing) {
    const request = existing.request as Record<string, unknown>;
    if (
      existing.actionType !== input.actionType ||
      request.runId !== input.targetRunId ||
      request.reason !== input.reason
    ) {
      return {
        status: "blocked",
        eventId: existing.id,
        summary: `Watchdog reconcile event ${existing.id} readback mismatch.`,
        problems: ["deterministic watchdog reconcile event readback mismatch"],
      };
    }
    return watchdogAppliedEvent(existing, input.actionType);
  }
  const action = {
    type: input.actionType,
    runId: input.targetRunId,
    reason: input.reason,
  } as Extract<HarnessAction, { type: "reclaimRunningTasks" | "integrateVerifiedRun" | "prepareRunDrain" }>;
  const result = applyParsedHarnessAction(harness, action, {});
  const eventId = harness.recordHarnessActionEvent({
    id: input.actionEventId,
    actionType: action.type,
    status: result.status,
    request: safeRequest(action),
    result: resultToRecord(result),
  });
  return { status: result.status, eventId, summary: result.summary, problems: result.problems };
}

function watchdogAppliedEvent(
  event: HarnessActionEvent,
  actionType: string,
) {
  const result = event.result as Record<string, unknown>;
  return {
    status: event.status,
    eventId: event.id,
    summary: typeof result.summary === "string" ? result.summary : `${actionType} replayed`,
    problems: Array.isArray(result.problems)
      ? result.problems.filter((problem): problem is string => typeof problem === "string")
      : [],
  };
}

function finalizeWatchdogReconcile(input: {
  harness: Harness;
  rootRunId: string;
  ownerId: string;
  fingerprint: string;
  outcome: WatchdogReconcileOutcome;
  now: number;
}): WatchdogReconcileFinalizeResult {
  let result: WatchdogReconcileFinalizeResult = {
    kind: "missing",
    summary: `Run not found: ${input.rootRunId}`,
  };
  input.harness.runInImmediateTransaction((db) => {
    const transactionRoot = input.harness.getRunWithDb(db, input.rootRunId);
    if (!transactionRoot) return;
    const current = readWatchdogState(transactionRoot.context);
    if (!current) {
      result = { kind: "missing", summary: `Watchdog state missing: ${input.rootRunId}` };
      return;
    }
    if (
      current.reconcileClaim?.ownerId !== input.ownerId ||
      current.reconcileClaim.fingerprint !== input.fingerprint
    ) {
      result = {
        kind: "advanced",
        linkedEventIds: current.actionEventIds,
        terminalBlocked: current.state === "blocked",
      };
      return;
    }
    const advancedState = recordReconciliationOutcome({
      previous: current,
      outcome: input.outcome,
      now: input.now,
    });
    advancedState.reconcileClaim = null;
    persistWatchdogStateWithDb(input.harness, db, input.rootRunId, advancedState);
    result = {
      kind: "advanced",
      linkedEventIds: advancedState.actionEventIds,
      terminalBlocked: advancedState.state === "blocked",
    };
  });
  return result;
}

/**
 * Phase 1 of the staged watchdog dispatch protocol. Reserve the deterministic
 * repair identity (run + task) and persist the pre-dispatch state inside a
 * single transaction. The reservation re-checks the live state under the
 * transaction so concurrent ticks and reopened Harness instances still produce
 * exactly one repair run per fingerprint. The fixed-action dispatch happens
 * OUTSIDE this transaction in Phase 2 because applyHarnessAction opens its
 * own transaction.
 */
function reserveWatchdogRepair(input: {
  harness: Harness;
  rootRunId: string;
  previousState: ControlPlaneWatchdogState | null;
  overview: RunOverview;
  now: number;
  daemonIntervalMs: number;
  inboxEvents: WatchdogSnapshotInboxEvents;
  scheduledReviews: WatchdogSnapshotScheduledReviews;
  reason: string;
}): WatchdogReservationResult {
  interface Mutable {
    result: WatchdogReservationResult;
  }
  const mutable: Mutable = {
    result: { kind: "missing", summary: `Run not found: ${input.rootRunId}` },
  };
  input.harness.runInImmediateTransaction((db) => {
    const transactionRoot = input.harness.getRunWithDb(db, input.rootRunId);
    if (!transactionRoot) {
      mutable.result = { kind: "missing", summary: `Run not found: ${input.rootRunId}` };
      return;
    }
    const transactionPrevious = readWatchdogState(transactionRoot.context) ?? input.previousState;
    const liveObservation = observeWatchdogTree({
      rootRunId: input.rootRunId,
      rootRun: transactionRoot,
      overview: input.overview,
      harness: input.harness,
      now: input.now,
      daemonIntervalMs: input.daemonIntervalMs,
      inboxEvents: input.inboxEvents,
      scheduledReviews: input.scheduledReviews,
    });
    const live = transitionWatchdogState({
      previous: transactionPrevious,
      observation: liveObservation,
      now: input.now,
      daemonIntervalMs: input.daemonIntervalMs,
    });
    if (live.transition.kind !== "repair") {
      persistWatchdogStateWithDb(input.harness, db, input.rootRunId, live.nextState);
      const terminalBlocked = live.transition.kind === "block" || live.nextState.state === "blocked";
      mutable.result = { kind: "raced", terminalBlocked };
      return;
    }
    const liveFault = live.transition.fault;
    const recoveryFingerprint = live.nextState.repairFingerprint ?? liveObservation.fingerprint;
    const identity = repairIdentity(input.rootRunId, recoveryFingerprint);
    ensureWatchdogRepairRunWithDb({
      harness: input.harness,
      db,
      rootRun: transactionRoot,
      identity,
      fault: liveFault,
      reason: input.reason,
    });
    const reservedState: ControlPlaneWatchdogState = {
      ...live.nextState,
      repairRunId: identity.runId,
      repairTaskId: identity.taskId,
    };
    persistWatchdogStateWithDb(input.harness, db, input.rootRunId, reservedState);
    mutable.result = {
      kind: "reserved",
      reservation: {
        identity,
        fault: liveFault,
        preDispatchState: reservedState,
        observationFingerprint: liveObservation.fingerprint,
      },
    };
  });
  return mutable.result;
}

type WatchdogFinalizeResult =
  | { kind: "missing"; summary: string }
  | { kind: "advanced"; linkedEventIds: string[] };

/**
 * Phase 3 of the staged watchdog dispatch protocol. Record the linked
 * completeSystemTask evidence and advance the persisted watchdog state inside
 * a final transaction. A failed fixed action (status === "blocked") or an
 * unsupported fault converges directly to blocked with the reserved repair
 * run, one action sequence, and the 15-minute cooldown.
 */
function finalizeWatchdogRepair(input: {
  harness: Harness;
  rootRunId: string;
  reserved: WatchdogRepairReservation;
  fixedResult: { status: "done" | "blocked"; eventId: string; summary: string; problems: string[] } | null;
  observation: WatchdogObservationSnapshot;
  now: number;
}): WatchdogFinalizeResult {
  interface Mutable {
    result: WatchdogFinalizeResult;
  }
  const mutable: Mutable = {
    result: { kind: "missing", summary: `Run not found: ${input.rootRunId}` },
  };
  input.harness.runInImmediateTransaction((db) => {
    const transactionRoot = input.harness.getRunWithDb(db, input.rootRunId);
    if (!transactionRoot) {
      mutable.result = { kind: "missing", summary: `Run not found: ${input.rootRunId}` };
      return;
    }
    const reserved = input.reserved;
    const fixedResult = input.fixedResult;
    // The fixed action was dispatched during the prior reconcile transition.
    // Prefer the freshly-dispatched event id when provided (legacy callers),
    // otherwise fall back to the most recent reconcile action event id recorded
    // in the reserved pre-dispatch state.
    const priorReconcileEventId =
      reserved.preDispatchState.actionEventIds.length > 0
        ? reserved.preDispatchState.actionEventIds[reserved.preDispatchState.actionEventIds.length - 1]
        : null;
    const actionEventId = fixedResult?.eventId ?? priorReconcileEventId ?? null;
    const sourceEvent = actionEventId
      ? input.harness.getHarnessActionEventWithDb(db, { id: actionEventId })
      : null;
    const sourceResult = sourceEvent?.result as Record<string, unknown> | undefined;
    const sourceSummary = typeof sourceResult?.summary === "string"
      ? sourceResult.summary
      : `watchdog reconcile ${sourceEvent?.status ?? "blocked"}`;
    const sourceProblems = Array.isArray(sourceResult?.problems)
      ? sourceResult.problems.filter((problem): problem is string => typeof problem === "string")
      : [];
    const systemStatus: "done" | "blocked" = sourceEvent?.status ?? fixedResult?.status ?? "blocked";
    const systemOutput: AttemptOutput = {
      status: systemStatus,
      summary: `System task completed from watchdog action ${actionEventId ?? "none"}: ${sourceSummary}`,
      changedFiles: [],
      checks: [
        { name: "watchdog action event", status: actionEventId ? "passed" : "failed", evidence: actionEventId ?? "missing" },
        { name: "watchdog action type", status: sourceEvent ? "passed" : "failed", evidence: sourceEvent?.actionType ?? "missing" },
      ],
      artifacts: [
        {
          kind: "watchdog_repair_complete",
          runId: input.rootRunId,
          taskId: reserved.identity.taskId,
          actionEventId,
          fixedActionStatus: systemStatus,
        },
      ],
      problems: systemStatus === "blocked"
        ? sourceProblems.length > 0 ? sourceProblems : [sourceSummary]
        : [],
    };
    const existingAttempt = db
      .query("select id from attempts where id = $id")
      .get({ $id: reserved.identity.attemptId }) as { id: string } | null;
    if (!existingAttempt) {
      input.harness.recordAttemptWithDb(db, {
        id: reserved.identity.attemptId,
        taskId: reserved.identity.taskId,
        input: {
          executor: "harness-action",
          actionType: "completeSystemTask",
          actionEventId,
          reason: "watchdog deterministic repair completion",
        },
        output: systemOutput,
      });
    }
    input.harness.updateRunStatusWithDb(db, {
      runId: reserved.identity.runId,
      status: systemStatus,
    });
    const existingCompleteEvent = input.harness.getHarnessActionEventWithDb(db, {
      id: reserved.identity.actionEventId,
    });
    const completeEventId = existingCompleteEvent?.id ?? input.harness.recordHarnessActionEventWithDb(db, {
      actionType: "completeSystemTask",
      status: "done",
      request: {
        type: "completeSystemTask",
        taskId: reserved.identity.taskId,
        actionEventId,
        reason: "watchdog deterministic repair completion",
      },
      result: {
        status: "done",
        actionType: "completeSystemTask",
        summary: `Recorded ${systemStatus} system attempt ${reserved.identity.attemptId} for task ${reserved.identity.taskId}.`,
        checks: [
          { name: "task", status: "passed", evidence: reserved.identity.taskId },
          { name: "attempt", status: "passed", evidence: reserved.identity.attemptId },
          { name: "action", status: actionEventId ? "passed" : "failed", evidence: actionEventId ?? "missing" },
        ],
        artifacts: [
          {
            kind: "watchdog_repair_complete",
            runId: input.rootRunId,
            taskId: reserved.identity.taskId,
            attemptId: reserved.identity.attemptId,
            actionEventId,
            fixedActionStatus: systemStatus,
          },
        ],
        problems: [],
      },
      id: reserved.identity.actionEventId,
    });
    const linkedEventIds = Array.from(
      new Set(
        [
          ...reserved.preDispatchState.actionEventIds,
          ...(actionEventId ? [actionEventId] : []),
          completeEventId,
        ].filter((value): value is string => typeof value === "string" && value.length > 0),
      ),
    );
    const failed = systemStatus === "blocked" || reserved.fault?.selectedAction === "none";
    const terminalObservation: WatchdogObservationSnapshot = {
      ...input.observation,
      fingerprint: reserved.observationFingerprint,
    };
    const advanced = failed
      ? blockAfterRepair({
          previous: reserved.preDispatchState,
          repairRunId: reserved.identity.runId,
          repairTaskId: reserved.identity.taskId,
          actionEventIds: linkedEventIds,
          observation: terminalObservation,
          failureReason:
            reserved.fault?.selectedAction === "none"
              ? `unsupported fault: ${reserved.fault?.kind ?? "unknown"}`
              : `fixed action ${reserved.fault?.selectedAction ?? "unknown"} returned blocked`,
          now: input.now,
        })
      : advanceAfterRepair({
          previous: reserved.preDispatchState,
          repairRunId: reserved.identity.runId,
          repairTaskId: reserved.identity.taskId,
          actionEventIds: linkedEventIds,
          now: input.now,
        });
    persistWatchdogStateWithDb(input.harness, db, input.rootRunId, advanced);
    mutable.result = { kind: "advanced", linkedEventIds };
  });
  return mutable.result;
}

function ensureWatchdogRepairRunWithDb(input: {
  harness: Harness;
  db: HarnessDatabase;
  rootRun: Run;
  identity: { runId: string; taskId: string };
  fault: NonNullable<ControlPlaneWatchdogState["fault"]>;
  reason: string;
}) {
  const { harness, db, rootRun, identity, fault, reason } = input;
  const existingRun = harness.getRunWithDb(db, identity.runId);
  if (!existingRun) {
    harness.createRunWithDb(db, {
      id: identity.runId,
      goal: `Watchdog repair for ${rootRun.id}: ${fault.kind}`,
      context: {
        parentRunId: rootRun.id,
        source: "watchdog-repair",
        watchdogFingerprintKind: fault.kind,
        watchdogAffectedRunIds: fault.affectedRunIds,
        watchdogSelectedAction: fault.selectedAction,
        watchdogDetails: fault.details,
        watchdogReason: reason,
        watchdogFrozenContract: WATCHDOG_FROZEN_CONTRACT,
      },
    });
  }
  const existingTask = db
    .query("select id from tasks where id = $id")
    .get({ $id: identity.taskId }) as { id: string } | null;
  if (!existingTask) {
    harness.createTaskWithDb(db, {
      id: identity.taskId,
      runId: identity.runId,
      role: "watchdog-repair",
      goal: `Apply fixed recovery ${fault.selectedAction} for ${fault.kind}`,
      prompt: buildWatchdogRepairPrompt(fault, reason),
      doneWhen: [
        "the selected fixed action is recorded as a harness action event",
        "the system task is completed from recorded fixed-action evidence",
        "no agent diagnosis or open-ended implementation is required",
      ],
      config: {
        verifierContract: {
          successCriteria: [
            "exactly one repair run and one repair action sequence exist for this fingerprint",
            "the frozen recovery order was honored",
          ],
          deterministicChecks: [],
          requiredArtifacts: [
            "watchdog_repair_complete event linked to the deterministic action event",
          ],
        },
        watchdog: {
          kind: fault.kind,
          selectedAction: fault.selectedAction,
          affectedRunIds: fault.affectedRunIds,
          details: fault.details,
          frozenContract: WATCHDOG_FROZEN_CONTRACT,
        },
      },
      worktreePath: null,
      parentId: null,
    });
  }
}

function buildWatchdogRepairPrompt(
  fault: NonNullable<ControlPlaneWatchdogState["fault"]>,
  reason: string,
): string {
  return [
    "Watchdog deterministic repair (no agent diagnosis is performed).",
    `Fault kind: ${fault.kind}`,
    `Selected fixed action: ${fault.selectedAction}`,
    `Affected run ids: ${fault.affectedRunIds.join(",") || "none"}`,
    `Details: ${fault.details}`,
    `Reason: ${reason}`,
    "This task is completed from recorded fixed-action evidence through completeSystemTask.",
    "It must never invoke an open-ended implementation agent or alter the frozen contract.",
  ].join("\n");
}

const WATCHDOG_FROZEN_CONTRACT = {
  contractVersion: WATCHDOG_STATE_VERSION,
  stallThreshold: WATCHDOG_STALL_TICK_THRESHOLD,
  stallMinIntervalMs: WATCHDOG_STALL_MIN_INTERVAL_MS,
  cooldownMs: WATCHDOG_COOLDOWN_MS,
  recoveryOrder: [
    "reclaim orphaned leases",
    "preserve/resume valid resumable work through existing supervision",
    "integrate pending verified work",
    "prepareRunDrain for an empty nonterminal run",
  ],
  constraints: [
    "no database schema changes",
    "no new dependencies or external services",
    "no agent diagnosis or open-ended repair prompt",
    "watchdog writes and heartbeat-only events never count as meaningful progress",
  ],
};

function amendRunContract(
  harness: Harness,
  action: Extract<HarnessAction, { type: "amendRunContract" }>,
): HarnessActionResult {
  const run = harness.getRun(action.runId);
  if (!run) {
    return blockedResult(action.type, `Run not found: ${action.runId}`, [`run not found: ${action.runId}`]);
  }
  const frozenKeys = frozenDesignContextKeys([action.contractKey]);
  if (frozenKeys.length > 0) {
    return blockedResult(
      action.type,
      `Run ${action.runId} frozen design context cannot be amended.`,
      [`frozen context keys: ${frozenKeys.join(",")}`],
    );
  }

  const existingAmendments = readContractAmendments(run.context);
  const currentVersion = existingAmendments
    .filter((entry) => entry.contractKey === action.contractKey)
    .reduce((max, entry) => (entry.version > max ? entry.version : max), 0);

  if (action.expectedVersion !== undefined && action.expectedVersion !== currentVersion) {
    return blockedResult(
      action.type,
      `Stale contract amendment for ${action.contractKey}: expected version ${action.expectedVersion}, current is ${currentVersion}.`,
      [
        `Stale contract amendment for contractKey ${action.contractKey}: expectedVersion=${action.expectedVersion}, current=${currentVersion}`,
      ],
    );
  }

  if (!Number.isInteger(action.version) || action.version <= currentVersion) {
    return blockedResult(
      action.type,
      `Non-monotonic contract amendment for ${action.contractKey}: version ${action.version} must be greater than current ${currentVersion}.`,
      [
        `Non-monotonic contract amendment for contractKey ${action.contractKey}: version=${action.version}, current=${currentVersion}`,
      ],
    );
  }

  const previousValue = run.context[action.contractKey] ?? null;
  const amendedAt = new Date().toISOString();
  const amendment: ContractAmendmentEntry = {
    contractKey: action.contractKey,
    version: action.version,
    previousValue,
    value: action.value,
    reason: action.reason ?? null,
    amendedAt,
  };
  const updated = harness.updateRun({
    runId: action.runId,
    contextPatch: {
      [action.contractKey]: action.value,
      contractAmendments: [...existingAmendments, amendment],
    },
  });
  if (!updated) {
    return blockedResult(action.type, `Run not found: ${action.runId}`, [`run not found: ${action.runId}`]);
  }

  return doneResult(
    action.type,
    `Amended run ${action.runId} contract ${action.contractKey} to version ${action.version}.`,
    [
      { name: "run exists", status: "passed", evidence: action.runId },
      { name: "contract key", status: "passed", evidence: action.contractKey },
      { name: "previous version", status: "passed", evidence: String(currentVersion) },
      { name: "next version", status: "passed", evidence: String(action.version) },
      {
        name: "expected version",
        status: "passed",
        evidence: action.expectedVersion === undefined ? "not provided" : String(action.expectedVersion),
      },
    ],
    [
      {
        kind: "contract_amendment",
        runId: action.runId,
        contractKey: action.contractKey,
        previousVersion: currentVersion,
        version: action.version,
        previousValue,
        value: action.value,
        reason: action.reason ?? null,
        amendedAt,
      },
    ],
  );
}

function readContractAmendments(context: Record<string, unknown>): ContractAmendmentEntry[] {
  const raw = context.contractAmendments;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter(isContractAmendmentEntry);
}

function isContractAmendmentEntry(value: unknown): value is ContractAmendmentEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.contractKey === "string" &&
    typeof entry.version === "number" &&
    Number.isInteger(entry.version) &&
    typeof entry.amendedAt === "string"
  );
}

function ensureGoalReviewTask(
  harness: Harness,
  runId: string,
  maxTries: number,
  overview: ReturnType<Harness["getRunOverview"]>,
  goalReviewInvalidated = false,
) {
  const currentReviewSessions = currentGoalReviewSessions(overview, goalReviewInvalidated);

  const latestReview = currentReviewSessions[currentReviewSessions.length - 1];
  if (latestReview && resolveRunDecision(latestReview.output) === "defer") {
    harness.updateRunStatus({ runId, status: "blocked" });
    return {
      status: "blocked" as const,
      summary: `Run ${runId} blocked by deferred goal-review ${latestReview.taskId}.`,
      checks: [{ name: "goal review defer", status: "passed" as const, evidence: latestReview.taskId }],
      artifacts: [{ kind: "goal_review", taskId: latestReview.taskId, status: "defer" }],
      problems: [],
    };
  }

  const nonTerminalReviews = currentReviewSessions.filter((session) => {
    const decision = resolveRunDecision(session.output);
    return decision === "continue" || decision === "verify";
  });
  if (nonTerminalReviews.length >= maxTries) {
    return goalReviewContinueLimitResult(harness, runId, nonTerminalReviews.length, maxTries);
  }

  const invalidatedTaskIds = invalidatedGoalReviewTaskIds(overview);
  const blockedReview = goalReviewInvalidated
    ? undefined
    : [...overview.tasks].reverse().find(
      (task) => task.role === "goal-review" && task.status === "blocked" && !invalidatedTaskIds.has(task.id),
    );
  if (blockedReview) {
    const lastTask = overview.tasks[overview.tasks.length - 1];
    const blockedTries = overview.sessions.filter((session) => session.taskId === blockedReview.id).length;
    const lastBlockedSession = [...overview.sessions].reverse().find((session) => session.taskId === blockedReview.id);
    const textualCompletion = lastBlockedSession
      ? inferExplicitRunDecision(lastBlockedSession.output) === "complete"
      : false;
    if (textualCompletion) {
      harness.updateRunStatus({ runId, status: "done" });
      return {
        status: "done" as const,
        summary: `Goal-review task ${blockedReview.id} reported textual completion.`,
        checks: [{ name: "goal review textual completion", status: "passed" as const, evidence: blockedReview.id }],
        artifacts: [{ kind: "goal_review", taskId: blockedReview.id, status: "done", recovered: "textual" }],
        problems: [],
      };
    }
    if (lastTask && lastTask.id !== blockedReview.id) {
      const created = createGoalReviewTask(harness, runId, overview);
      return {
        status: "done" as const,
        summary: `Created fresh goal-review task ${created.taskId} after newer work superseded ${blockedReview.id}.`,
        checks: [
          { name: "superseded goal review", status: "passed" as const, evidence: blockedReview.id },
          { name: "goal review created", status: "passed" as const, evidence: created.taskId },
        ],
        artifacts: [
          { kind: "goal_review", taskId: blockedReview.id, status: "blocked", superseded: true },
          goalReviewCreatedArtifact(created),
        ],
        problems: [],
      };
    }
    if (blockedTries >= maxTries) {
      recordGoalReviewTerminalDisposition(harness, overview, {
        tries: blockedTries,
        maxTries,
        taskId: blockedReview.id,
      });
      return {
        status: "blocked" as const,
        summary: `Goal-review task ${blockedReview.id} already reached max tries.`,
        checks: [{ name: "goal review max tries", status: "failed" as const, evidence: `${blockedTries}/${maxTries}` }],
        artifacts: [{ kind: "goal_review", taskId: blockedReview.id, tries: blockedTries, maxTries }],
        problems: [`goal-review max tries reached for ${blockedReview.id}`],
      };
    }
    harness.retryTask({ taskId: blockedReview.id });
    return {
      status: "done" as const,
      summary: `Goal-review task ${blockedReview.id} returned to todo.`,
      checks: [{ name: "goal review retried", status: "passed" as const, evidence: `${blockedTries + 1}/${maxTries}` }],
      artifacts: [{ kind: "goal_review", taskId: blockedReview.id, status: "todo", retried: true, tries: blockedTries + 1, maxTries }],
      problems: [],
    };
  }

  const created = createGoalReviewTask(harness, runId, overview);
  return {
    status: "done" as const,
    summary: `Created goal-review task ${created.taskId}.`,
    checks: [{ name: "goal review created", status: "passed" as const, evidence: created.taskId }],
    artifacts: [goalReviewCreatedArtifact(created)],
    problems: [],
  };
}

function currentGoalReviewSessions(
  overview: ReturnType<Harness["getRunOverview"]>,
  goalReviewInvalidated: boolean,
) {
  if (goalReviewInvalidated) {
    return [];
  }
  const invalidatedTaskIds = invalidatedGoalReviewTaskIds(overview);
  const latestProgressIndex = overview.sessions.reduce((latest, session, index) => {
    return session.role !== "goal-review" && session.role !== "verifier" && session.status === "done" ? index : latest;
  }, -1);
  return overview.sessions.filter(
    (session, index) =>
      index > latestProgressIndex &&
      session.role === "goal-review" &&
      session.status === "done" &&
      !invalidatedTaskIds.has(session.taskId),
  );
}

function goalReviewContinueLimitResult(harness: Harness, runId: string, tries: number, maxTries: number) {
  const overview = harness.getRunOverview({ runId, eventLimit: 0 });
  const latestReviewTaskId = [...overview.tasks].reverse().find((task) => task.role === "goal-review")?.id ?? null;
  recordGoalReviewTerminalDisposition(harness, overview, { tries, maxTries, taskId: latestReviewTaskId });
  return {
    status: "blocked" as const,
    summary: `Run ${runId} reached ${tries}/${maxTries} non-terminal goal-review decisions.`,
    checks: [{ name: "goal review continue limit", status: "failed" as const, evidence: `${tries}/${maxTries}` }],
    artifacts: [{ kind: "goal_review", tries, maxTries, status: "blocked" }],
    problems: [`goal-review continue/verify limit reached for ${runId}`],
  };
}

function currentGoalReviewTerminalDisposition(overview: ReturnType<Harness["getRunOverview"]>) {
  const raw = overview.run?.context.goalReviewTerminalDisposition;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const disposition = raw as Record<string, unknown>;
  if (
    disposition.kind !== "max-tries"
    || typeof disposition.tries !== "number"
    || typeof disposition.maxTries !== "number"
    || typeof disposition.recordedAt !== "string"
  ) {
    return null;
  }
  const latestProgressAttemptId = latestGoalReviewProgressAttemptId(overview);
  if ((disposition.progressAttemptId ?? null) !== latestProgressAttemptId) {
    return null;
  }
  return {
    kind: "max-tries" as const,
    tries: disposition.tries,
    maxTries: disposition.maxTries,
    taskId: typeof disposition.taskId === "string" ? disposition.taskId : null,
    progressAttemptId: typeof disposition.progressAttemptId === "string" ? disposition.progressAttemptId : null,
    recordedAt: disposition.recordedAt,
  };
}

function recordGoalReviewTerminalDisposition(
  harness: Harness,
  overview: ReturnType<Harness["getRunOverview"]>,
  input: { tries: number; maxTries: number; taskId: string | null },
) {
  const existing = currentGoalReviewTerminalDisposition(overview);
  if (existing && existing.tries === input.tries && existing.maxTries === input.maxTries && existing.taskId === input.taskId) {
    if (overview.run?.status !== "blocked") {
      harness.updateRunStatus({ runId: overview.run!.id, status: "blocked" });
    }
    return existing;
  }
  const disposition = {
    kind: "max-tries" as const,
    tries: input.tries,
    maxTries: input.maxTries,
    taskId: input.taskId,
    progressAttemptId: latestGoalReviewProgressAttemptId(overview),
    recordedAt: new Date().toISOString(),
  };
  harness.updateRun({
    runId: overview.run!.id,
    status: "blocked",
    contextPatch: { goalReviewTerminalDisposition: disposition },
  });
  return disposition;
}

function latestGoalReviewProgressAttemptId(overview: ReturnType<Harness["getRunOverview"]>) {
  return [...overview.sessions].reverse().find(
    (session) => session.role !== "goal-review" && session.role !== "verifier" && session.status === "done",
  )?.attemptId ?? null;
}

function createGoalReviewTask(
  harness: Harness,
  runId: string,
  overview: ReturnType<Harness["getRunOverview"]>,
) {
  const sourceTask = selectGoalReviewSourceTask(harness, runId, overview);
  const taskId = harness.createTask({
    runId,
    role: "goal-review",
    goal: GOAL_REVIEW_TASK_GOAL,
    prompt: GOAL_REVIEW_TASK_PROMPT,
    dependsOn: sourceTask?.status === "done" ? [sourceTask.id] : [],
    worktreePath: sourceTask?.worktreePath ?? null,
    doneWhen: GOAL_REVIEW_TASK_DONE_WHEN,
  });
  return { taskId, sourceTask };
}

function selectGoalReviewSourceTask(
  harness: Harness,
  runId: string,
  overview: ReturnType<Harness["getRunOverview"]>,
) {
  const integratedWorkerTaskIds = collectIntegratedWorkerTaskIds(harness, runId);
  return [...overview.tasks].reverse().find((task) =>
    (task.status === "done" || task.status === "blocked") &&
    task.worktreePath !== null &&
    !["planner", "verifier", "goal-review"].includes(task.role) &&
    (task.status === "blocked" || !integratedWorkerTaskIds.has(task.id))
  ) ?? null;
}

function goalReviewCreatedArtifact(created: ReturnType<typeof createGoalReviewTask>) {
  return {
    kind: "goal_review",
    taskId: created.taskId,
    status: "todo",
    created: true,
    ...(created.sourceTask
      ? {
          sourceTaskId: created.sourceTask.id,
          sourceWorktreePath: created.sourceTask.worktreePath,
        }
      : {}),
  };
}

export function goalReviewOutputHasCompletion(output: AttemptOutput) {
  return resolveRunDecision(output) === "complete";
}

function doneResult(
  actionType: HarnessAction["type"],
  summary: string,
  checks: HarnessActionResult["checks"],
  artifacts: HarnessActionResult["artifacts"],
): HarnessActionResult {
  return { status: "done", actionType, summary, checks, artifacts, problems: [] };
}

function blockedResult(actionType: string, summary: string, problems: string[]): HarnessActionResult {
  return {
    status: "blocked",
    actionType: actionType as HarnessActionResult["actionType"],
    summary,
    checks: [{ name: "action validation", status: "failed", evidence: problems.join("; ") }],
    artifacts: [],
    problems,
  };
}

function reclaimedArtifacts(reclaimed: ReclaimedRunningTask[]) {
  return reclaimed.map((task) => ({
    kind: "reclaimed_task",
    taskId: task.taskId,
    sessionRef: task.sessionRef,
    worktreePath: task.worktreePath,
    reason: task.reason,
  }));
}

function selectIntegrationWorker(overview: RunOverview, workerTaskId: string | undefined): Task | null {
  const isExecutionTask = (task: Task) =>
    task.status === "done" &&
    task.worktreePath !== null &&
    !["planner", "verifier", "goal-review"].includes(task.role);
  if (workerTaskId) {
    const task = overview.tasks.find((candidate) => candidate.id === workerTaskId);
    return task && isExecutionTask(task) ? task : null;
  }
  return [...overview.tasks].reverse().find(isExecutionTask) ?? null;
}

function redirectRepairWorkerToSource(input: {
  overview: RunOverview;
  worker: Task;
  worktreePath: string;
  repoPath: string;
  git: GitRunner;
  changedFiles: string[];
}): { worktreePath: string; sourceWorkerId: string } | null {
  const { overview, worker, worktreePath, repoPath, git, changedFiles } = input;
  if (changedFiles.length === 0) {
    return null;
  }
  const ownStatus = runGitStep(git, worktreePath, ["status", "--short"]);
  if (!ownStatus.ok || ownStatus.stdout.trim().length > 0) {
    return null;
  }
  const sourceWorker = findSourceWorkerForRepair(overview, worker.id);
  if (!sourceWorker || sourceWorker.id === worker.id) {
    return null;
  }
  const sourceWorktreePath = resolveWorktreePath(repoPath, sourceWorker.worktreePath);
  if (!sourceWorktreePath || !existsSync(sourceWorktreePath)) {
    return null;
  }
  const sourceStatus = runGitStep(git, sourceWorktreePath, ["status", "--short"]);
  if (!sourceStatus.ok || sourceStatus.stdout.trim().length === 0) {
    return null;
  }
  return { worktreePath: sourceWorktreePath, sourceWorkerId: sourceWorker.id };
}

function findSourceWorkerForRepair(overview: RunOverview, repairTaskId: string): Task | null {
  const repair = overview.tasks.find((task) => task.id === repairTaskId);
  if (!repair || !repair.parentId) {
    return null;
  }
  const verifier = overview.tasks.find((task) => task.id === repair.parentId);
  if (!verifier || verifier.role !== "verifier") {
    return null;
  }
  for (const dependencyId of verifier.dependsOn) {
    if (dependencyId === repairTaskId) {
      continue;
    }
    const candidate = overview.tasks.find((task) => task.id === dependencyId);
    if (candidate && candidate.role === "worker" && candidate.worktreePath) {
      return candidate;
    }
  }
  return null;
}

export function describeIntegrationReadiness(harness: Harness, runId: string): IntegrationReadiness {
  const overview = harness.getRunOverview({ runId, eventLimit: 0 });
  const integratedWorkerTaskIds = collectIntegratedWorkerTaskIds(harness, runId);
  const unintegrated: UnintegratedVerifiedWorker[] = [];
  for (const task of overview.tasks) {
    if (["planner", "verifier", "goal-review"].includes(task.role)) {
      continue;
    }
    if (task.status !== "done" || !task.worktreePath) {
      continue;
    }
    if (integratedWorkerTaskIds.has(task.id)) {
      continue;
    }
    const session = latestSessionForTask(overview, task.id);
    const changedFiles = filterOuroborosRuntimePaths(
      Array.isArray(session?.output.changedFiles) ? session.output.changedFiles : [],
    );
    if (changedFiles.length === 0) {
      continue;
    }
    const verifier = selectVerifierForWorker(overview, task.id);
    if (!verifier) {
      continue;
    }
    unintegrated.push({
      taskId: task.id,
      role: task.role,
      verifierTaskId: verifier.id,
      changedFiles,
    });
  }
  return { unintegrated, integratedWorkerTaskIds };
}

function collectIntegratedWorkerTaskIds(harness: Harness, runId: string): Set<string> {
  const ids = new Set<string>();
  for (const event of harness.listHarnessActionEvents({ limit: 500 })) {
    if (
      (event.actionType !== "integrateVerifiedRun" && event.actionType !== "commitExactGitIndex") ||
      event.status !== "done"
    ) {
      continue;
    }
    const request = event.request as Record<string, unknown>;
    const requestedWorkerTaskId = event.actionType === "commitExactGitIndex" ? request.taskId : request.workerTaskId;
    if (request.runId !== runId || typeof requestedWorkerTaskId !== "string") {
      continue;
    }
    const result = event.result as Record<string, unknown>;
    const artifacts = Array.isArray(result.artifacts) ? result.artifacts : [];
    const hasMatchingReceipt = artifacts.some((artifact) => {
      if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
        return false;
      }
      const record = artifact as Record<string, unknown>;
      const modeMatches = event.actionType === "commitExactGitIndex"
        ? record.mode === "exact_git_index_commit"
        : record.mode === "branch_merge" ||
          record.mode === "contained_worker_commit" ||
          record.mode === "materialized_target_commit";
      return record.kind === "integration" &&
        modeMatches &&
        record.runId === runId &&
        record.workerTaskId === requestedWorkerTaskId;
    });
    if (hasMatchingReceipt) {
      ids.add(requestedWorkerTaskId);
    }
  }
  return ids;
}

function latestSessionForTask(overview: RunOverview, taskId: string) {
  return [...overview.sessions].reverse().find((session) => session.taskId === taskId && session.status === "done") ?? null;
}

function verifyIntegrationVerifierCommands(input: {
  action: Extract<HarnessAction, { type: "integrateVerifiedRun" }>;
  runContext: Record<string, unknown>;
  verifier: Task;
}): { ok: true; commands?: string[] } | { ok: false; reason: string } {
  const contextClosure = optionalRecordValue(input.runContext.integrationClosure);
  const requestClosure = input.action.integrationClosure;
  const taskContract = input.verifier.config?.verifierContract;
  const persistedContract = taskContract ?? input.runContext.verifierContract;
  if (taskContract === undefined && !contextClosure && !requestClosure) {
    return { ok: true };
  }
  if (persistedContract === undefined) {
    // Older verifier tasks have no persisted contract. Preserve their existing
    // integration behavior, but never accept an unbound caller-supplied
    // closure that has no persisted contract to anchor it.
    if (contextClosure || requestClosure) {
      return { ok: false, reason: "integration closure cannot be verified without a persisted verifierContract" };
    }
    return { ok: true };
  }
  if (!persistedContract || typeof persistedContract !== "object" || Array.isArray(persistedContract)) {
    return { ok: false, reason: "referenced verifier task has no valid persisted verifierContract" };
  }

  const deterministicChecks = (persistedContract as Record<string, unknown>).deterministicChecks;
  if (!Array.isArray(deterministicChecks)) {
    return { ok: false, reason: "referenced verifier task verifierContract is missing deterministicChecks" };
  }
  const commands: string[] = [];
  for (const [index, check] of deterministicChecks.entries()) {
    if (typeof check === "string") {
      if (check.length === 0) {
        return { ok: false, reason: `referenced verifier task deterministicChecks[${index}] is empty` };
      }
      commands.push(check);
      continue;
    }
    if (!check || typeof check !== "object" || Array.isArray(check)) {
      return { ok: false, reason: `referenced verifier task deterministicChecks[${index}] has no command` };
    }
    const command = (check as Record<string, unknown>).command;
    if (typeof command !== "string" || command.length === 0) {
      return { ok: false, reason: `referenced verifier task deterministicChecks[${index}] has no command` };
    }
    commands.push(command);
  }

  if (contextClosure && requestClosure && !sameCanonicalValue(contextClosure, requestClosure)) {
    return { ok: false, reason: "integration closure request differs from the frozen run integrationClosure" };
  }
  const closure = requestClosure ?? contextClosure;
  if (!closure) {
    return { ok: true };
  }
  if (closure.verifierTaskId !== input.verifier.id) {
    return { ok: false, reason: "integration closure verifierTaskId does not match the referenced verifier task" };
  }
  if (!Array.isArray(closure.frozenCommands) || closure.frozenCommands.some((command) => typeof command !== "string")) {
    return { ok: false, reason: "integration closure frozenCommands must be an array of strings" };
  }
  if (!sameCanonicalValue(commands, closure.frozenCommands)) {
    return { ok: false, reason: "integration closure verifier commands do not exactly match the persisted verifier contract" };
  }
  return { ok: true, commands };
}

const MAX_CANDIDATE_WORKSPACE_DEPENDENCY_TREES = 64;
const MAX_CANDIDATE_DEPENDENCY_LINKS = 4096;

function candidateDependencyTarget(
  repoPath: string,
  candidatePath: string,
  sourcePath: string,
  requireCandidateMapping: boolean,
): { ok: true; target: string } | { ok: false } {
  const resolvedRepo = realpathSync(repoPath);
  const resolvedSource = realpathSync(sourcePath);
  if (!requireCandidateMapping) return { ok: true, target: resolvedSource };
  const repoRelative = relative(resolvedRepo, resolvedSource);
  if (repoRelative === ".." || repoRelative.startsWith(`..${sep}`) || isAbsolute(repoRelative)) {
    return { ok: true, target: resolvedSource };
  }
  const candidateTarget = resolve(realpathSync(candidatePath), repoRelative);
  return existsSync(candidateTarget)
    ? { ok: true, target: candidateTarget }
    : { ok: false };
}

function bindCandidateDependencyTree(input: {
  source: string;
  target: string;
  repoPath: string;
  candidatePath: string;
  linkCount: { value: number };
  scoped?: boolean;
}): boolean {
  if (existsSync(input.target)) return false;
  mkdirSync(input.target, { recursive: true });
  const entries = readdirSync(input.source, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    input.linkCount.value += 1;
    if (input.linkCount.value > MAX_CANDIDATE_DEPENDENCY_LINKS) return false;
    const source = join(input.source, entry.name);
    const target = join(input.target, entry.name);
    if (!input.scoped && entry.name.startsWith("@") && entry.isDirectory() && !entry.isSymbolicLink()) {
      if (!bindCandidateDependencyTree({ ...input, source, target, scoped: true })) return false;
      continue;
    }
    const dependencyTarget = candidateDependencyTarget(
      input.repoPath,
      input.candidatePath,
      source,
      entry.isSymbolicLink(),
    );
    if (!dependencyTarget.ok) return false;
    symlinkSync(dependencyTarget.target, target);
  }
  return true;
}

function bindCandidateDependencyTrees(repoPath: string, candidatePath: string): boolean {
  const bindings: Array<{ source: string; target: string }> = [];
  const rootDependencyPath = join(repoPath, "node_modules");
  if (existsSync(rootDependencyPath)) {
    bindings.push({ source: rootDependencyPath, target: join(candidatePath, "node_modules") });
  }

  const packagesPath = join(repoPath, "packages");
  if (existsSync(packagesPath)) {
    try {
      const workspaces = readdirSync(packagesPath, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .sort((left, right) => left.name.localeCompare(right.name));
      for (const workspace of workspaces) {
        const source = join(packagesPath, workspace.name, "node_modules");
        if (!existsSync(source)) continue;
        bindings.push({
          source,
          target: join(candidatePath, "packages", workspace.name, "node_modules"),
        });
      }
    } catch {
      return false;
    }
  }

  if (bindings.length > MAX_CANDIDATE_WORKSPACE_DEPENDENCY_TREES + 1) {
    return false;
  }
  try {
    const linkCount = { value: 0 };
    for (const binding of bindings) {
      if (!bindCandidateDependencyTree({
        ...binding,
        repoPath,
        candidatePath,
        linkCount,
      })) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function prepareIntegrationClosure(input: {
  action: Extract<HarnessAction, { type: "integrateVerifiedRun" }>;
  run: Run;
  overview: RunOverview;
  worker: Task;
  verifier: Task;
  repoPath: string;
  worktreePath: string;
  changedFiles: string[];
  terminal: boolean;
  git: GitRunner;
  runCommand: CommandRunner;
}): { ok: true; receipt?: Record<string, unknown>; materializedFiles?: Array<{ path: string; content: Buffer; mode: number }> } | { ok: false; reason: string } {
  const closure = input.action.integrationClosure ?? optionalRecordValue(input.run.context.integrationClosure);
  if (!closure && input.terminal) {
    return { ok: false, reason: "terminal integration requires a complete integration closure" };
  }
  if (closure) {
    const unknownFields = Object.keys(closure).filter((key) => !INTEGRATION_CLOSURE_FIELDS.has(key));
    if (unknownFields.length > 0) {
      return { ok: false, reason: `integration closure contains unsupported fields: ${unknownFields.sort().join(",")}` };
    }
  }
  if (!closure || !hasCompleteClosureFields(closure)) {
    if (input.terminal) {
      return { ok: false, reason: "terminal integration requires a complete integration closure" };
    }
    // Command-only closures remain compatible with pre-manifest runs. A design
    // delivery that starts freezing any manifest field must provide the whole
    // manifest so it cannot silently fall back to source-worktree evidence.
    if (closure && hasAnyClosureManifestField(closure)) {
      return { ok: false, reason: "integration closure manifest is incomplete" };
    }
    return { ok: true };
  }

  const targetBaseSha = closure.targetBaseSha;
  if (typeof targetBaseSha !== "string" || !/^[0-9a-f]{40}$/i.test(targetBaseSha)) {
    return { ok: false, reason: "integration closure targetBaseSha must be a full commit SHA" };
  }
  const targetHead = readGitStdout(input.git, input.repoPath, ["rev-parse", "HEAD"]);
  if (targetHead !== targetBaseSha) {
    return { ok: false, reason: "integration closure target base is stale" };
  }

  const sourceTaskIds = closureStringArrayField(closure.sourceTaskIds);
  const sourceAttemptIds = closureStringArrayField(closure.sourceAttemptIds);
  const rawPaths = closureStringArrayField(closure.paths);
  const paths = rawPaths ? normalizeRelativeFiles(rawPaths) : null;
  const pathHashes = recordStringMap(closure.pathHashes);
  if (!sourceTaskIds || !sourceAttemptIds || !paths || !pathHashes ||
    sourceTaskIds.length === 0 || sourceTaskIds.length !== sourceAttemptIds.length ||
    paths.length === 0 || paths.length > MAX_INTEGRATION_CLOSURE_PATHS || paths.length !== rawPaths!.length) {
    return { ok: false, reason: "integration closure manifest contains invalid task, attempt, path, or hash fields" };
  }
  if (sourceTaskIds.length !== new Set(sourceTaskIds).size || sourceAttemptIds.length !== new Set(sourceAttemptIds).size) {
    return { ok: false, reason: "integration closure source task and attempt order must be unique" };
  }
  for (let index = 0; index < sourceTaskIds.length; index += 1) {
    const sourceTask = input.overview.tasks.find((task) => task.id === sourceTaskIds[index]);
    const sourceAttempt = input.overview.sessions.find((session) =>
      session.taskId === sourceTaskIds[index] && session.attemptId === sourceAttemptIds[index] && session.status === "done",
    );
    if (!sourceTask || !sourceAttempt) {
      return { ok: false, reason: "integration closure contains a cross-run or unverified source task/attempt pair" };
    }
  }
  const latestWorkerAttempt = latestSessionForTask(input.overview, input.worker.id)?.attemptId;
  if (!sourceTaskIds.includes(input.worker.id) || !latestWorkerAttempt || !sourceAttemptIds.includes(latestWorkerAttempt)) {
    return { ok: false, reason: "integration closure does not include the selected worker and its latest attempt" };
  }

  const sortedPaths = [...paths].sort();
  const hashKeys = Object.keys(pathHashes).sort();
  if (sortedPaths.join("\0") !== hashKeys.join("\0")) {
    return { ok: false, reason: "integration closure pathHashes must exactly match the ordered materialized paths" };
  }
  for (const hash of Object.values(pathHashes)) {
    if (!/^[0-9a-f]{64}$/i.test(hash)) {
      return { ok: false, reason: "integration closure path hashes must be SHA-256 values" };
    }
  }
  if (closure.verifierTaskId !== input.verifier.id) {
    return { ok: false, reason: "integration closure verifierTaskId does not match the referenced verifier task" };
  }
  const frozenCommands = closureStringArrayField(closure.frozenCommands);
  if (!frozenCommands || frozenCommands.length === 0 || frozenCommands.length > MAX_INTEGRATION_CLOSURE_COMMANDS ||
      frozenCommands.some((command) => command.length === 0 || Buffer.byteLength(command) > MAX_INTEGRATION_CLOSURE_COMMAND_BYTES)) {
    return { ok: false, reason: "integration closure frozenCommands must be a non-empty array of strings" };
  }

  const sourceDiff = sourceTargetDifference(input.git, input.worktreePath, targetBaseSha);
  if (!sourceDiff.ok) {
    return { ok: false, reason: sourceDiff.reason };
  }
  if (sourceDiff.files.join("\0") !== sortedPaths.join("\0")) {
    return { ok: false, reason: `integration closure does not cover the complete source dependency closure: expected ${sourceDiff.files.join(",") || "none"}` };
  }
  for (const path of paths) {
    const actualHash = sha256File(join(input.worktreePath, path));
    if (!actualHash || actualHash.toLowerCase() !== pathHashes[path]!.toLowerCase()) {
      return { ok: false, reason: `integration closure hash mismatch for ${path}` };
    }
  }
  const materializedFiles: Array<{ path: string; content: Buffer; mode: number }> = [];
  let totalBytes = 0;
  try {
    for (const path of paths) {
      const source = join(input.worktreePath, path);
      const stat = lstatSync(source);
      if (!stat.isFile() || stat.size > MAX_INTEGRATION_CLOSURE_FILE_BYTES) {
        return { ok: false, reason: `integration closure path is not a bounded regular file: ${path}` };
      }
      const content = readFileSync(source);
      if (createHash("sha256").update(content).digest("hex").toLowerCase() !== pathHashes[path]!.toLowerCase()) {
        return { ok: false, reason: `integration closure changed while freezing ${path}` };
      }
      totalBytes += content.byteLength;
      if (totalBytes > MAX_INTEGRATION_CLOSURE_TOTAL_BYTES) {
        return { ok: false, reason: "integration closure materialized files exceed the bounded byte limit" };
      }
      materializedFiles.push({ path, content, mode: stat.mode & 0o777 });
    }
  } catch {
    return { ok: false, reason: "integration closure materialized files could not be frozen" };
  }

  const evaluation = input.run.context.designEvaluationContract ?? input.run.context.evaluationContract;
  const evaluationHash = typeof closure.evaluationContractSha256 === "string"
    ? closure.evaluationContractSha256
    : null;
  if (evaluation !== undefined && closure.evaluationContract === undefined && !evaluationHash) {
    return { ok: false, reason: "integration closure must bind the frozen evaluation contract" };
  }
  if (closure.evaluationContract !== undefined && !sameCanonicalValue(closure.evaluationContract, evaluation)) {
    return { ok: false, reason: "integration closure evaluation contract does not match the frozen run contract" };
  }
  if (evaluationHash && stableFingerprint(evaluation) !== evaluationHash) {
    return { ok: false, reason: "integration closure evaluation contract does not match the frozen run contract" };
  }

  const normalizedManifest = {
    targetBaseSha,
    sourceTaskIds: [...sourceTaskIds],
    sourceAttemptIds: [...sourceAttemptIds],
    paths: sortedPaths,
    pathHashes: Object.fromEntries(sortedPaths.map((path) => [path, pathHashes[path]!.toLowerCase()])),
    verifierTaskId: input.verifier.id,
    frozenCommands: [...frozenCommands],
    ...(closure.evaluationContract !== undefined ? { evaluationContract: closure.evaluationContract } : {}),
    ...(evaluationHash ? { evaluationContractSha256: evaluationHash } : {}),
  };
  const expectedManifestHash = stableFingerprint(normalizedManifest);
  if (closure.manifestHash !== undefined && closure.manifestHash !== expectedManifestHash) {
    return { ok: false, reason: "integration closure manifest hash does not match its frozen contents" };
  }

  const candidatePath = mkdtempSync(join(tmpdir(), "ouroboros-integration-candidate-"));
  try {
    const clone = runGitStep(input.git, dirname(candidatePath), [
      "-c", "core.autocrlf=false", "clone", "--no-local", input.repoPath, candidatePath,
    ]);
    if (!clone.ok) {
      return { ok: false, reason: "could not create a clean integration candidate" };
    }
    const checkout = runGitStep(input.git, candidatePath, ["checkout", "--detach", targetBaseSha]);
    if (!checkout.ok) {
      return { ok: false, reason: "could not reset the integration candidate to targetBaseSha" };
    }
    if (!materializeWorkerFiles(candidatePath, input.worktreePath, paths)) {
      return { ok: false, reason: "could not reconstruct the frozen integration closure on the clean candidate" };
    }
    const stage = runGitStep(input.git, candidatePath, ["add", "-A", "--", ...paths]);
    if (!stage.ok) {
      return { ok: false, reason: "could not stage the frozen integration closure on the clean candidate" };
    }
    const commit = runGitStep(input.git, candidatePath, [
      "-c", "user.name=Ouroboros Closure Candidate",
      "-c", "user.email=ouroboros@example.invalid",
      "-c", "commit.gpgSign=false",
      "-c", "core.hooksPath=/dev/null",
      "commit", "--no-verify", "-m", "Verify frozen integration closure",
    ]);
    if (!commit.ok) {
      return { ok: false, reason: "could not commit the reconstructed clean integration candidate" };
    }
    const candidateCommit = readGitStdout(input.git, candidatePath, ["rev-parse", "HEAD"]);
    if (!candidateCommit || !/^[0-9a-f]{40}$/i.test(candidateCommit)) {
      return { ok: false, reason: "clean integration candidate did not produce a full commit SHA" };
    }
    const candidateDiff = runGitStep(input.git, candidatePath, ["diff", "--name-only", targetBaseSha, "HEAD"]);
    if (!candidateDiff.ok || normalizeRelativeFiles(candidateDiff.stdout.split(/\r?\n/).filter(Boolean)).sort().join("\0") !== sortedPaths.join("\0")) {
      return { ok: false, reason: "clean integration candidate does not contain the exact frozen path set" };
    }
    if (!bindCandidateDependencyTrees(input.repoPath, candidatePath)) {
      return { ok: false, reason: "clean integration candidate could not bind the existing dependency trees" };
    }
    const runCommand = input.runCommand;
    for (const [index, command] of frozenCommands.entries()) {
      const result = runCommand({ cwd: candidatePath, command, timeoutMs: 600_000, maxOutputBytes: 128 * 1024 });
      if (result.exitCode !== 0) {
        return {
          ok: false,
          reason: `frozen verifier command failed on clean candidate at index ${index} (${stableFingerprint(command)})`,
        };
      }
    }
    const candidateReadback: Record<string, string> = {};
    for (const path of paths) {
      const actualHash = sha256File(join(candidatePath, path));
      if (!actualHash || actualHash.toLowerCase() !== pathHashes[path]!.toLowerCase()) {
        return { ok: false, reason: `clean candidate independent readback mismatch for ${path}` };
      }
      candidateReadback[path] = actualHash;
    }
    return {
      ok: true,
      materializedFiles,
      receipt: {
        ...normalizedManifest,
        manifestHash: expectedManifestHash,
        verifierCommandsSha256: stableFingerprint(frozenCommands),
        candidateCommit,
        candidateReadback,
      },
    };
  } finally {
    rmSync(candidatePath, { recursive: true, force: true });
  }
}

function hasAnyClosureManifestField(closure: Record<string, unknown>) {
  return ["targetBaseSha", "sourceTaskIds", "sourceAttemptIds", "paths", "pathHashes"].some((key) => key in closure);
}

function hasCompleteClosureFields(closure: Record<string, unknown>) {
  return ["targetBaseSha", "sourceTaskIds", "sourceAttemptIds", "paths", "pathHashes"].every((key) => key in closure);
}

function closureStringArrayField(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0)
    ? value as string[]
    : null;
}

function recordStringMap(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.some(([key, item]) => key.length === 0 || typeof item !== "string")) return null;
  return Object.fromEntries(entries) as Record<string, string>;
}

function sourceTargetDifference(git: GitRunner, worktreePath: string, targetBaseSha: string):
  { ok: true; files: string[] } | { ok: false; reason: string } {
  const sourceHead = runGitStep(git, worktreePath, ["rev-parse", "HEAD"]);
  if (!sourceHead.ok || !/^[0-9a-f]{40}$/i.test(sourceHead.stdout.trim())) {
    return { ok: false, reason: "could not resolve the source worktree HEAD" };
  }
  const mergeBase = runGitStep(git, worktreePath, ["merge-base", targetBaseSha, sourceHead.stdout.trim()]);
  if (!mergeBase.ok || !/^[0-9a-f]{40}$/i.test(mergeBase.stdout.trim())) {
    return { ok: false, reason: "could not resolve a source and target merge base" };
  }
  const baseSha = mergeBase.stdout.trim();
  const diff = runGitStep(git, worktreePath, ["diff", "--name-only", baseSha, "--"]);
  const targetDiff = runGitStep(git, worktreePath, ["diff", "--name-only", baseSha, targetBaseSha, "--"]);
  const untracked = runGitStep(git, worktreePath, ["ls-files", "--others", "--exclude-standard"]);
  if (!diff.ok || !targetDiff.ok || !untracked.ok) {
    return { ok: false, reason: "could not determine the complete source dependency closure" };
  }
  const files = new Set<string>();
  for (const value of `${diff.stdout}\n${untracked.stdout}`.split(/\r?\n/).filter(Boolean)) {
    files.add(value);
  }
  const normalizedFiles = normalizeRelativeFiles([...files]).sort();
  const targetFiles = new Set(normalizeRelativeFiles(targetDiff.stdout.split(/\r?\n/).filter(Boolean)));
  const overlappingFiles = normalizedFiles.filter((file) => targetFiles.has(file));
  if (overlappingFiles.length > 0) {
    return {
      ok: false,
      reason: `source dependency closure overlaps target branch changes: ${overlappingFiles.join(",")}`,
    };
  }
  return { ok: true, files: normalizedFiles };
}

function sha256File(path: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

function attachVerifierCommandReceipt(
  harness: Harness,
  action: Extract<HarnessAction, { type: "integrateVerifiedRun" }>,
  result: HarnessActionResult,
): HarnessActionResult {
  if (result.status !== "done") {
    return result;
  }
  const run = harness.getRun(action.runId);
  const closure = action.integrationClosure ?? optionalRecordValue(run?.context.integrationClosure);
  if (!closure || !Array.isArray(closure.frozenCommands)) {
    return result;
  }
  const frozenCommands = closure.frozenCommands as unknown[];
  return {
    ...result,
    artifacts: result.artifacts.map((artifact) => artifact.kind === "integration"
      ? {
          ...artifact,
          frozenCommands: [...frozenCommands],
          verifierCommandsSha256: stableFingerprint(frozenCommands),
        }
      : artifact),
  };
}

function attachIntegrationClosureReceipt(result: HarnessActionResult, state: IntegrationClosureState): HarnessActionResult {
  if (result.status !== "done" || !state.receipt) return result;
  const integrationArtifact = result.artifacts.find((artifact) => artifact.kind === "integration");
  const repoPath = typeof integrationArtifact?.repoPath === "string" ? integrationArtifact.repoPath : null;
  const paths = closureStringArrayField(state.receipt.paths);
  const pathHashes = recordStringMap(state.receipt.pathHashes);
  if (!repoPath || !paths || !pathHashes || paths.length !== Object.keys(pathHashes).length) {
    return blockAfterIntegrationClosureFailure(result, state,
      "Integrated target cannot be independently read back from the frozen closure.",
      "integration closure post-integration readback is unavailable");
  }
  const independentReadback: Record<string, string> = {};
  const materializedReadback: Record<string, string> = {};
  try {
    for (const file of state.materializedFiles ?? []) {
      const target = join(repoPath, file.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.content);
      chmodSync(target, file.mode);
    }
  } catch {
    return blockAfterIntegrationClosureFailure(result, state,
      "Integrated target could not materialize the frozen closure bytes.",
      "integration closure post-integration materialization failed");
  }
  for (const path of paths) {
    const materializedHash = sha256File(join(repoPath, path));
    if (!materializedHash || materializedHash.toLowerCase() !== pathHashes[path]?.toLowerCase()) {
      return blockAfterIntegrationClosureFailure(result, state,
        "Integrated target does not match the frozen closure.",
        `integration closure post-integration hash mismatch for ${path}: expected ${pathHashes[path]}, got ${materializedHash ?? "missing"}`);
    }
    const committedHash = sha256GitHeadPath(repoPath, path);
    if (!committedHash || committedHash.toLowerCase() !== pathHashes[path]?.toLowerCase()) {
      return blockAfterIntegrationClosureFailure(result, state,
        "Integrated commit does not match the frozen closure.",
        `integration closure committed hash mismatch for ${path}: expected ${pathHashes[path]}, got ${committedHash ?? "missing"}`);
    }
    materializedReadback[path] = materializedHash;
    independentReadback[path] = committedHash;
  }
  result.checks.push({
    name: "independent post-integration readback",
    status: "passed",
    evidence: `${paths.length} frozen paths`,
  });
  return {
    ...result,
    artifacts: result.artifacts.map((artifact) => artifact.kind === "integration"
      ? { ...artifact, ...state.receipt, materializedReadback, independentReadback }
      : artifact),
  };
}

function blockAfterIntegrationClosureFailure(
  result: HarnessActionResult,
  state: IntegrationClosureState,
  summary: string,
  problem: string,
): HarnessActionResult {
  const artifact = result.artifacts.find((candidate) => candidate.kind === "integration");
  const repoPath = typeof artifact?.repoPath === "string" ? artifact.repoPath : null;
  const targetBranch = typeof artifact?.targetBranch === "string" ? artifact.targetBranch : null;
  const targetBaseSha = typeof state.receipt?.targetBaseSha === "string" ? state.receipt.targetBaseSha : null;
  const paths = closureStringArrayField(state.receipt?.paths);
  const git = state.git ?? defaultGitRunner;
  let rollbackProblem: string | null = null;
  if (repoPath && targetBranch && targetBaseSha && paths) {
    const integratedHead = readGitStdout(git, repoPath, ["rev-parse", "HEAD"]);
    const rollback = integratedHead && runGitStep(git, repoPath, [
      "update-ref", `refs/heads/${targetBranch}`, targetBaseSha, integratedHead,
    ]);
    if (!rollback || !rollback.ok) {
      rollbackProblem = "integration closure rollback compare-and-swap failed";
    } else {
      const restore = artifact?.mode === "materialized_target_commit"
        ? runGitStep(git, repoPath, ["reset", targetBaseSha, "--", ...paths])
        : runGitStep(git, repoPath, ["restore", `--source=${targetBaseSha}`, "--staged", "--worktree", "--", ...paths]);
      if (!restore.ok) {
        rollbackProblem = "integration closure rollback path restoration failed";
      } else {
        result.checks.push({
          name: "integration closure rollback",
          status: "passed",
          evidence: `${integratedHead} -> ${targetBaseSha}`,
        });
      }
    }
  } else {
    rollbackProblem = "integration closure rollback evidence is incomplete";
  }
  return blockedIntegration("integrateVerifiedRun", summary, result.checks, [
    problem,
    ...(rollbackProblem ? [rollbackProblem] : []),
  ]);
}

function sha256GitHeadPath(repoPath: string, path: string): string | null {
  const result = Bun.spawnSync({
    cmd: ["git", "show", `HEAD:${path}`],
    cwd: repoPath,
    stdout: "pipe",
    stderr: "pipe",
    maxBuffer: MAX_INTEGRATION_CLOSURE_FILE_BYTES + 1,
  });
  if (result.exitCode !== 0) return null;
  return createHash("sha256").update(result.stdout).digest("hex");
}

function optionalRecordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function selectVerifierForWorker(overview: RunOverview, workerTaskId: string): Task | null {
  const latest = [...overview.tasks].reverse().find(
    (task) => task.role === "verifier" && task.dependsOn.includes(workerTaskId),
  );
  if (!latest || latest.status !== "done") {
    return null;
  }
  const session = latestSessionForTask(overview, latest.id);
  if (!session || session.output.status !== "done") {
    return null;
  }
  const checks = Array.isArray(session.output.checks) ? session.output.checks : [];
  return checks.some(isFailedCheck) ? null : latest;
}

function selectCompletedGoalReview(overview: RunOverview): Task | null {
  const invalidatedTaskIds = invalidatedGoalReviewTaskIds(overview);
  return [...overview.tasks].reverse().find((task) => {
    if (task.role !== "goal-review" || task.status !== "done" || invalidatedTaskIds.has(task.id)) {
      return false;
    }
    const session = latestSessionForTask(overview, task.id);
    if (session?.output.status !== "done") {
      return false;
    }
    const decision = resolveRunDecision(session.output);
    return decision === "complete" && (session.output.nextTasks ?? []).length === 0;
  }) ?? null;
}

function invalidatedGoalReviewTaskIds(overview: RunOverview): Set<string> {
  const raw = overview.run?.context.invalidatedGoalReviewTaskIds;
  return new Set(Array.isArray(raw) ? raw.filter((value): value is string => typeof value === "string") : []);
}

function isFailedCheck(check: unknown) {
  return Boolean(
    check &&
      typeof check === "object" &&
      "status" in check &&
      (check as { status?: unknown }).status === "failed",
  );
}

function resolveWorktreePath(repoPath: string, worktreePath: string | null) {
  if (!worktreePath) {
    return null;
  }
  if (isAbsolute(worktreePath)) {
    return worktreePath;
  }
  const repositoryRelativePath = join(repoPath, worktreePath);
  if (existsSync(repositoryRelativePath)) {
    return repositoryRelativePath;
  }
  const supervisorRelativePath = resolve(worktreePath);
  return existsSync(supervisorRelativePath) ? supervisorRelativePath : repositoryRelativePath;
}

function defaultGitRunner(input: GitCommandInput): GitCommandResult {
  const result = Bun.spawnSync({
    cmd: ["git", ...input.args],
    cwd: input.cwd,
    stdout: "pipe",
    stderr: "pipe",
    ...(input.env ? { env: { ...process.env, ...input.env } } : {}),
    ...(input.timeoutMs === undefined ? {} : { timeout: input.timeoutMs }),
    ...(input.maxOutputBytes === undefined ? {} : { maxBuffer: input.maxOutputBytes }),
  });
  return {
    exitCode: result.exitCode,
    stdout: decodeCommandOutput(result.stdout),
    stderr: decodeCommandOutput(result.stderr),
  };
}

function defaultCommandRunner(input: CommandRunnerInput): CommandRunnerResult {
  const result = Bun.spawnSync({
    cmd: ["sh", "-lc", input.command],
    cwd: input.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: input.cwd,
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      LANG: process.env.LANG ?? "C.UTF-8",
      LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
      CI: "1",
      ...(process.env.BUN_INSTALL ? { BUN_INSTALL: process.env.BUN_INSTALL } : {}),
    },
    ...(input.timeoutMs === undefined ? {} : { timeout: input.timeoutMs }),
    ...(input.maxOutputBytes === undefined ? {} : { maxBuffer: input.maxOutputBytes }),
  });
  return {
    exitCode: result.exitCode,
    stdout: decodeCommandOutput(result.stdout),
    stderr: decodeCommandOutput(result.stderr),
  };
}

function runGitStep(
  git: GitRunner,
  cwd: string,
  args: string[],
  limits: { timeoutMs?: number; maxOutputBytes?: number } = {},
) {
  const result = git({ cwd, args, ...limits });
  return {
    ...result,
    ok: result.exitCode === 0,
    command: `git ${args.join(" ")}`,
    cwd,
  };
}

function readTargetDirtyFiles(git: GitRunner, cwd: string): { ok: true; files: string[] } | { ok: false; result: ReturnType<typeof runGitStep> } {
  const commands = [
    ["diff", "--name-only"],
    ["diff", "--cached", "--name-only"],
    ["ls-files", "--others", "--exclude-standard"],
  ];
  const files = new Set<string>();
  for (const args of commands) {
    const result = runGitStep(git, cwd, args);
    if (!result.ok) {
      return { ok: false, result };
    }
    for (const file of result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
      files.add(file);
    }
  }
  return { ok: true, files: filterOuroborosRuntimePaths([...files]).sort() };
}

function normalizeRelativeFiles(files: string[]) {
  return filterOuroborosRuntimePaths(files).filter((file) =>
    file.length > 0 &&
    !isAbsolute(file) &&
    !file.split(/[\\/]+/).includes("..")
  );
}

function sameMaterializedFile(repoPath: string, worktreePath: string, file: string) {
  const repoFile = join(repoPath, file);
  const worktreeFile = join(worktreePath, file);
  const repoExists = existsSync(repoFile);
  const worktreeExists = existsSync(worktreeFile);
  if (repoExists !== worktreeExists) {
    return false;
  }
  if (!repoExists) {
    return true;
  }
  return readFileSync(repoFile).equals(readFileSync(worktreeFile));
}

type DirtyStatusEntry =
  | { kind: "regular"; path: string; staged: string; worktree: string }
  | { kind: "rename"; path: string; fromPath: string }
  | { kind: "unsafe"; path: string };

type DirtyStatusResult =
  | { ok: true; entries: DirtyStatusEntry[] }
  | { ok: false; result: ReturnType<typeof runGitStep> };

function readTargetDirtyStatus(git: GitRunner, cwd: string): DirtyStatusResult {
  // Porcelain v1 with `-z` NUL separators, `--untracked-files=all` so
  // individual untracked files are listed instead of collapsed directories,
  // and `-c core.quotepath=false` so non-ASCII paths are not C-escaped. With
  // `-z`, each entry is XY <space> path. For renames and copies, the orig
  // path and the new path are emitted as two consecutive NUL-separated
  // segments after the XY marker.
  const result = runGitStep(git, cwd, [
    "-c",
    "core.quotepath=false",
    "status",
    "--short",
    "-z",
    "--untracked-files=all",
  ]);
  if (!result.ok) {
    return { ok: false, result };
  }
  const entries: DirtyStatusEntry[] = [];
  const segments = result.stdout.split("\0");
  let i = 0;
  while (i < segments.length) {
    const segment = segments[i];
    if (!segment || segment.length < 4) {
      i += 1;
      continue;
    }
    const xy = segment.slice(0, 2);
    const rest = segment.slice(3);
    const staged = xy.charAt(0);
    const worktree = xy.charAt(1);
    if (staged === "R" || staged === "C" || worktree === "R" || worktree === "C") {
      // For -z output, the orig path is the next NUL-separated segment.
      const fromPath = rest;
      const toPath = segments[i + 1] ?? "";
      i += 2;
      const cleanFrom = normalizeRelativeFiles([fromPath])[0];
      const cleanTo = normalizeRelativeFiles([toPath])[0];
      if (!cleanFrom || !cleanTo) {
        entries.push({ kind: "unsafe", path: toPath || fromPath });
        continue;
      }
      entries.push({ kind: "rename", path: cleanTo, fromPath: cleanFrom });
      continue;
    }
    const path = normalizeRelativeFiles([rest])[0];
    i += 1;
    if (!path) {
      entries.push({ kind: "unsafe", path: rest });
      continue;
    }
    entries.push({ kind: "regular", path, staged, worktree });
  }
  // Filter out Ouroboros runtime paths so the supervisor never classifies
  // runtime control state as operator edits.
  const filtered = entries.filter((entry) => !isOuroborosRuntimePath(entry.path));
  return { ok: true, entries: filtered };
}

function pathContains(parent: string, child: string) {
  if (parent === child) {
    return true;
  }
  const parentSegments = parent.split(/[\\/]+/).filter(Boolean);
  const childSegments = child.split(/[\\/]+/).filter(Boolean);
  if (parentSegments.length >= childSegments.length) {
    return false;
  }
  for (let i = 0; i < parentSegments.length; i += 1) {
    if (parentSegments[i] !== childSegments[i]) {
      return false;
    }
  }
  return true;
}

function pathCollidesAsFileAndDirectory(left: string, right: string) {
  // A file/directory collision occurs when one path is a strict prefix of the
  // other AND the prefix path terminates without a separator. Example:
  //   left  = "src/foo"
  //   right = "src/foo/bar.ts"
  // Here `src/foo` would have to be both a file (per left) and a directory
  // (per right) — git cannot stage both at the same time.
  if (left === right) {
    return false;
  }
  const leftParts = left.split(/[\\/]+/).filter(Boolean);
  const rightParts = right.split(/[\\/]+/).filter(Boolean);
  const shorter = leftParts.length <= rightParts.length ? leftParts : rightParts;
  const longer = shorter === leftParts ? rightParts : leftParts;
  if (longer.length <= shorter.length) {
    return false;
  }
  for (let i = 0; i < shorter.length; i += 1) {
    if (shorter[i] !== longer[i]) {
      return false;
    }
  }
  return true;
}

function createMaterializedIntegrationTree(
  git: GitRunner,
  repoPath: string,
  parentSha: string,
  verifiedPaths: string[],
): { ok: true; tree: string } | { ok: false; result: ReturnType<typeof runGitStep> } {
  let tempDir: string;
  try {
    tempDir = mkdtempSync(join(tmpdir(), "ouroboros-integration-index-"));
  } catch {
    return {
      ok: false,
      result: {
        ok: false,
        exitCode: 1,
        stdout: "",
        stderr: "could not create isolated Git index directory",
        command: "git read-tree",
        cwd: repoPath,
      },
    };
  }
  const indexPath = join(tempDir, "index");
  const env = { GIT_INDEX_FILE: indexPath };
  try {
    const readTree = runGitWithEnvStep(git, repoPath, ["read-tree", parentSha], env);
    if (!readTree.ok) {
      return { ok: false, result: readTree };
    }
    const add = runGitWithEnvStep(git, repoPath, ["add", "--", ...verifiedPaths], env);
    if (!add.ok) {
      return { ok: false, result: add };
    }
    const tree = runGitWithEnvStep(git, repoPath, ["write-tree"], env);
    if (!tree.ok || !/^[0-9a-f]{40}$/i.test(tree.stdout.trim())) {
      return { ok: false, result: tree };
    }
    const changed = runGitStep(git, repoPath, [
      "diff-tree",
      "--no-commit-id",
      "--name-status",
      "-r",
      "-z",
      parentSha,
      tree.stdout.trim(),
      "--",
    ]);
    const entries = changed.ok ? parseNameStatusZ(changed.stdout) : null;
    const expected = [...new Set(verifiedPaths)].sort();
    const actual = entries?.map((entry) => entry.path).sort() ?? [];
    if (!changed.ok || !entries || entries.some((entry) => entry.status.startsWith("R") || entry.status.startsWith("C")) ||
      actual.length !== expected.length || actual.join("\0") !== expected.join("\0")) {
      return {
        ok: false,
        result: {
          ...changed,
          ok: false,
          exitCode: changed.ok ? 1 : changed.exitCode,
          stderr: changed.ok ? "isolated integration tree changed paths do not match verified worker paths" : changed.stderr,
        },
      };
    }
    return { ok: true, tree: tree.stdout.trim() };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

interface DisjointSnapshotEntry {
  path: string;
  exists: boolean;
  isSymlink: boolean;
  isDirectory: boolean;
  mode: number | null;
  content: Buffer | null;
  symlinkTarget: string | null;
  porcelain: string;
  tracked: boolean;
  indexMode: string | null;
  indexBlob: string | null;
  indexStage: string | null;
}

interface DisjointSnapshot {
  entries: DisjointSnapshotEntry[];
  incomplete: string[] | null;
}

type IndexEntry = { mode: string; blob: string; stage: string };

function snapshotIndexEntries(
  git: GitRunner,
  repoPath: string,
  paths: string[],
): { ok: true; entries: Array<{ path: string; entry: IndexEntry | null }> } | { ok: false } {
  const entries: Array<{ path: string; entry: IndexEntry | null }> = [];
  for (const path of paths) {
    const result = readIndexEntry(git, repoPath, path);
    if (!result.ok) {
      return { ok: false };
    }
    entries.push({ path, entry: result.entry });
  }
  return { ok: true, entries };
}

function syncIndexToTree(
  git: GitRunner,
  repoPath: string,
  tree: string,
  paths: string[],
): { ok: true } | { ok: false } {
  for (const path of paths) {
    const treeResult = runGitStep(git, repoPath, ["ls-tree", "-z", tree, "--", path]);
    if (!treeResult.ok) {
      return { ok: false };
    }
    const segment = treeResult.stdout.split("\0").find(Boolean);
    const match = segment ? /^(\d+) blob ([0-9a-fA-F]{40})\t(.+)$/.exec(segment) : null;
    const update = match
      ? runGitStep(git, repoPath, ["update-index", "--add", "--cacheinfo", `${match[1]},${match[2]},${path}`])
      : runGitStep(git, repoPath, ["update-index", "--force-remove", "--", path]);
    if (!update.ok) {
      return { ok: false };
    }
  }
  return { ok: true };
}

function restoreIndexEntries(
  git: GitRunner,
  repoPath: string,
  entries: Array<{ path: string; entry: IndexEntry | null }>,
) {
  for (const { path, entry } of entries) {
    if (entry) {
      runGitStep(git, repoPath, ["update-index", "--add", "--cacheinfo", `${entry.mode},${entry.blob},${path}`]);
    } else {
      runGitStep(git, repoPath, ["update-index", "--force-remove", "--", path]);
    }
  }
}

function readIndexEntry(
  git: GitRunner,
  repoPath: string,
  path: string,
): { ok: true; entry: { mode: string; blob: string; stage: string } | null } | { ok: false } {
  const result = runGitStep(git, repoPath, ["ls-files", "--stage", "-z", "--", path]);
  if (!result.ok) {
    return { ok: false };
  }
  const segment = result.stdout.split("\0").find(Boolean);
  if (!segment) {
    return { ok: true, entry: null };
  }
  const match = /^(\d+) ([0-9a-fA-F]{40}) (\d+)\t(.+)$/.exec(segment);
  if (!match || match[4] !== path) {
    return { ok: false };
  }
  return { ok: true, entry: { mode: match[1]!, blob: match[2]!.toLowerCase(), stage: match[3]! } };
}

function snapshotDisjointTargetPaths(
  git: GitRunner,
  repoPath: string,
  dirtyEntries: DirtyStatusEntry[],
  disjointPaths: string[],
): DisjointSnapshot {
  const entries: DisjointSnapshotEntry[] = [];
  const incomplete: string[] = [];
  for (const path of disjointPaths) {
    const abs = join(repoPath, path);
    const dirtyEntry = dirtyEntries.find((entry) => entry.kind === "regular" && entry.path === path);
    const index = readIndexEntry(git, repoPath, path);
    if (!dirtyEntry || dirtyEntry.kind !== "regular" || !index.ok) {
      incomplete.push(path);
      continue;
    }
    const common = {
      path,
      porcelain: `${dirtyEntry.staged}${dirtyEntry.worktree} ${path}`,
      tracked: index.entry !== null,
      indexMode: index.entry?.mode ?? null,
      indexBlob: index.entry?.blob ?? null,
      indexStage: index.entry?.stage ?? null,
    };
    let snapshot: DisjointSnapshotEntry;
    try {
      if (!existsSync(abs)) {
        snapshot = {
          ...common,
          exists: false,
          isSymlink: false,
          isDirectory: false,
          mode: null,
          content: null,
          symlinkTarget: null,
        };
      } else {
        const stat = lstatSync(abs);
        if (stat.isSymbolicLink()) {
          let target: string | null;
          try {
            target = readlinkSync(abs);
          } catch {
            incomplete.push(path);
            continue;
          }
          snapshot = {
            ...common,
            exists: true,
            isSymlink: true,
            isDirectory: false,
            mode: stat.mode & 0o777,
            content: null,
            symlinkTarget: target,
          };
        } else if (stat.isDirectory()) {
          snapshot = {
            ...common,
            exists: true,
            isSymlink: false,
            isDirectory: true,
            mode: stat.mode & 0o777,
            content: null,
            symlinkTarget: null,
          };
        } else {
          snapshot = {
            ...common,
            exists: true,
            isSymlink: false,
            isDirectory: false,
            mode: stat.mode & 0o777,
            content: readFileSync(abs),
            symlinkTarget: null,
          };
        }
      }
    } catch {
      incomplete.push(path);
      continue;
    }
    entries.push(snapshot);
  }
  return { entries, incomplete: incomplete.length > 0 ? incomplete : null };
}

function readbackDisjointTargetPaths(
  git: GitRunner,
  repoPath: string,
  snapshot: DisjointSnapshot,
): { ok: true } | { ok: false; mismatched: string[] } {
  const mismatched: string[] = [];
  const status = readTargetDirtyStatus(git, repoPath);
  if (!status.ok) {
    return { ok: false, mismatched: snapshot.entries.map((entry) => entry.path) };
  }
  for (const entry of snapshot.entries) {
    const abs = join(repoPath, entry.path);
    const current = status.entries.find((candidate) => candidate.kind === "regular" && candidate.path === entry.path);
    const index = readIndexEntry(git, repoPath, entry.path);
    if (!current || current.kind !== "regular" || !index.ok ||
      `${current.staged}${current.worktree} ${entry.path}` !== entry.porcelain ||
      (index.entry !== null) !== entry.tracked ||
      (index.entry?.mode ?? null) !== entry.indexMode ||
      (index.entry?.blob ?? null) !== entry.indexBlob ||
      (index.entry?.stage ?? null) !== entry.indexStage) {
      mismatched.push(entry.path);
      continue;
    }
    if (entry.exists !== existsSync(abs)) {
      mismatched.push(entry.path);
      continue;
    }
    if (!entry.exists) {
      continue;
    }
    try {
      const stat = lstatSync(abs);
      if (entry.isSymlink) {
        if (!stat.isSymbolicLink()) {
          mismatched.push(entry.path);
          continue;
        }
        let target: string;
        try {
          target = readlinkSync(abs);
        } catch {
          mismatched.push(entry.path);
          continue;
        }
        if (target !== entry.symlinkTarget) {
          mismatched.push(entry.path);
        }
        continue;
      }
      if (entry.isDirectory !== stat.isDirectory()) {
        mismatched.push(entry.path);
        continue;
      }
      if (entry.isDirectory) {
        if ((stat.mode & 0o777) !== entry.mode) {
          mismatched.push(entry.path);
        }
        continue;
      }
      const content = readFileSync(abs);
      if (!content.equals(entry.content ?? Buffer.alloc(0))) {
        mismatched.push(entry.path);
        continue;
      }
      if ((stat.mode & 0o777) !== entry.mode) {
        mismatched.push(entry.path);
      }
    } catch {
      mismatched.push(entry.path);
    }
  }
  return mismatched.length === 0 ? { ok: true } : { ok: false, mismatched };
}

function verifyIntegratedTargetPaths(
  git: GitRunner,
  repoPath: string,
  commitSha: string,
  paths: string[],
): { ok: true } | { ok: false; reason: string } {
  for (const path of paths) {
    const expected = runGitStep(git, repoPath, ["rev-parse", `${commitSha}:${path}`]);
    if (!expected.ok) {
      if (!existsSync(join(repoPath, path))) {
        continue;
      }
      return { ok: false, reason: `integrated path readback mismatch: ${path}` };
    }
    const actual = runGitStep(git, repoPath, ["hash-object", "--", path]);
    if (!actual.ok || actual.stdout.trim() !== expected.stdout.trim()) {
      return { ok: false, reason: `integrated path readback mismatch: ${path}` };
    }
  }
  return { ok: true };
}

function rollbackMaterializedIntegration(
  git: GitRunner,
  repoPath: string,
  actionType: Extract<HarnessAction, { type: "integrateVerifiedRun" }>["type"],
  checks: HarnessActionResult["checks"],
  expectedHead: string,
): HarnessActionResult | null {
  // Roll back ONLY the commit created by this integration attempt. Operator
  // edits in the working tree are left untouched. Returns null when rollback
  // is unavailable (e.g., HEAD already matches expected) and the caller must
  // produce its own blocked result.
  const head = readGitStdout(git, repoPath, ["rev-parse", "HEAD"]);
  if (!head) {
    return null;
  }
  if (head === expectedHead) {
    return null;
  }
  const rollback = runGitStep(git, repoPath, [
    "update-ref",
    "HEAD",
    expectedHead,
    head,
  ]);
  if (!rollback.ok) {
    return null;
  }
  return blockedIntegration(
    actionType,
    "Rolled back materialized integration after post-commit readback failure with a compare-and-swap ref update; operator edits preserved.",
    checks,
    [`readback mismatch; ref restored from ${head} to ${expectedHead}`],
  );
}

function snapshotStagedIndex(
  git: GitRunner,
  repoPath: string,
  paths: string[],
): { ok: true; entries: { path: string; mode: string; blob: string }[] } | { ok: false } {
  // Use `git ls-files --stage -z` to read the index entries for the given
  // paths. Each entry is `<mode> SP <blob> SP <stage>\t<path>\0`.
  const entries: { path: string; mode: string; blob: string }[] = [];
  const result = runGitStep(git, repoPath, ["ls-files", "--stage", "-z", "--", ...paths]);
  if (!result.ok) {
    return { ok: false };
  }
  const seen = new Set<string>();
  for (const segment of result.stdout.split("\0")) {
    if (!segment) {
      continue;
    }
    const match = /^(\d+) ([0-9a-fA-F]{40}) (\d+)\t(.+)$/.exec(segment);
    if (!match) {
      continue;
    }
    const path = match[4];
    if (!path || seen.has(path)) {
      continue;
    }
    seen.add(path);
    entries.push({ path, mode: match[1], blob: match[2].toLowerCase() });
  }
  if (entries.length !== paths.length) {
    return { ok: false };
  }
  return { ok: true, entries };
}

function restoreStagedIndex(
  git: GitRunner,
  repoPath: string,
  entries: { path: string; mode: string; blob: string }[],
): { ok: true } | { ok: false } {
  // Re-stage the operator's disjoint paths by adding them from the worktree.
  // The worktree bytes are byte-for-byte unchanged (preserved through the
  // integration commit), so the resulting index entries match the original
  // snapshot. This restores the porcelain status of every preserved path.
  if (entries.length === 0) {
    return { ok: true };
  }
  const paths = entries.map((entry) => entry.path);
  // Verify the worktree bytes still hash to the original blobs. If anything
  // drifted, surface a failure rather than re-staging mismatched content.
  for (const entry of entries) {
    const hashResult = runGitStep(git, repoPath, ["hash-object", "--", entry.path]);
    if (!hashResult.ok) {
      return { ok: false };
    }
    const hash = hashResult.stdout.trim().toLowerCase();
    if (hash !== entry.blob) {
      return { ok: false };
    }
  }
  const add = runGitStep(git, repoPath, ["add", "--", ...paths]);
  if (!add.ok) {
    return { ok: false };
  }
  return { ok: true };
}

function readGitStdout(git: GitRunner, cwd: string, args: string[]) {
  const result = runGitStep(git, cwd, args);
  return result.ok ? result.stdout.trim() : null;
}

function integrationOperationKey(
  harness: Harness,
  action: Extract<HarnessAction, { type: "integrateVerifiedRun" }>,
  git: GitRunner,
) {
  const overview = harness.getRunOverview({ runId: action.runId, eventLimit: 0 });
  if (!overview.run) {
    return null;
  }
  const worker = selectIntegrationWorker(overview, action.workerTaskId);
  const repoPath = action.repoPath ?? overview.run.projectRoot ?? overview.project?.rootPath ?? null;
  const workerPath = worker?.worktreePath && repoPath
    ? resolveWorktreePath(repoPath, worker.worktreePath)
    : worker?.worktreePath ?? null;
  const slot = worker?.id ?? action.workerTaskId ?? "automatic";
  const latestWorkerAttempt = worker
    ? [...overview.sessions].reverse().find((session) => session.taskId === worker.id)?.attemptId ?? null
    : null;
  const goalReviewTaskId = overview.tasks.find((task) => task.role === "goal-review")?.id ?? null;
  return {
    slot,
    key: stableFingerprint({
      action: {
        integrationContractVersion: INTEGRATION_CONTRACT_VERSION,
        runId: action.runId,
        workerTaskId: action.workerTaskId ?? null,
        repoPath,
        targetBranch: action.targetBranch ?? "main",
        push: action.push ?? false,
        integrationClosure: action.integrationClosure ?? overview.run.context.integrationClosure ?? null,
      },
      workerTaskId: worker?.id ?? null,
      workerAttemptId: latestWorkerAttempt,
      goalReviewTaskId,
      workerPath,
    }),
  };
}

function runGitWithEnvStep(
  git: GitRunner,
  cwd: string,
  args: string[],
  env: Record<string, string | undefined>,
) {
  const result = git({ cwd, args, env });
  return {
    ...result,
    ok: result.exitCode === 0,
    command: `git ${args.join(" ")}`,
    cwd,
  };
}

function gitRepositoryState(git: GitRunner, cwd: string | null) {
  if (!cwd || !existsSync(cwd)) {
    return { exists: false, cwd };
  }
  const read = (args: string[]) => {
    try {
      const result = runGitStep(git, cwd, args);
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      return { exitCode: -1, stdout: "", stderr: errorMessage(error) };
    }
  };
  return {
    exists: true,
    branch: read(["branch", "--show-current"]),
    status: read(["status", "--short"]),
    head: read(["rev-parse", "HEAD"]),
    mergeHead: read(["rev-parse", "--verify", "-q", "MERGE_HEAD"]),
  };
}

function stableFingerprint(value: unknown) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value)), "utf8").digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonicalize(record[key])]),
  );
}

function blockedCommand(
  actionType: Extract<HarnessAction, { type: "integrateVerifiedRun" }>["type"],
  summary: string,
  checks: HarnessActionResult["checks"],
  result: ReturnType<typeof runGitStep>,
): HarnessActionResult {
  const safeSummary = sanitizeEvolutionErrorText(summary);
  const safeStdout = sanitizeEvolutionErrorText(result.stdout);
  const safeStderr = sanitizeEvolutionErrorText(result.stderr);
  return {
    status: "blocked",
    actionType,
    summary: safeSummary,
    checks: [
      ...checks,
      { name: "git command", status: "failed", evidence: `${result.command} in ${result.cwd}` },
    ],
    artifacts: [
      {
        kind: "git_command",
        command: result.command,
        cwd: result.cwd,
        exitCode: result.exitCode,
        stdout: safeStdout,
        stderr: safeStderr,
      },
    ],
    problems: [safeStderr.trim() || safeStdout.trim() || safeSummary],
  };
}

function blockedIntegration(
  actionType: Extract<HarnessAction, { type: "integrateVerifiedRun" }>["type"],
  summary: string,
  checks: HarnessActionResult["checks"],
  problems: string[],
): HarnessActionResult {
  return {
    status: "blocked",
    actionType,
    summary,
    checks: [...checks, { name: "integration preflight", status: "failed", evidence: problems.join("; ") }],
    artifacts: [],
    problems,
  };
}

function decodeCommandOutput(value: Uint8Array | ArrayBuffer | string | null | undefined) {
  if (!value) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  return new TextDecoder().decode(value);
}

function objectRecord(value: unknown, label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalObjectField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  return objectRecord(value, key);
}

function stringField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value.trim();
}

function assertOnlyFields(record: Record<string, unknown>, label: string, allowed: string[]) {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(record).filter((key) => !allowedSet.has(key));
  if (unexpected.length > 0) {
    throw new Error(`${label} contains unsupported fields: ${unexpected.sort().join(", ")}`);
  }
}

function safeIdentifierField(record: Record<string, unknown>, key: string) {
  const value = stringField(record, key);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value)) {
    throw new Error(`${key} must be a safe identifier of at most 200 characters`);
  }
  return value;
}

function exactNonEmptyStringField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || value.includes("\0")) {
    throw new Error(`${key} must be an exact non-empty string without surrounding whitespace or NUL`);
  }
  return value;
}

function exactSafeIdentifierField(record: Record<string, unknown>, key: string) {
  const value = exactNonEmptyStringField(record, key);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value)) {
    throw new Error(`${key} must be a safe identifier of at most 200 characters`);
  }
  return value;
}

function exactAbsolutePathField(record: Record<string, unknown>, key: string) {
  const value = exactNonEmptyStringField(record, key);
  if (!isAbsolute(value)) {
    throw new Error(`${key} must be an absolute path`);
  }
  return value;
}

function exactGitBranchField(record: Record<string, unknown>, key: string) {
  const value = exactNonEmptyStringField(record, key);
  if (!isExactGitBranchRef(`refs/heads/${value}`)) {
    throw new Error(`${key} must be one exact branch name without wildcard or ref expressions`);
  }
  return value;
}

function exactGitCommitShaField(record: Record<string, unknown>, key: string) {
  const value = exactNonEmptyStringField(record, key);
  if (!/^[0-9a-f]{40}$/.test(value) || /^0+$/.test(value)) {
    throw new Error(`${key} must be a non-zero lowercase full 40-character commit SHA`);
  }
  return value;
}

function exactCommitMessageField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\r") ||
    value.includes("\n") ||
    value.trim() !== value ||
    new TextEncoder().encode(value).byteLength > EXACT_GIT_INDEX_MAX_COMMIT_MESSAGE_BYTES
  ) {
    throw new Error(`${key} must be one exact non-empty trimmed line of at most ${EXACT_GIT_INDEX_MAX_COMMIT_MESSAGE_BYTES} UTF-8 bytes without NUL`);
  }
  return value;
}

function exactGitIndexFilesField(record: Record<string, unknown>, key: string): ExactGitIndexFile[] {
  const value = record[key];
  if (!Array.isArray(value) || value.length === 0 || value.length > EXACT_GIT_INDEX_MAX_FILES) {
    throw new Error(`${key} must contain 1-${EXACT_GIT_INDEX_MAX_FILES} exact Git index additions`);
  }
  const seen = new Set<string>();
  return value.map((item, index) => {
    const file = objectRecord(item, `${key}[${index}]`);
    assertOnlyFields(file, `${key}[${index}]`, ["status", "path", "mode", "blobOid"]);
    if (file.status !== "A") {
      throw new Error(`${key}[${index}].status must be A`);
    }
    if (file.mode !== "100644") {
      throw new Error(`${key}[${index}].mode must be 100644`);
    }
    const path = exactRelativeGitPathField(file, "path", `${key}[${index}].path`);
    if (seen.has(path)) {
      throw new Error(`${key} must contain unique paths; duplicate: ${path}`);
    }
    seen.add(path);
    return {
      status: "A",
      path,
      mode: "100644",
      blobOid: exactGitBlobOidField(file, "blobOid", `${key}[${index}].blobOid`),
    };
  });
}

function exactRelativeGitPathField(record: Record<string, unknown>, key: string, label: string) {
  const value = record[key];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    isAbsolute(value) ||
    value.includes("\\") ||
    /[\x00-\x1f\x7f]/.test(value) ||
    new TextEncoder().encode(value).byteLength > EXACT_GIT_INDEX_MAX_PATH_BYTES ||
    value.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error(`${label} must be an exact safe relative Git path of at most ${EXACT_GIT_INDEX_MAX_PATH_BYTES} UTF-8 bytes`);
  }
  return value;
}

function exactGitBlobOidField(record: Record<string, unknown>, key: string, label: string) {
  const value = record[key];
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value) || /^0+$/.test(value)) {
    throw new Error(`${label} must be a non-zero lowercase full 40-character blob OID`);
  }
  return value;
}

function absolutePathField(record: Record<string, unknown>, key: string) {
  const value = stringField(record, key);
  if (!isAbsolute(value)) {
    throw new Error(`${key} must be an absolute path`);
  }
  return value;
}

function gitRemoteHostField(record: Record<string, unknown>, key: string) {
  const value = stringField(record, key).toLowerCase();
  if (!isGitRemoteHost(value)) {
    throw new Error(`${key} must be an exact DNS hostname without a scheme, port, or wildcard`);
  }
  return value;
}

function exactGitRemoteHostField(record: Record<string, unknown>, key: string) {
  const value = exactNonEmptyStringField(record, key);
  if (value !== value.toLowerCase() || !isGitRemoteHost(value)) {
    throw new Error(`${key} must be one exact lowercase DNS hostname without a scheme, port, or wildcard`);
  }
  return value;
}

function isGitRemoteHost(value: string) {
  return value.length <= 253 &&
    value.split(".").length >= 2 &&
    value.split(".").every((label) =>
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)
    );
}

function gitRepositoryField(record: Record<string, unknown>, key: string) {
  const value = stringField(record, key);
  if (!isGitRepository(value)) {
    throw new Error(`${key} must be an exact repository path without scheme, credentials, wildcard, or .git suffix`);
  }
  return value;
}

function exactGitRepositoryField(record: Record<string, unknown>, key: string) {
  const value = exactNonEmptyStringField(record, key);
  if (!isGitRepository(value)) {
    throw new Error(`${key} must be an exact repository path without scheme, credentials, wildcard, or .git suffix`);
  }
  return value;
}

function isGitRepository(value: string) {
  const segments = value.split("/");
  return segments.length >= 2 &&
    !value.endsWith(".git") &&
    !value.includes("..") &&
    segments.every((segment) => /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/.test(segment));
}

function gitBranchRefField(record: Record<string, unknown>, key: string) {
  const value = stringField(record, key);
  if (!isExactGitBranchRef(value)) {
    throw new Error(`${key} must be one exact refs/heads/* branch without wildcard, deletion, or ref expressions`);
  }
  return value;
}

function exactCreatableBranchRefField(record: Record<string, unknown>, key: string) {
  const value = exactNonEmptyStringField(record, key);
  if (!isExactGitBranchRef(value)) {
    throw new Error(`${key} must be one exact refs/heads/* branch without wildcard, deletion, or ref expressions`);
  }
  if (value === "refs/heads/main") {
    throw new Error(`${key} must not create refs/heads/main`);
  }
  return value;
}

function isExactGitBranchRef(value: string) {
  if (!value.startsWith("refs/heads/")) {
    return false;
  }
  const branch = value.slice("refs/heads/".length);
  if (
    branch.length === 0 ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch.includes("..") ||
    branch.includes("@{") ||
    /[\x00-\x20\x7f~^:?*\[\\]/.test(branch)
  ) {
    return false;
  }
  return branch.split("/").every((segment) =>
    segment.length > 0 && segment !== "." && segment !== ".." && !segment.startsWith(".") && !segment.endsWith(".lock")
  );
}

function gitCommitShaField(record: Record<string, unknown>, key: string) {
  const value = stringField(record, key).toLowerCase();
  if (!isGitCommitSha(value) || /^0+$/.test(value)) {
    throw new Error(`${key} must be a non-zero full 40-character commit SHA`);
  }
  return value;
}

function isGitCommitSha(value: string) {
  return /^[0-9a-f]{40}$/i.test(value);
}

function optionalStringField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string`);
  }
  return value.trim();
}

function optionalStatusField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (value !== "todo" && value !== "running" && value !== "done" && value !== "blocked") {
    throw new Error(`${key} must be todo, running, done, or blocked`);
  }
  return value;
}

function optionalBooleanField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${key} must be a boolean`);
  }
  return value;
}

function followUpTaskField(record: Record<string, unknown>, key: string) {
  const value = objectRecord(record[key], key);
  return {
    role: stringField(value, "role"),
    goal: stringField(value, "goal"),
    prompt: stringField(value, "prompt"),
    doneWhen: optionalStringArrayField(value, "doneWhen"),
  };
}

function optionalStringArrayField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${key} must be an array of strings`);
  }
  return value.map((item, index) => {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new Error(`${key}[${index}] must be a non-empty string`);
    }
    return item.trim();
  });
}

function optionalWatchdogEventsField(value: unknown) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error("inboxEvents must be an array");
  }
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`inboxEvents[${index}] must be an object`);
    }
    const record = item as Record<string, unknown>;
    return {
      id: stringField(record, "id"),
      status: stringField(record, "status"),
      provider: stringField(record, "provider"),
      eventType: stringField(record, "eventType"),
    };
  });
}

function optionalWatchdogReviewsField(value: unknown) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error("scheduledReviews must be an array");
  }
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`scheduledReviews[${index}] must be an object`);
    }
    const record = item as Record<string, unknown>;
    const reviewAtRaw = record.reviewAt;
    return {
      runId: stringField(record, "runId"),
      reviewAt:
        typeof reviewAtRaw === "string"
          ? reviewAtRaw
          : reviewAtRaw === null || reviewAtRaw === undefined
            ? null
            : (() => {
                throw new Error(`scheduledReviews[${index}].reviewAt must be a string or null`);
              })(),
    };
  });
}

function optionalThreadStatusFilter(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (
    value !== "running" &&
    value !== "done" &&
    value !== "blocked" &&
    value !== "interrupted" &&
    value !== "orphaned"
  ) {
    throw new Error(`${key} must be running, done, blocked, interrupted, or orphaned`);
  }
  return value as ExecutionThreadStatusFilter;
}

function stringArrayField(record: Record<string, unknown>, key: string) {
  const value = optionalStringArrayField(record, key);
  if (value === undefined) {
    throw new Error(`${key} must be an array of strings`);
  }
  return value;
}

function optionalPositiveInteger(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || typeof value !== "number" || value < 1) {
    throw new Error(`${key} must be a positive integer`);
  }
  return value;
}

function positiveIntegerField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (!Number.isInteger(value) || typeof value !== "number" || value < 1) {
    throw new Error(`${key} must be a positive integer`);
  }
  return value;
}

function optionalNonNegativeIntegerField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || typeof value !== "number" || value < 0) {
    throw new Error(`${key} must be a non-negative integer`);
  }
  return value;
}

function requiredValueField(record: Record<string, unknown>, key: string) {
  if (!(key in record)) {
    throw new Error(`${key} must be provided`);
  }
  return record[key];
}

function safeRequest(value: unknown): Record<string, unknown> {
  const sanitized = sanitizeActionRequestValue(value);
  return sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)
    ? (sanitized as Record<string, unknown>)
    : { value: sanitized };
}

function sanitizeActionRequestValue(
  value: unknown,
  key = "",
  active = new WeakSet<object>(),
): unknown {
  if (isSensitiveActionRequestKey(key)) {
    return "[REDACTED]";
  }
  if (typeof value === "string") {
    return sanitizeEvolutionErrorText(value);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (active.has(value)) {
    return "[CIRCULAR]";
  }
  active.add(value);
  const sanitized = Array.isArray(value)
    ? value.map((item) => sanitizeActionRequestValue(item, "", active))
    : Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        sanitizeActionRequestValue(entryValue, entryKey, active),
      ]),
    );
  active.delete(value);
  return sanitized;
}

function isSensitiveActionRequestKey(key: string) {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (words.some((word) => ["authorization", "token", "secret", "password", "credential", "credentials"].includes(word))) {
    return true;
  }
  return words.includes("key") && words.some((word) => ["api", "private", "secret", "access", "signing"].includes(word));
}

function resultToRecord(result: HarnessActionResult): Record<string, unknown> {
  return { ...result };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

// After a successful integration, transition the linked design proposal into
// `measuring` and (when due) seed a bounded outcome-review task. The reviewer
// records the formal retain/revise/retire outcome; the delivery task graph is
// not reopened. Idempotent: a second integration for the same run is a no-op.
function finalizeIntegrationOutcomeReview(
  harness: Harness,
  action: Extract<HarnessAction, { type: "integrateVerifiedRun" }>,
  result: HarnessActionResult,
): HarnessActionResult {
  if (result.status !== "done") {
    return result;
  }
  const integrationArtifact = result.artifacts.find(
    (artifact) =>
      typeof artifact === "object" &&
      artifact !== null &&
      (artifact as { kind?: unknown }).kind === "integration",
  );
  if (!integrationArtifact) {
    return result;
  }
  const run = harness.getRun(action.runId);
  const isTerminalDesignIntegration = integrationArtifact.preCompletion !== true &&
    run?.context.source === "design" && typeof run.context.designProposalId === "string";
  if (isTerminalDesignIntegration && !integrationArtifactHasCompleteClosure(integrationArtifact)) {
    return blockedIntegration(action.type, "Terminal integration is missing a verified integration closure.", result.checks, [
      "terminal integration cannot enter measurement without a complete closure receipt",
    ]);
  }
  if (integrationArtifact.preCompletion === true || integrationArtifact.goalReviewTaskId === null) {
    result.checks.push({
      name: "measurement eligibility",
      status: "passed",
      evidence: "deferred until terminal goal-review completion and closure reconciliation",
    });
    return result;
  }
  const immediate = action.immediateOutcomeReview === true;
  let linked: ReturnType<Harness["linkProposalOutcomeReview"]> | null = null;
  try {
    linked = harness.linkProposalOutcomeReview({
      runId: action.runId,
      immediateProxyReview: immediate,
    });
  } catch (error) {
    return {
      ...result,
      problems: [...(result.problems ?? []), `outcome review link failed: ${errorMessage(error)}`],
    };
  }
  if (!linked.proposalId) {
    return result;
  }
  if (linked.proposalStatus) {
    result.checks.push({
      name: "design proposal measuring",
      status: "passed",
      evidence: `${linked.proposalId}:${linked.proposalStatus}`,
    });
  }
  if (linked.outcomeReviewTaskId) {
    result.checks.push({
      name: "outcome review task",
      status: "passed",
      evidence: linked.outcomeReviewTaskId,
    });
    result.artifacts = [
      ...result.artifacts,
      {
        kind: "outcome-review",
        runId: action.runId,
        proposalId: linked.proposalId,
        taskId: linked.outcomeReviewTaskId,
        reviewDue: linked.reviewDue,
        reviewAt: linked.reviewAt,
        reason: linked.reason,
      },
    ];
  } else if (linked.reviewAt) {
    result.checks.push({
      name: "outcome review scheduled",
      status: "passed",
      evidence: `${linked.proposalId}:${linked.reviewAt}`,
    });
  }
  return result;
}

function integrationArtifactHasCompleteClosure(artifact: Record<string, unknown>) {
  const paths = closureStringArrayField(artifact.paths);
  const pathHashes = recordStringMap(artifact.pathHashes);
  const independentReadback = recordStringMap(artifact.independentReadback);
  if (!paths || paths.length === 0 || !pathHashes || !independentReadback) return false;
  const expectedKeys = [...paths].sort().join("\0");
  if (Object.keys(pathHashes).sort().join("\0") !== expectedKeys ||
      Object.keys(independentReadback).sort().join("\0") !== expectedKeys) return false;
  return paths.every((path) => /^[0-9a-f]{64}$/i.test(pathHashes[path] ?? "") &&
    pathHashes[path]?.toLowerCase() === independentReadback[path]?.toLowerCase());
}
