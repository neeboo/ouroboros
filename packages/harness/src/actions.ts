import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { acceptGuardrailProposal, proposeGuardrailsFromLessons } from "./guardrails";
import { completionVerificationContract, describeRunCompletionReadiness } from "./completion-readiness";
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
import { parseHarnessRevisionV1 } from "./harness-revision";
import { requireStrictIsoTimestamp } from "./iso-timestamp";
import {
  canonicalResearchEvidenceArtifactSha256,
  parseResearchEvidenceLinkPayload,
  type ResearchEvidenceArtifactRef,
  type ResearchEvidenceGrade,
  type ResearchEvidenceLinkV1,
} from "./research-evidence";
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
  HarnessRevisionV1,
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
  | { type: "reconcileRunEvidence"; runId: string; reason: string }
  | {
      type: "recordSignal";
      projectId: string;
      sourceRunId: string;
      signalClass: "system";
      source: string;
      title: string;
      summary: string;
      observationTime: string;
      confidence: number;
      evidence: string[];
      expiresAt?: string;
      payload: Record<string, unknown>;
      supersedesSignalId?: string;
    }
  | {
      type: "linkResearchEvidence";
      projectId: string;
      sourceRunId: string;
      sourceTaskId: string;
      sourceAttemptId: string;
      expiresAt: string;
      artifacts: Array<{
        artifactId: string;
        sha256: string;
        evidenceGrade: ResearchEvidenceGrade;
      }>;
    }
  | {
      type: "materializeDesignerActionRecovery";
      runId: string;
      sourceTaskId: string;
      sourceAttemptId: string;
      reason?: string;
    }
  | {
      type: "materializeDesignDeliveryRecovery";
      runId: string;
      sourcePlannerTaskId: string;
      reason?: string;
    }
  | {
      type: "materializeDesignWorkerRuntimeRecovery";
      runId: string;
      sourceWorkerTaskId: string;
      reason?: string;
    }
  | {
      type: "materializeDesignWorkerTransportRecovery";
      runId: string;
      sourceWorkerTaskId: string;
      reason?: string;
    }
  | {
      type: "materializeVerifierRepairRecovery";
      runId: string;
      verifierTaskId: string;
      reason?: string;
    }
  | {
      type: "reconcileVerifierRepairHandoff";
      runId: string;
      repairTaskId: string;
      verifierTaskId: string;
      reason?: string;
    }
  | {
      type: "buildVersionedCorpusManifest";
      projectId: string;
      sourceRunId: string;
      proposalId: string;
      decisionId: string;
      targetVersion: number;
      developmentFixtureRefs?: string[];
      unrelatedFixtureRefs?: string[];
      publicFixtureBindings?: Array<{
        ref: string;
        sourceTaskId: string;
        sourceAttemptId: string;
        relativePath: string;
        sha256: string;
      }>;
    }
  | {
      type: "bindHostEvidenceMaintenanceReceipt";
      runId: string;
      taskId: string;
      actionEventId: string;
      evidenceBundle: Record<string, unknown>;
    }
  | {
      type: "materializeHostEvidenceMaintenanceDelivery";
      proposalId: string;
      decisionId: string;
    }
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
  | { type: "retireTask"; taskId: string; reason: string }
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
      verifierTaskId?: string;
      verifiedAbsentPaths?: string[];
      preservedUntrackedRoots?: string[];
    }
  | {
      type: "freezeVerifiedPackageCommit";
      contractId: string;
      runId: string;
      taskId: string;
      verifierTaskId: string;
      repoPath: string;
      branch: string;
      expectedParentSha: string;
      commitMessage: string;
      allowedRoots: string[];
      preservedUntrackedRoots: string[];
      comparisonPath: string;
      expectedComparisonFileSha256: string;
      expectedAbsentPaths: string[];
      expectedTestPasses: number;
    }
  | {
      type: "freezeExactGitPush";
      runId: string;
      contractId: string;
      commitActionEventId: string;
      repoPath: string;
      remoteHost: string;
      repository: string;
      ref: string;
      expectedOldSha: string;
    }
  | {
      type: "completeVerifiedPackageDelivery";
      runId: string;
      commitActionEventId: string;
      pushActionEventId: string;
      nextGoal: string;
    }
  | {
      type: "stageExactWorkerFilesForVerification";
      contractId: string;
      runId: string;
      taskId: string;
      repoPath: string;
      branch: string;
      expectedParentSha: string;
      commitMessage: string;
    }
  | {
      type: "materializeAttemptArtifactsForVerification";
      contractId: string;
      runId: string;
      plannerTaskId: string;
      sourceAttemptId: string;
      receiptAttemptId: string;
      repoPath: string;
      worktreePath: string;
      branch: string;
      expectedParentSha: string;
      commitMessage: string;
      files: WorkerFileReceipt[];
      excludedPaths: string[];
    }
  | {
      type: "verifySealedCorpusForVerification";
      contractId: string;
      runId: string;
      taskId: string;
      repoPath: string;
      scriptPath: string;
      expectedRefsSha256: string;
      expectedCorpusSnapshotSha256: string;
      expectedCount: number;
      descriptorSource?: "approved-proposal-comparison";
      proposalId?: string;
      decisionId?: string;
    }
  | { type: "registerEvolutionProfile"; runId: string; profile: EvolutionProfile }
  | { type: "recordProductionEpisode"; runId: string; episode: ProductionEpisode }
  | { type: "registerHarnessVariant"; runId: string; variant: HarnessVariant }
  | {
      type: "activateHarnessRevision";
      runId: string;
      rootRunId: string;
      revision: HarnessRevisionV1;
    }
  | { type: "freezeMatchedExperiment"; runId: string; experiment: MatchedExperiment }
  | {
      type: "interruptAttemptAndCreateTask";
      attemptId: string;
      reason: string;
      followUpTask?: {
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
  /** Ephemeral host input. It is never copied into an action request or result. */
  sealedDescriptorJson?: string;
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
  stdin?: string;
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
  "parentRunId",
  "activeHarnessRevision",
  "harnessRevision",
  "resourceAllocation",
  "targetSystemDesignQuiescence",
  "researchEvidenceLinks",
  "targetSystemEvidenceBundle",
  "verifiedPackageCloseout",
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
  if (type === "reconcileRunEvidence") {
    assertOnlyFields(record, type, ["type", "runId", "reason"]);
    return {
      type,
      runId: stringField(record, "runId"),
      reason: stringField(record, "reason"),
    };
  }
  if (type === "recordSignal") {
    assertOnlyFields(record, type, [
      "type",
      "projectId",
      "sourceRunId",
      "signalClass",
      "source",
      "title",
      "summary",
      "observationTime",
      "confidence",
      "evidence",
      "expiresAt",
      "payload",
      "supersedesSignalId",
    ]);
    const projectId = exactSafeIdentifierField(record, "projectId");
    const sourceRunId = exactSafeIdentifierField(record, "sourceRunId");
    if (record.signalClass !== "system") {
      throw new Error("recordSignal signalClass must be system");
    }
    const source = exactBoundedTextField(record, "source", 256);
    if (source !== `blocked-run-outcome:${sourceRunId}`) {
      throw new Error("recordSignal source must bind the blocked sourceRunId");
    }
    const observationTime = requireStrictIsoTimestamp(record.observationTime, "observationTime");
    const expiresAt = record.expiresAt === undefined
      ? undefined
      : requireStrictIsoTimestamp(record.expiresAt, "expiresAt");
    if (expiresAt && Date.parse(expiresAt) <= Date.parse(observationTime)) {
      throw new Error("recordSignal expiresAt must be later than observationTime");
    }
    const confidence = record.confidence;
    if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new Error("recordSignal confidence must be a finite number between 0 and 1");
    }
    return {
      type,
      projectId,
      sourceRunId,
      signalClass: "system",
      source,
      title: exactBoundedTextField(record, "title", 256),
      summary: exactBoundedTextField(record, "summary", 2_048),
      observationTime,
      confidence,
      evidence: blockedRunSignalEvidence(record.evidence),
      expiresAt,
      payload: blockedRunSignalPayload(record.payload),
      supersedesSignalId: record.supersedesSignalId === undefined
        ? undefined
        : exactSafeIdentifierField(record, "supersedesSignalId"),
    };
  }
  if (type === "linkResearchEvidence") {
    assertOnlyFields(record, type, [
      "type",
      "projectId",
      "sourceRunId",
      "sourceTaskId",
      "sourceAttemptId",
      "expiresAt",
      "artifacts",
    ]);
    return {
      type,
      projectId: exactSafeIdentifierField(record, "projectId"),
      sourceRunId: exactSafeIdentifierField(record, "sourceRunId"),
      sourceTaskId: exactSafeIdentifierField(record, "sourceTaskId"),
      sourceAttemptId: exactSafeIdentifierField(record, "sourceAttemptId"),
      expiresAt: requireStrictIsoTimestamp(record.expiresAt, "expiresAt"),
      artifacts: researchEvidenceArtifactRequests(record.artifacts),
    };
  }
  if (type === "materializeDesignerActionRecovery") {
    assertOnlyFields(record, type, ["type", "runId", "sourceTaskId", "sourceAttemptId", "reason"]);
    return {
      type,
      runId: stringField(record, "runId"),
      sourceTaskId: stringField(record, "sourceTaskId"),
      sourceAttemptId: stringField(record, "sourceAttemptId"),
      reason: optionalStringField(record, "reason"),
    };
  }
  if (type === "materializeDesignDeliveryRecovery") {
    assertOnlyFields(record, type, ["type", "runId", "sourcePlannerTaskId", "reason"]);
    return {
      type,
      runId: stringField(record, "runId"),
      sourcePlannerTaskId: stringField(record, "sourcePlannerTaskId"),
      reason: optionalStringField(record, "reason"),
    };
  }
  if (type === "materializeDesignWorkerRuntimeRecovery") {
    assertOnlyFields(record, type, ["type", "runId", "sourceWorkerTaskId", "reason"]);
    return {
      type,
      runId: stringField(record, "runId"),
      sourceWorkerTaskId: stringField(record, "sourceWorkerTaskId"),
      reason: optionalStringField(record, "reason"),
    };
  }
  if (type === "materializeDesignWorkerTransportRecovery") {
    assertOnlyFields(record, type, ["type", "runId", "sourceWorkerTaskId", "reason"]);
    return {
      type,
      runId: stringField(record, "runId"),
      sourceWorkerTaskId: stringField(record, "sourceWorkerTaskId"),
      reason: optionalStringField(record, "reason"),
    };
  }
  if (type === "materializeVerifierRepairRecovery") {
    assertOnlyFields(record, type, ["type", "runId", "verifierTaskId", "reason"]);
    return {
      type,
      runId: stringField(record, "runId"),
      verifierTaskId: stringField(record, "verifierTaskId"),
      reason: optionalStringField(record, "reason"),
    };
  }
  if (type === "reconcileVerifierRepairHandoff") {
    assertOnlyFields(record, type, ["type", "runId", "repairTaskId", "verifierTaskId", "reason"]);
    return {
      type,
      runId: stringField(record, "runId"),
      repairTaskId: stringField(record, "repairTaskId"),
      verifierTaskId: stringField(record, "verifierTaskId"),
      reason: optionalStringField(record, "reason"),
    };
  }
  if (type === "buildVersionedCorpusManifest") {
    assertOnlyFields(record, type, [
      "type",
      "projectId",
      "sourceRunId",
      "proposalId",
      "decisionId",
      "targetVersion",
      "developmentFixtureRefs",
      "unrelatedFixtureRefs",
      "publicFixtureBindings",
    ]);
    const publicFixtureBindings = publicFixtureBindingsField(record.publicFixtureBindings);
    return {
      type,
      projectId: exactSafeIdentifierField(record, "projectId"),
      sourceRunId: exactSafeIdentifierField(record, "sourceRunId"),
      proposalId: exactSafeIdentifierField(record, "proposalId"),
      decisionId: exactSafeIdentifierField(record, "decisionId"),
      targetVersion: positiveIntegerField(record, "targetVersion"),
      developmentFixtureRefs: optionalStringArrayField(record, "developmentFixtureRefs"),
      unrelatedFixtureRefs: optionalStringArrayField(record, "unrelatedFixtureRefs"),
      ...(publicFixtureBindings === undefined ? {} : { publicFixtureBindings }),
    };
  }
  if (type === "bindHostEvidenceMaintenanceReceipt") {
    assertOnlyFields(record, type, ["type", "runId", "taskId", "actionEventId", "evidenceBundle"]);
    return {
      type,
      runId: exactSafeIdentifierField(record, "runId"),
      taskId: exactSafeIdentifierField(record, "taskId"),
      actionEventId: exactSafeIdentifierField(record, "actionEventId"),
      evidenceBundle: objectRecord(record.evidenceBundle, "evidenceBundle"),
    };
  }
  if (type === "materializeHostEvidenceMaintenanceDelivery") {
    assertOnlyFields(record, type, ["type", "proposalId", "decisionId"]);
    return {
      type,
      proposalId: exactSafeIdentifierField(record, "proposalId"),
      decisionId: exactSafeIdentifierField(record, "decisionId"),
    };
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
  if (type === "retireTask") {
    return { type, taskId: stringField(record, "taskId"), reason: stringField(record, "reason") };
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
      "verifierTaskId",
      "verifiedAbsentPaths",
      "preservedUntrackedRoots",
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
      verifierTaskId: optionalNonEmptyStringField(record, "verifierTaskId"),
      verifiedAbsentPaths: exactRelativePathListField(record, "verifiedAbsentPaths"),
      preservedUntrackedRoots: exactRelativeRootListField(record, "preservedUntrackedRoots"),
    };
  }
  if (type === "freezeVerifiedPackageCommit") {
    assertOnlyFields(record, type, [
      "type", "contractId", "runId", "taskId", "verifierTaskId", "repoPath", "branch",
      "expectedParentSha", "commitMessage", "allowedRoots", "preservedUntrackedRoots",
      "comparisonPath", "expectedComparisonFileSha256", "expectedAbsentPaths", "expectedTestPasses",
    ]);
    const allowedRoots = exactRelativeRootListField(record, "allowedRoots", true) ?? [];
    const preservedUntrackedRoots = exactRelativeRootListField(record, "preservedUntrackedRoots") ?? [];
    if ([...allowedRoots].sort().join("\0") !== "config/evolution/\0tests/evolution/") {
      throw new Error("allowedRoots must be exactly config/evolution/ and tests/evolution/");
    }
    if (preservedUntrackedRoots.join("\0") !== ".ouroboros/") {
      throw new Error("preservedUntrackedRoots must be exactly .ouroboros/");
    }
    const expectedAbsentPaths = exactRelativePathListField(record, "expectedAbsentPaths");
    if (!expectedAbsentPaths) throw new Error("expectedAbsentPaths is required");
    return {
      type,
      contractId: exactSafeIdentifierField(record, "contractId"),
      runId: exactNonEmptyStringField(record, "runId"),
      taskId: exactNonEmptyStringField(record, "taskId"),
      verifierTaskId: exactNonEmptyStringField(record, "verifierTaskId"),
      repoPath: exactAbsolutePathField(record, "repoPath"),
      branch: exactGitBranchField(record, "branch"),
      expectedParentSha: exactGitCommitShaField(record, "expectedParentSha"),
      commitMessage: exactCommitMessageField(record, "commitMessage"),
      allowedRoots,
      preservedUntrackedRoots,
      comparisonPath: exactRelativeGitPathField(record, "comparisonPath", "comparisonPath"),
      expectedComparisonFileSha256: exactSha256Field(record, "expectedComparisonFileSha256"),
      expectedAbsentPaths,
      expectedTestPasses: positiveIntegerField(record, "expectedTestPasses"),
    };
  }
  if (type === "freezeExactGitPush") {
    assertOnlyFields(record, type, [
      "type", "runId", "contractId", "commitActionEventId", "repoPath", "remoteHost",
      "repository", "ref", "expectedOldSha",
    ]);
    return {
      type,
      runId: exactNonEmptyStringField(record, "runId"),
      contractId: exactSafeIdentifierField(record, "contractId"),
      commitActionEventId: exactNonEmptyStringField(record, "commitActionEventId"),
      repoPath: exactAbsolutePathField(record, "repoPath"),
      remoteHost: exactGitRemoteHostField(record, "remoteHost"),
      repository: exactGitRepositoryField(record, "repository"),
      ref: gitBranchRefField(record, "ref"),
      expectedOldSha: exactGitCommitShaField(record, "expectedOldSha"),
    };
  }
  if (type === "completeVerifiedPackageDelivery") {
    assertOnlyFields(record, type, ["type", "runId", "commitActionEventId", "pushActionEventId", "nextGoal"]);
    return {
      type,
      runId: exactNonEmptyStringField(record, "runId"),
      commitActionEventId: exactNonEmptyStringField(record, "commitActionEventId"),
      pushActionEventId: exactNonEmptyStringField(record, "pushActionEventId"),
      nextGoal: exactNonEmptyStringField(record, "nextGoal"),
    };
  }
  if (type === "stageExactWorkerFilesForVerification") {
    assertOnlyFields(record, type, [
      "type",
      "contractId",
      "runId",
      "taskId",
      "repoPath",
      "branch",
      "expectedParentSha",
      "commitMessage",
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
    };
  }
  if (type === "materializeAttemptArtifactsForVerification") {
    assertOnlyFields(record, type, [
      "type",
      "contractId",
      "runId",
      "plannerTaskId",
      "sourceAttemptId",
      "receiptAttemptId",
      "repoPath",
      "worktreePath",
      "branch",
      "expectedParentSha",
      "commitMessage",
      "files",
      "excludedPaths",
    ]);
    return {
      type,
      contractId: exactSafeIdentifierField(record, "contractId"),
      runId: exactNonEmptyStringField(record, "runId"),
      plannerTaskId: exactNonEmptyStringField(record, "plannerTaskId"),
      sourceAttemptId: exactNonEmptyStringField(record, "sourceAttemptId"),
      receiptAttemptId: exactNonEmptyStringField(record, "receiptAttemptId"),
      repoPath: exactAbsolutePathField(record, "repoPath"),
      worktreePath: exactAbsolutePathField(record, "worktreePath"),
      branch: exactGitBranchField(record, "branch"),
      expectedParentSha: exactGitCommitShaField(record, "expectedParentSha"),
      commitMessage: exactCommitMessageField(record, "commitMessage"),
      files: exactWorkerFileReceiptsField(record, "files"),
      excludedPaths: exactRelativeGitPathsField(record, "excludedPaths", { allowEmpty: true }),
    };
  }
  if (type === "verifySealedCorpusForVerification") {
    assertOnlyFields(record, type, [
      "type",
      "contractId",
      "runId",
      "taskId",
      "repoPath",
      "scriptPath",
      "expectedRefsSha256",
      "expectedCorpusSnapshotSha256",
      "expectedCount",
      "descriptorSource",
      "proposalId",
      "decisionId",
    ]);
    const expectedCount = record.expectedCount;
    if (!Number.isSafeInteger(expectedCount) || (expectedCount as number) <= 0 || (expectedCount as number) > 1_000) {
      throw new Error("expectedCount must be an integer between 1 and 1000");
    }
    const descriptorSource = record.descriptorSource;
    const proposalId = record.proposalId;
    const decisionId = record.decisionId;
    const hasGovernedDescriptor = descriptorSource !== undefined || proposalId !== undefined || decisionId !== undefined;
    if (
      hasGovernedDescriptor
      && (
        descriptorSource !== "approved-proposal-comparison"
        || typeof proposalId !== "string" || proposalId.length === 0
        || typeof decisionId !== "string" || decisionId.length === 0
      )
    ) {
      throw new Error("approved proposal descriptor source requires descriptorSource, proposalId, and decisionId");
    }
    return {
      type,
      contractId: exactSafeIdentifierField(record, "contractId"),
      runId: exactNonEmptyStringField(record, "runId"),
      taskId: exactNonEmptyStringField(record, "taskId"),
      repoPath: exactAbsolutePathField(record, "repoPath"),
      scriptPath: exactRelativeGitPathField(record, "scriptPath", "scriptPath"),
      expectedRefsSha256: exactSha256Field(record, "expectedRefsSha256"),
      expectedCorpusSnapshotSha256: exactSha256Field(record, "expectedCorpusSnapshotSha256"),
      expectedCount: expectedCount as number,
      ...(hasGovernedDescriptor ? {
        descriptorSource: "approved-proposal-comparison" as const,
        proposalId: proposalId as string,
        decisionId: decisionId as string,
      } : {}),
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
  if (type === "activateHarnessRevision") {
    assertOnlyFields(record, type, ["type", "runId", "rootRunId", "revision"]);
    const revisionRecord = objectRecord(record.revision, "revision");
    const projectId = exactNonEmptyStringField(revisionRecord, "projectId");
    return {
      type,
      runId: exactNonEmptyStringField(record, "runId"),
      rootRunId: exactNonEmptyStringField(record, "rootRunId"),
      revision: parseHarnessRevisionV1(revisionRecord, projectId, "revision"),
    };
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
      followUpTask: optionalFollowUpTaskField(record, "followUpTask"),
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
    "harness action type must be reclaimRunningTasks, retryTask, reconcileRunEvidence, recordSignal, linkResearchEvidence, materializeDesignerActionRecovery, materializeDesignDeliveryRecovery, materializeDesignWorkerRuntimeRecovery, materializeDesignWorkerTransportRecovery, materializeVerifierRepairRecovery, reconcileVerifierRepairHandoff, buildVersionedCorpusManifest, bindHostEvidenceMaintenanceReceipt, materializeHostEvidenceMaintenanceDelivery, markRunTodo, updateRunContext, amendRunContract, retireRun, retireTask, prepareRunDrain, completeSystemTask, integrateVerifiedRun, pushExactGitRef, createExactGitRef, commitExactGitIndex, stageExactWorkerFilesForVerification, materializeAttemptArtifactsForVerification, verifySealedCorpusForVerification, registerEvolutionProfile, recordProductionEpisode, registerHarnessVariant, activateHarnessRevision, freezeMatchedExperiment, interruptAttemptAndCreateTask, interruptRunningAttemptsAndCreateTask, acceptGuardrailProposal, startSubsession, collectSubsessions, cancelSubsessions, or runWatchdogPass",
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
      request: invalidActionAuditRequest(rawAction),
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

  if (action.type === "activateHarnessRevision") {
    return applyHarnessRevisionActivationAtomically(harness, action);
  }

  if (action.type === "materializeDesignerActionRecovery") {
    return applyDesignerActionRecoveryAtomically(harness, action);
  }

  if (action.type === "materializeDesignDeliveryRecovery") {
    return applyDesignDeliveryRecoveryAtomically(harness, action);
  }

  if (action.type === "materializeDesignWorkerRuntimeRecovery") {
    return applyDesignWorkerRuntimeRecoveryAtomically(harness, action);
  }

  if (action.type === "materializeDesignWorkerTransportRecovery") {
    return applyDesignWorkerTransportRecoveryAtomically(harness, action);
  }

  if (action.type === "materializeVerifierRepairRecovery") {
    return applyVerifierRepairRecoveryAtomically(harness, action);
  }

  if (action.type === "reconcileVerifierRepairHandoff") {
    return applyVerifierRepairHandoffReconciliationAtomically(harness, action);
  }

  if (action.type === "reconcileRunEvidence") {
    return applyRunEvidenceReconciliationAtomically(harness, action);
  }

  if (action.type === "recordSignal") {
    return applyBlockedRunSignalAtomically(harness, action);
  }

  if (action.type === "linkResearchEvidence") {
    return applyResearchEvidenceLinkAtomically(harness, action);
  }

  if (action.type === "buildVersionedCorpusManifest") {
    return applyVersionedCorpusManifestAction(harness, action, options);
  }

  if (action.type === "materializeHostEvidenceMaintenanceDelivery") {
    return applyHostEvidenceMaintenanceDeliveryAtomically(harness, action);
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

type HarnessRevisionActivationAction = Extract<HarnessAction, { type: "activateHarnessRevision" }>;
type DesignerActionRecoveryAction = Extract<HarnessAction, { type: "materializeDesignerActionRecovery" }>;
type DesignDeliveryRecoveryAction = Extract<HarnessAction, { type: "materializeDesignDeliveryRecovery" }>;
type DesignWorkerRuntimeRecoveryAction = Extract<HarnessAction, { type: "materializeDesignWorkerRuntimeRecovery" }>;
type DesignWorkerTransportRecoveryAction = Extract<HarnessAction, { type: "materializeDesignWorkerTransportRecovery" }>;
type VerifierRepairRecoveryAction = Extract<HarnessAction, { type: "materializeVerifierRepairRecovery" }>;
type VerifierRepairHandoffReconciliationAction = Extract<HarnessAction, { type: "reconcileVerifierRepairHandoff" }>;
type RunEvidenceReconciliationAction = Extract<HarnessAction, { type: "reconcileRunEvidence" }>;
type ResearchEvidenceLinkAction = Extract<HarnessAction, { type: "linkResearchEvidence" }>;
type BlockedRunSignalAction = Extract<HarnessAction, { type: "recordSignal" }>;

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

function applyHarnessRevisionActivationAtomically(
  harness: Harness,
  action: HarnessRevisionActivationAction,
): HarnessActionResult & { eventId: string } {
  try {
    return harness.runInImmediateTransaction((db) => {
      const result = activateHarnessRevisionWithDb(harness, db, action);
      const eventId = harness.recordHarnessActionEventWithDb(db, {
        actionType: action.type,
        status: result.status,
        request: harnessRevisionActivationAuditRequest(action),
        result: resultToRecord(result),
      });
      return { ...result, eventId };
    });
  } catch (error) {
    const problem = limitUtf8Output(sanitizeEvolutionErrorText(errorMessage(error)), 4_096);
    const result = blockedResult(action.type, `${action.type} blocked: ${problem}`, [problem]);
    const eventId = harness.recordHarnessActionEvent({
      actionType: action.type,
      status: result.status,
      request: harnessRevisionActivationAuditRequest(action),
      result: resultToRecord(result),
    });
    return { ...result, eventId };
  }
}

function applyDesignerActionRecoveryAtomically(
  harness: Harness,
  action: DesignerActionRecoveryAction,
): HarnessActionResult & { eventId: string } {
  try {
    return harness.runInImmediateTransaction((db) => {
      const result = materializeDesignerActionRecoveryWithDb(harness, db, action);
      const eventId = harness.recordHarnessActionEventWithDb(db, {
        actionType: action.type,
        status: result.status,
        request: safeRequest(action),
        result: resultToRecord(result),
      });
      return { ...result, eventId };
    });
  } catch (error) {
    const problem = limitUtf8Output(sanitizeEvolutionErrorText(errorMessage(error)), 4_096);
    const result = blockedResult(action.type, `${action.type} blocked: ${problem}`, [problem]);
    const eventId = harness.recordHarnessActionEvent({
      actionType: action.type,
      status: result.status,
      request: safeRequest(action),
      result: resultToRecord(result),
    });
    return { ...result, eventId };
  }
}

function applyDesignDeliveryRecoveryAtomically(
  harness: Harness,
  action: DesignDeliveryRecoveryAction,
): HarnessActionResult & { eventId: string } {
  try {
    return harness.runInImmediateTransaction((db) => {
      const result = materializeDesignDeliveryRecoveryWithDb(harness, db, action);
      const eventId = harness.recordHarnessActionEventWithDb(db, {
        actionType: action.type,
        status: result.status,
        request: safeRequest(action),
        result: resultToRecord(result),
      });
      return { ...result, eventId };
    });
  } catch (error) {
    const problem = limitUtf8Output(sanitizeEvolutionErrorText(errorMessage(error)), 4_096);
    const result = blockedResult(action.type, `${action.type} blocked: ${problem}`, [problem]);
    const eventId = harness.recordHarnessActionEvent({
      actionType: action.type,
      status: result.status,
      request: safeRequest(action),
      result: resultToRecord(result),
    });
    return { ...result, eventId };
  }
}

function applyDesignWorkerRuntimeRecoveryAtomically(
  harness: Harness,
  action: DesignWorkerRuntimeRecoveryAction,
): HarnessActionResult & { eventId: string } {
  try {
    return harness.runInImmediateTransaction((db) => {
      const result = materializeDesignWorkerRuntimeRecoveryWithDb(harness, db, action);
      const eventId = harness.recordHarnessActionEventWithDb(db, {
        actionType: action.type,
        status: result.status,
        request: safeRequest(action),
        result: resultToRecord(result),
      });
      return { ...result, eventId };
    });
  } catch (error) {
    const problem = limitUtf8Output(sanitizeEvolutionErrorText(errorMessage(error)), 4_096);
    const result = blockedResult(action.type, `${action.type} blocked: ${problem}`, [problem]);
    const eventId = harness.recordHarnessActionEvent({
      actionType: action.type,
      status: result.status,
      request: safeRequest(action),
      result: resultToRecord(result),
    });
    return { ...result, eventId };
  }
}

function applyDesignWorkerTransportRecoveryAtomically(
  harness: Harness,
  action: DesignWorkerTransportRecoveryAction,
): HarnessActionResult & { eventId: string } {
  try {
    return harness.runInImmediateTransaction((db) => {
      const result = materializeDesignWorkerTransportRecoveryWithDb(harness, db, action);
      const eventId = harness.recordHarnessActionEventWithDb(db, {
        actionType: action.type,
        status: result.status,
        request: safeRequest(action),
        result: resultToRecord(result),
      });
      return { ...result, eventId };
    });
  } catch (error) {
    const problem = limitUtf8Output(sanitizeEvolutionErrorText(errorMessage(error)), 4_096);
    const result = blockedResult(action.type, `${action.type} blocked: ${problem}`, [problem]);
    const eventId = harness.recordHarnessActionEvent({
      actionType: action.type,
      status: result.status,
      request: safeRequest(action),
      result: resultToRecord(result),
    });
    return { ...result, eventId };
  }
}

function applyVerifierRepairRecoveryAtomically(
  harness: Harness,
  action: VerifierRepairRecoveryAction,
): HarnessActionResult & { eventId: string } {
  try {
    return harness.runInImmediateTransaction((db) => {
      const result = materializeVerifierRepairRecoveryWithDb(harness, db, action);
      const eventId = harness.recordHarnessActionEventWithDb(db, {
        actionType: action.type,
        status: result.status,
        request: safeRequest(action),
        result: resultToRecord(result),
      });
      return { ...result, eventId };
    });
  } catch (error) {
    const problem = limitUtf8Output(sanitizeEvolutionErrorText(errorMessage(error)), 4_096);
    const result = blockedResult(action.type, `${action.type} blocked: ${problem}`, [problem]);
    const eventId = harness.recordHarnessActionEvent({
      actionType: action.type,
      status: result.status,
      request: safeRequest(action),
      result: resultToRecord(result),
    });
    return { ...result, eventId };
  }
}

function applyVerifierRepairHandoffReconciliationAtomically(
  harness: Harness,
  action: VerifierRepairHandoffReconciliationAction,
): HarnessActionResult & { eventId: string } {
  try {
    return harness.runInImmediateTransaction((db) => {
      const result = reconcileVerifierRepairHandoffWithDb(harness, db, action);
      const eventId = harness.recordHarnessActionEventWithDb(db, {
        actionType: action.type,
        status: result.status,
        request: safeRequest(action),
        result: resultToRecord(result),
      });
      return { ...result, eventId };
    });
  } catch (error) {
    const problem = limitUtf8Output(sanitizeEvolutionErrorText(errorMessage(error)), 4_096);
    const result = blockedResult(action.type, `${action.type} blocked: ${problem}`, [problem]);
    const eventId = harness.recordHarnessActionEvent({
      actionType: action.type,
      status: result.status,
      request: safeRequest(action),
      result: resultToRecord(result),
    });
    return { ...result, eventId };
  }
}

function applyRunEvidenceReconciliationAtomically(
  harness: Harness,
  action: RunEvidenceReconciliationAction,
): HarnessActionResult & { eventId: string } {
  try {
    return harness.runInImmediateTransaction((db) => {
      const overview = harness.getRunOverviewWithDb(db, { runId: action.runId, eventLimit: 0 });
      const run = overview.run;
      if (!run) throw new Error(`run not found: ${action.runId}`);
      const completion = describeRunCompletionReadiness(overview);
      const reasons = [...new Set(completion.blockers.map((blocker) => blocker.reason))].sort();
      if (reasons.length === 0) {
        throw new Error(`run ${action.runId} has no machine-verifiable evidence blocker to reconcile`);
      }
      const currentConflict = objectRecordOrNull(run.context.evidenceConflict);
      const reused = run.status === "blocked"
        && currentConflict?.status === "blocked"
        && equalStringLists(currentConflict.reasons, reasons);
      const reconciledAt = reused && typeof currentConflict?.reconciledAt === "string"
        ? currentConflict.reconciledAt
        : new Date().toISOString();
      if (!reused) {
        harness.updateRunWithDb(db, {
          runId: run.id,
          status: "blocked",
          contextPatch: {
            evidenceConflict: {
              schemaVersion: 1,
              status: "blocked",
              reasons,
              reconciledAt,
              reason: action.reason,
            },
            pendingVerificationReason: reasons.join("; "),
          },
        });
        const parentRunId = typeof run.context.parentRunId === "string" ? run.context.parentRunId : null;
        if (parentRunId && harness.getRunWithDb(db, parentRunId)) {
          harness.updateRunWithDb(db, {
            runId: parentRunId,
            contextPatch: {
              designEvidenceCorrectionRequired: {
                schemaVersion: 1,
                sourceRunId: run.id,
                reasons,
                reconciledAt,
              },
            },
          });
        }
      }
      const result = doneResult(
        action.type,
        reused
          ? `Run ${run.id} evidence-conflict reconciliation reused.`
          : `Run ${run.id} blocked after evidence-conflict reconciliation.`,
        [
          { name: "completion evidence blockers", status: "passed", evidence: reasons.join("; ") },
          { name: "run status", status: "passed", evidence: "blocked" },
        ],
        [{ kind: "run_evidence_reconciliation", runId: run.id, status: "blocked", reasons, reused }],
      );
      const eventId = harness.recordHarnessActionEventWithDb(db, {
        actionType: action.type,
        status: result.status,
        request: safeRequest(action),
        result: resultToRecord(result),
      });
      return { ...result, eventId };
    });
  } catch (error) {
    const problem = limitUtf8Output(errorMessage(error), 4_096);
    const result = blockedResult(action.type, `${action.type} blocked: ${problem}`, [problem]);
    const eventId = harness.recordHarnessActionEvent({
      actionType: action.type,
      status: result.status,
      request: safeRequest(action),
      result: resultToRecord(result),
    });
    return { ...result, eventId };
  }
}

function applyBlockedRunSignalAtomically(
  harness: Harness,
  action: BlockedRunSignalAction,
): HarnessActionResult & { eventId: string } {
  try {
    return harness.runInImmediateTransaction((db) => {
      const run = harness.getRunWithDb(db, action.sourceRunId);
      if (!run) throw new Error(`source run not found: ${action.sourceRunId}`);
      if (run.projectId !== action.projectId) {
        throw new Error(`source run project does not match explicit projectId ${action.projectId}`);
      }
      if (run.status !== "blocked") {
        throw new Error(`recordSignal source run must be blocked: ${run.status}`);
      }
      const signalRecord = {
        projectId: action.projectId,
        signalClass: action.signalClass,
        source: action.source,
        title: action.title,
        summary: action.summary,
        observationTime: action.observationTime,
        confidence: action.confidence,
        evidence: action.evidence,
        expiresAt: action.expiresAt ?? null,
        runId: action.sourceRunId,
        payload: action.payload,
      };
      const supersededSignal = action.supersedesSignalId
        ? harness.getStrategySignalWithDb(db, { id: action.supersedesSignalId })
        : null;
      if (action.supersedesSignalId) {
        if (!supersededSignal) {
          throw new Error(`recordSignal superseded signal not found: ${action.supersedesSignalId}`);
        }
        if (supersededSignal.projectId !== action.projectId || supersededSignal.runId !== action.sourceRunId) {
          throw new Error(`recordSignal superseded signal is not bound to source run: ${action.supersedesSignalId}`);
        }
        if (supersededSignal.status !== "active" && supersededSignal.status !== "superseded") {
          throw new Error(`recordSignal cannot supersede signal in status ${supersededSignal.status}: ${action.supersedesSignalId}`);
        }
      }
      const conflictingSignalIds = action.supersedesSignalId ? [action.supersedesSignalId] : [];
      const signalSha256 = stableFingerprint(action.supersedesSignalId
        ? { ...signalRecord, conflictingSignalIds }
        : signalRecord);
      const signalId = action.supersedesSignalId
        ? `signal_blocked_correction_${stableFingerprint({
            supersedesSignalId: action.supersedesSignalId,
            signalSha256,
          }).slice(0, 32)}`
        : `signal_blocked_${stableFingerprint({
            projectId: action.projectId,
            sourceRunId: action.sourceRunId,
          }).slice(0, 32)}`;
      const existing = harness.getStrategySignalWithDb(db, { id: signalId });
      const reused = existing !== null;
      if (existing) {
        const existingRecord = {
          projectId: existing.projectId,
          signalClass: existing.signalClass,
          source: existing.source,
          title: existing.title,
          summary: existing.summary,
          observationTime: existing.observationTime,
          confidence: existing.confidence,
          evidence: existing.evidence,
          expiresAt: existing.expiresAt,
          runId: existing.runId,
          payload: existing.payload,
        };
        const existingSha256 = stableFingerprint(action.supersedesSignalId
          ? { ...existingRecord, conflictingSignalIds: existing.conflictingSignalIds }
          : existingRecord);
        if (existingSha256 !== signalSha256) {
          throw new Error(`recordSignal conflicts with existing blocked-run signal: ${signalId}`);
        }
      } else {
        harness.createStrategySignalWithDb(db, {
          id: signalId,
          ...signalRecord,
          conflictingSignalIds,
        });
      }
      if (action.supersedesSignalId) {
        if (supersededSignal?.status === "superseded" && !existing) {
          throw new Error(`recordSignal superseded signal has no matching correction: ${action.supersedesSignalId}`);
        }
        harness.supersedeStrategySignalWithDb(db, { id: action.supersedesSignalId });
      }
      const readback = harness.getStrategySignalWithDb(db, { id: signalId });
      if (!readback || readback.projectId !== action.projectId || readback.runId !== action.sourceRunId) {
        throw new Error(`recordSignal transactional readback failed: ${signalId}`);
      }
      const result = doneResult(
        action.type,
        reused ? `Blocked-run strategy signal ${signalId} reused.` : `Blocked-run strategy signal ${signalId} recorded.`,
        [
          { name: "source run status", status: "passed", evidence: "blocked" },
          { name: "project ownership", status: "passed", evidence: action.projectId },
          { name: "bounded evidence references", status: "passed", evidence: String(action.evidence.length) },
          { name: "transactional signal readback", status: "passed", evidence: signalSha256 },
        ],
        [{
          kind: "strategy_signal",
          signalId,
          signalSha256,
          projectId: action.projectId,
          sourceRunId: action.sourceRunId,
          supersededSignalId: action.supersedesSignalId ?? null,
          reused,
        }],
      );
      const eventId = harness.recordHarnessActionEventWithDb(db, {
        actionType: action.type,
        status: result.status,
        request: safeRequest(action),
        result: resultToRecord(result),
      });
      return { ...result, eventId };
    });
  } catch (error) {
    const problem = limitUtf8Output(sanitizeEvolutionErrorText(errorMessage(error)), 4_096);
    const result = blockedResult(action.type, `${action.type} blocked: ${problem}`, [problem]);
    const eventId = harness.recordHarnessActionEvent({
      actionType: action.type,
      status: result.status,
      request: safeRequest(action),
      result: resultToRecord(result),
    });
    return { ...result, eventId };
  }
}

function applyResearchEvidenceLinkAtomically(
  harness: Harness,
  action: ResearchEvidenceLinkAction,
): HarnessActionResult & { eventId: string } {
  try {
    return harness.runInImmediateTransaction((db) => {
      const overview = harness.getRunOverviewWithDb(db, { runId: action.sourceRunId, eventLimit: 0 });
      const run = overview.run;
      if (!run) throw new Error(`source run not found: ${action.sourceRunId}`);
      if (run.projectId !== action.projectId) {
        throw new Error(`source run project does not match explicit projectId ${action.projectId}`);
      }
      if (run.status !== "done") throw new Error(`source run must be done: ${run.status}`);
      if (run.context.researchOnly !== true || run.context.forbidImplementation !== true) {
        throw new Error("source run must be frozen research-only with implementation forbidden");
      }
      const task = overview.tasks.find((candidate) => candidate.id === action.sourceTaskId);
      if (!task || task.runId !== run.id) throw new Error(`source task does not belong to run: ${action.sourceTaskId}`);
      if (task.status !== "done") throw new Error(`source task must be done: ${task.status}`);
      if (task.config?.researchOnly !== true || task.config?.forbidWrites !== true || task.config?.forbidActions !== true) {
        throw new Error("source task must freeze researchOnly, forbidWrites, and forbidActions");
      }
      const session = overview.sessions.find((candidate) => candidate.attemptId === action.sourceAttemptId);
      if (!session || session.taskId !== task.id) {
        throw new Error(`source attempt does not belong to task: ${action.sourceAttemptId}`);
      }
      if (session.status !== "done" || session.output.status !== "done") {
        throw new Error(`source attempt must be done: ${session.status}`);
      }
      const output = session.output;
      if (!Array.isArray(output.changedFiles) || output.changedFiles.length !== 0) {
        throw new Error("research evidence source changedFiles must be empty; side effects are forbidden");
      }
      if ((output.designActions?.length ?? 0) > 0 || (output.nextTasks?.length ?? 0) > 0 || (output.nextRuns?.length ?? 0) > 0) {
        throw new Error("research evidence source must not create actions, tasks, or runs");
      }
      if (!hasPassedResearchCheck(output.checks, "research-only") || !hasPassedResearchCheck(output.checks, "side-effects")) {
        throw new Error("research-only and side-effects checks must both pass");
      }
      const outputArtifacts = Array.isArray(output.artifacts) ? output.artifacts : [];
      const identified = outputArtifacts.flatMap((artifact, artifactIndex) => {
        const id = researchArtifactId(artifact);
        return id ? [{ artifactId: id, artifactIndex, artifact }] : [];
      });
      if (identified.length === 0) throw new Error("research output must contain identified machine artifacts");
      if (new Set(identified.map((artifact) => artifact.artifactId)).size !== identified.length) {
        throw new Error("research artifact ids must be unique");
      }
      if (action.artifacts.length !== identified.length) {
        throw new Error("research artifact manifest must cover every identified machine artifact");
      }
      const expectedById = new Map(action.artifacts.map((artifact) => [artifact.artifactId, artifact]));
      if (expectedById.size !== action.artifacts.length) throw new Error("research artifact manifest ids must be unique");
      const artifactRefs: ResearchEvidenceArtifactRef[] = identified.map(({ artifactId, artifactIndex, artifact }) => {
        const expected = expectedById.get(artifactId);
        if (!expected) throw new Error(`research artifact missing from manifest: ${artifactId}`);
        const actualSha256 = canonicalResearchEvidenceArtifactSha256(artifact);
        if (actualSha256 !== expected.sha256) throw new Error(`research artifact hash mismatch: ${artifactId}`);
        return { artifactId, artifactIndex, sha256: actualSha256, evidenceGrade: expected.evidenceGrade };
      });
      const eventRefs = durableResearchEventRefs(task.config?.deadAttemptRecovery);
      if (eventRefs.length === 0) throw new Error("research evidence source must reference durable attempt events");
      for (const eventRef of eventRefs) {
        const exists = db.query("select 1 as found from attempt_events where id = $id").get({ $id: eventRef }) as { found: number } | null;
        if (!exists) throw new Error(`durable research event not found: ${eventRef}`);
      }
      const observedAt = normalizedEvidenceTimestamp(session.finishedAt);
      const expiresAtMs = Date.parse(action.expiresAt);
      if (expiresAtMs <= Date.parse(observedAt) || expiresAtMs <= Date.now()) {
        throw new Error("expiresAt must be later than the research observation and current time");
      }
      const signalId = `signal_research_${stableFingerprint({
        projectId: action.projectId,
        sourceRunId: run.id,
        sourceTaskId: task.id,
        sourceAttemptId: session.attemptId,
      }).slice(0, 32)}`;
      const existing = harness.getStrategySignalWithDb(db, { id: signalId });
      const existingLink = existing
        ? parseResearchEvidenceLinkPayload(existing.id, existing.projectId, existing.payload)
        : null;
      const link: ResearchEvidenceLinkV1 = {
        schemaVersion: 1,
        signalId,
        projectId: action.projectId,
        sourceRunId: run.id,
        sourceTaskId: task.id,
        sourceAttemptId: session.attemptId,
        outputSha256: stableFingerprint(output),
        observedAt,
        linkedAt: existingLink?.linkedAt ?? new Date().toISOString(),
        expiresAt: action.expiresAt,
        eventRefs,
        artifacts: artifactRefs,
        evaluationContractArtifactRef: artifactRefs.find((artifact) => artifact.artifactId === "evaluation-contract") ?? null,
      };
      if (!link.evaluationContractArtifactRef) {
        throw new Error("research evidence must include an identified evaluation-contract artifact");
      }
      const reused = existingLink !== null;
      if (existing) {
        if (!existingLink || stableFingerprint(existingLink) !== stableFingerprint(link)) {
          throw new Error(`research evidence link conflicts with existing signal: ${signalId}`);
        }
      } else {
        harness.createStrategySignalWithDb(db, {
          id: signalId,
          projectId: action.projectId,
          signalClass: "system",
          source: `research-evidence-link:${session.attemptId}`,
          title: "Completed research artifacts available for target design",
          summary: `Read ${artifactRefs.length} immutable research artifact references from completed run ${run.id}.`,
          observationTime: observedAt,
          confidence: 0.9,
          evidence: artifactRefs.map((artifact) => ({
            kind: "research-artifact-ref",
            ref: `${signalId}:${artifact.artifactId}`,
            sha256: artifact.sha256,
            evidenceGrade: artifact.evidenceGrade,
          })),
          expiresAt: action.expiresAt,
          runId: run.id,
          taskId: task.id,
          attemptId: session.attemptId,
          payload: { kind: "research-evidence-link", link },
        });
      }
      const result = doneResult(
        action.type,
        reused ? `Research evidence link ${signalId} reused.` : `Research evidence link ${signalId} created.`,
        [
          { name: "research-only source", status: "passed", evidence: session.attemptId },
          { name: "artifact manifest", status: "passed", evidence: `${artifactRefs.length} immutable references` },
          { name: "project ownership", status: "passed", evidence: action.projectId },
        ],
        [{ kind: "research_evidence_link", signalId, projectId: action.projectId, artifactCount: artifactRefs.length, reused }],
      );
      const eventId = harness.recordHarnessActionEventWithDb(db, {
        actionType: action.type,
        status: result.status,
        request: safeRequest(action),
        result: resultToRecord(result),
      });
      return { ...result, eventId };
    });
  } catch (error) {
    const problem = limitUtf8Output(errorMessage(error), 4_096);
    const result = blockedResult(action.type, `${action.type} blocked: ${problem}`, [problem]);
    const eventId = harness.recordHarnessActionEvent({
      actionType: action.type,
      status: result.status,
      request: safeRequest(action),
      result: resultToRecord(result),
    });
    return { ...result, eventId };
  }
}

type VersionedCorpusManifestAction = Extract<HarnessAction, { type: "buildVersionedCorpusManifest" }>;
type HostEvidenceMaintenanceDeliveryAction = Extract<HarnessAction, { type: "materializeHostEvidenceMaintenanceDelivery" }>;

function applyHostEvidenceMaintenanceDeliveryAtomically(
  harness: Harness,
  action: HostEvidenceMaintenanceDeliveryAction,
): HarnessActionResult & { eventId: string } {
  return harness.runInImmediateTransaction((db) => {
    const request = safeRequest(action);
    const prior = harness.listHarnessActionEventsWithDb(db, {
      actionType: action.type,
      statuses: ["done"],
      limit: 1_000,
    }).find((event) => stableFingerprint(event.request) === stableFingerprint(request));
    if (prior) {
      return { ...(prior.result as unknown as HarnessActionResult), eventId: prior.id };
    }

    let result: HarnessActionResult;
    try {
      const proposal = harness.getDesignProposalWithDb(db, { id: action.proposalId });
      if (!proposal || proposal.status !== "accepted" || !proposal.projectId) {
        throw new Error("host evidence maintenance proposal must be accepted and project-bound");
      }
      const investment = proposal.proposal.investment as Record<string, unknown> | undefined;
      if (investment?.classification !== "evidence-maintenance"
        || investment.oneTimeCost !== 0
        || investment.recurringCost !== 0
        || proposal.proposal.evolutionPack !== undefined
        || proposal.proposal.causalHypothesis !== undefined
        || proposal.proposal.evaluationContract.comparison !== undefined) {
        throw new Error("host evidence maintenance delivery requires a zero-cost receipt-only proposal");
      }
      const decision = harness.listDesignDecisionsWithDb(db, { proposalId: proposal.id })
        .find((candidate) => candidate.id === action.decisionId);
      if (!decision || decision.decision !== "approved") {
        throw new Error("host evidence maintenance delivery requires the named approved decision");
      }
      const sourceRoot = proposal.runId ? harness.getRunWithDb(db, proposal.runId) : null;
      if (!sourceRoot || sourceRoot.projectId !== proposal.projectId || sourceRoot.context.source !== "target-system-design") {
        throw new Error("host evidence maintenance proposal must originate from a target-system-design root");
      }
      const evidenceCandidates = (proposal.proposal.evidenceRefs ?? []).flatMap((signalId) => {
        const signal = harness.getStrategySignalWithDb(db, { id: signalId });
        if (!signal || signal.projectId !== proposal.projectId
          || signal.payload.outcome !== "evidence-defect"
          || signal.payload.defectKind !== "frozen-corpus-unrealizable") return [];
        return [signal];
      });
      if (evidenceCandidates.length !== 1) {
        throw new Error("host evidence maintenance delivery requires exactly one frozen-corpus-unrealizable signal");
      }
      const signal = evidenceCandidates[0]!;
      const frozen = objectRecord(signal.payload.frozenContract, "frozenContract");
      const nextDesign = objectRecord(signal.payload.nextDesign, "nextDesign");
      const sourceProposalId = stringField(frozen, "proposalId");
      const sourceProposal = harness.getDesignProposalWithDb(db, { id: sourceProposalId });
      if (!sourceProposal || sourceProposal.projectId !== proposal.projectId || sourceProposal.status !== "accepted") {
        throw new Error("host evidence maintenance immutable source proposal is invalid");
      }
      const sourceDecision = harness.listDesignDecisionsWithDb(db, { proposalId: sourceProposal.id })
        .find((candidate) => candidate.decision === "approved");
      if (!sourceDecision) throw new Error("host evidence maintenance immutable source decision is missing");
      const sourceVersion = (sourceProposal.proposal.evolutionPack as Record<string, unknown> | undefined)?.version;
      const targetVersion = nextDesign.targetVersion;
      if (!Number.isInteger(sourceVersion) || !Number.isInteger(targetVersion)
        || Number(targetVersion) !== Number(sourceVersion) + 1) {
        throw new Error("host evidence maintenance target version is not the next immutable version");
      }
      const allRuns = harness.listRunsWithDb(db, { limit: 10_000 });
      const immutableSourceRuns = allRuns.filter((candidate) => candidate.projectId === proposal.projectId
        && candidate.context.source === "design"
        && candidate.context.designProposalId === sourceProposal.id
        && candidate.context.designDecisionId === sourceDecision.id
        && candidate.context.retired !== true);
      if (immutableSourceRuns.length !== 1 || immutableSourceRuns[0]!.status !== "blocked") {
        throw new Error("host evidence maintenance requires one blocked immutable source delivery");
      }
      const immutableSourceRun = immutableSourceRuns[0]!;
      if (signal.source !== `blocked-run-outcome:${immutableSourceRun.id}`) {
        throw new Error("host evidence maintenance signal is not bound to the blocked immutable source delivery");
      }
      const activeDeliveries = allRuns.filter((candidate) => candidate.projectId === proposal.projectId
        && candidate.context.source === "design"
        && candidate.context.designProposalId === proposal.id
        && candidate.context.retired !== true);
      const runId = `run_${createHash("sha1").update(`host-evidence-delivery|${proposal.id}`).digest("hex")}`;
      const taskId = `task_${createHash("sha1").update(`host-evidence-task|${proposal.id}`).digest("hex")}`;
      if (activeDeliveries.length > 0 && !activeDeliveries.every((candidate) => candidate.id === runId)) {
        throw new Error("retire the prior evidence-maintenance delivery before materializing its host-action successor");
      }
      const existingRun = harness.getRunWithDb(db, runId);
      const existingTask = existingRun
        ? harness.getRunOverviewWithDb(db, { runId, eventLimit: 0 }).tasks.find((candidate) => candidate.id === taskId) ?? null
        : null;
      const marker = {
        kind: "versioned-corpus-manifest",
        sourceSignalId: signal.id,
        sourceRunId: immutableSourceRun.id,
        sourceProposalId: sourceProposal.id,
        sourceDecisionId: sourceDecision.id,
        targetVersion: Number(targetVersion),
      };
      const inheritedKeys = [
        "modelDefaults",
        "agentDefaults",
        "agentBackends",
        "founderCharterId",
        "designCharterId",
        "controlPlaneRuntime",
        "harnessRevision",
      ] as const;
      const inherited = Object.fromEntries(inheritedKeys.flatMap((key) =>
        sourceRoot.context[key] === undefined ? [] : [[key, sourceRoot.context[key]]]));
      if (!existingRun) {
        harness.createRunWithDb(db, {
          id: runId,
          goal: proposal.recommendation,
          projectId: proposal.projectId,
          context: {
            ...inherited,
            projectId: proposal.projectId,
            parentRunId: sourceRoot.id,
            sourceTaskId: proposal.taskId,
            source: "design",
            designProposalId: proposal.id,
            designDecisionId: decision.id,
            designEvaluationContract: proposal.proposal.evaluationContract,
            designProposal: proposal.proposal,
            designInvestment: proposal.proposal.investment,
            hostEvidenceMaintenance: { state: "pending", marker },
          },
        });
      }
      if (!existingTask) {
        harness.createTaskWithDb(db, {
          id: taskId,
          runId,
          role: "system",
          goal: `Build the host-owned version ${targetVersion} corpus receipt`,
          prompt: [
            "Execute the frozen host evidence-maintenance action through audited harness actions.",
            `Source signal: ${signal.id}`,
            `Immutable source proposal: ${sourceProposal.id}`,
            "Do not start a model executor or disclose holdout references, paths, or bytes.",
          ].join("\n"),
          doneWhen: [
            "one audited versioned corpus manifest receipt exists or the host boundary fails closed",
            "an independent read-only verifier is created only after a successful host receipt",
          ],
          config: { systemTask: true, hostEvidenceMaintenance: marker },
        });
      }
      result = doneResult(action.type, `Host evidence maintenance delivery ${runId} materialized.`, [
        { name: "accepted proposal", status: "passed", evidence: proposal.id },
        { name: "approved decision", status: "passed", evidence: decision.id },
        { name: "blocked immutable source", status: "passed", evidence: immutableSourceRun.id },
        { name: "entry task role", status: "passed", evidence: "system" },
      ], [{
        kind: "host_evidence_maintenance_delivery",
        runId,
        taskId,
        proposalId: proposal.id,
        decisionId: decision.id,
        sourceRunId: immutableSourceRun.id,
        reused: Boolean(existingRun && existingTask),
      }]);
    } catch (error) {
      result = blockedResult(action.type, `Host evidence maintenance delivery blocked: ${errorMessage(error)}`, [errorMessage(error)]);
    }
    const eventId = harness.recordHarnessActionEventWithDb(db, {
      actionType: action.type,
      status: result.status,
      request,
      result: resultToRecord(result),
    });
    return { ...result, eventId };
  });
}

function fixtureEntry(
  harness: Harness,
  projectId: string,
  projectRoot: string,
  ref: string,
  label: string,
  bindings: VersionedCorpusManifestAction["publicFixtureBindings"],
) {
  if (!ref.startsWith("fixture:")) {
    throw new Error(`${label} must use a fixture: reference`);
  }
  const relativePath = ref.slice("fixture:".length);
  if (!relativePath || isAbsolute(relativePath) || relativePath.split(/[\\/]+/).includes("..")) {
    throw new Error(`${label} must resolve inside the target project`);
  }
  const candidate = resolve(projectRoot, relativePath);
  const root = realpathSync(projectRoot);
  if (!existsSync(candidate)) {
    const binding = bindings?.find((entry) => entry.ref === ref);
    if (!binding) {
      throw new Error(`${label} is absent from the target project and has no authoritative attempt binding`);
    }
    const sourceTask = harness.getTask(binding.sourceTaskId);
    const sourceAttempt = harness.getAttempt(binding.sourceAttemptId);
    const sourceRun = sourceTask ? harness.getRun(sourceTask.runId) : null;
    if (!sourceTask || !sourceAttempt || sourceAttempt.taskId !== sourceTask.id
      || sourceAttempt.output.status !== "done" || sourceRun?.projectId !== projectId
      || !sourceTask.worktreePath) {
      throw new Error(`${label} authoritative attempt binding is not a completed target-project task`);
    }
    const artifact = (sourceAttempt.output.artifacts ?? []).find((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
      const record = entry as Record<string, unknown>;
      return record.kind === "file"
        && record.path === binding.relativePath
        && record.sha256 === binding.sha256;
    });
    if (!artifact) {
      throw new Error(`${label} authoritative attempt has no matching file artifact receipt`);
    }
    const worktreeRoot = realpathSync(sourceTask.worktreePath);
    const boundCandidate = resolve(worktreeRoot, binding.relativePath);
    const boundStat = lstatSync(boundCandidate);
    if (!boundStat.isFile() || boundStat.isSymbolicLink() || boundStat.size > 16 * 1024 * 1024) {
      throw new Error(`${label} authoritative attempt binding must be a bounded regular non-symlink file`);
    }
    const boundCanonical = realpathSync(boundCandidate);
    if (boundCanonical !== worktreeRoot && !boundCanonical.startsWith(`${worktreeRoot}${sep}`)) {
      throw new Error(`${label} authoritative attempt binding escapes its source worktree`);
    }
    const bytes = readFileSync(boundCanonical);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== binding.sha256) {
      throw new Error(`${label} authoritative attempt binding hash mismatch`);
    }
    return {
      ref,
      sha256,
      byteLength: bytes.byteLength,
      source: "authoritative-attempt-artifact",
      sourceAttemptId: sourceAttempt.id,
    };
  }
  const stat = lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must reference a regular non-symlink fixture`);
  }
  const canonical = realpathSync(candidate);
  if (canonical !== root && !canonical.startsWith(`${root}${sep}`)) {
    throw new Error(`${label} escapes the target project`);
  }
  if (stat.size > 16 * 1024 * 1024) {
    throw new Error(`${label} exceeds the 16 MiB host manifest limit`);
  }
  const bytes = readFileSync(canonical);
  return {
    ref,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.byteLength,
  };
}

function applyVersionedCorpusManifestAction(
  harness: Harness,
  action: VersionedCorpusManifestAction,
  options: HarnessActionOptions,
): HarnessActionResult & { eventId: string } {
  let result: HarnessActionResult;
  try {
    const run = harness.getRun(action.sourceRunId);
    if (!run || run.projectId !== action.projectId) {
      throw new Error("versioned corpus source run must belong to the explicit target project");
    }
    if (run.status !== "blocked") {
      throw new Error(`versioned corpus source run must be blocked: ${run.status}`);
    }
    const project = harness.getProject(action.projectId);
    if (!project) throw new Error(`target project not found: ${action.projectId}`);
    const proposal = harness.getDesignProposal({ id: action.proposalId });
    if (!proposal || proposal.projectId !== action.projectId || proposal.status !== "accepted") {
      throw new Error("versioned corpus proposal must be accepted and project-bound");
    }
    const decision = harness.listDesignDecisions({ proposalId: proposal.id, limit: 100 })
      .find((candidate) => candidate.id === action.decisionId);
    if (!decision || decision.decision !== "approved") {
      throw new Error("versioned corpus manifest requires the named approved decision");
    }
    if (run.context.designProposalId !== proposal.id || run.context.designDecisionId !== decision.id) {
      throw new Error("versioned corpus source run must freeze the named proposal and decision");
    }
    const pack = proposal.proposal.evolutionPack as Record<string, unknown> | undefined;
    const sourceVersion = pack?.version;
    if (!Number.isInteger(sourceVersion) || Number(sourceVersion) < 1) {
      throw new Error("accepted proposal must record a positive evolutionPack version");
    }
    if (action.targetVersion !== Number(sourceVersion) + 1) {
      throw new Error("targetVersion must be exactly one greater than the accepted proposal version");
    }
    const comparison = parseEvolutionComparison(proposal.proposal.evaluationContract.comparison);
    const developmentRefs = action.developmentFixtureRefs ?? comparison.developmentEvidenceRefs;
    const unrelatedRefs = action.unrelatedFixtureRefs ?? comparison.unrelatedEvidenceRefs;
    const developmentEntries = developmentRefs.map((ref, index) =>
      fixtureEntry(harness, action.projectId, project.rootPath, ref, `developmentEvidenceRefs[${index}]`, action.publicFixtureBindings));
    const unrelatedEntries = unrelatedRefs.map((ref, index) =>
      fixtureEntry(harness, action.projectId, project.rootPath, ref, `unrelatedEvidenceRefs[${index}]`, action.publicFixtureBindings));
    let holdoutEntries: Array<{ sha256: string; byteLength: number }>;
    let descriptorSha256: string | null = null;
    if (options.sealedDescriptorJson) {
      if (options.sealedDescriptorJson.length > 64 * 1024) throw new Error("private holdout descriptor exceeds 64 KiB");
      const descriptor = JSON.parse(options.sealedDescriptorJson) as Record<string, unknown>;
      if (Object.keys(descriptor).join("\0") !== "entries" || !Array.isArray(descriptor.entries) || descriptor.entries.length === 0) {
        throw new Error("private holdout descriptor must contain one non-empty entries array");
      }
      holdoutEntries = descriptor.entries.map((raw, index) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`private holdout entry ${index} is malformed`);
        const entry = raw as Record<string, unknown>;
        if (Object.keys(entry).sort().join("\0") !== "path\0ref" || typeof entry.path !== "string" || typeof entry.ref !== "string") {
          throw new Error(`private holdout entry ${index} must contain only path and ref`);
        }
        if (!isAbsolute(entry.path)) throw new Error(`private holdout entry ${index} path must be absolute`);
        const stat = lstatSync(entry.path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) {
          throw new Error(`private holdout entry ${index} must be a bounded regular non-symlink file`);
        }
        const bytes = readFileSync(realpathSync(entry.path));
        return { sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.byteLength };
      });
      descriptorSha256 = createHash("sha256").update(options.sealedDescriptorJson).digest("hex");
    } else {
      holdoutEntries = comparison.holdoutEvidenceRefs.map((ref, index) => {
        const entry = fixtureEntry(harness, action.projectId, project.rootPath, ref, `holdoutEvidenceRefs[${index}]`, undefined);
        return { sha256: entry.sha256, byteLength: entry.byteLength };
      });
    }
    const holdoutCommitmentSha256 = canonicalEvolutionValueSha256(holdoutEntries);
    const manifestBody = {
      schemaVersion: 1,
      projectId: action.projectId,
      sourceVersion: Number(sourceVersion),
      targetVersion: action.targetVersion,
      developmentEntries,
      unrelatedEntries,
      holdout: { count: holdoutEntries.length, commitmentSha256: holdoutCommitmentSha256 },
    };
    const corpusSnapshotSha256 = canonicalEvolutionValueSha256(manifestBody);
    const successorComparison: EvolutionComparison = {
      ...comparison,
      developmentEvidenceRefs: developmentEntries.map((entry) => entry.ref),
      holdoutEvidenceRefs: [`commitment:holdout-v${action.targetVersion}:${holdoutCommitmentSha256}`],
      unrelatedEvidenceRefs: unrelatedEntries.map((entry) => entry.ref),
      corpusSnapshotSha256,
    };
    const artifact = {
      kind: "versioned_corpus_manifest_receipt",
      projectId: action.projectId,
      sourceRunId: action.sourceRunId,
      proposalId: proposal.id,
      decisionId: decision.id,
      sourceVersion: Number(sourceVersion),
      targetVersion: action.targetVersion,
      sourceComparisonSha256: canonicalEvolutionValueSha256(comparison),
      manifestSha256: corpusSnapshotSha256,
      developmentEntries,
      unrelatedEntries,
      holdout: manifestBody.holdout,
      descriptorSource: options.sealedDescriptorJson ? "ephemeral-host-input" : "approved-proposal-comparison",
      descriptorSha256,
      comparison: successorComparison,
      comparisonSha256: canonicalEvolutionValueSha256(successorComparison),
      noHoldoutDisclosure: true,
      sideEffectCounters: zeroSideEffectCounters(),
    };
    result = doneResult(action.type, `Host-owned version ${action.targetVersion} corpus manifest receipt created.`, [
      { name: "approved source comparison", status: "passed", evidence: artifact.sourceComparisonSha256 },
      { name: "public fixture manifest", status: "passed", evidence: artifact.manifestSha256 },
      { name: "private holdout disclosure", status: "passed", evidence: "count-and-commitment-only" },
      { name: "side effects", status: "passed", evidence: "all zero" },
    ], [artifact]);
  } catch (error) {
    result = blockedResult(action.type, `Versioned corpus manifest blocked: ${errorMessage(error)}`, [errorMessage(error)]);
  }
  if (result.status === "done") {
    const request = safeRequest(action);
    const prior = harness.listHarnessActionEvents({ limit: 1_000 })
      .find((event) => event.status === "done" && event.actionType === action.type
        && stableFingerprint(event.request) === stableFingerprint(request));
    if (prior) {
      if (stableFingerprint(prior.result) === stableFingerprint(resultToRecord(result))) {
        return { ...result, eventId: prior.id };
      }
      result = blockedResult(
        action.type,
        "Versioned corpus manifest blocked because the same frozen request now resolves to different bytes.",
        ["versioned corpus manifest replay drift"],
      );
    }
  }
  const eventId = harness.recordHarnessActionEvent({
    actionType: action.type,
    status: result.status,
    request: safeRequest(action),
    result: resultToRecord(result),
  });
  return { ...result, eventId };
}

function hasPassedResearchCheck(checks: unknown[] | undefined, name: string) {
  return Array.isArray(checks) && checks.some((check) => {
    const record = objectRecordOrNull(check);
    return record?.name === name && (record.result === "pass" || record.status === "passed");
  });
}

function researchArtifactId(value: unknown) {
  const record = objectRecordOrNull(value);
  return typeof record?.id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(record.id)
    ? record.id
    : null;
}

function durableResearchEventRefs(value: unknown) {
  const record = objectRecordOrNull(value);
  const refs = Array.isArray(record?.durableEventRefs) ? record.durableEventRefs : [];
  if (!refs.every((ref) => typeof ref === "string" && /^event_[A-Za-z0-9._-]+$/.test(ref))) return [];
  return (refs as string[]).filter((ref, index, all) => all.indexOf(ref) === index);
}

function normalizedEvidenceTimestamp(value: string | null) {
  if (!value) throw new Error("research source attempt has no finished timestamp");
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const timestamp = new Date(normalized);
  if (!Number.isFinite(timestamp.valueOf())) throw new Error("research source attempt finished timestamp is invalid");
  return timestamp.toISOString();
}

function objectRecordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function equalStringLists(value: unknown, expected: string[]) {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((item, index) => item === expected[index]);
}

function materializeDesignerActionRecoveryWithDb(
  harness: Harness,
  db: HarnessDatabase,
  action: DesignerActionRecoveryAction,
): HarnessActionResult {
  const overview = harness.getRunOverviewWithDb(db, { runId: action.runId, eventLimit: 0 });
  const run = overview.run;
  if (!run) {
    throw new Error(`run not found: ${action.runId}`);
  }
  if (run.context.source !== "target-system-design" || run.context.retired === true) {
    throw new Error(`Designer action recovery requires an active target-system-design root: ${action.runId}`);
  }
  const sourceTask = overview.tasks.find((task) => task.id === action.sourceTaskId);
  if (!sourceTask || sourceTask.runId !== run.id || sourceTask.role !== "designer" || sourceTask.status !== "blocked") {
    throw new Error(`source task must be a blocked Designer in ${run.id}: ${action.sourceTaskId}`);
  }
  const sourceAttempts = overview.sessions.filter((session) => session.taskId === sourceTask.id);
  const sourceAttempt = sourceAttempts.find((session) => session.attemptId === action.sourceAttemptId);
  if (
    !sourceAttempt
    || sourceAttempt.status !== "blocked"
    || sourceAttempts.at(-1)?.attemptId !== sourceAttempt.attemptId
  ) {
    throw new Error(`source attempt must be the latest blocked attempt for ${sourceTask.id}: ${action.sourceAttemptId}`);
  }
  const validationProblem = [...(sourceAttempt.output.problems ?? [])]
    .reverse()
    .find((problem): problem is string =>
      typeof problem === "string" && /agent output action \d+ .*payload\./i.test(problem)
    );
  if (!validationProblem || (sourceAttempt.output.changedFiles ?? []).length > 0) {
    throw new Error(`source attempt is not an implementation-free fixed design action validation failure: ${sourceAttempt.attemptId}`);
  }

  const sourceRecovery = sourceTask.config?.designActionRecovery;
  const rootTaskId = sourceRecovery && typeof sourceRecovery === "object" && !Array.isArray(sourceRecovery)
    && typeof (sourceRecovery as Record<string, unknown>).rootTaskId === "string"
    ? String((sourceRecovery as Record<string, unknown>).rootTaskId)
    : sourceTask.id;
  const sourceRecoveryCount = sourceRecovery && typeof sourceRecovery === "object" && !Array.isArray(sourceRecovery)
    && Number.isInteger((sourceRecovery as Record<string, unknown>).count)
    ? Number((sourceRecovery as Record<string, unknown>).count)
    : 0;
  const existing = overview.tasks.filter((task) => {
    const recovery = task.config?.designActionRecovery;
    return recovery && typeof recovery === "object" && !Array.isArray(recovery)
      && (recovery as Record<string, unknown>).rootTaskId === rootTaskId;
  });
  if (existing.length > 1) {
    throw new Error(`multiple Designer action recoveries already exist for ${rootTaskId}`);
  }
  if (existing.length === 1) {
    const recoveryTask = existing[0]!;
    const recovery = recoveryTask.config!.designActionRecovery as Record<string, unknown>;
    const exact = recoveryTask.role === "designer"
      && recoveryTask.parentId === sourceTask.id
      && recoveryTask.goal === sourceTask.goal
      && recoveryTask.prompt === sourceTask.prompt
      && sameCanonicalValue(recoveryTask.doneWhen, sourceTask.doneWhen)
      && recovery.sourceTaskId === sourceTask.id
      && recovery.sourceAttemptId === sourceAttempt.attemptId
      && recovery.count === 1
      && recovery.limit === 1
      && recoveryTask.config?.forbidImplementation === true
      && recoveryTask.config?.forbidBrowser === true
      && recoveryTask.config?.browserProcessPolicy === "deny"
      && recoveryTask.config?.readOnly === true;
    if (!exact) {
      throw new Error(`existing Designer action recovery conflicts with ${sourceTask.id}`);
    }
    return doneResult(action.type, `Designer action recovery ${recoveryTask.id} reused.`, [
      { name: "source Designer", status: "passed", evidence: sourceTask.id },
      { name: "source fixed-action failure", status: "passed", evidence: sourceAttempt.attemptId },
      { name: "bounded recovery", status: "passed", evidence: "1/1 reused" },
      { name: "repair budget", status: "passed", evidence: "not charged" },
    ], [{
      kind: "reused_designer_recovery",
      taskId: recoveryTask.id,
      runId: run.id,
      sourceTaskId: sourceTask.id,
      sourceAttemptId: sourceAttempt.attemptId,
      status: recoveryTask.status,
    }]);
  }
  if (sourceRecoveryCount >= 1) {
    throw new Error(`bounded Designer fixed-action recovery exhausted at 1/1 for ${rootTaskId}`);
  }

  const recoveryTaskId = makeId("task");
  harness.createTaskWithDb(db, {
    id: recoveryTaskId,
    runId: run.id,
    parentId: sourceTask.id,
    cycleId: sourceTask.cycleId,
    role: "designer",
    goal: sourceTask.goal,
    prompt: sourceTask.prompt,
    dependsOn: sourceTask.dependsOn,
    doneWhen: sourceTask.doneWhen,
    worktreePath: null,
    config: {
      ...(sourceTask.config ?? {}),
      ...(sourceTask.worktreePath ? { sourceWorktreePath: sourceTask.worktreePath } : {}),
      forbidImplementation: true,
      forbidBrowser: true,
      browserProcessPolicy: "deny",
      readOnly: true,
      designActionRecovery: {
        rootTaskId,
        sourceTaskId: sourceTask.id,
        sourceAttemptId: sourceAttempt.attemptId,
        count: 1,
        limit: 1,
      },
    },
  });
  return doneResult(action.type, `Designer action recovery ${recoveryTaskId} created.`, [
    { name: "source Designer", status: "passed", evidence: sourceTask.id },
    { name: "source fixed-action failure", status: "passed", evidence: sourceAttempt.attemptId },
    { name: "bounded recovery", status: "passed", evidence: "1/1 created" },
    { name: "read-only execution", status: "passed", evidence: "browser and implementation forbidden" },
    { name: "repair budget", status: "passed", evidence: "not charged" },
  ], [{
    kind: "created_designer_recovery",
    taskId: recoveryTaskId,
    runId: run.id,
    sourceTaskId: sourceTask.id,
    sourceAttemptId: sourceAttempt.attemptId,
    status: "todo",
  }]);
}

function materializeDesignDeliveryRecoveryWithDb(
  harness: Harness,
  db: HarnessDatabase,
  action: DesignDeliveryRecoveryAction,
): HarnessActionResult {
  const overview = harness.getRunOverviewWithDb(db, { runId: action.runId, eventLimit: 0 });
  const run = overview.run;
  if (!run) throw new Error(`run not found: ${action.runId}`);
  if (run.context.source !== "design" || run.context.retired === true) {
    throw new Error(`design delivery recovery requires an active design child: ${action.runId}`);
  }
  const proposalId = typeof run.context.designProposalId === "string" ? run.context.designProposalId : "";
  const decisionId = typeof run.context.designDecisionId === "string" ? run.context.designDecisionId : "";
  const parentRunId = typeof run.context.parentRunId === "string" ? run.context.parentRunId : "";
  const deliveryPlan = objectRecordOrNull(run.context.designDeliveryPlan);
  const planPlanner = objectRecordOrNull(deliveryPlan?.planner);
  const evaluationContract = objectRecordOrNull(run.context.designEvaluationContract);
  if (
    deliveryPlan?.schemaVersion !== 1
    || typeof deliveryPlan.runGoal !== "string"
    || !planPlanner
    || typeof planPlanner.goal !== "string"
    || typeof planPlanner.prompt !== "string"
    || !Array.isArray(planPlanner.doneWhen)
    || planPlanner.doneWhen.some((entry) => typeof entry !== "string")
    || !proposalId
    || !decisionId
    || !parentRunId
    || !evaluationContract
  ) {
    throw new Error(`design child ${run.id} is missing its frozen delivery or evaluation contract`);
  }
  const authority = db.query(
    `
    select design_proposals.id
    from design_proposals
    join design_decisions on design_decisions.proposal_id = design_proposals.id
    where design_proposals.id = $proposalId
      and design_proposals.run_id = $parentRunId
      and design_proposals.project_id is $projectId
      and design_proposals.status = 'accepted'
      and design_decisions.id = $decisionId
      and design_decisions.decision = 'approved'
    limit 1
    `,
  ).get({
    $proposalId: proposalId,
    $parentRunId: parentRunId,
    $projectId: run.projectId,
    $decisionId: decisionId,
  }) as { id: string } | null;
  if (!authority) {
    throw new Error(`design child ${run.id} is not bound to an accepted proposal and approved authority decision`);
  }

  const canonicalPlannerCandidates = overview.tasks.filter((task) =>
    task.role === "planner"
    && task.goal === planPlanner.goal
    && task.prompt === planPlanner.prompt
    && sameCanonicalValue(task.doneWhen, planPlanner.doneWhen)
    && !task.config?.goalReviewContinuation
    && !task.config?.designDeliveryRecovery
  );
  if (canonicalPlannerCandidates.length !== 1) {
    throw new Error(`design child ${run.id} has ${canonicalPlannerCandidates.length} canonical frozen Planner tasks; expected exactly one`);
  }
  const canonicalPlanner = canonicalPlannerCandidates[0]!;
  const sourcePlanner = overview.tasks.find((task) => task.id === action.sourcePlannerTaskId);
  if (!sourcePlanner || sourcePlanner.runId !== run.id || sourcePlanner.role !== "planner" || sourcePlanner.status !== "done") {
    throw new Error(`source Planner must be done in ${run.id}: ${action.sourcePlannerTaskId}`);
  }
  const sourceAttempt = overview.sessions.filter((session) => session.taskId === sourcePlanner.id).at(-1);
  if (!sourceAttempt || sourceAttempt.status !== "done") {
    throw new Error(`source Planner ${sourcePlanner.id} has no terminal done attempt`);
  }
  const nextTasks = Array.isArray(sourceAttempt.output.nextTasks) ? sourceAttempt.output.nextTasks : [];
  if (nextTasks.length !== 1) {
    throw new Error(`source Planner ${sourcePlanner.id} must freeze exactly one Worker task`);
  }
  const workerPlan = objectRecordOrNull(nextTasks[0]);
  if (
    workerPlan?.role !== "worker"
    || typeof workerPlan.goal !== "string"
    || workerPlan.goal.trim().length === 0
    || typeof workerPlan.prompt !== "string"
    || workerPlan.prompt.trim().length === 0
    || (workerPlan.doneWhen !== undefined
      && (!Array.isArray(workerPlan.doneWhen) || workerPlan.doneWhen.some((entry) => typeof entry !== "string")))
  ) {
    throw new Error(`source Planner ${sourcePlanner.id} did not produce a valid frozen Worker plan`);
  }

  const recoveryKey = stableFingerprint({
    runId: run.id,
    proposalId,
    decisionId,
    canonicalPlannerTaskId: canonicalPlanner.id,
    sourcePlannerTaskId: sourcePlanner.id,
    workerPlan,
    evaluationContract,
  });
  const existingRecovery = overview.tasks.filter((task) => {
    const marker = objectRecordOrNull(task.config?.designDeliveryRecovery);
    return marker?.recoveryKey === recoveryKey;
  });
  if (existingRecovery.length > 0) {
    const planner = existingRecovery.find((task) => task.role === "planner");
    const worker = existingRecovery.find((task) => task.role === "worker");
    const verifier = existingRecovery.find((task) => task.role === "verifier");
    if (
      existingRecovery.length !== 3
      || !planner || !worker || !verifier
      || !sameCanonicalValue(worker.dependsOn, [planner.id])
      || !sameCanonicalValue(verifier.dependsOn, [worker.id])
    ) {
      throw new Error(`existing design delivery recovery conflicts with ${recoveryKey}`);
    }
    return doneResult(action.type, `Design delivery recovery ${recoveryKey} reused.`, [
      { name: "frozen Planner", status: "passed", evidence: canonicalPlanner.id },
      { name: "bounded recovery graph", status: "passed", evidence: "reused" },
      { name: "repair budget", status: "passed", evidence: "not charged" },
    ], [{
      kind: "design_delivery_recovery",
      runId: run.id,
      plannerTaskId: planner.id,
      workerTaskId: worker.id,
      verifierTaskId: verifier.id,
      supersededTaskIds: supersededDesignDeliveryTaskIds(overview.tasks, sourcePlanner.id),
      recoveryKey,
      reused: true,
    }]);
  }

  const activeTasks = overview.tasks.filter((task) => task.status === "todo" || task.status === "running");
  if (activeTasks.length > 0) {
    throw new Error(`design child ${run.id} still has active tasks: ${activeTasks.map((task) => task.id).join(", ")}`);
  }

  const verifierContract = {
    schemaVersion: 1,
    source: "frozen-design-evaluation-contract",
    designProposalId: proposalId,
    designDecisionId: decisionId,
    evaluationContract,
    evaluationContractSha256: stableFingerprint(evaluationContract),
  };
  const verifierContractSha256 = stableFingerprint(verifierContract);
  const agentDefaults = objectRecordOrNull(run.context.agentDefaults);
  const roleDefaults = objectRecordOrNull(agentDefaults?.roles);
  const workerBackend = typeof roleDefaults?.worker === "string" ? roleDefaults.worker : "";
  const agentBackends = objectRecordOrNull(run.context.agentBackends);
  const workerBackendConfig = objectRecordOrNull(agentBackends?.[workerBackend]);
  if (!workerBackend || workerBackendConfig?.kind !== "dsh-cli") {
    throw new Error(`design child ${run.id} must freeze its Worker to a configured dsh-cli backend before recovery`);
  }
  const marker = {
    schemaVersion: 1,
    recoveryKey,
    canonicalPlannerTaskId: canonicalPlanner.id,
    sourcePlannerTaskId: sourcePlanner.id,
    sourcePlannerAttemptId: sourceAttempt.attemptId,
    designProposalId: proposalId,
    designDecisionId: decisionId,
    verifierContractSha256,
    worktreeMode: "isolated-task",
    reason: action.reason ?? "recover the frozen design delivery graph once",
  };
  const plannerTaskId = makeId("task");
  const workerTaskId = makeId("task");
  const verifierTaskId = makeId("task");
  harness.createTaskWithDb(db, {
    id: plannerTaskId,
    runId: run.id,
    parentId: sourcePlanner.id,
    cycleId: sourcePlanner.cycleId,
    role: "planner",
    goal: `Confirm recovered frozen plan: ${workerPlan.goal}`,
    prompt: [
      "Confirm the host-materialized recovery graph matches the already approved design.",
      `Canonical Planner: ${canonicalPlanner.id}`,
      `Source Planner: ${sourcePlanner.id}`,
      `Frozen Worker: ${workerTaskId}`,
      `Independent Verifier: ${verifierTaskId}`,
      "Do not create nextTasks, change the frozen verifier contract, implement files, or use a browser.",
      "Return a terminal read-only confirmation only.",
    ].join("\n"),
    dependsOn: [sourcePlanner.id],
    doneWhen: [
      "the host-materialized Worker and Verifier dependencies match the frozen graph",
      "no nextTasks, nextRuns, or design actions are emitted",
    ],
    worktreePath: null,
    config: {
      agentBackend: "codex-resumable",
      permissionMode: "read-only",
      readOnly: true,
      forbidImplementation: true,
      forbidBrowser: true,
      browserProcessPolicy: "deny",
      verifierContract,
      frozenDesignPlanner: marker,
      designDeliveryRecovery: marker,
    },
  });
  harness.createTaskWithDb(db, {
    id: workerTaskId,
    runId: run.id,
    parentId: plannerTaskId,
    cycleId: sourcePlanner.cycleId,
    role: "worker",
    goal: workerPlan.goal,
    prompt: workerPlan.prompt,
    dependsOn: [plannerTaskId],
    doneWhen: Array.isArray(workerPlan.doneWhen) ? workerPlan.doneWhen as string[] : [],
    worktreePath: null,
    config: {
      agentBackend: workerBackend,
      permissionMode: "workspace-write",
      dshProfileIsolation: "base-headless",
      dshRequiredPlugins: [],
      forbidBrowser: true,
      browserProcessPolicy: "deny",
      verifierContract,
      frozenDesignPlanner: marker,
      designDeliveryRecovery: marker,
    },
  });
  harness.createTaskWithDb(db, {
    id: verifierTaskId,
    runId: run.id,
    parentId: workerTaskId,
    cycleId: sourcePlanner.cycleId,
    role: "verifier",
    goal: `Independently verify: ${workerPlan.goal}`,
    prompt: [
      "Verify the completed Worker against the exact frozen verifier contract in task config.",
      `Worker task: ${workerTaskId}`,
      "Use read-only evidence and report blockers without implementing repairs.",
    ].join("\n"),
    dependsOn: [workerTaskId],
    doneWhen: [
      "the latest Worker lineage is independently checked against every frozen criterion",
      "all evidence is cited or the Verifier fails closed",
    ],
    worktreePath: null,
    config: {
      agentBackend: "codex-resumable",
      permissionMode: "read-only",
      readOnly: true,
      forbidImplementation: true,
      forbidBrowser: true,
      browserProcessPolicy: "deny",
      verifierContract,
      sourceTaskId: workerTaskId,
      frozenDesignPlanner: marker,
      designDeliveryRecovery: marker,
    },
  });
  harness.updateRunWithDb(db, {
    runId: run.id,
    status: "todo",
    contextPatch: {
      designDeliveryRecovery: {
        ...marker,
        plannerTaskId,
        workerTaskId,
        verifierTaskId,
      },
    },
  });
  return doneResult(action.type, `Design delivery recovery ${recoveryKey} materialized.`, [
    { name: "accepted design authority", status: "passed", evidence: `${proposalId}:${decisionId}` },
    { name: "frozen Planner", status: "passed", evidence: canonicalPlanner.id },
    { name: "DSH isolation", status: "passed", evidence: "base-headless; network deny; zero target credentials" },
    { name: "independent Verifier dependency", status: "passed", evidence: `${verifierTaskId}->${workerTaskId}` },
    { name: "repair budget", status: "passed", evidence: "not charged" },
  ], [{
    kind: "design_delivery_recovery",
    runId: run.id,
    plannerTaskId,
    workerTaskId,
    verifierTaskId,
    supersededTaskIds: supersededDesignDeliveryTaskIds(overview.tasks, sourcePlanner.id),
    recoveryKey,
    reused: false,
  }]);
}

function supersededDesignDeliveryTaskIds(tasks: Task[], sourcePlannerTaskId: string) {
  return tasks
    .filter((task) => task.id !== sourcePlannerTaskId
      && (task.role === "worker" || task.role === "verifier")
      && task.status === "blocked")
    .map((task) => task.id)
    .sort();
}

function materializeDesignWorkerRuntimeRecoveryWithDb(
  harness: Harness,
  db: HarnessDatabase,
  action: DesignWorkerRuntimeRecoveryAction,
): HarnessActionResult {
  const overview = harness.getRunOverviewWithDb(db, { runId: action.runId, eventLimit: 0 });
  const run = overview.run;
  if (!run || run.context.source !== "design" || run.context.retired === true) {
    throw new Error(`design Worker runtime recovery requires an active design child: ${action.runId}`);
  }
  const sourceWorker = overview.tasks.find((task) => task.id === action.sourceWorkerTaskId);
  if (!sourceWorker || sourceWorker.role !== "worker" || sourceWorker.status !== "blocked") {
    throw new Error(`source DSH Worker must be blocked in ${run.id}: ${action.sourceWorkerTaskId}`);
  }
  if (sourceWorker.config?.agentBackend !== "deepseek-harness" || sourceWorker.config?.permissionMode !== "workspace-write") {
    throw new Error(`source Worker ${sourceWorker.id} is not a frozen workspace-write DSH task`);
  }
  const sourceAttempt = overview.sessions.filter((session) => session.taskId === sourceWorker.id).at(-1);
  if (!sourceAttempt || sourceAttempt.status !== "blocked") {
    throw new Error(`source Worker ${sourceWorker.id} has no blocked terminal attempt`);
  }
  const persistedAttempt = harness.getAttemptWithDb(db, sourceAttempt.attemptId);
  const attemptInput = objectRecordOrNull(persistedAttempt?.input);
  const permissionReceipt = sourceAttempt.output.artifacts?.find((artifact) =>
    objectRecordOrNull(artifact)?.kind === "dsh_execution_profile_receipt"
  );
  const receiptPermission = objectRecordOrNull(permissionReceipt)?.permissionMode;
  if (attemptInput?.permissionMode === "workspace-write" && receiptPermission === "workspace-write") {
    throw new Error(`source Worker ${sourceWorker.id} did not fail from the frozen permission-route mismatch`);
  }
  if (sourceWorker.dependsOn.length !== 1) {
    throw new Error(`source Worker ${sourceWorker.id} must depend on exactly one frozen Planner`);
  }
  const planner = overview.tasks.find((task) => task.id === sourceWorker.dependsOn[0]);
  if (!planner || planner.role !== "planner" || planner.status !== "done" || !planner.config?.frozenDesignPlanner) {
    throw new Error(`source Worker ${sourceWorker.id} is not downstream of one done frozen Planner`);
  }
  const sourceVerifier = overview.tasks.find((task) =>
    task.role === "verifier" && sameCanonicalValue(task.dependsOn, [sourceWorker.id])
  );
  if (!sourceVerifier || sourceVerifier.status !== "blocked") {
    throw new Error(`source Worker ${sourceWorker.id} has no blocked independent Verifier descendant`);
  }
  const proposalId = typeof run.context.designProposalId === "string" ? run.context.designProposalId : "";
  const storedProposal = proposalId ? harness.getDesignProposalWithDb(db, { id: proposalId }) : null;
  const storedPack = objectRecordOrNull(storedProposal?.proposal.evolutionPack);
  const rawSurfaces = Array.isArray(storedPack?.mutationSurfaces) ? storedPack.mutationSurfaces : [];
  const surfaces = rawSurfaces.map((surface) => objectRecordOrNull(surface)).filter((surface): surface is Record<string, unknown> => Boolean(surface));
  const allowedPaths = [...new Set(surfaces.flatMap((surface) =>
    Array.isArray(surface.allowedPaths) ? surface.allowedPaths.filter((path): path is string => typeof path === "string") : []
  ))].sort();
  const forbiddenPaths = [...new Set([
    ...surfaces.flatMap((surface) =>
      Array.isArray(surface.forbiddenPaths) ? surface.forbiddenPaths.filter((path): path is string => typeof path === "string") : []
    ),
    ".git/orbs/**",
    ".ouroboros/**",
    ".orbs/**",
  ])].sort();
  if (!sameCanonicalValue(allowedPaths, ["config/evolution/**", "tests/evolution/**"])) {
    throw new Error(`design Worker runtime recovery requires the exact frozen config/evolution/** and tests/evolution/** surfaces`);
  }
  const offlineTestPaths = allowedPaths.filter((path) => path.startsWith("tests/evolution/"));
  if (offlineTestPaths.length === 0) throw new Error("design Worker runtime recovery requires a frozen offline evolution test surface");
  const worktreePath = sourceWorker.worktreePath
    ?? (typeof attemptInput?.cwd === "string" ? attemptInput.cwd : null)
    ?? (typeof sourceWorker.config?.sourceWorktreePath === "string" ? sourceWorker.config.sourceWorktreePath : null);
  if (!worktreePath) throw new Error(`source Worker ${sourceWorker.id} has no frozen worktree path`);

  const recoveryKey = stableFingerprint({
    runId: run.id,
    sourceWorkerTaskId: sourceWorker.id,
    sourceWorkerAttemptId: sourceAttempt.attemptId,
    plannerTaskId: planner.id,
    verifierTaskId: sourceVerifier.id,
    allowedPaths,
    forbiddenPaths,
  });
  const existing = overview.tasks.filter((task) => objectRecordOrNull(task.config?.designWorkerRuntimeRecovery)?.recoveryKey === recoveryKey);
  if (existing.length > 0) {
    const worker = existing.find((task) => task.role === "worker");
    const verifier = existing.find((task) => task.role === "verifier");
    if (existing.length !== 2 || !worker || !verifier || !sameCanonicalValue(verifier.dependsOn, [worker.id])) {
      throw new Error(`existing design Worker runtime recovery conflicts with ${recoveryKey}`);
    }
    return doneResult(action.type, `Design Worker runtime recovery ${recoveryKey} reused.`, [
      { name: "bounded runtime recovery", status: "passed", evidence: "reused" },
      { name: "repair budget", status: "passed", evidence: "not charged" },
    ], [{
      kind: "design_worker_runtime_recovery",
      runId: run.id,
      sourceWorkerTaskId: sourceWorker.id,
      sourceWorkerAttemptId: sourceAttempt.attemptId,
      workerTaskId: worker.id,
      verifierTaskId: verifier.id,
      recoveryKey,
      reused: true,
    }]);
  }
  const priorRuntimeRecoveries = overview.tasks.filter((task) => task.config?.designWorkerRuntimeRecovery !== undefined);
  if (sourceWorker.config?.designWorkerRuntimeRecovery !== undefined || priorRuntimeRecoveries.length > 0) {
    throw new Error(`design child ${run.id} already used its one bounded DSH runtime recovery`);
  }
  const activeTasks = overview.tasks.filter((task) => task.status === "todo" || task.status === "running");
  if (activeTasks.length > 0) {
    throw new Error(`design child ${run.id} still has active tasks: ${activeTasks.map((task) => task.id).join(", ")}`);
  }

  const marker = {
    schemaVersion: 1,
    recoveryKey,
    sourceWorkerTaskId: sourceWorker.id,
    sourceWorkerAttemptId: sourceAttempt.attemptId,
    sourceVerifierTaskId: sourceVerifier.id,
    plannerTaskId: planner.id,
    maxRecoveries: 1,
    reason: action.reason ?? "recover one frozen DSH runtime permission mismatch",
  };
  const filePolicy = {
    schemaVersion: 1,
    source: "frozen-design-mutation-surfaces",
    allowedPaths,
    forbiddenPaths,
  };
  const offlineTestPolicy = {
    mode: "allowlist",
    allowedPaths: offlineTestPaths,
    forbidTargetBusinessTests: true,
  };
  const workerTaskId = makeId("task");
  const verifierTaskId = makeId("task");
  harness.createTaskWithDb(db, {
    id: workerTaskId,
    runId: run.id,
    parentId: sourceWorker.id,
    cycleId: sourceWorker.cycleId,
    role: "worker",
    goal: sourceWorker.goal,
    prompt: sourceWorker.prompt,
    dependsOn: [planner.id],
    doneWhen: sourceWorker.doneWhen,
    worktreePath: null,
    config: {
      ...sourceWorker.config,
      permissionMode: "workspace-write",
      dshProfileIsolation: "base-headless",
      dshRequiredPlugins: [],
      forbidBrowser: true,
      browserProcessPolicy: "deny",
      sourceWorktreePath: worktreePath,
      dshFilePolicy: filePolicy,
      offlineTestPolicy,
      designWorkerRuntimeRecovery: marker,
    },
  });
  harness.createTaskWithDb(db, {
    id: verifierTaskId,
    runId: run.id,
    parentId: workerTaskId,
    cycleId: sourceWorker.cycleId,
    role: "verifier",
    goal: sourceVerifier.goal,
    prompt: [
      sourceVerifier.prompt,
      "Only execute offline checks whose paths match tests/evolution/**.",
      "Do not run the target project's complete test suite, typecheck, browser checks, or unrelated source inspection.",
    ].join("\n"),
    dependsOn: [workerTaskId],
    doneWhen: sourceVerifier.doneWhen,
    worktreePath: null,
    config: {
      ...sourceVerifier.config,
      permissionMode: "read-only",
      readOnly: true,
      forbidImplementation: true,
      forbidBrowser: true,
      browserProcessPolicy: "deny",
      sourceTaskId: workerTaskId,
      sourceWorktreePath: worktreePath,
      offlineTestPolicy,
      designWorkerRuntimeRecovery: marker,
    },
  });
  harness.updateRunWithDb(db, {
    runId: run.id,
    status: "todo",
    contextPatch: { designWorkerRuntimeRecovery: { ...marker, workerTaskId, verifierTaskId } },
  });
  return doneResult(action.type, `Design Worker runtime recovery ${recoveryKey} materialized.`, [
    { name: "task permission route", status: "passed", evidence: "worker=workspace-write; verifier=read-only" },
    { name: "frozen write paths", status: "passed", evidence: allowedPaths.join(",") },
    { name: "offline test gate", status: "passed", evidence: offlineTestPaths.join(",") },
    { name: "repair budget", status: "passed", evidence: "not charged" },
  ], [{
    kind: "design_worker_runtime_recovery",
    runId: run.id,
    sourceWorkerTaskId: sourceWorker.id,
    sourceWorkerAttemptId: sourceAttempt.attemptId,
    workerTaskId,
    verifierTaskId,
    recoveryKey,
    reused: false,
  }]);
}

function materializeDesignWorkerTransportRecoveryWithDb(
  harness: Harness,
  db: HarnessDatabase,
  action: DesignWorkerTransportRecoveryAction,
): HarnessActionResult {
  const overview = harness.getRunOverviewWithDb(db, { runId: action.runId, eventLimit: 0 });
  const run = overview.run;
  if (!run || run.context.source !== "design" || run.context.retired === true) {
    throw new Error(`design Worker transport recovery requires an active design child: ${action.runId}`);
  }
  const sourceWorker = overview.tasks.find((task) => task.id === action.sourceWorkerTaskId);
  if (!sourceWorker || sourceWorker.role !== "worker" || sourceWorker.status !== "blocked") {
    throw new Error(`source DSH Worker must be blocked in ${run.id}: ${action.sourceWorkerTaskId}`);
  }
  if (sourceWorker.config?.agentBackend !== "deepseek-harness" || sourceWorker.config?.permissionMode !== "workspace-write") {
    throw new Error(`source Worker ${sourceWorker.id} is not a frozen workspace-write DSH task`);
  }
  const sourceAttempt = overview.sessions.filter((session) => session.taskId === sourceWorker.id).at(-1);
  if (!sourceAttempt || sourceAttempt.status !== "blocked") {
    throw new Error(`source Worker ${sourceWorker.id} has no blocked terminal attempt`);
  }
  const permissionReceipt = sourceAttempt.output.artifacts?.find((artifact) =>
    objectRecordOrNull(artifact)?.kind === "dsh_execution_profile_receipt"
  );
  const receipt = objectRecordOrNull(permissionReceipt);
  const legacyNetwork = objectRecordOrNull(receipt?.network);
  if (receipt?.permissionMode !== "workspace-write"
    || legacyNetwork?.mode !== "deny"
    || legacyNetwork.enforcement !== "darwin-host-seatbelt") {
    throw new Error(`source Worker ${sourceWorker.id} lacks the whole-process DSH network denial receipt`);
  }
  const diagnostic = [sourceAttempt.output.summary, ...(sourceAttempt.output.problems ?? [])].join("\n");
  if (!/TRANSPORT|DeepSeek API request/i.test(diagnostic)) {
    throw new Error(`source Worker ${sourceWorker.id} did not fail at the DeepSeek model transport boundary`);
  }
  if (sourceWorker.dependsOn.length !== 1) {
    throw new Error(`source Worker ${sourceWorker.id} must depend on exactly one frozen Planner`);
  }
  const planner = overview.tasks.find((task) => task.id === sourceWorker.dependsOn[0]);
  if (!planner || planner.role !== "planner" || planner.status !== "done" || !planner.config?.frozenDesignPlanner) {
    throw new Error(`source Worker ${sourceWorker.id} is not downstream of one done frozen Planner`);
  }
  const sourceVerifier = overview.tasks.find((task) =>
    task.role === "verifier" && sameCanonicalValue(task.dependsOn, [sourceWorker.id])
  );
  if (!sourceVerifier || sourceVerifier.status !== "blocked") {
    throw new Error(`source Worker ${sourceWorker.id} has no blocked independent Verifier descendant`);
  }
  const filePolicy = objectRecordOrNull(sourceWorker.config?.dshFilePolicy);
  const allowedPaths = Array.isArray(filePolicy?.allowedPaths)
    ? filePolicy.allowedPaths.filter((path): path is string => typeof path === "string")
    : [];
  const forbiddenPaths = Array.isArray(filePolicy?.forbiddenPaths)
    ? filePolicy.forbiddenPaths.filter((path): path is string => typeof path === "string")
    : [];
  if (filePolicy?.schemaVersion !== 1
    || filePolicy.source !== "frozen-design-mutation-surfaces"
    || !sameCanonicalValue(allowedPaths, ["config/evolution/**", "tests/evolution/**"])
    || !sameCanonicalValue(forbiddenPaths, [".git/orbs/**", ".orbs/**", ".ouroboros/**", "db/**"])) {
    throw new Error(`design Worker transport recovery requires the exact frozen DSH file policy`);
  }
  const worktreePath = sourceWorker.worktreePath
    ?? (typeof sourceWorker.config?.sourceWorktreePath === "string" ? sourceWorker.config.sourceWorktreePath : null);
  if (!worktreePath) throw new Error(`source Worker ${sourceWorker.id} has no frozen worktree path`);

  const recoveryKey = stableFingerprint({
    runId: run.id,
    sourceWorkerTaskId: sourceWorker.id,
    sourceWorkerAttemptId: sourceAttempt.attemptId,
    plannerTaskId: planner.id,
    verifierTaskId: sourceVerifier.id,
    filePolicy,
    failureClass: "dsh-model-transport-denied-by-tool-sandbox",
  });
  const existing = overview.tasks.filter((task) =>
    objectRecordOrNull(task.config?.designWorkerTransportRecovery)?.recoveryKey === recoveryKey
  );
  if (existing.length > 0) {
    const worker = existing.find((task) => task.role === "worker");
    const verifier = existing.find((task) => task.role === "verifier");
    if (existing.length !== 2 || !worker || !verifier || !sameCanonicalValue(verifier.dependsOn, [worker.id])) {
      throw new Error(`existing design Worker transport recovery conflicts with ${recoveryKey}`);
    }
    return doneResult(action.type, `Design Worker transport recovery ${recoveryKey} reused.`, [
      { name: "bounded transport recovery", status: "passed", evidence: "reused" },
      { name: "repair budget", status: "passed", evidence: "not charged" },
    ], [{
      kind: "design_worker_transport_recovery",
      runId: run.id,
      sourceWorkerTaskId: sourceWorker.id,
      sourceWorkerAttemptId: sourceAttempt.attemptId,
      workerTaskId: worker.id,
      verifierTaskId: verifier.id,
      recoveryKey,
      reused: true,
    }]);
  }
  if (sourceWorker.config?.designWorkerTransportRecovery !== undefined
    || overview.tasks.some((task) => task.config?.designWorkerTransportRecovery !== undefined)) {
    throw new Error(`design child ${run.id} already used its one bounded DSH transport recovery`);
  }
  const activeTasks = overview.tasks.filter((task) => task.status === "todo" || task.status === "running");
  if (activeTasks.length > 0) {
    throw new Error(`design child ${run.id} still has active tasks: ${activeTasks.map((task) => task.id).join(", ")}`);
  }

  const marker = {
    schemaVersion: 1,
    recoveryKey,
    sourceWorkerTaskId: sourceWorker.id,
    sourceWorkerAttemptId: sourceAttempt.attemptId,
    sourceVerifierTaskId: sourceVerifier.id,
    plannerTaskId: planner.id,
    maxRecoveries: 1,
    reason: action.reason ?? "split one DSH model transport from its denied tool execution plane",
  };
  const workerTaskId = makeId("task");
  const verifierTaskId = makeId("task");
  harness.createTaskWithDb(db, {
    id: workerTaskId,
    runId: run.id,
    parentId: sourceWorker.id,
    cycleId: sourceWorker.cycleId,
    role: "worker",
    goal: sourceWorker.goal,
    prompt: sourceWorker.prompt,
    dependsOn: [planner.id],
    doneWhen: sourceWorker.doneWhen,
    worktreePath: null,
    config: {
      ...sourceWorker.config,
      permissionMode: "workspace-write",
      dshProfileIsolation: "base-headless",
      dshRequiredPlugins: [],
      dshModelTransport: "host-brokered-deepseek",
      dshToolNetwork: "deny",
      forbidBrowser: true,
      browserProcessPolicy: "deny",
      sourceWorktreePath: worktreePath,
      dshFilePolicy: filePolicy,
      designWorkerTransportRecovery: marker,
    },
  });
  harness.createTaskWithDb(db, {
    id: verifierTaskId,
    runId: run.id,
    parentId: workerTaskId,
    cycleId: sourceWorker.cycleId,
    role: "verifier",
    goal: sourceVerifier.goal,
    prompt: sourceVerifier.prompt,
    dependsOn: [workerTaskId],
    doneWhen: sourceVerifier.doneWhen,
    worktreePath: null,
    config: {
      ...sourceVerifier.config,
      permissionMode: "read-only",
      readOnly: true,
      forbidImplementation: true,
      forbidBrowser: true,
      browserProcessPolicy: "deny",
      sourceTaskId: workerTaskId,
      sourceWorktreePath: worktreePath,
      designWorkerTransportRecovery: marker,
    },
  });
  harness.updateRunWithDb(db, {
    runId: run.id,
    status: "todo",
    contextPatch: { designWorkerTransportRecovery: { ...marker, workerTaskId, verifierTaskId } },
  });
  return doneResult(action.type, `Design Worker transport recovery ${recoveryKey} materialized.`, [
    { name: "model transport", status: "passed", evidence: "host-brokered-deepseek" },
    { name: "tool sandbox", status: "passed", evidence: "network deny; exact frozen paths; zero credentials" },
    { name: "independent Verifier dependency", status: "passed", evidence: `${verifierTaskId}->${workerTaskId}` },
    { name: "repair budget", status: "passed", evidence: "not charged" },
  ], [{
    kind: "design_worker_transport_recovery",
    runId: run.id,
    sourceWorkerTaskId: sourceWorker.id,
    sourceWorkerAttemptId: sourceAttempt.attemptId,
    workerTaskId,
    verifierTaskId,
    recoveryKey,
    reused: false,
  }]);
}

function materializeVerifierRepairRecoveryWithDb(
  harness: Harness,
  db: HarnessDatabase,
  action: VerifierRepairRecoveryAction,
): HarnessActionResult {
  const overview = harness.getRunOverviewWithDb(db, { runId: action.runId, eventLimit: 0 });
  const run = overview.run;
  if (!run || run.context.source !== "design" || run.context.retired === true) {
    throw new Error(`Verifier repair recovery requires an active design child: ${action.runId}`);
  }
  const verifier = overview.tasks.find((task) => task.id === action.verifierTaskId);
  if (!verifier || verifier.role !== "verifier" || !["done", "blocked"].includes(verifier.status)) {
    throw new Error(`Verifier repair recovery requires one terminal Verifier: ${action.verifierTaskId}`);
  }
  const verifierSession = [...overview.sessions].reverse().find((session) => session.taskId === verifier.id);
  if (!verifierSession || !verifierAttemptRequiresRepair(verifierSession.output)) {
    throw new Error(`Verifier ${verifier.id} does not contain a machine-readable or compatible failure verdict`);
  }
  if (verifier.dependsOn.length !== 1) {
    throw new Error(`Verifier ${verifier.id} must depend on exactly one source Worker`);
  }
  const sourceWorker = overview.tasks.find((task) => task.id === verifier.dependsOn[0]);
  if (!sourceWorker || sourceWorker.role !== "worker" || sourceWorker.status !== "done") {
    throw new Error(`Verifier ${verifier.id} has no done source Worker`);
  }
  if (sourceWorker.config?.agentBackend !== "deepseek-harness"
    || sourceWorker.config?.permissionMode !== "workspace-write"
    || sourceWorker.config?.dshModelTransport !== "host-brokered-deepseek"
    || sourceWorker.config?.dshToolNetwork !== "deny") {
    throw new Error(`source Worker ${sourceWorker.id} lacks the frozen DSH broker and tool-deny contract`);
  }
  const sourceSession = [...overview.sessions].reverse().find((session) => session.taskId === sourceWorker.id);
  const sourceAttempt = sourceSession ? harness.getAttemptWithDb(db, sourceSession.attemptId) : null;
  const sourceAttemptCwd = typeof sourceAttempt?.input.cwd === "string" && sourceAttempt.input.cwd.trim()
    ? sourceAttempt.input.cwd
    : null;
  const sourceConfigWorktree = typeof sourceWorker.config?.sourceWorktreePath === "string"
    && sourceWorker.config.sourceWorktreePath.trim()
    ? sourceWorker.config.sourceWorktreePath
    : null;
  const recoveryWorktreePath = sourceWorker.worktreePath ?? sourceAttemptCwd ?? sourceConfigWorktree;
  if (!sourceSession || !sourceAttempt || !recoveryWorktreePath) {
    throw new Error(`source Worker ${sourceWorker.id} lacks one durable attempt worktree binding`);
  }
  const executionReceipt = sourceSession?.output.artifacts?.map(objectRecordOrNull).find((artifact) =>
    artifact?.kind === "dsh_execution_profile_receipt"
  );
  const modelTransport = objectRecordOrNull(executionReceipt?.modelTransport);
  const toolSandbox = objectRecordOrNull(executionReceipt?.toolSandbox);
  if (modelTransport?.enforcement !== "loopback-http-broker"
    || modelTransport.credentialIsolation !== true
    || toolSandbox?.network !== "deny"
    || toolSandbox.credentialsInherited !== false
    || executionReceipt?.noTargetNetworkBypass !== true) {
    throw new Error(`source Worker ${sourceWorker.id} lacks the split DSH execution receipt`);
  }
  const problems = (verifierSession.output.problems ?? []).map((problem) =>
    limitUtf8Output(sanitizeEvolutionErrorText(problem), 2_000)
  );
  const failedChecks = (verifierSession.output.checks ?? []).flatMap((check) => {
    const record = objectRecordOrNull(check);
    return record?.status === "failed" && typeof record.name === "string"
      ? [limitUtf8Output(sanitizeEvolutionErrorText(record.name), 500)]
      : [];
  });
  const findings = [...new Set([...problems, ...failedChecks])];
  if (findings.length === 0) {
    findings.push("Verifier omitted a required pass/fail verdict and cannot authorize completion.");
  }
  const recoveryKey = stableFingerprint({
    runId: run.id,
    verifierTaskId: verifier.id,
    verifierAttemptId: verifierSession.attemptId,
    sourceWorkerTaskId: sourceWorker.id,
    findings,
  });
  const existing = overview.tasks.filter((task) =>
    objectRecordOrNull(task.config?.verifierRepairRecovery)?.recoveryKey === recoveryKey
  );
  if (existing.length > 0) {
    const repair = existing.find((task) => task.role === "worker");
    const nextVerifier = existing.find((task) => task.role === "verifier");
    if (existing.length !== 2 || !repair || !nextVerifier || !sameCanonicalValue(nextVerifier.dependsOn, [repair.id])) {
      throw new Error(`existing Verifier repair recovery conflicts with ${recoveryKey}`);
    }
    return doneResult(action.type, `Verifier repair recovery ${recoveryKey} reused.`, [
      { name: "bounded Verifier repair", status: "passed", evidence: "reused" },
    ], [{
      kind: "verifier_repair_recovery",
      runId: run.id,
      verifierTaskId: verifier.id,
      verifierAttemptId: verifierSession.attemptId,
      sourceWorkerTaskId: sourceWorker.id,
      repairTaskId: repair.id,
      nextVerifierTaskId: nextVerifier.id,
      recoveryKey,
      reused: true,
    }]);
  }
  const activeTasks = overview.tasks.filter((task) => task.status === "todo" || task.status === "running");
  if (activeTasks.length > 0) {
    throw new Error(`design child ${run.id} still has active tasks: ${activeTasks.map((task) => task.id).join(", ")}`);
  }

  const rawBudget = objectRecordOrNull(run.context.repairReplanBudget) ?? {};
  const limit = typeof rawBudget.limit === "number" && Number.isInteger(rawBudget.limit) && rawBudget.limit > 0
    ? rawBudget.limit
    : 3;
  const used = typeof rawBudget.used === "number" && Number.isInteger(rawBudget.used) && rawBudget.used >= 0
    ? rawBudget.used
    : 0;
  const entries = Array.isArray(rawBudget.entries) ? rawBudget.entries : [];
  if (used >= limit) {
    harness.updateRunWithDb(db, {
      runId: run.id,
      status: "blocked",
      contextPatch: {
        pendingVerificationTaskIds: [verifier.id],
        pendingVerificationReason: `Verifier ${verifier.id} failed with repair budget exhausted at ${used}/${limit}`,
      },
    });
    return blockedResult(action.type, `Verifier repair budget exhausted at ${used}/${limit}.`, [
      `Verifier ${verifier.id} failed and no further Repair is allowed`,
    ]);
  }

  const marker = {
    schemaVersion: 1,
    recoveryKey,
    verifierTaskId: verifier.id,
    verifierAttemptId: verifierSession.attemptId,
    sourceWorkerTaskId: sourceWorker.id,
    maxRecoveries: 1,
    findingFingerprint: stableFingerprint(findings),
    reason: action.reason ?? "repair one terminal Verifier failure without Goal Review",
  };
  const repairTaskId = makeId("task");
  const nextVerifierTaskId = makeId("task");
  const frozenFindings = findings.map((finding) => `- ${finding}`).join("\n");
  const repairPrompt = [
    `Repair the existing implementation from Worker ${sourceWorker.id} in the same frozen worktree.`,
    "Preserve the existing files. Do not replan, modify the frozen comparison, broaden permissions, or create Goal Review tasks.",
    "Address every independent Verifier finding with real measured evidence, receipts, and state readback:",
    frozenFindings,
    "Keep the DeepSeek model transport host-brokered. All model-triggered tools remain network-denied and credential-free.",
    "Return structured changedFiles, checks, artifacts, problems, and no downstream tasks. A separate read-only Verifier is already frozen.",
  ].join("\n\n");
  const repairDoneWhen = [...new Set([
    ...sourceWorker.doneWhen,
    ...verifier.doneWhen,
    ...findings.map((finding) => `Resolved with machine evidence: ${finding}`),
    "The Repair output reports exact changed files, measured checks, receipts, and state restoration evidence.",
  ])];
  harness.createTaskWithDb(db, {
    id: repairTaskId,
    runId: run.id,
    parentId: verifier.id,
    cycleId: sourceWorker.cycleId,
    role: "worker",
    goal: `Repair: ${verifier.goal}`,
    prompt: repairPrompt,
    dependsOn: [sourceWorker.id],
    doneWhen: repairDoneWhen,
    worktreePath: recoveryWorktreePath,
    config: {
      ...sourceWorker.config,
      permissionMode: "workspace-write",
      dshProfileIsolation: "base-headless",
      dshRequiredPlugins: [],
      dshModelTransport: "host-brokered-deepseek",
      dshToolNetwork: "deny",
      forbidBrowser: true,
      browserProcessPolicy: "deny",
      verifierContract: verifier.config?.verifierContract,
      verifierRepairRecovery: marker,
    },
  });
  const repairTask = harness.getRunOverviewWithDb(db, { runId: run.id, eventLimit: 0 })
    .tasks.find((task) => task.id === repairTaskId);
  if (!repairTask) {
    throw new Error(`bounded Repair ${repairTaskId} was not persisted`);
  }
  const completionContract = completionVerificationContract(
    harness.getRunOverviewWithDb(db, { runId: run.id, eventLimit: 0 }),
    repairTask,
  );
  harness.createTaskWithDb(db, {
    id: nextVerifierTaskId,
    runId: run.id,
    parentId: repairTaskId,
    cycleId: sourceWorker.cycleId,
    role: "verifier",
    goal: verifier.goal,
    prompt: [
      verifier.prompt,
      "Return verdict=pass only when every frozen finding is independently disproved or repaired with machine-readable evidence.",
      "Return verdict=fail for any remaining failed check or P1 finding. Run only the frozen offline tests/evolution/** checks.",
    ].join("\n\n"),
    dependsOn: [repairTaskId],
    doneWhen: [...new Set([
      ...verifier.doneWhen,
      ...repairTask.doneWhen,
      ...completionContract.requiredEvidence,
    ])],
    worktreePath: recoveryWorktreePath,
    config: {
      ...verifier.config,
      permissionMode: "read-only",
      readOnly: true,
      forbidImplementation: true,
      forbidBrowser: true,
      browserProcessPolicy: "deny",
      sourceTaskId: repairTaskId,
      completionContract,
      verdictRequired: true,
      verifierRepairRecovery: marker,
    },
  });
  const nextBudget = {
    limit,
    used: used + 1,
    entries: [...entries, {
      taskId: verifier.id,
      attemptId: verifierSession.attemptId,
      kind: "repair",
      summary: `Repair: ${verifier.goal}`,
      rootTaskId: sourceWorker.id,
      rootCause: findings[0],
      chargedAt: new Date().toISOString(),
    }],
  };
  harness.updateRunWithDb(db, {
    runId: run.id,
    status: "todo",
    contextPatch: {
      repairReplanBudget: nextBudget,
      verifierRepairRecovery: { ...marker, repairTaskId, nextVerifierTaskId },
      pendingVerificationTaskIds: [nextVerifierTaskId],
      pendingVerificationReason: `Verifier ${verifier.id} failed; bounded Repair ${repairTaskId} awaits execution`,
    },
  });
  return doneResult(action.type, `Verifier repair recovery ${recoveryKey} materialized.`, [
    { name: "Verifier semantic failure", status: "passed", evidence: `${verifier.id}:${verifierSession.attemptId}` },
    { name: "bounded Repair budget", status: "passed", evidence: `${used + 1}/${limit}` },
    { name: "DSH execution boundary", status: "passed", evidence: "host broker; tool network deny; zero inherited credentials" },
    { name: "independent Verifier dependency", status: "passed", evidence: `${nextVerifierTaskId}->${repairTaskId}` },
    { name: "Goal Review", status: "passed", evidence: "not created" },
  ], [{
    kind: "verifier_repair_recovery",
    runId: run.id,
    verifierTaskId: verifier.id,
    verifierAttemptId: verifierSession.attemptId,
    sourceWorkerTaskId: sourceWorker.id,
    repairTaskId,
    nextVerifierTaskId,
    recoveryKey,
    findingFingerprint: marker.findingFingerprint,
    findingCount: findings.length,
    budgetUsed: used + 1,
    budgetLimit: limit,
    reused: false,
  }]);
}

function verifierAttemptRequiresRepair(output: AttemptOutput) {
  if (output.status === "blocked" || output.verdict === "fail") return true;
  const failedCheck = (output.checks ?? []).some((check) => objectRecordOrNull(check)?.status === "failed");
  const priorityProblem = (output.problems ?? []).some((problem) => /^P[0-3]\s*:/i.test(problem.trim()));
  if (failedCheck || priorityProblem || /fail-closed/i.test(output.summary)) return true;
  return output.verdict !== "pass";
}

function reconcileVerifierRepairHandoffWithDb(
  harness: Harness,
  db: HarnessDatabase,
  action: VerifierRepairHandoffReconciliationAction,
): HarnessActionResult {
  const overview = harness.getRunOverviewWithDb(db, { runId: action.runId, eventLimit: 0 });
  const run = overview.run;
  if (!run || run.context.source !== "design" || run.context.retired === true) {
    throw new Error(`Verifier Repair handoff requires an active design child: ${action.runId}`);
  }
  const repair = overview.tasks.find((task) => task.id === action.repairTaskId);
  const verifier = overview.tasks.find((task) => task.id === action.verifierTaskId);
  if (!repair || repair.role !== "worker" || !["blocked", "done"].includes(repair.status)) {
    throw new Error(`Verifier Repair handoff requires one terminal Repair: ${action.repairTaskId}`);
  }
  if (!verifier || verifier.role !== "verifier" || !["todo", "blocked"].includes(verifier.status)) {
    throw new Error(`Verifier Repair handoff requires one unattempted Verifier: ${action.verifierTaskId}`);
  }
  if (!sameCanonicalValue(verifier.dependsOn, [repair.id]) || verifier.config?.sourceTaskId !== repair.id) {
    throw new Error(`Verifier ${verifier.id} is not bound only to Repair ${repair.id}`);
  }
  if (repair.worktreePath !== verifier.worktreePath) {
    throw new Error(`Verifier ${verifier.id} is bound to a different Repair worktree`);
  }
  const repairRecovery = objectRecordOrNull(repair.config?.verifierRepairRecovery);
  const verifierRecovery = objectRecordOrNull(verifier.config?.verifierRepairRecovery);
  if (!repairRecovery || !sameCanonicalValue(repairRecovery, verifierRecovery)) {
    throw new Error("Repair and Verifier do not share one frozen recovery identity");
  }
  if (!sameCanonicalValue(repair.config?.verifierContract, verifier.config?.verifierContract)) {
    throw new Error("Repair and Verifier have different frozen verifier contracts");
  }
  const verifierSessions = overview.sessions.filter((session) => session.taskId === verifier.id);
  if (verifierSessions.length > 0) {
    throw new Error(`Verifier ${verifier.id} already has an attempt and cannot be rebound`);
  }
  const priorReceipt = overview.sessions.flatMap((session) => session.taskId === repair.id
    ? (session.output.artifacts ?? []).map((artifact) => ({ session, artifact: objectRecordOrNull(artifact) }))
    : [])
    .find(({ artifact }) => artifact?.kind === "verifier_repair_handoff_receipt");
  if (priorReceipt) {
    return doneResult(action.type, `Verifier Repair handoff for ${repair.id} reused.`, [
      { name: "handoff receipt", status: "passed", evidence: priorReceipt.session.attemptId },
    ], [{
      kind: "verifier_repair_handoff",
      runId: run.id,
      repairTaskId: repair.id,
      blockedAttemptId: priorReceipt.artifact?.blockedAttemptId,
      recoveryAttemptId: priorReceipt.session.attemptId,
      verifierTaskId: verifier.id,
      reused: true,
    }]);
  }
  const blockedSession = [...overview.sessions].reverse().find((session) =>
    session.taskId === repair.id && session.status === "blocked"
  );
  if (!blockedSession) {
    throw new Error(`Repair ${repair.id} has no blocked completion-handoff attempt`);
  }
  const handoffProblem = `existing verifier ${verifier.id} has a different frozen completion contract`;
  const problems = blockedSession.output.problems ?? [];
  if (problems.length !== 1 || problems[0] !== handoffProblem) {
    throw new Error(`Repair ${repair.id} has unresolved problems beyond the frozen completion handoff`);
  }
  const conflictArtifact = (blockedSession.output.artifacts ?? []).some((artifact) => {
    const record = objectRecordOrNull(artifact);
    return record?.kind === "conflicting_completion_contract"
      && record.taskId === verifier.id
      && record.sourceTaskId === repair.id;
  });
  if (!conflictArtifact) {
    throw new Error(`Repair ${repair.id} lacks the matching completion-conflict artifact`);
  }
  const checks = blockedSession.output.checks ?? [];
  if (checks.length === 0 || checks.some((check) => objectRecordOrNull(check)?.status !== "passed")) {
    throw new Error(`Repair ${repair.id} lacks an all-passing structured check set`);
  }
  const frozenFindings = repair.doneWhen.filter((item) => item.startsWith("Resolved with machine evidence:"));
  const namedChecks = new Set(checks.flatMap((check) => {
    const name = objectRecordOrNull(check)?.name;
    return typeof name === "string" && name.trim() ? [name.trim()] : [];
  }));
  if (frozenFindings.length === 0 || namedChecks.size < frozenFindings.length) {
    throw new Error(`Repair ${repair.id} does not provide structured evidence for every frozen finding`);
  }
  const changedFiles = blockedSession.output.changedFiles ?? [];
  const filePolicy = objectRecordOrNull(repair.config?.dshFilePolicy);
  const allowedPaths = Array.isArray(filePolicy?.allowedPaths)
    ? filePolicy.allowedPaths.filter((path): path is string => typeof path === "string")
    : [];
  const forbiddenPaths = Array.isArray(filePolicy?.forbiddenPaths)
    ? filePolicy.forbiddenPaths.filter((path): path is string => typeof path === "string")
    : [];
  if (changedFiles.length === 0 || allowedPaths.length === 0 || changedFiles.some((path) =>
    forbiddenPaths.some((pattern) => evolutionPathMatches(pattern, path))
    || !allowedPaths.some((pattern) => evolutionPathMatches(pattern, path))
  )) {
    throw new Error(`Repair ${repair.id} changed files outside its frozen allowlist`);
  }
  const executionReceipt = (blockedSession.output.artifacts ?? []).map(objectRecordOrNull).find((artifact) =>
    artifact?.kind === "dsh_execution_profile_receipt"
  );
  const modelTransport = objectRecordOrNull(executionReceipt?.modelTransport);
  const toolSandbox = objectRecordOrNull(executionReceipt?.toolSandbox);
  if (modelTransport?.enforcement !== "loopback-http-broker"
    || modelTransport.credentialIsolation !== true
    || toolSandbox?.network !== "deny"
    || toolSandbox.credentialsInherited !== false
    || executionReceipt?.noTargetNetworkBypass !== true) {
    throw new Error(`Repair ${repair.id} lacks the frozen split execution receipt`);
  }
  const completionContract = completionVerificationContract(overview, repair);
  const existingCompletion = objectRecordOrNull(verifier.config?.completionContract);
  if (existingCompletion) {
    const existingEvidence = existingCompletion.requiredEvidence;
    if (!sameCanonicalValue(existingEvidence, completionContract.requiredEvidence)) {
      throw new Error(`Verifier ${verifier.id} has a genuinely different frozen required-evidence contract`);
    }
    if (existingCompletion.sourceTaskId !== repair.id
      && existingCompletion.sourceTaskId !== repairRecovery.sourceWorkerTaskId) {
      throw new Error(`Verifier ${verifier.id} completion lineage is unrelated to the frozen Repair recovery`);
    }
  }
  const receiptKey = stableFingerprint({
    runId: run.id,
    repairTaskId: repair.id,
    blockedAttemptId: blockedSession.attemptId,
    verifierTaskId: verifier.id,
    recoveryKey: repairRecovery.recoveryKey,
    completionContract,
  });
  const recoveryAttemptId = harness.recordAttemptWithDb(db, {
    taskId: repair.id,
    input: {
      executor: "harness-action",
      actionType: action.type,
      blockedAttemptId: blockedSession.attemptId,
      verifierTaskId: verifier.id,
      receiptKey,
    },
    output: {
      status: "done",
      summary: `${blockedSession.output.summary} Host reconciliation preserved the blocked attempt and repaired only the frozen Verifier handoff metadata.`,
      changedFiles,
      checks,
      artifacts: [
        ...(blockedSession.output.artifacts ?? []),
        {
          kind: "verifier_repair_handoff_receipt",
          schemaVersion: 1,
          receiptKey,
          blockedAttemptId: blockedSession.attemptId,
          verifierTaskId: verifier.id,
          completionContract,
          changedFilesSha256: stableFingerprint(changedFiles),
          checksSha256: stableFingerprint(checks),
          sideEffectCounters: {
            paidUsd: 0,
            realProviderCalls: 0,
            pancatWrites: 0,
            productionPublishes: 0,
            realAssetDeletes: 0,
            crossProjectMemoryReads: 0,
            crossProjectMemoryWrites: 0,
          },
        },
      ],
      problems: [],
    },
  });
  const verifierUpdate = db.query(
    `update tasks
     set status = 'todo', config_json = $configJson, done_when_json = $doneWhenJson, updated_at = current_timestamp
     where id = $taskId and status in ('todo', 'blocked')`,
  ).run({
    $taskId: verifier.id,
    $configJson: JSON.stringify({ ...(verifier.config ?? {}), completionContract }),
    $doneWhenJson: JSON.stringify([...new Set([
      ...verifier.doneWhen,
      ...repair.doneWhen,
      ...completionContract.requiredEvidence,
    ])]),
  });
  if (verifierUpdate.changes !== 1) {
    throw new Error(`Verifier ${verifier.id} changed while reconciling the frozen handoff`);
  }
  db.query(
    `update tasks set status = 'blocked', updated_at = current_timestamp
     where run_id = $runId and role = 'goal-review' and status in ('todo', 'running', 'blocked')`,
  ).run({ $runId: run.id });
  harness.updateRunWithDb(db, {
    runId: run.id,
    status: "todo",
    contextPatch: {
      pendingVerificationTaskIds: [verifier.id],
      pendingVerificationReason: `Repair ${repair.id} evidence reconciled; frozen Verifier ${verifier.id} is ready`,
      verifierRepairHandoff: {
        schemaVersion: 1,
        receiptKey,
        repairTaskId: repair.id,
        blockedAttemptId: blockedSession.attemptId,
        recoveryAttemptId,
        verifierTaskId: verifier.id,
      },
    },
  });
  return doneResult(action.type, `Repair ${repair.id} reconciled; frozen Verifier ${verifier.id} is ready.`, [
    { name: "Repair structured evidence", status: "passed", evidence: blockedSession.attemptId },
    { name: "changed-file allowlist", status: "passed", evidence: `${changedFiles.length}:${stableFingerprint(changedFiles)}` },
    { name: "frozen completion identity", status: "passed", evidence: receiptKey },
    { name: "original Verifier", status: "passed", evidence: verifier.id },
    { name: "Goal Review", status: "passed", evidence: "blocked; not retried" },
  ], [{
    kind: "verifier_repair_handoff",
    runId: run.id,
    repairTaskId: repair.id,
    blockedAttemptId: blockedSession.attemptId,
    recoveryAttemptId,
    verifierTaskId: verifier.id,
    receiptKey,
    reused: false,
  }]);
}

function activateHarnessRevisionWithDb(
  harness: Harness,
  db: HarnessDatabase,
  action: HarnessRevisionActivationAction,
): HarnessActionResult {
  const sourceRun = harness.getRunWithDb(db, action.runId);
  if (!sourceRun?.projectId) {
    throw new Error(`activateHarnessRevision requires a project-bound source run: ${action.runId}`);
  }
  const rootRun = harness.getRunWithDb(db, action.rootRunId);
  if (!rootRun?.projectId) {
    throw new Error(`activateHarnessRevision requires a project-bound root run: ${action.rootRunId}`);
  }
  if (sourceRun.projectId !== rootRun.projectId || action.revision.projectId !== rootRun.projectId) {
    throw new Error("activateHarnessRevision project identity must match the source run and root run");
  }
  requireCanonicalSelfImprovementRoot(rootRun);
  if (!runDescendsFromRootWithDb(harness, db, sourceRun.id, rootRun.id)) {
    throw new Error("activateHarnessRevision source run must belong to the long-lived root run");
  }

  const frozen = frozenEvolutionContext(harness, db, sourceRun, action.type);
  const variant = harness.getHarnessVariantWithDb(db, {
    projectId: action.revision.projectId,
    id: action.revision.variant.id,
  });
  if (!variant) {
    throw new Error(
      `HarnessVariant record hash mismatch: trusted variant ${action.revision.variant.id} was not found`,
    );
  }
  if (variant.role !== "candidate" || !variant.evolutionTargets.includes("harness")) {
    throw new Error("activateHarnessRevision requires a candidate HarnessVariant that targets harness evolution");
  }
  const variantRecordSha256 = canonicalEvolutionRecordSha256(variant);
  if (variantRecordSha256 !== action.revision.variant.recordSha256) {
    throw new Error("HarnessVariant record hash mismatch");
  }
  if (variant.contentSha256 !== action.revision.variant.contentSha256) {
    throw new Error("HarnessVariant content hash mismatch");
  }
  requireEvolutionActionReceipt(db, {
    projectId: variant.projectId,
    recordKind: "variant",
    recordId: variant.id,
    recordSha256: variantRecordSha256,
  }, frozen);
  validateHarnessRevisionEvidence(db, action, variant);

  const currentRaw = rootRun.context.activeHarnessRevision;
  let reused = false;
  if (currentRaw !== undefined) {
    const current = parseHarnessRevisionV1(
      currentRaw,
      rootRun.projectId,
      "root activeHarnessRevision",
    );
    if (current.contentSha256 === action.revision.contentSha256) {
      if (!sameCanonicalValue(current, action.revision)) {
        throw new Error("active Harness revision digest collision or canonical readback mismatch");
      }
      reused = true;
    } else {
      if (action.revision.version !== current.version + 1) {
        throw new Error(
          `Harness revision version must advance exactly once from ${current.version} to ${current.version + 1}`,
        );
      }
      if (action.revision.parentSha256 !== current.contentSha256) {
        throw new Error("Harness revision parentSha256 is stale or does not match the active revision");
      }
    }
  } else if (action.revision.version !== 1 || action.revision.parentSha256 !== null) {
    throw new Error("The first active Harness revision must be version 1 with parentSha256=null");
  }

  if (!reused) {
    const updated = harness.updateRunWithDb(db, {
      runId: rootRun.id,
      contextPatch: { activeHarnessRevision: action.revision },
    });
    const readback = updated?.context.activeHarnessRevision;
    const parsedReadback = parseHarnessRevisionV1(
      readback,
      rootRun.projectId,
      "active Harness revision readback",
    );
    if (!sameCanonicalValue(parsedReadback, action.revision)) {
      throw new Error("active Harness revision transactional readback mismatch");
    }
  }

  return doneResult(
    action.type,
    `${reused ? "Reused" : "Activated"} Harness revision ${action.revision.version} for project ${rootRun.projectId}.`,
    [
      { name: "root project identity", status: "passed", evidence: rootRun.projectId },
      { name: "accepted design proposal", status: "passed", evidence: frozen.proposalId },
      { name: "approved authority decision", status: "passed", evidence: frozen.authorityDecisionId },
      { name: "trusted HarnessVariant receipt", status: "passed", evidence: variantRecordSha256 },
      { name: "verified revision evidence", status: "passed", evidence: String(action.revision.evidenceRefs.length) },
      { name: "active revision readback", status: "passed", evidence: action.revision.contentSha256 },
    ],
    [{
      kind: "harness_revision_activation",
      projectId: rootRun.projectId,
      rootRunId: rootRun.id,
      sourceRunId: sourceRun.id,
      version: action.revision.version,
      parentSha256: action.revision.parentSha256,
      contentSha256: action.revision.contentSha256,
      variantId: variant.id,
      variantRecordSha256,
      reused,
      externalEffectsApplied: false,
    }],
  );
}

function requireCanonicalSelfImprovementRoot(
  run: NonNullable<ReturnType<Harness["getRunWithDb"]>>,
) {
  if (run.context.source !== "self-improve" || run.context.parentRunId !== undefined) {
    throw new Error("activateHarnessRevision root must be the canonical parentless self-improve root");
  }
  const selfImprovement = objectRecord(
    run.context.selfImprovement,
    "activateHarnessRevision root selfImprovement",
  );
  if (
    typeof selfImprovement.cycleIndex !== "number"
    || !Number.isInteger(selfImprovement.cycleIndex)
    || selfImprovement.cycleIndex < 0
    || typeof selfImprovement.assessmentFingerprint !== "string"
    || selfImprovement.assessmentFingerprint.length === 0
  ) {
    throw new Error("activateHarnessRevision root must carry the canonical self-improvement cycle identity");
  }
}

function runDescendsFromRootWithDb(
  harness: Harness,
  db: HarnessDatabase,
  sourceRunId: string,
  rootRunId: string,
) {
  let currentId: string | null = sourceRunId;
  const visited = new Set<string>();
  while (currentId) {
    if (currentId === rootRunId) return true;
    if (visited.has(currentId)) {
      throw new Error("activateHarnessRevision run ancestry contains a cycle");
    }
    visited.add(currentId);
    const current = harness.getRunWithDb(db, currentId);
    const parentRunId = current?.context.parentRunId;
    currentId = typeof parentRunId === "string" && parentRunId.length > 0 ? parentRunId : null;
  }
  return false;
}

function validateHarnessRevisionEvidence(
  db: HarnessDatabase,
  action: HarnessRevisionActivationAction,
  variant: HarnessVariant,
) {
  let verifiedAttemptCount = 0;
  for (const evidenceRef of action.revision.evidenceRefs) {
    if (!evidenceRef.startsWith("attempt:")) {
      throw new Error(`Harness revision evidence must use a trusted verifier attempt receipt: ${evidenceRef}`);
    }
    const attemptId = evidenceRef.slice("attempt:".length);
    const row = db.query(`
      select attempts.status as attempt_status,
             attempts.output_json as output_json,
             tasks.role as task_role,
             tasks.run_id as task_run_id,
             runs.project_id as project_id
      from attempts
      join tasks on tasks.id = attempts.task_id
      join runs on runs.id = tasks.run_id
      where attempts.id = $attemptId
    `).get({ $attemptId: attemptId }) as {
      attempt_status: string;
      output_json: string;
      task_role: string;
      task_run_id: string;
      project_id: string | null;
    } | null;
    if (
      !row
      || row.attempt_status !== "done"
      || row.task_role !== "verifier"
      || row.task_run_id !== action.runId
      || row.project_id !== action.revision.projectId
    ) {
      throw new Error(`Harness revision evidence is not a done verifier receipt from the source run: ${evidenceRef}`);
    }
    const output = objectRecord(JSON.parse(row.output_json), `Harness revision evidence ${evidenceRef} output`);
    const checks = Array.isArray(output.checks) ? output.checks : [];
    if (
      checks.length === 0
      || checks.some((check) => !check || typeof check !== "object" || Array.isArray(check)
        || (check as Record<string, unknown>).status !== "passed")
    ) {
      throw new Error(`Harness revision evidence must contain only passed checks: ${evidenceRef}`);
    }
    const problems = Array.isArray(output.problems) ? output.problems : [];
    if (problems.length > 0) {
      throw new Error(`Harness revision evidence contains verifier problems: ${evidenceRef}`);
    }
    const artifacts = Array.isArray(output.artifacts) ? output.artifacts : [];
    const matchingArtifact = artifacts.some((artifact) => {
      if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) return false;
      const record = artifact as Record<string, unknown>;
      return record.kind === "harness_revision_verification"
        && record.projectId === action.revision.projectId
        && record.variantId === variant.id
        && record.variantRecordSha256 === action.revision.variant.recordSha256
        && record.variantContentSha256 === action.revision.variant.contentSha256
        && record.revisionContentSha256 === action.revision.contentSha256;
    });
    if (!matchingArtifact) {
      throw new Error(`Harness revision verifier receipt does not bind the frozen hashes: ${evidenceRef}`);
    }
    verifiedAttemptCount += 1;
  }
  if (verifiedAttemptCount === 0) {
    throw new Error("Harness revision requires at least one trusted verifier attempt receipt");
  }
}

function harnessRevisionActivationAuditRequest(action: HarnessRevisionActivationAction) {
  return {
    type: action.type,
    runId: action.runId,
    rootRunId: action.rootRunId,
    projectId: action.revision.projectId,
    version: action.revision.version,
    contentSha256: action.revision.contentSha256,
    variantId: action.revision.variant.id,
    variantRecordSha256: action.revision.variant.recordSha256,
  };
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
  actionType: EvolutionAction["type"] | HarnessRevisionActivationAction["type"],
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
  action: Exclude<
    HarnessAction,
    SubsessionAction | EvolutionAction | HarnessRevisionActivationAction | DesignerActionRecoveryAction | RunEvidenceReconciliationAction | ResearchEvidenceLinkAction | BlockedRunSignalAction | VersionedCorpusManifestAction | HostEvidenceMaintenanceDeliveryAction
  >,
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

  if (action.type === "bindHostEvidenceMaintenanceReceipt") {
    const run = harness.getRun(action.runId);
    const task = harness.getTask(action.taskId);
    const event = harness.getHarnessActionEvent({ id: action.actionEventId });
    if (!run || !task || task.runId !== run.id || task.role !== "system") {
      return blockedResult(action.type, "Host evidence receipt binding requires its project-bound system task.", [
        `run=${action.runId}`,
        `task=${action.taskId}`,
      ]);
    }
    const marker = task.config?.hostEvidenceMaintenance;
    if (!marker || typeof marker !== "object" || Array.isArray(marker)) {
      return blockedResult(action.type, "Host evidence receipt binding task has no frozen marker.", [action.taskId]);
    }
    if (!event || event.status !== "done" || event.actionType !== "buildVersionedCorpusManifest") {
      return blockedResult(action.type, "Host evidence receipt binding requires a completed manifest action.", [action.actionEventId]);
    }
    const bundleSha256 = action.evidenceBundle.bundleSha256;
    const { bundleSha256: _ignoredBundleSha256, ...bundleBody } = action.evidenceBundle;
    if (typeof bundleSha256 !== "string" || canonicalEvolutionValueSha256(bundleBody) !== bundleSha256) {
      return blockedResult(action.type, "Host evidence receipt bundle hash mismatch.", [action.actionEventId]);
    }
    const receipts = action.evidenceBundle.hostCorpusReceipts;
    if (!Array.isArray(receipts) || receipts.length !== 1) {
      return blockedResult(action.type, "Host evidence receipt bundle must contain exactly one sanitized receipt.", [action.actionEventId]);
    }
    const receipt = receipts[0];
    if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)
      || (receipt as Record<string, unknown>).actionId !== action.actionEventId
      || (receipt as Record<string, unknown>).noHoldoutDisclosure !== true) {
      return blockedResult(action.type, "Host evidence receipt bundle is not bound to the audited action.", [action.actionEventId]);
    }
    const updated = harness.updateRun({
      runId: run.id,
      contextPatch: {
        targetSystemEvidenceBundle: action.evidenceBundle,
        hostEvidenceMaintenance: {
          state: "awaiting-verification",
          taskId: task.id,
          actionEventId: event.id,
        },
      },
    });
    if (!updated) {
      return blockedResult(action.type, `Run not found: ${run.id}`, [`run not found: ${run.id}`]);
    }
    return doneResult(action.type, `Host evidence receipt ${event.id} bound for independent verification.`, [
      { name: "system task binding", status: "passed", evidence: task.id },
      { name: "manifest action", status: "passed", evidence: event.id },
      { name: "evidence bundle hash", status: "passed", evidence: bundleSha256 },
      { name: "holdout disclosure", status: "passed", evidence: "count-and-commitment-only" },
    ], [{
      kind: "host_evidence_maintenance_binding",
      runId: run.id,
      taskId: task.id,
      actionEventId: event.id,
      bundleSha256,
      noHoldoutDisclosure: true,
    }]);
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

  if (action.type === "retireTask") {
    const task = harness.getTask(action.taskId);
    if (!task) {
      return blockedResult(action.type, `Task not found: ${action.taskId}`, [`task not found: ${action.taskId}`]);
    }
    if (task.status === "blocked") {
      const receipt = harness.runInTransaction((db) => harness.listHarnessActionEventsWithDb(db, {
        actionType: "retireTask",
        statuses: ["done"],
        requestTaskId: action.taskId,
        limit: 1,
      })).find((event) => event.request.reason === action.reason);
      if (!receipt) {
        return blockedResult(action.type, `Task ${action.taskId} is already blocked without a matching retirement receipt.`, [
          `task status is blocked: ${action.taskId}`,
        ]);
      }
      return doneResult(action.type, `Task ${action.taskId} retirement reused.`, [
        { name: "task exists", status: "passed", evidence: action.taskId },
        { name: "retirement receipt", status: "passed", evidence: receipt.id },
      ], [{ kind: "retired_task", taskId: action.taskId, previousStatus: "blocked", status: "blocked", reused: true }]);
    }
    if (task.status !== "todo") {
      return blockedResult(action.type, `Task ${action.taskId} must be todo before retirement.`, [
        `task status is ${task.status}: ${action.taskId}`,
      ]);
    }
    const retired = harness.retireTask({ taskId: action.taskId, reason: action.reason });
    if (!retired?.retired) {
      return blockedResult(action.type, `Task ${action.taskId} changed before retirement.`, [
        `task status is ${retired?.task.status ?? "missing"}: ${action.taskId}`,
      ]);
    }
    return doneResult(action.type, `Task ${action.taskId} retired from the active queue.`, [
      { name: "task exists", status: "passed", evidence: action.taskId },
      { name: "previous task status", status: "passed", evidence: "todo" },
      { name: "retired task status", status: "passed", evidence: "blocked" },
    ], [{
      kind: "retired_task",
      taskId: action.taskId,
      runId: task.runId,
      role: task.role,
      previousStatus: "todo",
      status: "blocked",
      reason: action.reason,
    }]);
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

  if (action.type === "freezeVerifiedPackageCommit") {
    return freezeVerifiedPackageCommit(harness, action, options);
  }

  if (action.type === "freezeExactGitPush") {
    return freezeExactGitPush(harness, action);
  }

  if (action.type === "completeVerifiedPackageDelivery") {
    return completeVerifiedPackageDelivery(harness, action);
  }

  if (action.type === "stageExactWorkerFilesForVerification") {
    return stageExactWorkerFilesForVerification(harness, action, options);
  }

  if (action.type === "materializeAttemptArtifactsForVerification") {
    return materializeAttemptArtifactsForVerification(harness, action, options);
  }

  if (action.type === "verifySealedCorpusForVerification") {
    return verifySealedCorpusForVerification(harness, action, options);
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

  if (action.type === "prepareRunDrain") {
    return prepareRunDrain(harness, action);
  }
  throw new Error(`unhandled harness action type: ${(action as { type: string }).type}`);
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
type StageExactWorkerFilesAction = Extract<HarnessAction, { type: "stageExactWorkerFilesForVerification" }>;
type MaterializeAttemptArtifactsAction = Extract<HarnessAction, { type: "materializeAttemptArtifactsForVerification" }>;
type VerifySealedCorpusAction = Extract<HarnessAction, { type: "verifySealedCorpusForVerification" }>;

interface WorkerFileReceipt {
  path: string;
  sha256: string;
}

function failedHostEvidenceAction(
  action: StageExactWorkerFilesAction | MaterializeAttemptArtifactsAction | VerifySealedCorpusAction | FreezeVerifiedPackageCommitAction,
  summary: string,
  checks: HarnessActionResult["checks"],
): HarnessActionResult {
  return {
    status: "blocked",
    actionType: action.type,
    summary,
    checks,
    artifacts: [],
    problems: [summary],
  };
}

function materializeAttemptArtifactsForVerification(
  harness: Harness,
  action: MaterializeAttemptArtifactsAction,
  options: HarnessActionOptions,
): HarnessActionResult {
  const checks: HarnessActionResult["checks"] = [];
  const run = harness.getRun(action.runId);
  if (!run || !run.projectId || !run.projectRoot) {
    return failedHostEvidenceAction(action, `Run ${action.runId} is not bound to one target project root.`, checks);
  }
  if (!existsSync(action.repoPath)) {
    return failedHostEvidenceAction(action, "Target repository path does not exist.", checks);
  }
  try {
    if (realpathSync(run.projectRoot) !== realpathSync(action.repoPath)) {
      return failedHostEvidenceAction(action, "Target repository path does not match the run project root.", checks);
    }
  } catch {
    return failedHostEvidenceAction(action, "Target project root could not be resolved.", checks);
  }
  checks.push({ name: "target project binding", status: "passed", evidence: `${run.projectId}:${action.repoPath}` });

  const planner = harness.getTask(action.plannerTaskId);
  if (!planner || planner.runId !== action.runId || planner.role !== "planner" || planner.status !== "done") {
    return failedHostEvidenceAction(action, `Planner ${action.plannerTaskId} is not completed in target run ${action.runId}.`, checks);
  }
  checks.push({ name: "frozen planner", status: "passed", evidence: planner.id });

  const sourceAttempt = harness.getAttempt(action.sourceAttemptId);
  const sourceTask = sourceAttempt ? harness.getTask(sourceAttempt.taskId) : null;
  const sourceRun = sourceTask ? harness.getRun(sourceTask.runId) : null;
  if (
    !sourceAttempt || sourceAttempt.status !== "done" || sourceAttempt.output.status !== "done" ||
    !sourceTask || sourceTask.role !== "worker" || sourceTask.status !== "done" || !sourceTask.worktreePath ||
    !sourceRun || sourceRun.projectId !== run.projectId
  ) {
    return failedHostEvidenceAction(action, "Source attempt is not one completed same-project Worker artifact source.", checks);
  }
  const sourcePaths = Array.isArray(sourceAttempt.output.changedFiles) ? sourceAttempt.output.changedFiles : [];
  if (!sameUniqueStrings(sourcePaths, action.files.map((file) => file.path))) {
    return failedHostEvidenceAction(action, "Source attempt changedFiles do not exactly match the frozen materialization paths.", checks);
  }
  const sourceArtifacts = Array.isArray(sourceAttempt.output.artifacts) ? sourceAttempt.output.artifacts : [];
  for (const file of action.files) {
    const matches = sourceArtifacts.filter((artifact) => {
      const value = artifact && typeof artifact === "object" && !Array.isArray(artifact)
        ? artifact as Record<string, unknown>
        : null;
      return value?.kind === "file" && value.path === file.path;
    });
    if (matches.length !== 1) {
      return failedHostEvidenceAction(action, `Source attempt must report exactly one file artifact for ${file.path}.`, checks);
    }
  }
  checks.push({ name: "source attempt artifact boundary", status: "passed", evidence: `${sourceAttempt.id}:${action.files.length}` });

  const receiptAttempt = harness.getAttempt(action.receiptAttemptId);
  const receiptTask = receiptAttempt ? harness.getTask(receiptAttempt.taskId) : null;
  if (
    !receiptAttempt || receiptAttempt.status !== "done" || receiptAttempt.output.status !== "done" ||
    !receiptTask || receiptTask.runId !== action.runId || receiptTask.role !== "worker" || receiptTask.status !== "done" ||
    !receiptTask.dependsOn.includes(planner.id)
  ) {
    return failedHostEvidenceAction(action, "Receipt attempt is not one completed target-run Worker downstream of the frozen Planner.", checks);
  }
  const receiptArtifacts = Array.isArray(receiptAttempt.output.artifacts) ? receiptAttempt.output.artifacts : [];
  const shaReceipts = receiptArtifacts.filter((artifact) => {
    const value = artifact && typeof artifact === "object" && !Array.isArray(artifact)
      ? artifact as Record<string, unknown>
      : null;
    return value?.kind === "workerSha256Receipt" && value.projectId === run.projectId;
  }) as Array<Record<string, unknown>>;
  const retrievalReceipts = receiptArtifacts.filter((artifact) => {
    const value = artifact && typeof artifact === "object" && !Array.isArray(artifact)
      ? artifact as Record<string, unknown>
      : null;
    return value?.kind === "retrievalEvidence"
      && value.sourceWorkerAttemptId === action.sourceAttemptId
      && value.sourceWorkerTaskId === sourceTask.id
      && value.artifactWorktree === sourceTask.worktreePath;
  });
  if (shaReceipts.length !== 1 || retrievalReceipts.length !== 1) {
    return failedHostEvidenceAction(
      action,
      "Receipt attempt must contain one project-bound SHA-256 receipt and one exact source-attempt retrieval receipt.",
      checks,
    );
  }
  const receiptItems = Array.isArray(shaReceipts[0]!.items) ? shaReceipts[0]!.items : [];
  const normalizedReceiptFiles: WorkerFileReceipt[] = [];
  try {
    for (const item of receiptItems) {
      const value = objectRecord(item, "workerSha256Receipt.items[]");
      normalizedReceiptFiles.push({
        path: exactRelativeGitPathField(value, "path", "workerSha256Receipt.items[].path"),
        sha256: exactSha256Field(value, "sha256"),
      });
    }
  } catch (error) {
    return failedHostEvidenceAction(action, errorMessage(error), checks);
  }
  if (!sameWorkerFileReceipts(normalizedReceiptFiles, action.files)) {
    return failedHostEvidenceAction(action, "Receipt attempt file hashes do not exactly match the frozen materialization request.", checks);
  }
  checks.push({ name: "independent SHA-256 receipt", status: "passed", evidence: receiptAttempt.id });

  const git = options.runGit ?? defaultGitRunner;
  const top = safeGitStep(git, action.repoPath, ["rev-parse", "--show-toplevel"]);
  const head = safeGitStep(git, action.repoPath, ["rev-parse", "HEAD"]);
  const sourceCommon = safeGitStep(git, sourceTask.worktreePath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const targetCommon = safeGitStep(git, action.repoPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (
    !top.ok || !head.ok || !sourceCommon.ok || !targetCommon.ok ||
    realpathSync(top.stdout.trim()) !== realpathSync(action.repoPath) ||
    head.stdout.trim() !== action.expectedParentSha ||
    realpathSync(sourceCommon.stdout.trim()) !== realpathSync(targetCommon.stdout.trim())
  ) {
    return failedHostEvidenceAction(action, "Source and target Git identities or expected parent SHA do not match.", checks);
  }
  const expectedWorktreeRoot = join(realpathSync(action.repoPath), ".ouroboros", "worktrees");
  const resolvedWorktreeParent = realpathSync(dirname(action.worktreePath));
  if (resolvedWorktreeParent !== expectedWorktreeRoot || action.worktreePath === sourceTask.worktreePath) {
    return failedHostEvidenceAction(action, "Target worktree must be one fresh direct child of the target .ouroboros/worktrees root.", checks);
  }

  const requestSha256 = createHash("sha256").update(JSON.stringify({
    contractId: action.contractId,
    runId: action.runId,
    plannerTaskId: action.plannerTaskId,
    sourceAttemptId: action.sourceAttemptId,
    receiptAttemptId: action.receiptAttemptId,
    repoPath: action.repoPath,
    worktreePath: action.worktreePath,
    branch: action.branch,
    expectedParentSha: action.expectedParentSha,
    commitMessage: action.commitMessage,
    files: action.files,
    excludedPaths: action.excludedPaths,
  })).digest("hex");
  const materializationTaskId = `task_host_materialization_${requestSha256.slice(0, 24)}`;
  const materializationAttemptId = `attempt_host_materialization_${requestSha256.slice(0, 24)}`;
  const existingTask = harness.getTask(materializationTaskId);
  if (existingTask) {
    const existingAttempt = harness.getAttempt(materializationAttemptId);
    if (
      existingTask.runId !== action.runId || existingTask.role !== "worker" || existingTask.status !== "done" ||
      existingTask.worktreePath !== action.worktreePath || !existingTask.dependsOn.includes(planner.id) ||
      !existingAttempt || existingAttempt.status !== "done" || existingAttempt.output.status !== "done" ||
      !verifyMaterializedFiles(action.worktreePath, action.files, action.excludedPaths, git)
    ) {
      return failedHostEvidenceAction(action, "Existing host materialization task conflicts with the frozen request.", checks);
    }
    checks.push({ name: "materialized file readback", status: "passed", evidence: requestSha256 });
    return doneResult(action.type, `Reused host materialization ${materializationTaskId}.`, checks, [{
      kind: "host_attempt_artifact_materialization",
      contractId: action.contractId,
      taskId: materializationTaskId,
      attemptId: materializationAttemptId,
      sourceTaskId: sourceTask.id,
      sourceAttemptId: sourceAttempt.id,
      receiptAttemptId: receiptAttempt.id,
      worktreePath: action.worktreePath,
      branch: action.branch,
      parentSha: action.expectedParentSha,
      commitMessage: action.commitMessage,
      files: action.files,
      excludedPaths: action.excludedPaths,
      sideEffectCounters: zeroSideEffectCounters(),
      reused: true,
    }]);
  }

  let createdWorktree = false;
  if (!existsSync(action.worktreePath)) {
    mkdirSync(dirname(action.worktreePath), { recursive: true });
    const add = safeGitStep(git, action.repoPath, ["worktree", "add", "-b", action.branch, action.worktreePath, action.expectedParentSha]);
    if (!add.ok) {
      return failedHostEvidenceAction(action, "Host could not create the isolated materialization worktree.", checks);
    }
    createdWorktree = true;
  }
  const worktreeTop = safeGitStep(git, action.worktreePath, ["rev-parse", "--show-toplevel"]);
  const worktreeBranch = safeGitStep(git, action.worktreePath, ["branch", "--show-current"]);
  const worktreeHead = safeGitStep(git, action.worktreePath, ["rev-parse", "HEAD"]);
  const worktreeStatus = safeGitStep(git, action.worktreePath, ["status", "--porcelain=v1", "--untracked-files=all"]);
  const responseLossRecovered = !createdWorktree
    && verifyMaterializedFiles(action.worktreePath, action.files, action.excludedPaths, git);
  if (
    !worktreeTop.ok || !worktreeBranch.ok || !worktreeHead.ok || !worktreeStatus.ok ||
    realpathSync(worktreeTop.stdout.trim()) !== realpathSync(action.worktreePath) ||
    worktreeBranch.stdout.trim() !== action.branch || worktreeHead.stdout.trim() !== action.expectedParentSha ||
    (worktreeStatus.stdout.length > 0 && !responseLossRecovered)
  ) {
    if (createdWorktree) safeGitStep(git, action.repoPath, ["worktree", "remove", "--force", action.worktreePath]);
    return failedHostEvidenceAction(action, "Materialization worktree is not a clean exact branch at the frozen parent.", checks);
  }

  let totalBytes = 0;
  try {
    if (!responseLossRecovered) {
      for (const file of action.files) {
        const source = join(sourceTask.worktreePath, file.path);
        const target = join(action.worktreePath, file.path);
        const sourceStat = lstatSync(source);
        if (
          !sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.size > MAX_INTEGRATION_CLOSURE_FILE_BYTES ||
          !realpathSync(source).startsWith(`${realpathSync(sourceTask.worktreePath)}${sep}`) ||
          sha256File(source) !== file.sha256 || existsSync(target)
        ) {
          throw new Error(`Source artifact is not one exact bounded regular file: ${file.path}`);
        }
        totalBytes += sourceStat.size;
        if (totalBytes > MAX_INTEGRATION_CLOSURE_TOTAL_BYTES) {
          throw new Error("Source artifacts exceed the bounded total byte limit.");
        }
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(source, target);
        chmodSync(target, sourceStat.mode & 0o777);
        if (sha256File(source) !== file.sha256 || sha256File(target) !== file.sha256) {
          throw new Error(`Source artifact changed during host materialization: ${file.path}`);
        }
      }
    }
    if (!verifyMaterializedFiles(action.worktreePath, action.files, action.excludedPaths, git)) {
      throw new Error("Materialized file readback does not match the frozen exact paths and hashes.");
    }
  } catch (error) {
    if (createdWorktree) safeGitStep(git, action.repoPath, ["worktree", "remove", "--force", action.worktreePath]);
    return failedHostEvidenceAction(action, errorMessage(error), checks);
  }
  checks.push({ name: "materialized file readback", status: "passed", evidence: requestSha256 });

  try {
    harness.runInTransaction((db) => {
      harness.createTaskWithDb(db, {
        id: materializationTaskId,
        runId: action.runId,
        role: "worker",
        goal: "Host-materialize the frozen attempt artifact set for independent verification",
        prompt: "This system task is completed only from host-owned fixed-action evidence; no model execution is allowed.",
        dependsOn: [planner.id],
        doneWhen: [
          "the source attempt and receipt attempt are independently bound",
          "the exact file path and SHA-256 set is materialized into one clean isolated worktree",
          "excluded paths are absent and all side-effect counters remain zero",
        ],
        worktreePath: action.worktreePath,
        config: {
          systemTask: true,
          hostAttemptArtifactMaterialization: {
            contractId: action.contractId,
            requestSha256,
            sourceTaskId: sourceTask.id,
            sourceAttemptId: sourceAttempt.id,
            receiptAttemptId: receiptAttempt.id,
          },
        },
      });
      harness.recordAttemptWithDb(db, {
        id: materializationAttemptId,
        taskId: materializationTaskId,
        input: {
          executor: "harness-action",
          actionType: action.type,
          contractId: action.contractId,
          requestSha256,
        },
        output: {
          status: "done",
          summary: `Host materialized ${action.files.length} exact historical attempt artifacts for independent verification.`,
          changedFiles: action.files.map((file) => file.path),
          checks,
          artifacts: [
            { kind: "worktree", path: action.worktreePath, branch: action.branch },
            ...action.files.map((file) => ({ kind: "file", ...file })),
            {
              kind: "host_attempt_artifact_materialization",
              contractId: action.contractId,
              requestSha256,
              sourceTaskId: sourceTask.id,
              sourceAttemptId: sourceAttempt.id,
              receiptAttemptId: receiptAttempt.id,
              worktreePath: action.worktreePath,
              branch: action.branch,
              parentSha: action.expectedParentSha,
              files: action.files,
              excludedPaths: action.excludedPaths,
              sideEffectCounters: zeroSideEffectCounters(),
              responseLossRecovered,
            },
          ],
          problems: [],
        },
      });
    });
  } catch (error) {
    return failedHostEvidenceAction(action, `Host materialized files but could not persist the system task receipt: ${errorMessage(error)}`, checks);
  }
  return doneResult(action.type, `Host materialized ${action.files.length} exact attempt artifacts for independent verification.`, checks, [{
    kind: "host_attempt_artifact_materialization",
    contractId: action.contractId,
    taskId: materializationTaskId,
    attemptId: materializationAttemptId,
    sourceTaskId: sourceTask.id,
    sourceAttemptId: sourceAttempt.id,
    receiptAttemptId: receiptAttempt.id,
    worktreePath: action.worktreePath,
    branch: action.branch,
    parentSha: action.expectedParentSha,
    commitMessage: action.commitMessage,
    files: action.files,
    excludedPaths: action.excludedPaths,
    sideEffectCounters: zeroSideEffectCounters(),
    responseLossRecovered,
    reused: false,
  }]);
}

function sameWorkerFileReceipts(left: WorkerFileReceipt[], right: WorkerFileReceipt[]) {
  if (left.length !== right.length) return false;
  const byPath = new Map(left.map((file) => [file.path, file.sha256]));
  return right.every((file) => byPath.get(file.path) === file.sha256);
}

function verifyMaterializedFiles(
  worktreePath: string,
  files: WorkerFileReceipt[],
  excludedPaths: string[],
  git: GitRunner = defaultGitRunner,
) {
  try {
    const expected = files.map((file) => file.path).sort();
    for (const file of files) {
      const absolute = join(worktreePath, file.path);
      const stat = lstatSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink() || sha256File(absolute) !== file.sha256) return false;
    }
    if (excludedPaths.some((path) => existsSync(join(worktreePath, path)))) return false;
    const untracked = safeGitStep(git, worktreePath, ["ls-files", "--others", "--exclude-standard", "-z"]);
    const modified = safeGitStep(git, worktreePath, ["diff", "--name-only", "-z"]);
    return untracked.ok && modified.ok && modified.stdout.length === 0
      && untracked.stdout.split("\0").filter(Boolean).sort().join("\0") === expected.join("\0");
  } catch {
    return false;
  }
}

function zeroSideEffectCounters() {
  return {
    paidUsd: 0,
    realProviderCalls: 0,
    pancatWrites: 0,
    productionPublishes: 0,
    realAssetDeletes: 0,
    crossProjectMemoryReads: 0,
    crossProjectMemoryWrites: 0,
  };
}

function exactZeroSideEffectCounters(value: unknown) {
  const record = objectRecordOrNull(value);
  const expected = zeroSideEffectCounters();
  if (!record || Object.keys(record).sort().join("\0") !== Object.keys(expected).sort().join("\0")) {
    return null;
  }
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (!Object.is(record[key], expectedValue)) return null;
  }
  return expected;
}

function sourceSideEffectReceipt(attempt: RunOverview["sessions"][number]) {
  const artifacts = Array.isArray(attempt.output.artifacts) ? attempt.output.artifacts : [];
  const matches = artifacts.map(objectRecordOrNull).filter((artifact) =>
    artifact?.kind === "verifier_repair_handoff_receipt" && exactZeroSideEffectCounters(artifact.sideEffectCounters));
  if (matches.length !== 1) return null;
  return exactZeroSideEffectCounters(matches[0]!.sideEffectCounters);
}

function completedWorkerFileReceipts(
  harness: Harness,
  action: StageExactWorkerFilesAction | VerifySealedCorpusAction,
  checks: HarnessActionResult["checks"],
): { task: Task; attemptId: string; files: WorkerFileReceipt[] } | { problem: string } {
  const run = harness.getRun(action.runId);
  if (!run) return { problem: `Run not found: ${action.runId}.` };
  checks.push({ name: "run exists", status: "passed", evidence: action.runId });
  const task = harness.getTask(action.taskId);
  if (!task || task.runId !== action.runId || task.status !== "done" || task.role !== "worker") {
    return { problem: `Task ${action.taskId} is not a completed Worker in run ${action.runId}.` };
  }
  checks.push({ name: "completed worker", status: "passed", evidence: action.taskId });
  const overview = harness.getRunOverview({ runId: action.runId, eventLimit: 0 });
  const attempt = latestSessionForTask(overview, action.taskId);
  if (!attempt || attempt.status !== "done" || attempt.output.status !== "done") {
    return { problem: `Task ${action.taskId} has no completed attempt output.` };
  }
  const changedFiles = Array.isArray(attempt.output.changedFiles) ? attempt.output.changedFiles : [];
  if (
    changedFiles.length === 0 ||
    changedFiles.length > EXACT_GIT_INDEX_MAX_FILES ||
    changedFiles.some((path) => typeof path !== "string") ||
    new Set(changedFiles).size !== changedFiles.length
  ) {
    return { problem: `Task ${action.taskId} changedFiles must be a non-empty unique bounded list.` };
  }
  const artifacts = Array.isArray(attempt.output.artifacts) ? attempt.output.artifacts : [];
  const files: WorkerFileReceipt[] = [];
  for (const rawPath of changedFiles as string[]) {
    let path: string;
    try {
      path = exactRelativeGitPathField({ path: rawPath }, "path", "worker changedFiles path");
    } catch (error) {
      return { problem: errorMessage(error) };
    }
    const matches = artifacts.filter((artifact) => {
      const value = artifact && typeof artifact === "object" && !Array.isArray(artifact)
        ? artifact as Record<string, unknown>
        : null;
      return value?.kind === "file" && value.path === path && typeof value.sha256 === "string";
    }) as Array<Record<string, unknown>>;
    if (matches.length !== 1 || !/^[0-9a-f]{64}$/.test(String(matches[0]!.sha256))) {
      return { problem: `Task ${action.taskId} must report exactly one lowercase SHA-256 file artifact for ${path}.` };
    }
    files.push({ path, sha256: String(matches[0]!.sha256) });
  }
  checks.push({ name: "worker file receipts", status: "passed", evidence: `${attempt.attemptId}:${files.length}` });
  return { task, attemptId: attempt.attemptId, files };
}

function sameNullSeparatedPaths(output: string, expected: string[]) {
  const actual = output.split("\0").filter((value) => value.length > 0);
  return sameUniqueStrings(actual, expected);
}

function stageExactWorkerFilesForVerification(
  harness: Harness,
  action: StageExactWorkerFilesAction,
  options: HarnessActionOptions,
): HarnessActionResult {
  const checks: HarnessActionResult["checks"] = [];
  const evidence = completedWorkerFileReceipts(harness, action, checks);
  if ("problem" in evidence) return failedHostEvidenceAction(action, evidence.problem, checks);
  if (!existsSync(action.repoPath)) return failedHostEvidenceAction(action, "Repository path does not exist.", checks);
  if (!evidence.task.worktreePath) {
    return failedHostEvidenceAction(action, `Task ${action.taskId} has no worktree.`, checks);
  }
  try {
    if (realpathSync(evidence.task.worktreePath) !== realpathSync(action.repoPath)) {
      return failedHostEvidenceAction(action, "Task worktree does not match repoPath.", checks);
    }
  } catch {
    return failedHostEvidenceAction(action, "Task worktree could not be resolved.", checks);
  }
  const git = options.runGit ?? defaultGitRunner;
  const top = safeGitStep(git, action.repoPath, ["rev-parse", "--show-toplevel"]);
  const branch = safeGitStep(git, action.repoPath, ["branch", "--show-current"]);
  const head = safeGitStep(git, action.repoPath, ["rev-parse", "HEAD"]);
  if (
    !top.ok || !branch.ok || !head.ok ||
    realpathSync(top.stdout.trim()) !== realpathSync(action.repoPath) ||
    branch.stdout.trim() !== action.branch ||
    head.stdout.trim() !== action.expectedParentSha
  ) {
    return failedHostEvidenceAction(action, "Repository identity, branch, or parent SHA does not match the frozen request.", checks);
  }
  checks.push({ name: "repository identity", status: "passed", evidence: `${action.branch}:${action.expectedParentSha}` });
  const expectedPaths = evidence.files.map((file) => file.path);
  const unstaged = safeGitStep(git, action.repoPath, ["diff", "--name-only", "-z"]);
  const stagedBefore = safeGitStep(git, action.repoPath, ["diff", "--cached", "--name-only", "-z", action.expectedParentSha, "--"]);
  const untracked = safeGitStep(git, action.repoPath, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const conflicts = safeGitStep(git, action.repoPath, ["ls-files", "--unmerged", "-z"]);
  if (!unstaged.ok || unstaged.stdout.length > 0 || !conflicts.ok || conflicts.stdout.length > 0) {
    return failedHostEvidenceAction(action, "Repository contains tracked changes or conflicts outside the exact worker additions.", checks);
  }
  const replay = stagedBefore.ok && sameNullSeparatedPaths(stagedBefore.stdout, expectedPaths) && untracked.ok && untracked.stdout.length === 0;
  if (!replay && (!stagedBefore.ok || stagedBefore.stdout.length > 0 || !untracked.ok || !sameNullSeparatedPaths(untracked.stdout, expectedPaths))) {
    return failedHostEvidenceAction(action, "Repository untracked files do not exactly match the Worker file receipt.", checks);
  }
  for (const file of evidence.files) {
    const absolute = join(action.repoPath, file.path);
    try {
      const stat = lstatSync(absolute);
      if (!stat.isFile() || !realpathSync(absolute).startsWith(`${realpathSync(action.repoPath)}${sep}`)) {
        return failedHostEvidenceAction(action, `Worker artifact is not one regular in-repository file: ${file.path}.`, checks);
      }
    } catch {
      return failedHostEvidenceAction(action, `Worker artifact is missing or cannot be resolved: ${file.path}.`, checks);
    }
    if (sha256File(absolute) !== file.sha256) {
      return failedHostEvidenceAction(action, `Worker artifact SHA-256 does not match its receipt: ${file.path}.`, checks);
    }
  }
  checks.push({ name: "exact worktree files", status: "passed", evidence: expectedPaths.join(",") });
  if (!replay) {
    const add = safeGitStep(git, action.repoPath, ["add", "--", ...expectedPaths]);
    if (!add.ok) {
      safeGitStep(git, action.repoPath, ["reset", "--mixed", action.expectedParentSha, "--", ...expectedPaths]);
      return failedHostEvidenceAction(action, "Host could not stage the exact Worker files.", checks);
    }
  }
  const staged = safeGitStep(git, action.repoPath, ["diff", "--cached", "--name-status", "-z", action.expectedParentSha, "--"]);
  const stagedEntries = staged.ok ? parseNameStatusZ(staged.stdout) : null;
  if (!staged.ok || !stagedEntries || stagedEntries.length !== expectedPaths.length || stagedEntries.some((entry) => entry.status !== "A") || !sameUniqueStrings(stagedEntries.map((entry) => entry.path), expectedPaths)) {
    safeGitStep(git, action.repoPath, ["reset", "--mixed", action.expectedParentSha, "--", ...expectedPaths]);
    return failedHostEvidenceAction(action, "Staged Git index does not exactly match the Worker file receipt.", checks);
  }
  const files: ExactGitIndexFile[] = [];
  for (const file of evidence.files) {
    const blob = safeGitStep(git, action.repoPath, ["hash-object", "--", file.path]);
    if (!blob.ok || !/^[0-9a-f]{40}$/.test(blob.stdout.trim())) {
      return failedHostEvidenceAction(action, `Could not read staged blob for ${file.path}.`, checks);
    }
    const stagedEntry = safeGitStep(git, action.repoPath, ["ls-files", "--stage", "-z", "--", file.path]);
    const exact = { status: "A" as const, path: file.path, mode: "100644" as const, blobOid: blob.stdout.trim() };
    if (!stagedEntry.ok || !sameExactIndexEntry(stagedEntry.stdout, exact)) {
      return failedHostEvidenceAction(action, `Staged blob does not match ${file.path}.`, checks);
    }
    files.push(exact);
  }
  const tree = safeGitStep(git, action.repoPath, ["write-tree"]);
  if (!tree.ok || !/^[0-9a-f]{40}$/.test(tree.stdout.trim())) {
    return failedHostEvidenceAction(action, "Could not read staged verification tree.", checks);
  }
  checks.push({ name: "exact staged index", status: "passed", evidence: tree.stdout.trim() });
  return {
    status: "done",
    actionType: action.type,
    summary: `Staged ${files.length} exact Worker files for independent verification.`,
    checks,
    artifacts: [{
      kind: "pre_verification_git_index",
      contractId: action.contractId,
      runId: action.runId,
      workerTaskId: action.taskId,
      workerAttemptId: evidence.attemptId,
      repoPath: action.repoPath,
      branch: action.branch,
      parentSha: action.expectedParentSha,
      treeOid: tree.stdout.trim(),
      commitMessage: action.commitMessage,
      files: files.map((file, index) => ({ ...file, sha256: evidence.files[index]!.sha256 })),
      reused: replay,
    }],
    problems: [],
  };
}

function shellSingleQuote(value: string) {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function verifySealedCorpusForVerification(
  harness: Harness,
  action: VerifySealedCorpusAction,
  options: HarnessActionOptions,
): HarnessActionResult {
  const checks: HarnessActionResult["checks"] = [];
  const evidence = completedWorkerFileReceipts(harness, action, checks);
  if ("problem" in evidence) return failedHostEvidenceAction(action, evidence.problem, checks);
  let descriptorText = options.sealedDescriptorJson;
  let descriptorSource = "ephemeral-host-input";
  let opaqueAuthorizationRef: string | null = null;
  let authorizationDecision: string | null = null;
  if (action.descriptorSource === "approved-proposal-comparison") {
    if (!action.proposalId || !action.decisionId) {
      return failedHostEvidenceAction(action, "Approved proposal descriptor derivation requires proposal and decision IDs.", checks);
    }
    if (descriptorText) {
      return failedHostEvidenceAction(action, "Approved proposal descriptor derivation cannot be combined with an external descriptor.", checks);
    }
    const governed = governedSealedDescriptor(harness, {
      ...action,
      descriptorSource: action.descriptorSource,
      proposalId: action.proposalId,
      decisionId: action.decisionId,
    });
    if ("problem" in governed) return failedHostEvidenceAction(action, governed.problem, checks);
    descriptorText = governed.descriptorText;
    descriptorSource = action.descriptorSource;
    opaqueAuthorizationRef = governed.opaqueAuthorizationRef;
    authorizationDecision = "approved";
    checks.push({ name: "sealed descriptor governance", status: "passed", evidence: governed.opaqueAuthorizationRef });
  }
  if (typeof descriptorText !== "string" || descriptorText.length === 0 || descriptorText.length > 64 * 1024) {
    return failedHostEvidenceAction(action, "A bounded ephemeral sealed descriptor is required from the host.", checks);
  }
  let descriptor: Record<string, unknown>;
  try {
    descriptor = JSON.parse(descriptorText) as Record<string, unknown>;
  } catch {
    return failedHostEvidenceAction(action, "The ephemeral sealed descriptor is invalid JSON.", checks);
  }
  if (Object.keys(descriptor).join("\0") !== "entries" || !Array.isArray(descriptor.entries) || descriptor.entries.length !== action.expectedCount) {
    return failedHostEvidenceAction(action, "The ephemeral sealed descriptor does not match the frozen count.", checks);
  }
  const refs: string[] = [];
  const sealedPaths: string[] = [];
  for (const entry of descriptor.entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return failedHostEvidenceAction(action, "The ephemeral sealed descriptor entry is malformed.", checks);
    }
    const value = entry as Record<string, unknown>;
    if (Object.keys(value).sort().join("\0") !== "path\0ref" || typeof value.ref !== "string" || !value.ref.startsWith("fixture:") || typeof value.path !== "string" || value.path.length === 0) {
      return failedHostEvidenceAction(action, "The ephemeral sealed descriptor entry must contain only ref and path.", checks);
    }
    refs.push(value.ref);
    if (!isAbsolute(value.path)) {
      return failedHostEvidenceAction(action, "The ephemeral sealed descriptor path must be absolute.", checks);
    }
    try {
      const stat = lstatSync(value.path);
      if (!stat.isFile() || realpathSync(value.path) !== value.path) {
        return failedHostEvidenceAction(action, "The ephemeral sealed descriptor path must be one regular non-symlink file.", checks);
      }
    } catch {
      return failedHostEvidenceAction(action, "The ephemeral sealed descriptor path is unavailable.", checks);
    }
    sealedPaths.push(value.path);
  }
  const refsSha256 = createHash("sha256").update(JSON.stringify([...refs].sort())).digest("hex");
  if (refsSha256 !== action.expectedRefsSha256) {
    return failedHostEvidenceAction(action, "The sealed descriptor commitment does not match the frozen refs SHA-256.", checks);
  }
  const sideEffectCounters = {
    paidUsd: 0,
    realProviderCalls: 0,
    pancatWrites: 0,
    productionPublishes: 0,
    realAssetDeletes: 0,
    crossProjectMemoryReads: 0,
    crossProjectMemoryWrites: 0,
  };
  const descriptorSha256 = createHash("sha256").update(descriptorText).digest("hex");
  const sealedAuditReceipt = (executionStatus: "passed" | "failed") => ({
    kind: "sealed_corpus_verification_receipt",
    descriptorSource,
    opaqueAuthorizationRef,
    authorizationDecision,
    descriptorSha256,
    expectedCount: action.expectedCount,
    expectedRefsSha256: action.expectedRefsSha256,
    expectedCorpusSnapshotSha256: action.expectedCorpusSnapshotSha256,
    executionStatus,
    noHoldoutDisclosure: true,
    sideEffectCounters,
  });
  const failedWithSealedAudit = (problem: string) => {
    const failed = failedHostEvidenceAction(action, problem, checks);
    return { ...failed, artifacts: [sealedAuditReceipt("failed")] };
  };
  if (!evidence.files.some((file) => file.path === action.scriptPath)) {
    return failedHostEvidenceAction(action, "The sealed verifier script is not bound to the Worker file receipt.", checks);
  }
  if (process.platform !== "darwin") {
    return failedHostEvidenceAction(action, "Host-enforced sealed verification is unavailable on this platform.", checks);
  }
  const runCommand = options.runCommand ?? defaultCommandRunner;
  const sourceHome = process.env.HOME;
  const deniedReadPaths = sourceHome
    ? [".ssh", ".aws", ".codex", ".linear", ".config", ".zshrc", ".zprofile", ".bashrc", ".bash_profile"]
        .map((path) => join(sourceHome, path))
        .filter((path) => !sealedPaths.includes(path))
    : [];
  const profile = [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    "(deny file-write*)",
    ...deniedReadPaths.map((path) => `(deny file-read* (subpath ${JSON.stringify(path)}))`),
  ].join(" ");
  const command = `/usr/bin/sandbox-exec -p ${shellSingleQuote(profile)} /usr/bin/env node ${shellSingleQuote(action.scriptPath)} --sealed-stdin`;
  const result = runCommand({
    cwd: action.repoPath,
    command,
    stdin: descriptorText,
    timeoutMs: 30_000,
    maxOutputBytes: 16 * 1024,
  });
  if (result.exitCode !== 0) {
    return failedWithSealedAudit(`Sealed verifier exited ${result.exitCode}; secret diagnostics were not persisted.`);
  }
  const firstLine = result.stdout.split(/\r?\n/, 1)[0] ?? "";
  let output: Record<string, unknown>;
  try {
    output = JSON.parse(firstLine) as Record<string, unknown>;
  } catch {
    return failedWithSealedAudit("Sealed verifier did not return the required structured result.");
  }
  if (
    output.status !== "pass" ||
    output.refsSha256 !== action.expectedRefsSha256 ||
    output.corpusSnapshotSha256 !== action.expectedCorpusSnapshotSha256
  ) {
    return failedWithSealedAudit("Sealed verifier result does not match the frozen commitment and corpus SHA-256.");
  }
  checks.push({ name: "sealed descriptor commitment", status: "passed", evidence: `${action.expectedCount}:${action.expectedRefsSha256}` });
  checks.push({ name: "sealed verifier result", status: "passed", evidence: action.expectedCorpusSnapshotSha256 });
  return {
    status: "done",
    actionType: action.type,
    summary: "Host verified the sealed corpus through ephemeral stdin with network and file writes denied.",
    checks,
    artifacts: [{
      kind: "sealed_corpus_verification_receipt",
      contractId: action.contractId,
      runId: action.runId,
      workerTaskId: action.taskId,
      workerAttemptId: evidence.attemptId,
      scriptPath: action.scriptPath,
      scriptSha256: evidence.files.find((file) => file.path === action.scriptPath)!.sha256,
      descriptorCount: action.expectedCount,
      descriptorSource,
      opaqueAuthorizationRef,
      authorizationDecision,
      descriptorSha256,
      expectedCount: action.expectedCount,
      expectedRefsSha256: action.expectedRefsSha256,
      expectedCorpusSnapshotSha256: action.expectedCorpusSnapshotSha256,
      executionStatus: "passed",
      refsSha256: action.expectedRefsSha256,
      corpusSnapshotSha256: action.expectedCorpusSnapshotSha256,
      networkPolicy: "sandbox-exec:deny-network",
      fileWritePolicy: "sandbox-exec:deny-file-write",
      command: `node ${action.scriptPath} --sealed-stdin`,
      exitCode: 0,
      noHoldoutDisclosure: true,
      sideEffectCounters,
    }],
    problems: [],
  };
}

function governedSealedDescriptor(
  harness: Harness,
  action: VerifySealedCorpusAction & {
    descriptorSource: "approved-proposal-comparison";
    proposalId: string;
    decisionId: string;
  },
): { descriptorText: string; opaqueAuthorizationRef: string } | { problem: string } {
  const run = harness.getRun(action.runId);
  if (!run || !run.projectId || !run.projectRoot) {
    return { problem: "The target run is not bound to one project root for governed sealed verification." };
  }
  if (
    run.context.designProposalId !== action.proposalId
    || run.context.designDecisionId !== action.decisionId
  ) {
    return { problem: "The target run does not freeze the requested proposal and authority decision." };
  }
  const proposal = harness.getDesignProposal({ id: action.proposalId });
  if (!proposal || proposal.projectId !== run.projectId || proposal.status !== "accepted") {
    return { problem: "The sealed descriptor proposal is not one accepted target-project proposal." };
  }
  const approvedDecisions = harness.listDesignDecisions({ proposalId: proposal.id, limit: 100 })
    .filter((decision) => decision.decision === "approved");
  const decision = approvedDecisions.find((candidate) => candidate.id === action.decisionId);
  if (!decision || approvedDecisions.at(-1)?.id !== decision.id) {
    return { problem: "The sealed descriptor decision is not the latest approved authority decision." };
  }
  const evaluationContract = objectRecordOrNull(proposal.proposal.evaluationContract);
  const comparison = objectRecordOrNull(evaluationContract?.comparison);
  const refs = Array.isArray(comparison?.holdoutEvidenceRefs) ? comparison.holdoutEvidenceRefs : [];
  if (
    refs.length !== action.expectedCount
    || !refs.every((ref): ref is string => typeof ref === "string" && ref.startsWith("fixture:"))
  ) {
    return { problem: "The accepted comparison does not contain the frozen fixture holdout count." };
  }
  const refsSha256 = createHash("sha256").update(JSON.stringify([...refs].sort())).digest("hex");
  if (refsSha256 !== action.expectedRefsSha256) {
    return { problem: "The accepted comparison holdout commitment does not match the fixed action." };
  }
  if (comparison?.corpusSnapshotSha256 !== action.expectedCorpusSnapshotSha256) {
    return { problem: "The accepted comparison corpus snapshot does not match the fixed action." };
  }
  let projectRoot: string;
  try {
    projectRoot = realpathSync(run.projectRoot);
  } catch {
    return { problem: "The target project root is unavailable for governed sealed verification." };
  }
  const projectCommon = safeGitStep(defaultGitRunner, projectRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const verifierCommon = safeGitStep(defaultGitRunner, action.repoPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (
    !projectCommon.ok || !verifierCommon.ok
    || realpathSync(projectCommon.stdout.trim()) !== realpathSync(verifierCommon.stdout.trim())
  ) {
    return { problem: "The sealed verification worktree does not share the target project Git identity." };
  }
  const entries: Array<{ ref: string; path: string }> = [];
  for (const ref of refs) {
    let relativePath: string;
    try {
      relativePath = exactRelativeGitPathField({ value: ref.slice("fixture:".length) }, "value", "holdoutEvidenceRefs[]");
      if (!relativePath.startsWith("tests/fixtures/") || isOuroborosRuntimePath(relativePath)) {
        return { problem: "The accepted comparison holdout reference is outside the project fixture boundary." };
      }
    } catch {
      return { problem: "The accepted comparison contains an invalid fixture holdout reference." };
    }
    const candidate = join(projectRoot, relativePath);
    try {
      const canonical = realpathSync(candidate);
      const stat = lstatSync(canonical);
      if (!stat.isFile() || stat.isSymbolicLink() || !canonical.startsWith(`${projectRoot}${sep}`)) {
        return { problem: "The governed holdout source is not one project-owned regular file." };
      }
      entries.push({ ref, path: canonical });
    } catch {
      return { problem: "The governed holdout source is unavailable on the host." };
    }
  }
  const descriptorText = JSON.stringify({ entries });
  return {
    descriptorText,
    opaqueAuthorizationRef: `authorization_sha256:${createHash("sha256").update(JSON.stringify({
      projectId: run.projectId,
      proposalId: proposal.id,
      decisionId: decision.id,
      expectedRefsSha256: action.expectedRefsSha256,
    })).digest("hex")}`,
  };
}

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

type FreezeVerifiedPackageCommitAction = Extract<HarnessAction, { type: "freezeVerifiedPackageCommit" }>;

function pathUnderOneRoot(path: string, roots: string[]) {
  return roots.some((root) => path.startsWith(root));
}

function latestDoneAttemptForTask(overview: RunOverview, taskId: string) {
  return [...overview.sessions].reverse().find((session) => session.taskId === taskId && session.status === "done") ?? null;
}

function verifiedPackageComparisonMatches(
  value: Record<string, unknown>,
  frozenComparison: Record<string, unknown>,
  projectId: string,
) {
  const fields = [
    "canonicalManifestSha256", "corpusSnapshotSha256", "equalBudget", "freezeStage",
    "holdoutEvidenceCommitment", "id", "kind", "maximumGuardRegression", "minimumUplift",
    "primaryMetric", "projectId", "reviewAt", "schemaVersion", "sourceByteCommitments",
  ].sort();
  if (Object.keys(value).sort().join("\0") !== fields.join("\0")) return false;
  const holdout = objectRecordOrNull(value.holdoutEvidenceCommitment);
  const commitments = objectRecordOrNull(value.sourceByteCommitments);
  if (!holdout || Object.keys(holdout).sort().join("\0") !== "algorithm\0count\0refsSha256"
    || holdout.algorithm !== "sha256" || !Number.isInteger(holdout.count) || Number(holdout.count) <= 0
    || typeof holdout.refsSha256 !== "string" || !/^[0-9a-f]{64}$/.test(holdout.refsSha256) || /^0+$/.test(holdout.refsSha256)
    || !commitments || Object.keys(commitments).length === 0 || Object.keys(commitments).length > EXACT_GIT_INDEX_MAX_FILES
    || Object.entries(commitments).some(([path, sha256]) =>
      !path.startsWith("config/evolution/v5/") || isOuroborosRuntimePath(path)
      || typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256) || /^0+$/.test(sha256))) {
    return false;
  }
  const reviewAt = typeof value.reviewAt === "string" ? value.reviewAt : "";
  const validReviewAt = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(reviewAt)
    && Number.isFinite(Date.parse(reviewAt));
  return value.schemaVersion === 1
    && value.kind === "comparison-freeze"
    && value.id === "comparison-freeze:target-evolution-v5"
    && value.freezeStage === "comparison-freeze-before-comparison"
    && value.projectId === projectId
    && typeof value.canonicalManifestSha256 === "string"
    && /^[0-9a-f]{64}$/.test(value.canonicalManifestSha256) && !/^0+$/.test(value.canonicalManifestSha256)
    && validReviewAt
    && value.corpusSnapshotSha256 === frozenComparison.corpusSnapshotSha256
    && sameCanonicalValue(value.equalBudget, frozenComparison.equalBudget)
    && value.primaryMetric === frozenComparison.primaryMetric
    && value.minimumUplift === frozenComparison.minimumUplift
    && value.maximumGuardRegression === frozenComparison.maximumGuardRegression;
}

function freezeVerifiedPackageCommit(
  harness: Harness,
  action: FreezeVerifiedPackageCommitAction,
  options: HarnessActionOptions,
): HarnessActionResult {
  const checks: HarnessActionResult["checks"] = [];
  const run = harness.getRun(action.runId);
  const task = harness.getTask(action.taskId);
  const verifier = harness.getTask(action.verifierTaskId);
  if (!run || !task || !verifier || task.runId !== run.id || verifier.runId !== run.id) {
    return failedHostEvidenceAction(action, "Run, execution task, and Verifier must belong to the same delivery.", checks);
  }
  if (task.status !== "done" || task.role !== "worker" || !task.worktreePath) {
    return failedHostEvidenceAction(action, "The package source must be one completed Worker or Repair with a worktree.", checks);
  }
  if (verifier.status !== "done" || verifier.role !== "verifier" || !verifier.dependsOn.includes(task.id)) {
    return failedHostEvidenceAction(action, "The named independent Verifier must be done and depend on the package source task.", checks);
  }
  const overview = harness.getRunOverview({ runId: run.id, eventLimit: 0 });
  const sourceAttempt = latestDoneAttemptForTask(overview, task.id);
  const verifierAttempt = latestDoneAttemptForTask(overview, verifier.id);
  if (!sourceAttempt || sourceAttempt.output.status !== "done" || (sourceAttempt.output.problems ?? []).length > 0) {
    return failedHostEvidenceAction(action, "The package source has no clean completed attempt evidence.", checks);
  }
  const verifierChecks = Array.isArray(verifierAttempt?.output.checks) ? verifierAttempt!.output.checks : [];
  const requiredVerifierChecks = ["frozen-offline-suite", "authorized-artifact-surface", "canonical-manifest-binding", "side-effects"];
  if (
    !verifierAttempt || verifierAttempt.output.status !== "done" || verifierAttempt.output.verdict !== "pass" ||
    (verifierAttempt.output.problems ?? []).length > 0 || verifierChecks.some(isFailedCheck) ||
    requiredVerifierChecks.some((name) => !verifierChecks.some((check) => objectRecordOrNull(check)?.name === name && objectRecordOrNull(check)?.status === "passed"))
  ) {
    return failedHostEvidenceAction(action, "The independent Verifier does not contain the required machine-readable pass evidence.", checks);
  }
  const verifierEvidence = exactCommitVerifierEvidence(overview, task.id, verifier.id);
  if (!verifierEvidence.ok) {
    return failedHostEvidenceAction(action, `Verifier lineage is unresolved: ${verifierEvidence.reason}.`, checks);
  }
  const sourceChecks = Array.isArray(sourceAttempt.output.checks) ? sourceAttempt.output.checks : [];
  for (const name of ["node-test-all-pass-no-skip", "zero-side-effect-counters", "authorized-paths-only-no-ouroboros-touches"]) {
    if (!sourceChecks.some((check) => objectRecordOrNull(check)?.name === name && objectRecordOrNull(check)?.status === "passed")) {
      return failedHostEvidenceAction(action, `The package source is missing passed check ${name}.`, checks);
    }
  }
  if (!new RegExp(`\\b${action.expectedTestPasses}/${action.expectedTestPasses}\\b`).test(sourceAttempt.output.summary ?? "")) {
    return failedHostEvidenceAction(action, `The package source does not attest ${action.expectedTestPasses}/${action.expectedTestPasses} offline tests.`, checks);
  }
  const sideEffectCounters = sourceSideEffectReceipt(sourceAttempt);
  if (!sideEffectCounters) {
    return failedHostEvidenceAction(action, "The package source lacks one machine-readable zero-side-effect receipt.", checks);
  }
  checks.push({ name: "verified package evidence", status: "passed", evidence: `${sourceAttempt.attemptId}:${verifierAttempt.attemptId}` });

  if (!existsSync(action.repoPath)) return failedHostEvidenceAction(action, "Repository path does not exist.", checks);
  const taskWorktreePath = task.worktreePath;
  try {
    if (!taskWorktreePath || realpathSync(taskWorktreePath) !== realpathSync(action.repoPath)) {
      return failedHostEvidenceAction(action, "Package source worktree does not match repoPath.", checks);
    }
  } catch {
    return failedHostEvidenceAction(action, "Package source worktree cannot be resolved.", checks);
  }
  const git = options.runGit ?? defaultGitRunner;
  const top = safeGitStep(git, action.repoPath, ["rev-parse", "--show-toplevel"]);
  const branch = safeGitStep(git, action.repoPath, ["branch", "--show-current"]);
  const head = safeGitStep(git, action.repoPath, ["rev-parse", "HEAD"]);
  if (!top.ok || !branch.ok || !head.ok || realpathSync(top.stdout.trim()) !== realpathSync(action.repoPath)
    || branch.stdout.trim() !== action.branch || head.stdout.trim() !== action.expectedParentSha) {
    return failedHostEvidenceAction(action, "Repository identity, branch, or parent SHA does not match the frozen request.", checks);
  }
  const changedFiles = Array.isArray(sourceAttempt.output.changedFiles) ? sourceAttempt.output.changedFiles : [];
  if (changedFiles.length === 0 || changedFiles.length > EXACT_GIT_INDEX_MAX_FILES
    || !changedFiles.every((path): path is string => typeof path === "string")
    || new Set(changedFiles).size !== changedFiles.length
    || changedFiles.some((path) => !pathUnderOneRoot(path, action.allowedRoots) || isOuroborosRuntimePath(path))) {
    return failedHostEvidenceAction(action, "Source changedFiles must be a unique bounded list inside the frozen package roots.", checks);
  }
  const present: string[] = [];
  const missing: string[] = [];
  for (const path of changedFiles) {
    const absolute = join(action.repoPath, path);
    if (!existsSync(absolute)) {
      const parentEntry = safeGitStep(git, action.repoPath, ["cat-file", "-e", `${action.expectedParentSha}:${path}`]);
      if (parentEntry.ok) return failedHostEvidenceAction(action, `Missing source path would silently delete a tracked file: ${path}.`, checks);
      missing.push(path);
      continue;
    }
    try {
      const stat = lstatSync(absolute);
      if (!stat.isFile() || stat.isSymbolicLink() || !realpathSync(absolute).startsWith(`${realpathSync(action.repoPath)}${sep}`)) {
        return failedHostEvidenceAction(action, `Package path is not one regular in-repository file: ${path}.`, checks);
      }
    } catch {
      return failedHostEvidenceAction(action, `Package path cannot be read: ${path}.`, checks);
    }
    present.push(path);
  }
  if (!sameUniqueStrings(missing, action.expectedAbsentPaths)) {
    return failedHostEvidenceAction(action, "Missing source paths do not exactly match expectedAbsentPaths.", checks);
  }
  if (present.length === 0) return failedHostEvidenceAction(action, "The verified package has no files to commit.", checks);

  const unstaged = safeGitStep(git, action.repoPath, ["diff", "--name-only", "-z"]);
  const stagedBefore = safeGitStep(git, action.repoPath, ["diff", "--cached", "--name-only", "-z", action.expectedParentSha, "--"]);
  const untracked = safeGitStep(git, action.repoPath, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const conflicts = safeGitStep(git, action.repoPath, ["ls-files", "--unmerged", "-z"]);
  if (!unstaged.ok || unstaged.stdout.length > 0 || !stagedBefore.ok
    || !untracked.ok || !conflicts.ok || conflicts.stdout.length > 0) {
    return failedHostEvidenceAction(action, "Repository must have only untracked package and explicitly preserved runtime files before staging.", checks);
  }
  const untrackedPaths = untracked.stdout.split("\0").filter(Boolean);
  const presentSet = new Set(present);
  const unauthorized = untrackedPaths.filter((path) => !presentSet.has(path) && !pathUnderOneRoot(path, action.preservedUntrackedRoots));
  const preservedUntrackedPaths = untrackedPaths.filter((path) => pathUnderOneRoot(path, action.preservedUntrackedRoots));
  const replay = sameNullSeparatedPaths(stagedBefore.stdout, present);
  const missingUntracked = replay ? [] : present.filter((path) => !untrackedPaths.includes(path));
  if (unauthorized.length > 0 || missingUntracked.length > 0 || (!replay && stagedBefore.stdout.length > 0)) {
    return failedHostEvidenceAction(action, `Untracked scope differs from the frozen package: ${[...unauthorized, ...missingUntracked].join(",")}.`, checks);
  }
  const comparisonAbsolute = join(action.repoPath, action.comparisonPath);
  if (!presentSet.has(action.comparisonPath)) {
    return failedHostEvidenceAction(action, "The frozen comparison file must be part of the committed package.", checks);
  }
  let comparisonFile: Record<string, unknown>;
  try {
    comparisonFile = JSON.parse(readFileSync(comparisonAbsolute, "utf8")) as Record<string, unknown>;
  } catch {
    return failedHostEvidenceAction(action, "The frozen comparison file is not valid JSON.", checks);
  }
  const comparisonFileSha256 = sha256File(comparisonAbsolute);
  if (comparisonFileSha256 !== action.expectedComparisonFileSha256) {
    return failedHostEvidenceAction(action, "The package comparison file SHA-256 does not match the frozen whole-file receipt.", checks);
  }
  const frozenComparison = objectRecordOrNull(objectRecordOrNull(run.context.designEvaluationContract)?.comparison);
  if (!frozenComparison || !run.projectId || !verifiedPackageComparisonMatches(comparisonFile, frozenComparison, run.projectId)) {
    return failedHostEvidenceAction(action, "The package comparison file changed the frozen evaluation comparison.", checks);
  }
  if (!replay) {
    const add = safeGitStep(git, action.repoPath, ["add", "--", ...present]);
    if (!add.ok) return failedHostEvidenceAction(action, "Host could not stage the verified package files.", checks);
  }

  const files: Array<ExactGitIndexFile & { sha256: string }> = [];
  for (const path of present.sort()) {
    const blob = safeGitStep(git, action.repoPath, ["hash-object", "--", path]);
    const entry = safeGitStep(git, action.repoPath, ["ls-files", "--stage", "-z", "--", path]);
    const exact = { status: "A" as const, path, mode: "100644" as const, blobOid: blob.stdout.trim() };
    if (!blob.ok || !/^[0-9a-f]{40}$/.test(exact.blobOid) || !entry.ok || !sameExactIndexEntry(entry.stdout, exact)) {
      return failedHostEvidenceAction(action, `Staged package blob does not match ${path}.`, checks);
    }
    const sha256 = sha256File(join(action.repoPath, path));
    if (!sha256) return failedHostEvidenceAction(action, `Could not hash package path ${path}.`, checks);
    files.push({ ...exact, sha256 });
  }
  const contract = {
    runId: action.runId,
    taskId: action.taskId,
    verifierTaskId: action.verifierTaskId,
    repoPath: action.repoPath,
    branch: action.branch,
    expectedParentSha: action.expectedParentSha,
    commitMessage: action.commitMessage,
    files: files.map(({ sha256: _sha256, ...file }) => file),
    verifiedAbsentPaths: missing.sort(),
    preservedUntrackedRoots: [...action.preservedUntrackedRoots].sort(),
  };
  const existingContracts = objectRecordOrNull(run.context.gitIndexCommitContracts) ?? {};
  const existing = objectRecordOrNull(existingContracts[action.contractId]);
  if (existing && !sameCanonicalValue(existing, contract)) {
    return failedHostEvidenceAction(action, `Frozen Git index contract ${action.contractId} conflicts with this package.`, checks);
  }
  harness.updateRun({
    runId: run.id,
    contextPatch: { gitIndexCommitContracts: { ...existingContracts, [action.contractId]: contract } },
  });
  checks.push({ name: "exact package paths and SHA-256", status: "passed", evidence: `${files.length}:${stableFingerprint(files)}` });
  checks.push({ name: "frozen comparison unchanged", status: "passed", evidence: stableFingerprint(frozenComparison) });
  checks.push({ name: "preserved untracked boundary", status: "passed", evidence: `${action.preservedUntrackedRoots.join(",")}:${preservedUntrackedPaths.length}` });
  return doneResult(action.type, `Frozen and staged ${files.length} verified package files.`, checks, [{
    kind: "verified_package_commit_freeze",
    contractId: action.contractId,
    runId: run.id,
    taskId: task.id,
    verifierTaskId: verifier.id,
    sourceAttemptId: sourceAttempt.attemptId,
    verifierAttemptId: verifierAttempt.attemptId,
    fileCount: files.length,
    files,
    verifiedAbsentPaths: missing.sort(),
    preservedUntrackedRoots: [...action.preservedUntrackedRoots].sort(),
    preservedUntrackedCount: preservedUntrackedPaths.length,
    comparisonPath: action.comparisonPath,
    comparisonFileSha256,
    comparisonContractSha256: stableFingerprint(frozenComparison),
    sideEffectCounters,
    reused: replay,
  }]);
}

type FreezeExactGitPushAction = Extract<HarnessAction, { type: "freezeExactGitPush" }>;

function freezeExactGitPush(harness: Harness, action: FreezeExactGitPushAction): HarnessActionResult {
  const checks: HarnessActionResult["checks"] = [];
  const run = harness.getRun(action.runId);
  const event = harness.getHarnessActionEvent({ id: action.commitActionEventId });
  if (!run || !event || event.status !== "done" || event.actionType !== "commitExactGitIndex" || event.request.runId !== run.id) {
    return blockedResult(action.type, "The exact commit receipt is missing or does not belong to this run.", [action.commitActionEventId]);
  }
  const eventArtifacts = Array.isArray(event.result.artifacts) ? event.result.artifacts : [];
  const commit = eventArtifacts.map(objectRecordOrNull).find((artifact) =>
    artifact?.kind === "git_commit" && artifact.runId === run.id && artifact.repoPath === action.repoPath);
  if (!commit || typeof commit.sha !== "string" || commit.parentSha !== action.expectedOldSha) {
    return blockedResult(action.type, "The exact commit receipt does not match the frozen repository or old SHA.", [action.commitActionEventId]);
  }
  const contract = {
    repoPath: action.repoPath,
    remoteHost: action.remoteHost,
    repository: action.repository,
    ref: action.ref,
    expectedOldSha: action.expectedOldSha,
    newSha: commit.sha,
  };
  const contracts = objectRecordOrNull(run.context.gitRemoteWriteContracts) ?? {};
  const existing = objectRecordOrNull(contracts[action.contractId]);
  if (existing && !sameCanonicalValue(existing, contract)) {
    return blockedResult(action.type, `Frozen Git push contract ${action.contractId} conflicts with the exact commit.`, [action.contractId]);
  }
  harness.updateRun({ runId: run.id, contextPatch: { gitRemoteWriteContracts: { ...contracts, [action.contractId]: contract } } });
  checks.push({ name: "exact commit receipt", status: "passed", evidence: action.commitActionEventId });
  checks.push({ name: "frozen remote ref", status: "passed", evidence: `${action.remoteHost}/${action.repository}:${action.ref}` });
  return doneResult(action.type, `Frozen exact push ${action.contractId} for ${commit.sha}.`, checks, [{
    kind: "git_push_contract",
    contractId: action.contractId,
    commitActionEventId: event.id,
    ...contract,
  }]);
}

type CompleteVerifiedPackageDeliveryAction = Extract<HarnessAction, { type: "completeVerifiedPackageDelivery" }>;

function completeVerifiedPackageDelivery(
  harness: Harness,
  action: CompleteVerifiedPackageDeliveryAction,
): HarnessActionResult {
  try {
    return harness.runInImmediateTransaction((db) => {
      const run = harness.getRunWithDb(db, action.runId);
      if (!run || !run.projectId || run.context.source !== "design") {
        throw new Error("verified package closeout requires one project-bound design delivery run");
      }
      const commitEvent = harness.getHarnessActionEventWithDb(db, { id: action.commitActionEventId });
      const pushEvent = harness.getHarnessActionEventWithDb(db, { id: action.pushActionEventId });
      if (!commitEvent || commitEvent.status !== "done" || commitEvent.actionType !== "commitExactGitIndex"
        || commitEvent.request.runId !== run.id) {
        throw new Error("exact commit action is not a successful receipt for this run");
      }
      if (!pushEvent || pushEvent.status !== "done" || pushEvent.actionType !== "pushExactGitRef"
        || pushEvent.request.runId !== run.id) {
        throw new Error("exact push action is not a successful receipt for this run");
      }
      const commitArtifacts = Array.isArray(commitEvent.result.artifacts) ? commitEvent.result.artifacts : [];
      const pushArtifacts = Array.isArray(pushEvent.result.artifacts) ? pushEvent.result.artifacts : [];
      const commit = commitArtifacts.map(objectRecordOrNull).find((artifact) => artifact?.kind === "git_commit");
      const push = pushArtifacts.map(objectRecordOrNull).find((artifact) =>
        artifact?.kind === "git_remote_write" && artifact.outcome === "verified");
      if (!commit || !push || typeof commit.sha !== "string" || push.newSha !== commit.sha) {
        throw new Error("commit and independently read-back remote SHA do not match");
      }
      const overview = harness.getRunOverviewWithDb(db, { runId: run.id, eventLimit: 0 });
      if (overview.tasks.some((task) => task.status === "todo" || task.status === "running")) {
        throw new Error("delivery still has active tasks and cannot close");
      }
      const integration = commitArtifacts.map(objectRecordOrNull).find((artifact) =>
        artifact?.kind === "integration" && artifact.mode === "exact_git_index_commit");
      if (!integration || typeof integration.verifierTaskId !== "string"
        || commit.verifierTaskId !== integration.verifierTaskId || typeof commit.taskId !== "string") {
        throw new Error("exact commit lacks independent Verifier integration evidence");
      }
      const verifierEvidence = exactCommitVerifierEvidence(overview, commit.taskId, integration.verifierTaskId);
      if (!verifierEvidence.ok) {
        throw new Error(`exact commit Verifier receipt is no longer valid: ${verifierEvidence.reason}`);
      }
      const nextRunId = `run_${createHash("sha1").update(`verified-package-next|${run.id}|${commit.sha}`).digest("hex")}`;
      const nextTaskId = `task_${createHash("sha1").update(`verified-package-next-task|${run.id}|${commit.sha}`).digest("hex")}`;
      const signalId = `signal_verified_package_${createHash("sha256").update(`${run.id}|${commit.sha}`).digest("hex").slice(0, 32)}`;
      const existingCloseout = objectRecordOrNull(run.context.verifiedPackageCloseout);
      if (existingCloseout) {
        if (existingCloseout.commitSha !== commit.sha || existingCloseout.nextDesignerRunId !== nextRunId) {
          throw new Error("verified package closeout conflicts with the existing terminal receipt");
        }
        return doneResult(action.type, `Verified package closeout for ${run.id} reused.`, [
          { name: "terminal receipt", status: "passed", evidence: String(commit.sha) },
        ], [{ kind: "verified_package_closeout", ...existingCloseout, reused: true }]);
      }
      const now = new Date().toISOString();
      const closeout = {
        schemaVersion: 1,
        commitActionEventId: commitEvent.id,
        pushActionEventId: pushEvent.id,
        commitSha: commit.sha,
        tree: commit.tree,
        remoteRef: push.ref,
        verifierTaskId: integration.verifierTaskId,
        packageOnly: true,
        overallGoalComplete: false,
        nextDesignerRunId: nextRunId,
        nextDesignerTaskId: nextTaskId,
        recordedAt: now,
      };
      harness.createStrategySignalWithDb(db, {
        id: signalId,
        projectId: run.projectId,
        signalClass: "system",
        source: `verified-package-integration:${run.id}`,
        title: "Verified evaluation package is ready for runtime integration",
        summary: "The versioned evaluation and contract package is committed and independently read back remotely. Runtime integration and real end-to-end evidence remain open.",
        observationTime: now,
        confidence: 1,
        evidence: [`run:${run.id}`, `action:${commitEvent.id}`, `action:${pushEvent.id}`, `commit:${commit.sha}`],
        runId: run.id,
        taskId: String(commit.taskId),
        payload: { kind: "verified-package-runtime-integration-needed", closeout, sideEffectCounters: zeroSideEffectCounters() },
      });
      harness.createRunWithDb(db, {
        id: nextRunId,
        goal: action.nextGoal,
        projectId: run.projectId,
        projectRoot: run.projectRoot,
        context: {
          source: "target-system-design",
          parentRunId: run.id,
          projectId: run.projectId,
          founderCharterId: run.context.founderCharterId,
          designCharterId: run.context.designCharterId ?? run.context.founderCharterId,
          evolutionInstance: run.context.evolutionInstance,
          verifiedPackageEvidence: { signalId, ...closeout },
          targetSystemEvidenceBundle: {
            schemaVersion: 1,
            purpose: "runtime-integration-after-verified-package",
            signalId,
            sourceRunId: run.id,
            commitSha: commit.sha,
            remoteRef: push.ref,
            packageOnly: true,
            overallGoalComplete: false,
          },
        },
      });
      harness.createTaskWithDb(db, {
        id: nextTaskId,
        runId: nextRunId,
        role: "designer",
        goal: action.nextGoal,
        prompt: [
          "Design the smallest evidence-backed runtime integration after the verified package delivery.",
          "The prior delivery established only the evaluation and contract package; it did not integrate the capability into the target runtime.",
          `Use durable evidence ${signalId}, commit ${commit.sha}, and remote ref ${String(push.ref)}.`,
          "Propose a governed delivery with real end-to-end evidence, or return a mutation-free quiescent decision. Do not implement in this task.",
        ].join("\n"),
        doneWhen: [
          "the verified package receipt is read back",
          "runtime integration scope and end-to-end evidence are explicit",
          "one governed proposal is emitted or a justified mutation-free quiescent decision is recorded",
          "no implementation or browser execution occurs",
        ],
        config: {
          readOnly: true,
          forbidImplementation: true,
          forbidBrowser: true,
          browserProcessPolicy: "deny",
          verifiedPackageEvidence: { signalId, ...closeout },
        },
      });
      harness.updateRunWithDb(db, { runId: run.id, contextPatch: { verifiedPackageCloseout: closeout } });
      harness.updateRunStatusWithDb(db, { runId: run.id, status: "done" });
      return doneResult(action.type, `Verified package ${commit.sha} closed and runtime integration Designer ${nextTaskId} created.`, [
        { name: "exact commit", status: "passed", evidence: commitEvent.id },
        { name: "independent remote readback", status: "passed", evidence: pushEvent.id },
        { name: "delivery terminal", status: "passed", evidence: "done" },
        { name: "next governed Designer", status: "passed", evidence: nextTaskId },
      ], [{ kind: "verified_package_closeout", ...closeout, signalId, reused: false }]);
    });
  } catch (error) {
    return blockedResult(action.type, `Verified package closeout blocked: ${errorMessage(error)}`, [errorMessage(error)]);
  }
}

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

  const frozen = frozenGitIndexCommitContract(run.context, action.contractId)
    ?? stagedGitIndexCommitContract(harness, action);
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
  const expectedReportedPaths = [...contractPaths, ...(action.verifiedAbsentPaths ?? [])];
  if (!attempt || !sameUniqueStrings(changedFiles, expectedReportedPaths)) {
    return failedGitIndexCommit(
      action,
      "task_invalid",
      `Task ${action.taskId} done attempt changedFiles do not exactly match the frozen files.`,
      checks,
    );
  }
  checks.push({ name: "worker changedFiles", status: "passed", evidence: contractPaths.join(",") });

  const verifierEvidence = exactCommitVerifierEvidence(overview, action.taskId, action.verifierTaskId);
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

  const initialWorktreeState = exactGitWorktreeState(git, action.repoPath, action.preservedUntrackedRoots ?? []);
  if (!initialWorktreeState.ok) {
    return failedGitIndexCommit(
      action,
      "repo_invalid",
      initialWorktreeState.summary,
      checks,
      initialWorktreeState.result,
    );
  }
  checks.push({ name: "worktree state", status: "passed", evidence: "no unstaged or conflicted files; only frozen preserved untracked roots" });

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
  const lateWorktreeState = exactGitWorktreeState(git, action.repoPath, action.preservedUntrackedRoots ?? []);
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
  const fields = [
    "branch",
    "commitMessage",
    ...(action.verifiedAbsentPaths === undefined ? [] : ["verifiedAbsentPaths"]),
    "expectedParentSha",
    "files",
    ...(action.preservedUntrackedRoots === undefined ? [] : ["preservedUntrackedRoots"]),
    "repoPath",
    "runId",
    "taskId",
    ...(action.verifierTaskId === undefined ? [] : ["verifierTaskId"]),
  ].sort();
  if (Object.keys(frozen).sort().join("\0") !== fields.join("\0")) {
    return false;
  }
  return frozen.runId === action.runId &&
    frozen.taskId === action.taskId &&
    frozen.repoPath === action.repoPath &&
    frozen.branch === action.branch &&
    frozen.expectedParentSha === action.expectedParentSha &&
    frozen.commitMessage === action.commitMessage &&
    JSON.stringify(frozen.files) === JSON.stringify(action.files) &&
    (action.verifierTaskId === undefined || frozen.verifierTaskId === action.verifierTaskId) &&
    (action.verifiedAbsentPaths === undefined || JSON.stringify(frozen.verifiedAbsentPaths) === JSON.stringify(action.verifiedAbsentPaths)) &&
    (action.preservedUntrackedRoots === undefined || JSON.stringify(frozen.preservedUntrackedRoots) === JSON.stringify(action.preservedUntrackedRoots));
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
  verifierTaskId?: string,
): { ok: true; verifiers: Task[] } | { ok: false; reason: string } {
  const verifiers = overview.tasks.filter((task) =>
    task.role === "verifier" && task.dependsOn.includes(workerTaskId)
  );
  if (verifiers.length === 0) {
    return { ok: false, reason: "no dependency verifier exists" };
  }
  if (verifierTaskId && !verifiers.some((verifier) => verifier.id === verifierTaskId)) {
    return { ok: false, reason: `frozen verifier ${verifierTaskId} is not a dependency verifier` };
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
    const problems = Array.isArray(latestAttempt.output.problems) ? latestAttempt.output.problems : [];
    if (checks.some(isFailedCheck) || (verifierTaskId !== undefined && (latestAttempt.output.verdict !== "pass" || problems.length > 0))) {
      return { ok: false, reason: `verifier ${verifier.id} has no clean machine-readable pass verdict` };
    }
  }
  return { ok: true, verifiers: verifierTaskId ? verifiers.filter((verifier) => verifier.id === verifierTaskId) : verifiers };
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
  preservedUntrackedRoots: string[] = [],
):
  | { ok: true }
  | { ok: false; summary: string; result: ReturnType<typeof safeGitStep> } {
  const unstaged = safeGitStep(git, repoPath, ["diff", "--name-only", "-z"]);
  if (!unstaged.ok || unstaged.stdout.length > 0) {
    return { ok: false, summary: "Repository has unstaged changes.", result: unstaged };
  }
  const untracked = safeGitStep(git, repoPath, ["ls-files", "--others", "--exclude-standard", "-z"]);
  const untrackedPaths = untracked.stdout.split("\0").filter(Boolean);
  if (!untracked.ok || untrackedPaths.some((path) => !pathUnderOneRoot(path, preservedUntrackedRoots))) {
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
  const clean = exactGitWorktreeState(git, action.repoPath, action.preservedUntrackedRoots ?? []);
  if (!clean.ok) {
    return { ok: false, result: clean.result };
  }
  return {
    ok: true,
    checks: [
      { name: "independent commit readback", status: "passed", evidence: commitSha },
      { name: "parent tree message signature", status: "passed", evidence: "exact unsigned commit" },
      ...exactTree.checks,
      { name: "worktree boundary", status: "passed", evidence: "clean except frozen preserved untracked roots" },
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
      verifierTaskId,
      verifiedAbsentPaths: action.verifiedAbsentPaths ?? [],
      preservedUntrackedRoots: action.preservedUntrackedRoots ?? [],
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
      verifiedAbsentPaths: action.verifiedAbsentPaths ?? [],
      preservedDisjointFiles: action.preservedUntrackedRoots ?? [],
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
    const result = runGitStep(git, cwd, args, {
      ...limits,
      ...(isGitRemoteCommand(args) ? { env: clearedAmbientProxyEnv() } : {}),
    });
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
    followUpTaskId
      ? `Interrupted attempt ${prepared.attempt.id} and created follow-up task ${followUpTaskId}.`
      : `Interrupted attempt ${prepared.attempt.id} without creating replacement work.`,
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
      ...(followUpTaskId
        ? [{ name: "follow-up task created", status: "passed" as const, evidence: followUpTaskId }]
        : [{ name: "replacement work", status: "passed" as const, evidence: "none created" }]),
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
      ...(followUpTaskId && action.followUpTask ? [{
        kind: "task",
        taskId: followUpTaskId,
        runId: prepared.run.id,
        parentTaskId: prepared.task.id,
        role: action.followUpTask.role,
        status: "todo",
        reason: action.reason,
      }] : []),
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

type TargetSystemDesignQuiescence = {
  schemaVersion: 1;
  decision: "no-design-action";
  fingerprint: string;
  sourceTaskId: string;
  sourceAttemptId: string;
  recoveryTaskId: string;
  recoveryRootTaskId: string;
  goalReviewTaskIds: string[];
  summary: string;
  recordedAt: string;
};

function closeTargetSystemDesignQuiescence(
  harness: Harness,
  runId: string,
): HarnessActionResult | null {
  return harness.runInImmediateTransaction((db) => {
    const overview = harness.getRunOverviewWithDb(db, { runId, eventLimit: 0 });
    const run = overview.run;
    if (!run || run.context.source !== "target-system-design" || run.context.retired === true) {
      return null;
    }
    if (overview.tasks.some((task) => task.status === "todo" || task.status === "running")) {
      return null;
    }
    const hasActiveDesignChild = harness.listRunsWithDb(db, { statuses: ["todo", "running"], limit: 1000 }).some(
      (candidate) => candidate.context.parentRunId === runId
        && candidate.context.source === "design"
        && candidate.context.retired !== true,
    );
    if (hasActiveDesignChild) {
      return null;
    }

    const sourceSession = [...overview.sessions].reverse().find((session) =>
      session.role === "designer"
      && session.status === "done"
      && session.output.status === "done"
      && Array.isArray(session.output.designActions)
      && session.output.designActions.length === 0
      && Array.isArray(session.output.nextTasks)
      && session.output.nextTasks.length === 0
      && Array.isArray(session.output.nextRuns)
      && session.output.nextRuns.length === 0
      && Array.isArray(session.output.changedFiles)
      && session.output.changedFiles.length === 0
      && typeof session.output.summary === "string"
      && session.output.summary.trim().length > 0,
    );
    if (!sourceSession) {
      return null;
    }
    const sourceTask = overview.tasks.find((task) => task.id === sourceSession.taskId);
    if (!sourceTask || sourceTask.status !== "done") {
      return null;
    }

    const directRecovery = readDesignerActionRecovery(sourceTask);
    const continuation = readDesignerSignalContinuation(sourceTask);
    const recoveryTask = directRecovery
      ? sourceTask
      : continuation
        ? overview.tasks.find((task) => task.id === continuation.sourceTaskId) ?? null
        : null;
    const recovery = recoveryTask ? readDesignerActionRecovery(recoveryTask) : null;
    if (
      !recoveryTask
      || !recovery
      || recoveryTask.config?.forbidImplementation !== true
      || recoveryTask.config?.forbidBrowser !== true
      || recoveryTask.config?.readOnly !== true
      || (continuation && !sourceTask.dependsOn.includes(recoveryTask.id))
    ) {
      return null;
    }

    const sourceTaskIndex = overview.tasks.findIndex((task) => task.id === sourceTask.id);
    if (sourceTaskIndex < 0) {
      return null;
    }
    const laterTasks = overview.tasks.slice(sourceTaskIndex + 1);
    if (laterTasks.some((task) => task.role !== "goal-review")) {
      return null;
    }
    const goalReviewTaskIds = laterTasks.map((task) => task.id);
    for (const reviewTask of laterTasks) {
      const reviewSession = [...overview.sessions].reverse().find((session) => session.taskId === reviewTask.id);
      if (!reviewSession || reviewSession.status === "blocked") {
        continue;
      }
      const decision = resolveRunDecision(reviewSession.output);
      if (decision === "complete" || decision === "defer") {
        return null;
      }
      const proposedTasks = reviewSession.output.nextTasks ?? [];
      const governedRejection = (reviewSession.output.artifacts ?? []).some((artifact) => {
        if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
          return false;
        }
        const kind = (artifact as Record<string, unknown>).kind;
        return kind === "reused_designer_recovery" || kind === "designer_recovery_exhausted";
      });
      if (proposedTasks.length > 0 && !governedRejection) {
        return null;
      }
    }

    const fingerprintInput = JSON.stringify({
      schemaVersion: 1,
      runId,
      sourceTaskId: sourceTask.id,
      sourceAttemptId: sourceSession.attemptId,
      recoveryTaskId: recoveryTask.id,
      recoveryRootTaskId: recovery.rootTaskId,
      summary: sourceSession.output.summary,
      problems: sourceSession.output.problems ?? [],
    });
    const fingerprint = createHash("sha256").update(fingerprintInput).digest("hex");
    const existing = run.context.targetSystemDesignQuiescence;
    const existingRecord = existing && typeof existing === "object" && !Array.isArray(existing)
      ? existing as Record<string, unknown>
      : null;
    const reused = existingRecord?.schemaVersion === 1
      && existingRecord.decision === "no-design-action"
      && existingRecord.fingerprint === fingerprint
      && existingRecord.sourceTaskId === sourceTask.id
      && existingRecord.sourceAttemptId === sourceSession.attemptId;
    const quiescence: TargetSystemDesignQuiescence = reused
      ? existingRecord as unknown as TargetSystemDesignQuiescence
      : {
          schemaVersion: 1,
          decision: "no-design-action",
          fingerprint,
          sourceTaskId: sourceTask.id,
          sourceAttemptId: sourceSession.attemptId,
          recoveryTaskId: recoveryTask.id,
          recoveryRootTaskId: recovery.rootTaskId,
          goalReviewTaskIds,
          summary: sourceSession.output.summary,
          recordedAt: sourceSession.finishedAt ?? new Date().toISOString(),
        };
    if (!reused || run.status !== "blocked") {
      harness.updateRunWithDb(db, {
        runId,
        status: "blocked",
        contextPatch: { targetSystemDesignQuiescence: quiescence },
      });
    }
    return doneResult(
      "prepareRunDrain",
      reused
        ? `Run ${runId} is already quiescent at Designer attempt ${sourceSession.attemptId}.`
        : `Run ${runId} is quiescent after bounded Designer attempt ${sourceSession.attemptId}.`,
      [
        { name: "target-system design root", status: "passed", evidence: runId },
        { name: "bounded Designer recovery", status: "passed", evidence: `${recoveryTask.id}:1/1` },
        { name: "mutation-free continuation", status: "passed", evidence: sourceSession.attemptId },
        { name: "active governed work", status: "passed", evidence: "0" },
        { name: "repair budget", status: "passed", evidence: "unchanged" },
      ],
      [{
        kind: "target_system_design_quiescence",
        runId,
        status: "blocked",
        reused,
        ...quiescence,
      }],
    );
  });
}

function stagedGitIndexCommitContract(
  harness: Harness,
  action: ExactGitIndexCommitAction,
): Record<string, unknown> | null {
  const event = harness.listHarnessActionEvents({ limit: 500 }).find((candidate) => {
    if (candidate.actionType !== "stageExactWorkerFilesForVerification" || candidate.status !== "done") return false;
    const request = candidate.request as Record<string, unknown>;
    return request.contractId === action.contractId && request.runId === action.runId && request.taskId === action.taskId;
  });
  if (!event) return null;
  const request = event.request as Record<string, unknown>;
  const result = event.result as Record<string, unknown>;
  const artifacts = Array.isArray(result.artifacts) ? result.artifacts : [];
  const receipt = artifacts.find((artifact) => {
    const value = artifact && typeof artifact === "object" && !Array.isArray(artifact)
      ? artifact as Record<string, unknown>
      : null;
    return value?.kind === "pre_verification_git_index" && value.contractId === action.contractId;
  }) as Record<string, unknown> | undefined;
  if (!receipt || !Array.isArray(receipt.files)) return null;
  const files = receipt.files.map((file) => {
    const value = file as Record<string, unknown>;
    return { status: value.status, path: value.path, mode: value.mode, blobOid: value.blobOid };
  });
  return {
    runId: request.runId,
    taskId: request.taskId,
    repoPath: request.repoPath,
    branch: request.branch,
    expectedParentSha: request.expectedParentSha,
    commitMessage: request.commitMessage,
    files,
  };
}

function readDesignerActionRecovery(task: Task) {
  const raw = task.config?.designActionRecovery;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (
    typeof record.rootTaskId !== "string"
    || typeof record.sourceTaskId !== "string"
    || typeof record.sourceAttemptId !== "string"
    || record.count !== 1
    || record.limit !== 1
  ) {
    return null;
  }
  return {
    rootTaskId: record.rootTaskId,
    sourceTaskId: record.sourceTaskId,
    sourceAttemptId: record.sourceAttemptId,
    count: 1,
    limit: 1,
  } as const;
}

function readDesignerSignalContinuation(task: Task) {
  const raw = task.config?.designContinuation;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (record.kind !== "after-recordSignal" || typeof record.sourceTaskId !== "string") {
    return null;
  }
  return { kind: "after-recordSignal" as const, sourceTaskId: record.sourceTaskId };
}

function prepareRunDrain(harness: Harness, action: Extract<HarnessAction, { type: "prepareRunDrain" }>): HarnessActionResult {
  const maxTries = action.maxTries ?? 3;
  const run = harness.getRun(action.runId);
  if (!run) {
    return blockedResult(action.type, `Run not found: ${action.runId}`, [`run not found: ${action.runId}`]);
  }
  if (run.context.retired === true) {
    return blockedResult(
      action.type,
      `Run ${action.runId} is retired and cannot be prepared for execution.`,
      [`retired run cannot be drained: ${action.runId}`],
    );
  }
  if (run.status === "done") {
    const completion = describeRunCompletionReadiness(harness.getRunOverview({ runId: action.runId, eventLimit: 0 }));
    if (completion.blockers.length > 0) {
      return blockedResult(
        action.type,
        `Run ${action.runId} has an unresolved frozen verification lineage despite its stored done status.`,
        completion.blockers.map((blocker) => blocker.reason),
      );
    }
    return doneResult(action.type, `Run ${action.runId} is already done.`, [
      { name: "run status", status: "passed", evidence: "done" },
    ], [{ kind: "run", runId: action.runId, status: "done" }]);
  }

  const activeDesignChildren = harness.listRuns({ limit: 1000 }).filter((candidate) =>
    candidate.context.parentRunId === action.runId
    && candidate.context.source === "design"
    && candidate.context.retired !== true
    && (candidate.status === "todo" || candidate.status === "running")
  );
  if (activeDesignChildren.length > 0) {
    return doneResult(
      action.type,
      `Run ${action.runId} is waiting for ${activeDesignChildren.length} active canonical design child run(s).`,
      [{
        name: "active canonical design children",
        status: "passed",
        evidence: activeDesignChildren.map((child) => child.id).join(","),
      }],
      activeDesignChildren.map((child) => ({
        kind: "active_child_run",
        runId: child.id,
        source: "design",
        status: child.status,
      })),
    );
  }

  const hostReceiptDesignFailure = closeHostReceiptDesignFailure(harness, action.runId);
  if (hostReceiptDesignFailure) {
    return hostReceiptDesignFailure;
  }

  const invalidEmptyGoalReview = closeInvalidEmptyGoalReview(harness, action.runId);
  if (invalidEmptyGoalReview) {
    return invalidEmptyGoalReview;
  }

  const exhaustedDesignCorrection = closeExhaustedTargetSystemDesignCorrection(harness, action.runId);
  if (exhaustedDesignCorrection) {
    return exhaustedDesignCorrection;
  }

  const quiescence = closeTargetSystemDesignQuiescence(harness, action.runId);
  if (quiescence) {
    return quiescence;
  }

  const initialOverview = harness.getRunOverview({ runId: action.runId, eventLimit: 0 });
  const pendingRepairHandoff = pendingVerifierRepairHandoff(initialOverview);
  if (pendingRepairHandoff) {
    const retiredGoalReviewTaskIds = initialOverview.tasks.flatMap((task) => {
      if (task.role !== "goal-review" || task.status !== "todo") return [];
      const retired = harness.retireTask({
        taskId: task.id,
        reason: `pending fixed Repair handoff ${pendingRepairHandoff.repairTaskId}`,
      });
      return retired?.retired ? [task.id] : [];
    });
    const signalId = `signal_verifier_repair_handoff_${stableFingerprint({
      runId: action.runId,
      repairTaskId: pendingRepairHandoff.repairTaskId,
      repairAttemptId: pendingRepairHandoff.repairAttemptId,
      verifierTaskId: pendingRepairHandoff.verifierTaskId,
    }).slice(0, 24)}`;
    const existingSignals = Array.isArray(run.context.controlPlaneSignals)
      ? run.context.controlPlaneSignals.filter((item) => item && typeof item === "object" && !Array.isArray(item))
      : [];
    const signal = {
      id: signalId,
      kind: "verifier-repair-handoff-blocked",
      evidence: [
        `run:${action.runId}`,
        `task:${pendingRepairHandoff.repairTaskId}`,
        `attempt:${pendingRepairHandoff.repairAttemptId}`,
        `task:${pendingRepairHandoff.verifierTaskId}`,
      ],
      reason: "Repair evidence is terminal but its original frozen Verifier has not run",
    };
    harness.updateRun({
      runId: action.runId,
      status: "blocked",
      contextPatch: {
        pendingVerificationTaskIds: [pendingRepairHandoff.verifierTaskId],
        pendingVerificationReason: `Repair ${pendingRepairHandoff.repairTaskId} requires fixed handoff reconciliation before Verifier ${pendingRepairHandoff.verifierTaskId}`,
        controlPlaneSignals: existingSignals.some((item) => objectRecordOrNull(item)?.id === signalId)
          ? existingSignals
          : [...existingSignals, signal],
      },
    });
    return {
      status: "blocked",
      actionType: action.type,
      summary: `Run ${action.runId} is waiting for fixed reconciliation of Repair ${pendingRepairHandoff.repairTaskId}.`,
      checks: [{
        name: "pending frozen Verifier handoff",
        status: "failed",
        evidence: `${pendingRepairHandoff.repairTaskId}->${pendingRepairHandoff.verifierTaskId}`,
      }],
      artifacts: [{
        kind: "pending_verifier_repair_handoff",
        ...pendingRepairHandoff,
        signalId,
        retiredGoalReviewTaskIds,
      }],
      problems: [`Repair ${pendingRepairHandoff.repairTaskId} is blocked only on frozen Verifier handoff metadata`],
    };
  }
  const initialActive = initialOverview.tasks.some((task) => task.status === "todo" || task.status === "running");
  const initialGoalReviewInvalidated = initialOverview.run?.context.goalReviewInvalidatedByIntegration === true;
  const initialReviewSessions = currentGoalReviewSessions(initialOverview, initialGoalReviewInvalidated);
  const initialLatestReview = initialReviewSessions[initialReviewSessions.length - 1];
  const initialCompletedReview = initialGoalReviewInvalidated ? null : selectCompletedGoalReview(initialOverview);
  const terminalVerifier = initialGoalReviewInvalidated
    ? null
    : blockedVerifierAtExhaustedRepairBudget(initialOverview);
  if (!initialActive && terminalVerifier) {
    if (run.status !== "blocked") {
      harness.updateRunStatus({ runId: action.runId, status: "blocked" });
    }
    return {
      status: "blocked",
      actionType: action.type,
      summary: `Run ${action.runId} reached its final verifier with repair budget exhausted at ${terminalVerifier.used}/${terminalVerifier.limit}.`,
      checks: [{
        name: "terminal verifier",
        status: "failed",
        evidence: `${terminalVerifier.taskId}:${terminalVerifier.attemptId}`,
      }],
      artifacts: [{
        kind: "terminal_verifier",
        taskId: terminalVerifier.taskId,
        attemptId: terminalVerifier.attemptId,
        status: "blocked",
        repairBudget: { used: terminalVerifier.used, limit: terminalVerifier.limit },
      }],
      problems: [`final verifier ${terminalVerifier.taskId} remains blocked after repair budget exhausted`],
    };
  }
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
  const repairBudgetStop = initialGoalReviewInvalidated
    ? null
    : blockedGoalReviewAtExhaustedRepairBudget(initialOverview);
  if (repairBudgetStop) {
    if (run.status !== "blocked") {
      harness.updateRunStatus({ runId: action.runId, status: "blocked" });
    }
    return {
      status: "blocked",
      actionType: action.type,
      summary: `Run ${action.runId} retains blocked goal-review ${repairBudgetStop.taskId}; repair budget exhausted at ${repairBudgetStop.used}/${repairBudgetStop.limit}.`,
      checks: [{
        name: "repair budget exhausted",
        status: "failed",
        evidence: `${repairBudgetStop.used}/${repairBudgetStop.limit}`,
      }],
      artifacts: [{
        kind: "goal_review",
        taskId: repairBudgetStop.taskId,
        attemptId: repairBudgetStop.attemptId,
        status: "blocked",
        runDecision: repairBudgetStop.runDecision,
        repairBudget: { used: repairBudgetStop.used, limit: repairBudgetStop.limit },
      }],
      problems: [
        `goal-review ${repairBudgetStop.taskId} cannot be retried after repair budget exhausted at ${repairBudgetStop.used}/${repairBudgetStop.limit}`,
      ],
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
    const completion = describeRunCompletionReadiness(harness.getRunOverview({ runId: action.runId, eventLimit: 0 }));
    if (completion.blockers.length > 0) {
      harness.updateRun({
        runId: action.runId,
        status: "blocked",
        contextPatch: {
          pendingVerificationTaskIds: completion.blockers.map((blocker) => blocker.taskId),
          pendingVerificationReason: completion.blockers.map((blocker) => blocker.reason).join("; "),
        },
      });
      checks.push({
        name: "pending verification",
        status: "failed",
        evidence: completion.blockers.map((blocker) => blocker.taskId).join(","),
      });
      artifacts.push(...completion.blockers.map((blocker) => ({
        kind: "pending_verification",
        taskId: blocker.taskId,
        verifierTaskId: blocker.verifierTaskId,
        reason: blocker.reason,
      })));
      return {
        status: "blocked",
        actionType: action.type,
        summary: `Run ${action.runId} has an unresolved frozen verification lineage.`,
        checks,
        artifacts,
        problems: completion.blockers.map((blocker) => blocker.reason),
      };
    }
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

function blockedVerifierAtExhaustedRepairBudget(overview: ReturnType<Harness["getRunOverview"]>) {
  const rawBudget = overview.run?.context.repairReplanBudget;
  if (!rawBudget || typeof rawBudget !== "object" || Array.isArray(rawBudget)) {
    return null;
  }
  const budget = rawBudget as Record<string, unknown>;
  const limit = typeof budget.limit === "number" && Number.isFinite(budget.limit) && budget.limit > 0
    ? budget.limit
    : 3;
  const used = typeof budget.used === "number" && Number.isFinite(budget.used) && budget.used >= 0
    ? budget.used
    : 0;
  if (used < limit) {
    return null;
  }
  const verifier = [...overview.tasks].reverse().find((task) => task.role === "verifier");
  if (!verifier || verifier.status !== "blocked") {
    return null;
  }
  const session = [...overview.sessions].reverse().find((candidate) =>
    candidate.taskId === verifier.id && candidate.status === "blocked"
  );
  if (!session?.attemptId) {
    return null;
  }
  const laterRepair = overview.tasks.some((task) =>
    task.role === "worker"
    && task.parentId === verifier.id
    && (task.status === "todo" || task.status === "running")
  );
  return laterRepair ? null : { taskId: verifier.id, attemptId: session.attemptId, used, limit };
}

function blockedGoalReviewAtExhaustedRepairBudget(overview: ReturnType<Harness["getRunOverview"]>) {
  const rawBudget = overview.run?.context.repairReplanBudget;
  if (!rawBudget || typeof rawBudget !== "object" || Array.isArray(rawBudget)) {
    return null;
  }
  const budget = rawBudget as Record<string, unknown>;
  const limit = typeof budget.limit === "number" && Number.isFinite(budget.limit) && budget.limit > 0
    ? budget.limit
    : 3;
  const used = typeof budget.used === "number" && Number.isFinite(budget.used) && budget.used >= 0
    ? budget.used
    : 0;
  if (used < limit) {
    return null;
  }
  const invalidatedTaskIds = invalidatedGoalReviewTaskIds(overview);
  const blockedReview = [...overview.tasks].reverse().find(
    (task) => task.role === "goal-review" && task.status === "blocked" && !invalidatedTaskIds.has(task.id),
  );
  if (!blockedReview) {
    return null;
  }
  const latestTask = overview.tasks[overview.tasks.length - 1];
  if (latestTask && latestTask.id !== blockedReview.id) {
    return null;
  }
  const blockedSession = [...overview.sessions].reverse().find((session) => {
    if (session.taskId !== blockedReview.id || session.status !== "blocked") {
      return false;
    }
    const decision = resolveRunDecision(session.output);
    return decision === "continue" || decision === "verify";
  });
  if (!blockedSession) {
    return null;
  }
  const runDecision = resolveRunDecision(blockedSession.output);
  if (runDecision !== "continue" && runDecision !== "verify") {
    return null;
  }
  return {
    taskId: blockedReview.id,
    attemptId: blockedSession.attemptId,
    runDecision,
    used,
    limit,
  };
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
      const completion = describeRunCompletionReadiness(harness.getRunOverview({ runId, eventLimit: 0 }));
      if (completion.blockers.length > 0) {
        harness.updateRun({
          runId,
          status: "blocked",
          contextPatch: {
            pendingVerificationTaskIds: completion.blockers.map((blocker) => blocker.taskId),
            pendingVerificationReason: completion.blockers.map((blocker) => blocker.reason).join("; "),
          },
        });
        return {
          status: "blocked" as const,
          summary: `Goal-review task ${blockedReview.id} cannot complete an unresolved verification lineage.`,
          checks: [{
            name: "pending verification",
            status: "failed" as const,
            evidence: completion.blockers.map((blocker) => blocker.taskId).join(","),
          }],
          artifacts: completion.blockers.map((blocker) => ({
            kind: "pending_verification",
            taskId: blocker.taskId,
            verifierTaskId: blocker.verifierTaskId,
            reason: blocker.reason,
          })),
          problems: completion.blockers.map((blocker) => blocker.reason),
        };
      }
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
  const targetSystemDesign = overview.run?.context.source === "target-system-design";
  const designDelivery = overview.run?.context.source === "design";
  const evidenceBundle = targetSystemDesign ? overview.run?.context.targetSystemEvidenceBundle : undefined;
  const offlineTestPolicy = designDelivery ? designDeliveryOfflineTestPolicy(overview.run?.context ?? {}) : null;
  const prompt = targetSystemDesign
    ? [
        "Review only the target-system Designer decision and its fixed-action validation against the authoritative evidence bundle below.",
        "Do not run project tests, builds, installs, or repository-wide scans. Do not inspect a database discovered inside the target worktree.",
        "Do not create a Planner or Worker on this design root. A rejected fixed design action may only produce one bounded read-only Designer correction; an accepted proposal proceeds through authority and createRunsFromDesign.",
        "Authoritative evidence bundle:",
        JSON.stringify(evidenceBundle ?? null, null, 2),
      ].join("\n")
    : designDelivery && offlineTestPolicy
      ? [
          GOAL_REVIEW_TASK_PROMPT,
          "This is a read-only design-delivery review. Do not run the target project's complete test suite, typecheck, build, browser checks, installs, or unrelated source scans.",
          `Only the frozen offline test paths are eligible for review: ${offlineTestPolicy.allowedPaths.join(", ")}.`,
        ].join("\n")
      : GOAL_REVIEW_TASK_PROMPT;
  const taskId = harness.createTask({
    runId,
    role: "goal-review",
    goal: GOAL_REVIEW_TASK_GOAL,
    prompt,
    dependsOn: sourceTask?.status === "done" ? [sourceTask.id] : [],
    worktreePath: sourceTask?.worktreePath ?? null,
    doneWhen: GOAL_REVIEW_TASK_DONE_WHEN,
    config: targetSystemDesign
      ? {
          readOnly: true,
          forbidImplementation: true,
          forbidBrowser: true,
          forbidProjectCommands: true,
          ...(evidenceBundle !== undefined ? { targetSystemEvidenceBundle: evidenceBundle } : {}),
        }
      : designDelivery && offlineTestPolicy
        ? {
            permissionMode: "read-only",
            readOnly: true,
            forbidImplementation: true,
            forbidBrowser: true,
            browserProcessPolicy: "deny",
            forbidProjectCommands: true,
            offlineTestPolicy,
          }
        : undefined,
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
  const env = { ...process.env } as Record<string, string | undefined>;
  for (const [key, value] of Object.entries(input.env ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const result = Bun.spawnSync({
    cmd: ["git", ...input.args],
    cwd: input.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env,
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
    ...(input.stdin === undefined ? {} : { stdin: Buffer.from(input.stdin, "utf8") }),
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
  limits: { timeoutMs?: number; maxOutputBytes?: number; env?: Record<string, string | undefined> } = {},
) {
  const result = git({ cwd, args, ...limits });
  return {
    ...result,
    ok: result.exitCode === 0,
    command: `git ${args.join(" ")}`,
    cwd,
  };
}

function isGitRemoteCommand(args: string[]) {
  return args[0] === "ls-remote" || args[0] === "push" || args[0] === "fetch";
}

function clearedAmbientProxyEnv() {
  return Object.fromEntries([
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
    "http_proxy", "https_proxy", "all_proxy", "no_proxy",
    "GIT_SSH_COMMAND",
  ].map((key) => [key, undefined]));
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

function pendingVerifierRepairHandoff(overview: ReturnType<Harness["getRunOverview"]>) {
  for (const repair of overview.tasks) {
    if (repair.role !== "worker" || repair.status !== "blocked") continue;
    const repairRecovery = objectRecordOrNull(repair.config?.verifierRepairRecovery);
    if (!repairRecovery || typeof repairRecovery.recoveryKey !== "string") continue;
    const verifier = overview.tasks.find((task) =>
      task.role === "verifier"
      && ["todo", "blocked"].includes(task.status)
      && sameCanonicalValue(task.dependsOn, [repair.id])
      && task.config?.sourceTaskId === repair.id
      && sameCanonicalValue(task.config?.verifierRepairRecovery, repairRecovery)
      && !overview.sessions.some((session) => session.taskId === task.id)
    );
    if (!verifier) continue;
    const repairSession = [...overview.sessions].reverse().find((session) =>
      session.taskId === repair.id
      && session.status === "blocked"
      && (session.output.problems ?? []).includes(
        `existing verifier ${verifier.id} has a different frozen completion contract`,
      )
      && (session.output.artifacts ?? []).some((artifact) => {
        const record = objectRecordOrNull(artifact);
        return record?.kind === "conflicting_completion_contract"
          && record.taskId === verifier.id
          && record.sourceTaskId === repair.id;
      })
    );
    if (!repairSession) continue;
    return {
      repairTaskId: repair.id,
      repairAttemptId: repairSession.attemptId,
      verifierTaskId: verifier.id,
      recoveryKey: repairRecovery.recoveryKey,
    };
  }
  return null;
}

function designDeliveryOfflineTestPolicy(context: Record<string, unknown>) {
  const proposal = objectRecordOrNull(context.designProposal);
  const pack = objectRecordOrNull(proposal?.evolutionPack);
  const surfaces = Array.isArray(pack?.mutationSurfaces)
    ? pack.mutationSurfaces.map((surface) => objectRecordOrNull(surface)).filter((surface): surface is Record<string, unknown> => Boolean(surface))
    : [];
  const allowedPaths = [...new Set(surfaces.flatMap((surface) =>
    Array.isArray(surface.allowedPaths)
      ? surface.allowedPaths.filter((path): path is string => typeof path === "string" && path.startsWith("tests/evolution/"))
      : []
  ))].sort();
  return allowedPaths.length > 0
    ? { mode: "allowlist", allowedPaths, forbidTargetBusinessTests: true }
    : null;
}

function closeHostReceiptDesignFailure(
  harness: Harness,
  runId: string,
): HarnessActionResult | null {
  const overview = harness.getRunOverview({ runId, eventLimit: 0 });
  const run = overview.run;
  if (!run || run.context.source !== "target-system-design" || !run.projectId) return null;
  if (overview.tasks.some((task) => task.status === "todo" || task.status === "running")) return null;
  const designer = [...overview.tasks].reverse().find((task) =>
    task.role === "designer"
    && task.status === "blocked"
    && task.config?.hostReceiptDesignAdapter
    && typeof task.config.hostReceiptDesignAdapter === "object"
    && !Array.isArray(task.config.hostReceiptDesignAdapter));
  if (!designer) return null;
  const session = [...overview.sessions].reverse().find((candidate) =>
    candidate.taskId === designer.id && candidate.status === "blocked");
  if (!session) return null;
  const problem = [...(session.output.problems ?? [])].reverse().find((entry) => entry.trim().length > 0)
    ?? session.output.summary;
  if (!/(?:host corpus manifest action|host receipt|versioned business design|evolutionPack\.version)/i.test(problem)) {
    return null;
  }
  const adapter = designer.config!.hostReceiptDesignAdapter as Record<string, unknown>;
  const actionEvidenceRef = typeof adapter.actionEvidenceRef === "string" ? adapter.actionEvidenceRef : null;
  if (!actionEvidenceRef || !/^action:action_[A-Za-z0-9._-]+$/.test(actionEvidenceRef)) return null;
  const fingerprint = stableFingerprint(JSON.stringify({
    runId,
    taskId: designer.id,
    attemptId: session.attemptId,
    actionEvidenceRef,
    problem,
  }));
  const existing = run.context.hostReceiptDesignFailure;
  const existingRecord = existing && typeof existing === "object" && !Array.isArray(existing)
    ? existing as Record<string, unknown>
    : null;
  if (existingRecord?.fingerprint === fingerprint) {
    if (run.status !== "blocked") harness.updateRunStatus({ runId, status: "blocked" });
    return {
      status: "blocked",
      actionType: "prepareRunDrain",
      summary: `Run ${runId} already stopped at host receipt Designer failure ${session.attemptId}.`,
      checks: [{ name: "host receipt Designer failure", status: "failed", evidence: fingerprint }],
      artifacts: [{ kind: "host_receipt_design_failure", ...existingRecord, reused: true }],
      problems: [problem],
    };
  }
  const record = {
    schemaVersion: 1,
    fingerprint,
    sourceTaskId: designer.id,
    sourceAttemptId: session.attemptId,
    actionEvidenceRef,
    validationProblem: limitUtf8Output(problem, 1_024),
    recordedAt: normalizedEvidenceTimestamp(session.finishedAt),
  };
  harness.updateRun({ runId, status: "blocked", contextPatch: { hostReceiptDesignFailure: record } });
  const signal = applyHarnessAction(harness, {
    type: "recordSignal",
    projectId: run.projectId,
    sourceRunId: runId,
    signalClass: "system",
    source: `blocked-run-outcome:${runId}`,
    title: "Host-receipt versioned Designer failed fixed validation",
    summary: "The first host-receipt-bound Designer failed fixed validation. The root stopped without Goal Review or another Designer continuation.",
    observationTime: record.recordedAt,
    confidence: 1,
    evidence: [`run:${runId}`, `task:${designer.id}`, `attempt:${session.attemptId}`, actionEvidenceRef],
    payload: {
      outcome: "evidence-defect",
      defectKind: "host-receipt-versioned-design-validation-failed",
      validationFingerprint: fingerprint,
      validationProblem: record.validationProblem,
      actionEvidenceRef,
      nextStep: "new-independent-versioned-designer-trigger-or-quiescence",
      sideEffectCounters: zeroSideEffectCounters(),
    },
  });
  return {
    status: "blocked",
    actionType: "prepareRunDrain",
    summary: `Run ${runId} stopped after its first host-receipt Designer validation failure.`,
    checks: [
      { name: "host receipt Designer failure", status: "failed", evidence: fingerprint },
      { name: "recursive Goal Review", status: "passed", evidence: "stopped before creation" },
    ],
    artifacts: signal.artifacts,
    problems: [problem],
  };
}

function closeInvalidEmptyGoalReview(
  harness: Harness,
  runId: string,
): HarnessActionResult | null {
  const overview = harness.getRunOverview({ runId, eventLimit: 0 });
  const run = overview.run;
  if (!run || overview.tasks.some((task) => task.status === "todo" || task.status === "running")) return null;
  const session = [...overview.sessions].reverse().find((candidate) => {
    if (candidate.role !== "goal-review" || candidate.status !== "blocked") return false;
    const decision = resolveRunDecision(candidate.output);
    return (decision === "continue" || decision === "verify")
      && (candidate.output.nextTasks ?? []).length === 0
      && (candidate.output.problems ?? []).some((problem) => /must include one to \d+ nextTasks items/i.test(problem));
  });
  if (!session) return null;
  const decision = resolveRunDecision(session.output) as "continue" | "verify";
  const fingerprint = stableFingerprint(JSON.stringify({
    runId,
    taskId: session.taskId,
    attemptId: session.attemptId,
    decision,
    nextTasks: [],
  }));
  const existing = run.context.invalidGoalReviewContinuation;
  const record = existing && typeof existing === "object" && !Array.isArray(existing)
    && (existing as Record<string, unknown>).fingerprint === fingerprint
    ? existing as Record<string, unknown>
    : {
        schemaVersion: 1,
        fingerprint,
        taskId: session.taskId,
        attemptId: session.attemptId,
        decision,
        recordedAt: normalizedEvidenceTimestamp(session.finishedAt),
      };
  if (existing !== record || run.status !== "blocked") {
    harness.updateRun({ runId, status: "blocked", contextPatch: { invalidGoalReviewContinuation: record } });
  }
  return {
    status: "blocked",
    actionType: "prepareRunDrain",
    summary: `Run ${runId} stopped at an invalid empty ${decision} Goal Review.`,
    checks: [{ name: "goal review concrete continuation", status: "failed", evidence: session.attemptId }],
    artifacts: [{ kind: "invalid_goal_review_continuation", ...record }],
    problems: [`${decision} goal-review ${session.taskId} supplied no next task`],
  };
}

function closeExhaustedTargetSystemDesignCorrection(
  harness: Harness,
  runId: string,
): HarnessActionResult | null {
  const overview = harness.getRunOverview({ runId, eventLimit: 0 });
  const run = overview.run;
  if (!run || run.context.source !== "target-system-design" || !run.projectId) return null;
  if (overview.tasks.some((task) => task.status === "todo" || task.status === "running")) return null;
  const blockedDesigners = overview.tasks
    .filter((task) => task.role === "designer" && task.status === "blocked")
    .map((task) => ({
      task,
      session: overview.sessions
        .filter((session) => session.taskId === task.id && session.status === "blocked")
        .sort((left, right) => left.attemptId.localeCompare(right.attemptId))
        .at(-1),
    }))
    .filter((entry): entry is typeof entry & { session: NonNullable<typeof entry.session> } => Boolean(entry.session));
  if (blockedDesigners.length < 2) return null;
  const reviews = overview.tasks.filter((task) => task.role === "goal-review");
  const completedReviews = reviews.filter((task) => task.status === "done");
  if (completedReviews.length === 0) return null;
  const correction = blockedDesigners[blockedDesigners.length - 1]!;
  const initial = blockedDesigners[blockedDesigners.length - 2]!;
  const lineageReview = completedReviews.find((task) =>
    task.dependsOn.includes(initial.task.id) && correction.task.dependsOn.includes(task.id));
  if (!lineageReview) return null;
  const validationProblem = [...(correction.session.output.problems ?? [])].reverse().find((problem) => problem.trim())
    ?? correction.session.output.summary;
  const observationTime = normalizedEvidenceTimestamp(correction.session.finishedAt);
  if (run.status !== "blocked") harness.updateRunStatus({ runId, status: "blocked" });
  const signal = applyHarnessAction(harness, {
    type: "recordSignal",
    projectId: run.projectId,
    sourceRunId: runId,
    signalClass: "system",
    source: `blocked-run-outcome:${runId}`,
    title: "Versioned target design validation exhausted its bounded correction",
    summary: "The initial target-system Designer and its single governed correction both failed fixed-action validation. The root was closed without another Goal Review.",
    observationTime,
    confidence: 1,
    evidence: [
      `run:${runId}`,
      `task:${initial.task.id}`,
      `attempt:${initial.session.attemptId}`,
      `task:${correction.task.id}`,
      `attempt:${correction.session.attemptId}`,
      `task:${lineageReview.id}`,
    ],
    payload: {
      outcome: "evidence-defect",
      defectKind: "target-system-versioned-design-validation-exhausted",
      correctionLimit: 1,
      validationFingerprint: stableFingerprint(validationProblem),
      validationProblem: limitUtf8Output(validationProblem, 1_024),
      initialDesignerTaskId: initial.task.id,
      correctionDesignerTaskId: correction.task.id,
      goalReviewTaskIds: [lineageReview.id],
      nextStep: "new-independent-designer-trigger-or-quiescence",
      sideEffectCounters: zeroSideEffectCounters(),
    },
  });
  return {
    status: "blocked",
    actionType: "prepareRunDrain",
    summary: `Run ${runId} stopped after its single bounded Designer correction failed validation.`,
    checks: [
      { name: "bounded Designer correction", status: "failed", evidence: "1/1" },
      { name: "recursive Goal Review", status: "passed", evidence: "stopped" },
      { name: "strategy signal", status: signal.status === "done" ? "passed" : "failed", evidence: signal.eventId },
    ],
    artifacts: signal.artifacts,
    problems: [validationProblem],
  };
}

function exactBoundedTextField(record: Record<string, unknown>, key: string, maxBytes: number) {
  const value = exactNonEmptyStringField(record, key);
  if (value.includes("\r") || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`${key} must be exact bounded text of at most ${maxBytes} UTF-8 bytes without carriage returns`);
  }
  if (sanitizeEvolutionErrorText(value) !== value) {
    throw new Error(`${key} must not contain credentials`);
  }
  return value;
}

function blockedRunSignalEvidence(value: unknown) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    throw new Error("recordSignal evidence must contain 1-32 bounded immutable references");
  }
  const refs = value.map((entry, index) => {
    if (typeof entry !== "string" || entry.trim() !== entry || Buffer.byteLength(entry, "utf8") > 256) {
      throw new Error(`recordSignal evidence[${index}] must be an exact reference of at most 256 UTF-8 bytes`);
    }
    const entityRef = /^(?:run|task|attempt|action):[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(entry);
    const commitRef = /^commit:[0-9a-f]{40}$/.test(entry) && !/^commit:0+$/.test(entry);
    const digestRef = /^sha256:[0-9a-f]{64}$/.test(entry) && !/^sha256:0+$/.test(entry);
    if (!entityRef && !commitRef && !digestRef) {
      throw new Error(`recordSignal evidence[${index}] must be a run, task, attempt, action, commit, or sha256 reference`);
    }
    return entry;
  });
  if (new Set(refs).size !== refs.length) {
    throw new Error("recordSignal evidence references must be unique");
  }
  return refs;
}

function blockedRunSignalPayload(value: unknown) {
  const payload = objectRecord(value, "recordSignal payload");
  const encoded = JSON.stringify(payload);
  if (Buffer.byteLength(encoded, "utf8") > 8_192) {
    throw new Error("recordSignal payload must be at most 8192 UTF-8 bytes");
  }
  validateBlockedRunSignalJson(payload, "recordSignal payload", 0);
  return payload;
}

function validateBlockedRunSignalJson(value: unknown, label: string, depth: number): void {
  if (depth > 6) throw new Error(`${label} exceeds the maximum nesting depth`);
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} numbers must be finite`);
    return;
  }
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > 512) throw new Error(`${label} strings must be at most 512 UTF-8 bytes`);
    if (/\bBearer\s+\S+/i.test(value) || /\w+:\/\/[^/\s@]+@/i.test(value)) {
      throw new Error(`${label} must not contain credentials`);
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 32) throw new Error(`${label} arrays must contain at most 32 entries`);
    value.forEach((entry, index) => validateBlockedRunSignalJson(entry, `${label}[${index}]`, depth + 1));
    return;
  }
  if (!value || typeof value !== "object") throw new Error(`${label} must contain JSON values only`);
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 64) throw new Error(`${label} objects must contain at most 64 fields`);
  for (const [key, entry] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key)) throw new Error(`${label} contains an invalid field name`);
    if (/(?:authorization|api[_-]?key|access[_-]?token|secret|password|credential)/i.test(key)) {
      throw new Error(`${label}.${key} is a forbidden credential field`);
    }
    validateBlockedRunSignalJson(entry, `${label}.${key}`, depth + 1);
  }
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

function exactSha256Field(record: Record<string, unknown>, key: string) {
  const value = exactNonEmptyStringField(record, key);
  if (!/^[0-9a-f]{64}$/.test(value) || /^0+$/.test(value)) {
    throw new Error(`${key} must be a non-zero lowercase full 64-character SHA-256`);
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

function optionalNonEmptyStringField(record: Record<string, unknown>, key: string) {
  const value = optionalStringField(record, key);
  if (value !== undefined && value.length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
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

function exactRelativePathListField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > EXACT_GIT_INDEX_MAX_FILES) {
    throw new Error(`${key} must be a bounded array of relative Git paths`);
  }
  const paths = value.map((item, index) => exactRelativeGitPathField({ value: item }, "value", `${key}[${index}]`));
  if (new Set(paths).size !== paths.length) throw new Error(`${key} must contain unique paths`);
  return paths;
}

function exactRelativeRootListField(record: Record<string, unknown>, key: string, required = false) {
  const value = record[key];
  if (value === undefined && !required) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
    throw new Error(`${key} must be a non-empty bounded array of relative directory roots`);
  }
  const roots = value.map((item, index) => {
    if (typeof item !== "string" || !item.endsWith("/")) {
      throw new Error(`${key}[${index}] must end with /`);
    }
    const path = exactRelativeGitPathField({ value: item.slice(0, -1) }, "value", `${key}[${index}]`);
    return `${path}/`;
  });
  if (new Set(roots).size !== roots.length) throw new Error(`${key} must contain unique roots`);
  return roots;
}

function exactWorkerFileReceiptsField(record: Record<string, unknown>, key: string): WorkerFileReceipt[] {
  const value = record[key];
  if (!Array.isArray(value) || value.length === 0 || value.length > EXACT_GIT_INDEX_MAX_FILES) {
    throw new Error(`${key} must contain 1-${EXACT_GIT_INDEX_MAX_FILES} exact file SHA-256 receipts`);
  }
  const seen = new Set<string>();
  return value.map((item, index) => {
    const file = objectRecord(item, `${key}[${index}]`);
    assertOnlyFields(file, `${key}[${index}]`, ["path", "sha256"]);
    const path = exactRelativeGitPathField(file, "path", `${key}[${index}].path`);
    if (seen.has(path)) throw new Error(`${key} must contain unique paths; duplicate: ${path}`);
    seen.add(path);
    return { path, sha256: exactSha256Field(file, "sha256") };
  });
}

function exactRelativeGitPathsField(
  record: Record<string, unknown>,
  key: string,
  options: { allowEmpty: boolean },
) {
  const value = record[key];
  if (!Array.isArray(value) || (!options.allowEmpty && value.length === 0) || value.length > EXACT_GIT_INDEX_MAX_FILES) {
    throw new Error(`${key} must be a bounded array of exact relative Git paths`);
  }
  const seen = new Set<string>();
  return value.map((item, index) => {
    const wrapper = { value: item };
    const path = exactRelativeGitPathField(wrapper, "value", `${key}[${index}]`);
    if (seen.has(path)) throw new Error(`${key} must contain unique paths; duplicate: ${path}`);
    seen.add(path);
    return path;
  });
}

function researchEvidenceArtifactRequests(value: unknown): ResearchEvidenceLinkAction["artifacts"] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 200) {
    throw new Error("artifacts must be a non-empty array of at most 200 research artifact references");
  }
  return value.map((entry, index) => {
    const record = objectRecord(entry, `artifacts[${index}]`);
    assertOnlyFields(record, `artifacts[${index}]`, ["artifactId", "sha256", "evidenceGrade"]);
    const artifactId = exactSafeIdentifierField(record, "artifactId");
    const sha256 = exactNonEmptyStringField(record, "sha256");
    if (!/^[0-9a-f]{64}$/.test(sha256) || /^0+$/.test(sha256)) {
      throw new Error(`artifacts[${index}].sha256 must be a non-zero lowercase SHA-256`);
    }
    const evidenceGrade = exactNonEmptyStringField(record, "evidenceGrade");
    if (evidenceGrade !== "A" && evidenceGrade !== "B" && evidenceGrade !== "C" && evidenceGrade !== "D") {
      throw new Error(`artifacts[${index}].evidenceGrade must be A, B, C, or D`);
    }
    return { artifactId, sha256, evidenceGrade };
  });
}

function optionalFollowUpTaskField(record: Record<string, unknown>, key: string) {
  return record[key] === undefined ? undefined : followUpTaskField(record, key);
}

function publicFixtureBindingsField(value: unknown) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new Error("publicFixtureBindings must be a non-empty array of at most 100 bindings");
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const record = objectRecord(entry, `publicFixtureBindings[${index}]`);
    assertOnlyFields(record, `publicFixtureBindings[${index}]`, [
      "ref",
      "sourceTaskId",
      "sourceAttemptId",
      "relativePath",
      "sha256",
    ]);
    const ref = exactNonEmptyStringField(record, "ref");
    const sourceTaskId = exactSafeIdentifierField(record, "sourceTaskId");
    const sourceAttemptId = exactSafeIdentifierField(record, "sourceAttemptId");
    const relativePath = exactRelativeGitPathField(record, "relativePath", `publicFixtureBindings[${index}].relativePath`);
    const sha256 = exactNonEmptyStringField(record, "sha256");
    if (!/^[0-9a-f]{64}$/.test(sha256)) {
      throw new Error(`publicFixtureBindings[${index}].sha256 must be a lowercase SHA-256`);
    }
    if (seen.has(ref)) throw new Error(`publicFixtureBindings contains duplicate ref ${ref}`);
    seen.add(ref);
    return { ref, sourceTaskId, sourceAttemptId, relativePath, sha256 };
  });
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

function invalidActionAuditRequest(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return safeRequest(value);
  }
  const record = value as Record<string, unknown>;
  if (record.type !== "activateHarnessRevision") {
    return safeRequest(value);
  }
  const revision = record.revision && typeof record.revision === "object" && !Array.isArray(record.revision)
    ? record.revision as Record<string, unknown>
    : {};
  const variant = revision.variant && typeof revision.variant === "object" && !Array.isArray(revision.variant)
    ? revision.variant as Record<string, unknown>
    : {};
  return Object.fromEntries(Object.entries({
    type: "activateHarnessRevision",
    runId: typeof record.runId === "string" ? record.runId : undefined,
    rootRunId: typeof record.rootRunId === "string" ? record.rootRunId : undefined,
    projectId: typeof revision.projectId === "string" ? revision.projectId : undefined,
    version: typeof revision.version === "number" ? revision.version : undefined,
    contentSha256: typeof revision.contentSha256 === "string" ? revision.contentSha256 : undefined,
    variantId: typeof variant.id === "string" ? variant.id : undefined,
    variantRecordSha256: typeof variant.recordSha256 === "string" ? variant.recordSha256 : undefined,
  }).filter(([, fieldValue]) => fieldValue !== undefined));
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
