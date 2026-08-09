import { parseJson } from "./json";
import {
  canonicalEvolutionRecordSha256,
  parseEvolutionProfile,
  parseHarnessVariant,
  parseMatchedExperiment,
  parseProductionEpisode,
} from "./target-evolution";
import type {
  Attempt,
  AttemptEvent,
  AttemptOutput,
  DesignDecision,
  DesignOutcome,
  DesignProposal,
  DesignProposalData,
  ExecutionThread,
  EvolutionProfile,
  ExternalRef,
  FounderCharter,
  FounderCharterData,
  HarnessActionEvent,
  HarnessVariant,
  InboxEvent,
  Lesson,
  MatchedExperiment,
  Project,
  PromptTemplate,
  ProductionEpisode,
  Run,
  Status,
  StrategySignal,
  Task,
  TaskConfig,
} from "./types";
import type {
  AttemptEventRow,
  AttemptRow,
  DesignDecisionRow,
  DesignOutcomeRow,
  DesignProposalRow,
  ExecutionThreadRow,
  EvolutionProfileRow,
  ExternalRefRow,
  FounderCharterRow,
  HarnessActionEventRow,
  HarnessVariantRow,
  InboxEventRow,
  LessonRow,
  MatchedExperimentRow,
  ProjectRow,
  PromptTemplateRow,
  ProductionEpisodeRow,
  RunRow,
  StrategySignalRow,
  TaskRow,
} from "./rows";

export function runFromRow(row: RunRow): Run {
  const context = parseJson<Record<string, unknown>>(row.context_json);
  return {
    id: row.id,
    projectId: row.project_id ?? null,
    projectRoot: row.project_root ?? stringOrNull(context.projectRoot) ?? null,
    goal: row.goal,
    status: row.status,
    context,
    createdAt: row.created_at ?? null,
  };
}

export function projectFromRow(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    rootPath: row.root_path,
    context: parseJson<Record<string, unknown>>(row.context_json),
  };
}

export function taskFromRow(row: TaskRow): Task {
  return {
    id: row.id,
    runId: row.run_id,
    parentId: row.parent_id,
    cycleId: row.cycle_id ?? row.id,
    status: row.status,
    role: row.role,
    goal: row.goal,
    prompt: row.prompt,
    dependsOn: parseJson<string[]>(row.depends_on_json),
    doneWhen: parseJson<string[]>(row.done_when_json),
    config: parseJson<TaskConfig>(row.config_json),
    worktreePath: row.worktree_path,
    sessionRef: row.session_ref,
    contextVersion: row.context_version,
  };
}

export function attemptFromRow(row: AttemptRow): Attempt {
  return {
    id: row.id,
    taskId: row.task_id,
    status: row.status,
    input: parseJson<Record<string, unknown>>(row.input_json),
    output: parseJson<AttemptOutput>(row.output_json),
    checks: parseJson<unknown[]>(row.checks_json),
    artifacts: parseJson<unknown[]>(row.artifacts_json),
    error: row.error,
  };
}

export function attemptEventFromRow(row: AttemptEventRow): AttemptEvent {
  return {
    id: row.id,
    attemptId: row.attempt_id,
    sequence: row.sequence,
    stream: row.stream,
    text: row.text,
    payload: parseJson<Record<string, unknown>>(row.payload_json),
    createdAt: row.created_at,
  };
}

export function executionThreadFromRow(row: ExecutionThreadRow): ExecutionThread {
  return {
    id: row.id,
    runId: row.run_id,
    taskId: row.task_id,
    attemptId: row.attempt_id,
    parentThreadId: row.parent_thread_id,
    ownerType: row.owner_type,
    ownerId: row.owner_id,
    role: row.role,
    status: row.status,
    pid: row.pid,
    sessionName: row.session_name,
    agentSessionId: row.agent_session_id,
    worktreePath: row.worktree_path,
    heartbeatAt: row.heartbeat_at,
    interruptedAt: row.interrupted_at,
    interruptReason: row.interrupt_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function externalRefFromRow(row: ExternalRefRow): ExternalRef {
  return {
    id: row.id,
    localType: row.local_type,
    localId: row.local_id,
    provider: row.provider,
    externalType: row.external_type,
    externalId: row.external_id,
    externalUrl: row.external_url,
  };
}

export function inboxEventFromRow(row: InboxEventRow): InboxEvent {
  return {
    id: row.id,
    provider: row.provider,
    eventType: row.event_type,
    externalId: row.external_id,
    payload: parseJson<Record<string, unknown>>(row.payload_json),
    status: row.status as Status,
    createdAt: row.created_at ?? null,
    processedAt: row.processed_at ?? null,
  };
}

export function lessonFromRow(row: LessonRow): Lesson {
  return {
    id: row.id,
    runId: row.run_id,
    taskId: row.task_id,
    attemptId: row.attempt_id,
    kind: row.kind,
    summary: row.summary,
    evidence: parseJson<Record<string, unknown>>(row.evidence_json),
  };
}

export function promptTemplateFromRow(row: PromptTemplateRow): PromptTemplate {
  return {
    key: row.key,
    contentMd: row.content_md,
  };
}

export function harnessActionEventFromRow(row: HarnessActionEventRow): HarnessActionEvent {
  return {
    id: row.id,
    actionType: row.action_type,
    status: row.status,
    request: parseJson<Record<string, unknown>>(row.request_json),
    result: parseJson<Record<string, unknown>>(row.result_json),
    createdAt: row.created_at,
  };
}

export function founderCharterFromRow(row: FounderCharterRow): FounderCharter {
  const charter = parseJson<FounderCharterData>(row.charter_json);
  return {
    id: row.id,
    projectId: row.project_id ?? null,
    version: row.version,
    isActive: row.is_active === 1,
    activatedAt: row.activated_at ?? null,
    supersededAt: row.superseded_at ?? null,
    mission: row.mission,
    charter,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function strategySignalFromRow(row: StrategySignalRow): StrategySignal {
  return {
    id: row.id,
    projectId: row.project_id ?? null,
    signalClass: row.signal_class,
    source: row.source,
    title: row.title,
    summary: row.summary,
    observationTime: row.observation_time,
    confidence: row.confidence,
    evidence: parseJson<unknown[]>(row.evidence_json),
    expiresAt: row.expires_at ?? null,
    status: row.status,
    conflictingSignalIds: parseJson<string[]>(row.conflicting_signal_ids_json),
    proposalId: row.proposal_id ?? null,
    runId: row.run_id ?? null,
    taskId: row.task_id ?? null,
    attemptId: row.attempt_id ?? null,
    payload: parseJson<Record<string, unknown>>(row.payload_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function designProposalFromRow(row: DesignProposalRow): DesignProposal {
  return {
    id: row.id,
    projectId: row.project_id ?? null,
    runId: row.run_id ?? null,
    taskId: row.task_id ?? null,
    attemptId: row.attempt_id ?? null,
    charterId: row.charter_id ?? null,
    title: row.title,
    problem: row.problem,
    recommendation: row.recommendation,
    status: row.status,
    proposal: parseJson<DesignProposalData>(row.proposal_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function designDecisionFromRow(row: DesignDecisionRow): DesignDecision {
  return {
    id: row.id,
    proposalId: row.proposal_id,
    charterId: row.charter_id ?? null,
    decision: row.decision,
    actorKind: row.actor_kind,
    actorRef: row.actor_ref ?? null,
    reasons: parseJson<string[]>(row.reasons_json),
    authority: parseJson<Record<string, unknown>>(row.authority_json),
    payload: parseJson<Record<string, unknown>>(row.payload_json),
    createdAt: row.created_at,
  };
}

export function designOutcomeFromRow(row: DesignOutcomeRow): DesignOutcome {
  return {
    id: row.id,
    proposalId: row.proposal_id,
    runId: row.run_id ?? null,
    taskId: row.task_id ?? null,
    attemptId: row.attempt_id ?? null,
    stage: row.stage,
    recommendation: row.recommendation,
    baseline: parseJson<Record<string, unknown>>(row.baseline_json),
    observed: parseJson<Record<string, unknown>>(row.observed_json),
    evidence: parseJson<unknown[]>(row.evidence_json),
    unexpectedEffects: parseJson<unknown[]>(row.unexpected_effects_json),
    reviewAt: row.review_at ?? null,
    payload: parseJson<Record<string, unknown>>(row.payload_json),
    createdAt: row.created_at,
  };
}

export function evolutionProfileFromRow(row: EvolutionProfileRow): EvolutionProfile {
  const record = parseEvolutionProfile(
    parseJson<unknown>(row.record_json),
    row.project_id,
    `evolution_profiles.${row.id}.record_json`,
  );
  if (
    record.id !== row.id ||
    record.schemaVersion !== row.schema_version ||
    record.maturity !== row.maturity
    || canonicalEvolutionRecordSha256(record) !== row.record_sha256
  ) {
    throw new Error(`evolution profile readback mismatch: ${row.id}`);
  }
  return record;
}

export function productionEpisodeFromRow(row: ProductionEpisodeRow): ProductionEpisode {
  const record = parseProductionEpisode(
    parseJson<unknown>(row.record_json),
    row.project_id,
    `production_episodes.${row.id}.record_json`,
  );
  if (
    record.id !== row.id ||
    record.schemaVersion !== row.schema_version ||
    record.profileId !== row.profile_id ||
    record.sourceRef !== row.source_ref ||
    record.leakageGroupId !== row.leakage_group_id
    || canonicalEvolutionRecordSha256(record) !== row.record_sha256
  ) {
    throw new Error(`production episode readback mismatch: ${row.id}`);
  }
  return record;
}

export function harnessVariantFromRow(row: HarnessVariantRow): HarnessVariant {
  const record = parseHarnessVariant(
    parseJson<unknown>(row.record_json),
    row.project_id,
    `harness_variants.${row.id}.record_json`,
  );
  if (
    record.id !== row.id ||
    record.schemaVersion !== row.schema_version ||
    record.profileId !== row.profile_id ||
    record.role !== row.role
    || canonicalEvolutionRecordSha256(record) !== row.record_sha256
  ) {
    throw new Error(`harness variant readback mismatch: ${row.id}`);
  }
  return record;
}

export function matchedExperimentFromRow(row: MatchedExperimentRow): MatchedExperiment {
  const record = parseMatchedExperiment(
    parseJson<unknown>(row.record_json),
    row.project_id,
    `matched_experiments.${row.id}.record_json`,
  );
  if (
    record.id !== row.id ||
    record.schemaVersion !== row.schema_version ||
    record.profileId !== row.profile_id ||
    record.controlVariantId !== row.control_variant_id ||
    record.candidateVariantId !== row.candidate_variant_id ||
    record.outcome !== row.outcome
    || canonicalEvolutionRecordSha256(record) !== row.record_sha256
  ) {
    throw new Error(`matched experiment readback mismatch: ${row.id}`);
  }
  return record;
}

function stringOrNull(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}
