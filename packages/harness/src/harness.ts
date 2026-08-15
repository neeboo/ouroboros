import {
  ensureEvolutionRuntimeTables,
  initDatabase,
  normalizeDatabasePath,
  withDatabase,
  withReadOnlyDatabase,
} from "./database";
import type { HarnessDatabase } from "./database";
import {
  DEFAULT_CONTEXT_SUMMARY_PROMPT_TEMPLATE,
  DEFAULT_REPAIR_TASK_PROMPT_TEMPLATE,
  DEFAULT_TASK_PROMPT_TEMPLATE,
  DEFAULT_VERIFIER_TASK_PROMPT_TEMPLATE,
  LEGACY_DEFAULT_TASK_PROMPT_TEMPLATES,
} from "./default-prompts";
import { makeId } from "./ids";
import { toJson } from "./json";
import { assertRunCompletionReady } from "./completion-readiness";
import {
  attemptEventFromRow,
  attemptFromRow,
  designDecisionFromRow,
  designOutcomeFromRow,
  designProposalFromRow,
  executionThreadFromRow,
  evolutionProfileFromRow,
  externalRefFromRow,
  founderCharterFromRow,
  harnessActionEventFromRow,
  harnessVariantFromRow,
  inboxEventFromRow,
  lessonFromRow,
  matchedExperimentFromRow,
  projectFromRow,
  promptTemplateFromRow,
  productionEpisodeFromRow,
  runFromRow,
  strategySignalFromRow,
  taskFromRow,
} from "./mappers";
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
import type {
  ActivateFounderCharterInput,
  AttemptOutput,
  CreateDesignProposalInput,
  CreateExternalRefInput,
  CreateFounderCharterInput,
  CreateInboxEventInput,
  EnsureExternalRefInput,
  EnsureExternalRefResult,
  EnsureInboxEventInput,
  EnsureInboxEventResult,
  InboxTransitionTarget,
  TransitionInboxEventInput,
  TransitionInboxEventResult,
  CreateProjectInput,
  CreateRunInput,
  CreateStrategySignalInput,
  CreateTaskInput,
  DependencyAttempt,
  AttemptEvent,
  DesignProposal,
  DesignProposalStatus,
  EvolutionProfile,
  FinishAttemptInput,
  FounderCharterData,
  GetActiveFounderCharterInput,
  GetDesignProposalInput,
  GetFounderCharterInput,
  GetHarnessActionEventInput,
  GetInboxEventInput,
  GetRunOverviewInput,
  GetStrategySignalInput,
  LeaseReadyTasksInput,
  LinkProposalOutcomeReviewInput,
  LinkProposalOutcomeReviewResult,
  HarnessVariant,
  ListDesignDecisionsInput,
  ListDesignOutcomesInput,
  ListDesignProposalsInput,
  ListExecutionThreadsInput,
  ListFounderChartersInput,
  ListHarnessActionEventsInput,
  ListInboxEventsInput,
  ListRunningAttemptsInput,
  ListExternalRefsInput,
  FindExternalRefsInput,
  ListLessonsInput,
  ListRunsInput,
  ListStrategySignalsInput,
  MatchedExperiment,
  BlockedDependencyTask,
  BlockTasksWithBlockedDependenciesInput,
  BlockTasksWithSharedRootCauseInput,
  BlockTasksWithSharedRootCauseResult,
  SharedRootCauseRecord,
  RecordAttemptEventInput,
  RecordAttemptInput,
  RecordDesignDecisionInput,
  RecordDesignOutcomeInput,
  RecordHarnessActionEventInput,
  ProductionEpisode,
  BlockedUnfinishedTask,
  BlockUnfinishedTasksForRunInput,
  ReclaimedRunningTask,
  ReclaimRunningTasksInput,
  RetryTaskInput,
  RetireTaskInput,
  SetPromptTemplateInput,
  StartAttemptInput,
  Status,
  Task,
  UpdateDesignProposalStatusInput,
  UpdateRunStatusInput,
  UpdateRunInput,
  UpdateAttemptInputInput,
  UpdateExecutionThreadInput,
  UpsertExecutionThreadInput,
} from "./types";
import {
  canonicalEvolutionRecordSha256,
  parseEvolutionProfile,
  parseHarnessVariant,
  parseMatchedExperiment,
  parseProductionEpisode,
} from "./target-evolution";
import { basename, resolve } from "node:path";
import { readableList, readableValue } from "./readable";
import { readWatchdogState } from "./watchdog";

const ATTEMPT_EVENT_BUSY_RETRIES = 5;

// Production callers that own a transaction may pass these optional filters to
// find prior audit rows deterministically. Public callers see no change.
interface ListHarnessActionEventsWithDbInput extends ListHarnessActionEventsInput {
  actionType?: string;
  statuses?: Array<"done" | "blocked">;
  requestType?: string;
  requestRunId?: string;
  requestTaskId?: string;
}

interface ListEvolutionRecordsInput {
  projectId: string;
  profileId?: string;
}

interface GetEvolutionRecordInput {
  projectId: string;
  id: string;
}

interface ListHarnessVariantsInput extends ListEvolutionRecordsInput {
  role?: HarnessVariant["role"];
}

interface EvolutionRecordWriteResult<T> {
  record: T;
  reused: boolean;
}

export class Harness {
  readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = normalizeDatabasePath(dbPath);
  }

  init() {
    initDatabase(this.dbPath);
    this.seedPromptTemplates();
  }

  // Runs `callback` against a single database connection inside a transaction.
  // If the callback throws, the transaction rolls back and the error
  // propagates to the caller. Designer mutations and their audit events use
  // this primitive so a failed audit write cannot leave a durable strategy
  // mutation or child run behind.
  runInTransaction<T>(callback: (db: HarnessDatabase) => T): T {
    return withDatabase(this.dbPath, (db) => db.transaction(callback)(db));
  }

  // Acquire the SQLite write reservation before reading mutable coordination
  // state. This avoids deferred-transaction snapshot upgrades when multiple
  // daemon processes claim the same watchdog fingerprint concurrently.
  runInImmediateTransaction<T>(callback: (db: HarnessDatabase) => T): T {
    return withDatabase(this.dbPath, (db) => db.transaction(callback).immediate(db));
  }

  createProject(input: CreateProjectInput) {
    const id = input.id ?? makeId("project");
    const rootPath = resolve(input.rootPath);
    return withDatabase(this.dbPath, (db) => {
      const existing = db.query("select * from projects where root_path = $rootPath").get({ $rootPath: rootPath }) as
        | ProjectRow
        | null;
      if (existing) {
        return existing.id;
      }
      db.query(
        `
        insert into projects (id, name, root_path, context_json)
        values ($id, $name, $rootPath, $contextJson)
        `,
      ).run({
        $id: id,
        $name: input.name,
        $rootPath: rootPath,
        $contextJson: toJson(input.context ?? {}),
      });
      return id;
    });
  }

  getProject(id: string) {
    return withReadOnlyDatabase(this.dbPath, (db) => {
      const row = db.query("select * from projects where id = $id").get({ $id: id }) as ProjectRow | null;
      return row ? projectFromRow(row) : null;
    });
  }

  listProjects() {
    return withReadOnlyDatabase(this.dbPath, (db) => {
      const rows = db.query("select * from projects order by created_at, id").all() as ProjectRow[];
      return rows.map(projectFromRow);
    });
  }

  recordEvolutionProfile(value: unknown): EvolutionRecordWriteResult<EvolutionProfile> {
    return withDatabase(this.dbPath, (db) =>
      db.transaction(() => this.recordEvolutionProfileWithDb(db, value))(),
    );
  }

  recordEvolutionProfileWithDb(
    db: HarnessDatabase,
    value: unknown,
  ): EvolutionRecordWriteResult<EvolutionProfile> {
    ensureEvolutionRuntimeTables(db);
    const projectId = evolutionRecordProjectId(value, "EvolutionProfile");
    const record = parseEvolutionProfile(value, projectId);
    requireProjectWithDb(db, record.projectId);
    const recordJson = toJson(record);
    const existing = db
      .query("select * from evolution_profiles where id = $id")
      .get({ $id: record.id }) as EvolutionProfileRow | null;
    if (existing) {
      requireIdenticalEvolutionRecord(existing.record_json, recordJson, "EvolutionProfile", record.id);
      const stored = evolutionProfileFromRow(existing);
      requireEvolutionReadback(stored, recordJson, "EvolutionProfile", record.id);
      return { record: stored, reused: true };
    }

    db.query(
      `
      insert into evolution_profiles (
        id, schema_version, project_id, runtime_maturity, registered_at, record_sha256, record_json
      ) values (
        $id, $schemaVersion, $projectId, $runtimeMaturity, $registeredAt, $recordSha256, $recordJson
      )
      `,
    ).run({
      $id: record.id,
      $schemaVersion: record.schemaVersion,
      $projectId: record.projectId,
      $runtimeMaturity: record.runtimeMaturity,
      $registeredAt: record.registeredAt,
      $recordSha256: canonicalEvolutionRecordSha256(record),
      $recordJson: recordJson,
    });
    const inserted = this.getEvolutionProfileWithDb(db, { projectId: record.projectId, id: record.id });
    requireEvolutionReadback(inserted, recordJson, "EvolutionProfile", record.id);
    return { record: inserted, reused: false };
  }

  getEvolutionProfile(input: GetEvolutionRecordInput): EvolutionProfile | null {
    return withReadOnlyDatabase(this.dbPath, (db) => this.getEvolutionProfileWithDb(db, input));
  }

  getEvolutionProfileWithDb(db: HarnessDatabase, input: GetEvolutionRecordInput): EvolutionProfile | null {
    const row = db
      .query("select * from evolution_profiles where project_id = $projectId and id = $id")
      .get({ $projectId: input.projectId, $id: input.id }) as EvolutionProfileRow | null;
    return row ? evolutionProfileFromRow(row) : null;
  }

  listEvolutionProfiles(input: Pick<ListEvolutionRecordsInput, "projectId">): EvolutionProfile[] {
    return withReadOnlyDatabase(this.dbPath, (db) => {
      const query = db.query(
        `
        select * from evolution_profiles
        ${input.projectId ? "where project_id = $projectId" : ""}
        order by created_at, id
        `,
      );
      const rows = (input.projectId
        ? query.all({ $projectId: input.projectId })
        : query.all()) as EvolutionProfileRow[];
      return rows.map(evolutionProfileFromRow);
    });
  }

  recordProductionEpisode(value: unknown): EvolutionRecordWriteResult<ProductionEpisode> {
    return withDatabase(this.dbPath, (db) =>
      db.transaction(() => this.recordProductionEpisodeWithDb(db, value))(),
    );
  }

  recordProductionEpisodeWithDb(
    db: HarnessDatabase,
    value: unknown,
  ): EvolutionRecordWriteResult<ProductionEpisode> {
    ensureEvolutionRuntimeTables(db);
    const projectId = evolutionRecordProjectId(value, "ProductionEpisode");
    const record = parseProductionEpisode(value, projectId);
    requireProjectWithDb(db, record.projectId);
    const profile = requireEvolutionProfileWithDb(db, record.projectId, record.profileId, "ProductionEpisode");
    requireSameEvolutionScope(record, profile, "ProductionEpisode", record.id);
    const recordJson = toJson(record);
    const existing = db
      .query("select * from production_episodes where id = $id")
      .get({ $id: record.id }) as ProductionEpisodeRow | null;
    if (existing) {
      requireIdenticalEvolutionRecord(existing.record_json, recordJson, "ProductionEpisode", record.id);
      const stored = productionEpisodeFromRow(existing);
      requireEvolutionReadback(stored, recordJson, "ProductionEpisode", record.id);
      return { record: stored, reused: true };
    }

    db.query(
      `
      insert into production_episodes (
        id, schema_version, project_id, profile_id, source_ref,
        leakage_group_id, record_sha256, record_json
      ) values (
        $id, $schemaVersion, $projectId, $profileId, $sourceRef,
        $leakageGroupId, $recordSha256, $recordJson
      )
      `,
    ).run({
      $id: record.id,
      $schemaVersion: record.schemaVersion,
      $projectId: record.projectId,
      $profileId: record.profileId,
      $sourceRef: record.sourceRef,
      $leakageGroupId: record.leakageGroupId,
      $recordSha256: canonicalEvolutionRecordSha256(record),
      $recordJson: recordJson,
    });
    const inserted = this.getProductionEpisodeWithDb(db, { projectId: record.projectId, id: record.id });
    requireEvolutionReadback(inserted, recordJson, "ProductionEpisode", record.id);
    return { record: inserted, reused: false };
  }

  getProductionEpisode(input: GetEvolutionRecordInput): ProductionEpisode | null {
    return withReadOnlyDatabase(this.dbPath, (db) => this.getProductionEpisodeWithDb(db, input));
  }

  getProductionEpisodeWithDb(db: HarnessDatabase, input: GetEvolutionRecordInput): ProductionEpisode | null {
    const row = db
      .query("select * from production_episodes where project_id = $projectId and id = $id")
      .get({ $projectId: input.projectId, $id: input.id }) as ProductionEpisodeRow | null;
    return row ? productionEpisodeFromRow(row) : null;
  }

  listProductionEpisodes(input: ListEvolutionRecordsInput): ProductionEpisode[] {
    return withReadOnlyDatabase(this.dbPath, (db) => {
      const filters = evolutionScopeFilters(input);
      const rows = db
        .query(
          `select * from production_episodes ${filters.sql}
           order by created_at, id`,
        )
        .all(filters.params) as ProductionEpisodeRow[];
      return rows.map(productionEpisodeFromRow);
    });
  }

  recordHarnessVariant(value: unknown): EvolutionRecordWriteResult<HarnessVariant> {
    return withDatabase(this.dbPath, (db) =>
      db.transaction(() => this.recordHarnessVariantWithDb(db, value))(),
    );
  }

  recordHarnessVariantWithDb(
    db: HarnessDatabase,
    value: unknown,
  ): EvolutionRecordWriteResult<HarnessVariant> {
    ensureEvolutionRuntimeTables(db);
    const projectId = evolutionRecordProjectId(value, "HarnessVariant");
    const record = parseHarnessVariant(value, projectId);
    requireProjectWithDb(db, record.projectId);
    const profile = requireEvolutionProfileWithDb(db, record.projectId, record.profileId, "HarnessVariant");
    requireSameEvolutionScope(record, profile, "HarnessVariant", record.id);
    const allowedSurfaces = new Set(profile.allowedSurfaceIds);
    for (const surfaceId of record.mutationSurfaceIds) {
      if (!allowedSurfaces.has(surfaceId)) {
        throw new Error(
          `HarnessVariant ${record.id} mutation surface is not allowed by profile ${profile.id}: ${surfaceId}`,
        );
      }
    }
    const recordJson = toJson(record);
    const existing = db
      .query("select * from harness_variants where id = $id")
      .get({ $id: record.id }) as HarnessVariantRow | null;
    if (existing) {
      requireIdenticalEvolutionRecord(existing.record_json, recordJson, "HarnessVariant", record.id);
      const stored = harnessVariantFromRow(existing);
      requireEvolutionReadback(stored, recordJson, "HarnessVariant", record.id);
      return { record: stored, reused: true };
    }

    db.query(
      `
      insert into harness_variants (
        id, schema_version, project_id, profile_id, role, record_sha256, record_json
      ) values (
        $id, $schemaVersion, $projectId, $profileId, $role, $recordSha256, $recordJson
      )
      `,
    ).run({
      $id: record.id,
      $schemaVersion: record.schemaVersion,
      $projectId: record.projectId,
      $profileId: record.profileId,
      $role: record.role,
      $recordSha256: canonicalEvolutionRecordSha256(record),
      $recordJson: recordJson,
    });
    const inserted = this.getHarnessVariantWithDb(db, { projectId: record.projectId, id: record.id });
    requireEvolutionReadback(inserted, recordJson, "HarnessVariant", record.id);
    return { record: inserted, reused: false };
  }

  getHarnessVariant(input: GetEvolutionRecordInput): HarnessVariant | null {
    return withReadOnlyDatabase(this.dbPath, (db) => this.getHarnessVariantWithDb(db, input));
  }

  getHarnessVariantWithDb(db: HarnessDatabase, input: GetEvolutionRecordInput): HarnessVariant | null {
    const row = db
      .query("select * from harness_variants where project_id = $projectId and id = $id")
      .get({ $projectId: input.projectId, $id: input.id }) as HarnessVariantRow | null;
    return row ? harnessVariantFromRow(row) : null;
  }

  listHarnessVariants(input: ListHarnessVariantsInput): HarnessVariant[] {
    return withReadOnlyDatabase(this.dbPath, (db) => {
      const filters = evolutionScopeFilters(input, input.role);
      const rows = db
        .query(
          `select * from harness_variants ${filters.sql}
           order by created_at, id`,
        )
        .all(filters.params) as HarnessVariantRow[];
      return rows.map(harnessVariantFromRow);
    });
  }

  recordMatchedExperiment(value: unknown): EvolutionRecordWriteResult<MatchedExperiment> {
    return withDatabase(this.dbPath, (db) =>
      db.transaction(() => this.recordMatchedExperimentWithDb(db, value))(),
    );
  }

  recordMatchedExperimentWithDb(
    db: HarnessDatabase,
    value: unknown,
  ): EvolutionRecordWriteResult<MatchedExperiment> {
    ensureEvolutionRuntimeTables(db);
    const projectId = evolutionRecordProjectId(value, "MatchedExperiment");
    const record = parseMatchedExperiment(value, projectId);
    if (record.outcome !== "pending") {
      throw new Error(`MatchedExperiment ${record.id} must be recorded with pending outcome`);
    }
    requireProjectWithDb(db, record.projectId);
    const profile = requireEvolutionProfileWithDb(db, record.projectId, record.profileId, "MatchedExperiment");
    requireSameEvolutionScope(record, profile, "MatchedExperiment", record.id);

    const control = requireHarnessVariantWithDb(
      db,
      record.projectId,
      record.profileId,
      record.controlVariantId,
      "control",
    );
    const candidate = requireHarnessVariantWithDb(
      db,
      record.projectId,
      record.profileId,
      record.candidateVariantId,
      "candidate",
    );
    requireVariantForExperiment(control, record, "control");
    requireVariantForExperiment(candidate, record, "candidate");
    requireExperimentEpisodesWithDb(db, record);

    const recordJson = toJson(record);
    const existing = db
      .query("select * from matched_experiments where id = $id")
      .get({ $id: record.id }) as MatchedExperimentRow | null;
    if (existing) {
      requireIdenticalEvolutionRecord(existing.record_json, recordJson, "MatchedExperiment", record.id);
      const stored = matchedExperimentFromRow(existing);
      requireEvolutionReadback(stored, recordJson, "MatchedExperiment", record.id);
      return { record: stored, reused: true };
    }

    db.query(
      `
      insert into matched_experiments (
        id, schema_version, project_id, profile_id, control_variant_id,
        candidate_variant_id, outcome, record_sha256, record_json
      ) values (
        $id, $schemaVersion, $projectId, $profileId, $controlVariantId,
        $candidateVariantId, $outcome, $recordSha256, $recordJson
      )
      `,
    ).run({
      $id: record.id,
      $schemaVersion: record.schemaVersion,
      $projectId: record.projectId,
      $profileId: record.profileId,
      $controlVariantId: record.controlVariantId,
      $candidateVariantId: record.candidateVariantId,
      $outcome: record.outcome,
      $recordSha256: canonicalEvolutionRecordSha256(record),
      $recordJson: recordJson,
    });
    const inserted = this.getMatchedExperimentWithDb(db, { projectId: record.projectId, id: record.id });
    requireEvolutionReadback(inserted, recordJson, "MatchedExperiment", record.id);
    return { record: inserted, reused: false };
  }

  getMatchedExperiment(input: GetEvolutionRecordInput): MatchedExperiment | null {
    return withReadOnlyDatabase(this.dbPath, (db) => this.getMatchedExperimentWithDb(db, input));
  }

  getMatchedExperimentWithDb(db: HarnessDatabase, input: GetEvolutionRecordInput): MatchedExperiment | null {
    const row = db
      .query("select * from matched_experiments where project_id = $projectId and id = $id")
      .get({ $projectId: input.projectId, $id: input.id }) as MatchedExperimentRow | null;
    return row ? matchedExperimentFromRow(row) : null;
  }

  listMatchedExperiments(input: ListEvolutionRecordsInput): MatchedExperiment[] {
    return withReadOnlyDatabase(this.dbPath, (db) => {
      const filters = evolutionScopeFilters(input);
      const rows = db
        .query(
          `select * from matched_experiments ${filters.sql}
           order by created_at, id`,
        )
        .all(filters.params) as MatchedExperimentRow[];
      return rows.map(matchedExperimentFromRow);
    });
  }

  createRun(input: CreateRunInput) {
    const id = input.id ?? makeId("run");
    return withDatabase(this.dbPath, (db) => this.createRunWithDb(db, { ...input, id }));
  }

  createRunWithDb(db: HarnessDatabase, input: CreateRunInput) {
    const id = input.id ?? makeId("run");
    const projectId = resolveRunProjectId(db, input);
    db.query(
      `
      insert into runs (id, project_id, goal, status, context_json)
      values ($id, $projectId, $goal, 'todo', $contextJson)
      `,
    ).run({
      $id: id,
      $projectId: projectId,
      $goal: input.goal,
      $contextJson: toJson(input.context ?? {}),
    });
    return id;
  }

  updateRunStatus(input: UpdateRunStatusInput) {
    return withDatabase(this.dbPath, (db) => this.updateRunStatusWithDb(db, input));
  }

  updateRunStatusWithDb(db: HarnessDatabase, input: UpdateRunStatusInput) {
    if (input.status === "done") {
      const current = this.getRunWithDb(db, input.runId);
      if (current && current.status !== "done") {
        assertRunCompletionReady(this.getRunOverviewWithDb(db, { runId: input.runId, eventLimit: 0 }));
      }
    }
    db.query(
      `
      update runs
      set status = $status, updated_at = current_timestamp
      where id = $runId
      `,
    ).run({
      $status: input.status,
      $runId: input.runId,
    });
  }

  updateRun(input: UpdateRunInput) {
    return withDatabase(this.dbPath, (db) => this.updateRunWithDb(db, input));
  }

  updateRunWithDb(db: HarnessDatabase, input: UpdateRunInput) {
    const existing = db.query("select * from runs where id = $runId").get({ $runId: input.runId }) as RunRow | null;
    if (!existing) {
      return null;
    }
    const current = runFromRow(existing);
    const nextContext = input.contextPatch ? { ...current.context, ...input.contextPatch } : current.context;
    if (input.status === "done" && current.status !== "done") {
      assertRunCompletionReady(this.getRunOverviewWithDb(db, { runId: input.runId, eventLimit: 0 }));
    }
    db.query(
      `
      update runs
      set goal = $goal,
          status = $status,
          context_json = $contextJson,
          updated_at = current_timestamp
      where id = $runId
      `,
    ).run({
      $goal: input.goal ?? current.goal,
      $status: input.status ?? current.status,
      $contextJson: toJson(nextContext),
      $runId: input.runId,
    });
    return this.getRunWithDb(db, input.runId);
  }

  reconcileDrainedResearchRecoveryRun(input: { runId: string }) {
    return withDatabase(this.dbPath, (db) =>
      db.transaction(() => this.reconcileDrainedResearchRecoveryRunWithDb(db, input.runId)).immediate(),
    );
  }

  reconcileDrainedResearchRecoveryRunWithDb(db: HarnessDatabase, runId: string) {
    const runRow = db.query("select * from runs where id = $runId").get({ $runId: runId }) as RunRow | null;
    if (!runRow || (runRow.status !== "todo" && runRow.status !== "running")) {
      return false;
    }
    const run = runFromRow(runRow);
    if (run.context.researchOnly !== true || run.context.forbidImplementation !== true) {
      return false;
    }

    const taskRows = db.query(
      "select * from tasks where run_id = $runId order by created_at, id",
    ).all({ $runId: runId }) as TaskRow[];
    if (taskRows.length === 0 || taskRows.some((row) => row.status === "todo" || row.status === "running")) {
      return false;
    }
    const tasks = taskRows.map(taskFromRow);
    if (tasks.some((task) => task.role !== "designer"
      || task.config?.researchOnly !== true
      || task.config?.forbidBrowser !== true
      || task.config?.forbidWrites !== true
      || task.config?.forbidActions !== true)) {
      return false;
    }

    const runningAttempt = db.query(
      `
      select 1
      from attempts
      join tasks on tasks.id = attempts.task_id
      where tasks.run_id = $runId and attempts.status = 'running'
      limit 1
      `,
    ).get({ $runId: runId });
    if (runningAttempt) {
      return false;
    }
    const runningThread = db.query(
      `
      select 1
      from execution_threads
      left join attempts on attempts.id = execution_threads.attempt_id
      where execution_threads.run_id = $runId
        and execution_threads.status = 'running'
        and (execution_threads.attempt_id is null or attempts.status = 'running')
      limit 1
      `,
    ).get({ $runId: runId });
    if (runningThread) {
      return false;
    }

    for (const recoveryTask of [...tasks].reverse()) {
      if (recoveryTask.status !== "done") continue;
      const recovery = recoveryTask.config?.deadAttemptRecovery;
      if (!isDeadAttemptRecovery(recovery)) continue;
      if (recoveryTask.parentId !== recovery.sourceTaskId) continue;
      const sourceTask = tasks.find((task) => task.id === recovery.sourceTaskId);
      if (!sourceTask || sourceTask.status !== "blocked" || sourceTask.role !== recoveryTask.role) continue;
      if (toJson(sourceTask.doneWhen) !== toJson(recoveryTask.doneWhen)) continue;

      const sourceAttemptRow = db.query(
        "select * from attempts where id = $attemptId and task_id = $taskId and status = 'blocked'",
      ).get({ $attemptId: recovery.sourceAttemptId, $taskId: sourceTask.id }) as AttemptRow | null;
      if (!sourceAttemptRow) continue;
      const recoveryAttemptRow = db.query(
        `
        select * from attempts
        where task_id = $taskId and status = 'done'
        order by finished_at desc, id desc
        limit 1
        `,
      ).get({ $taskId: recoveryTask.id }) as AttemptRow | null;
      if (!recoveryAttemptRow) continue;
      const output = attemptFromRow(recoveryAttemptRow).output;
      if ((output.changedFiles?.length ?? 0) > 0
        || (output.nextTasks?.length ?? 0) > 0
        || (output.nextRuns?.length ?? 0) > 0
        || (output.designActions?.length ?? 0) > 0) {
        continue;
      }

      const nextContext = {
        ...run.context,
        researchRecoveryClosure: {
          kind: "bounded-dead-attempt-recovery",
          sourceTaskId: sourceTask.id,
          sourceAttemptId: recovery.sourceAttemptId,
          recoveryTaskId: recoveryTask.id,
          recoveryAttemptId: recoveryAttemptRow.id,
          recoveryCount: recovery.count,
          recoveryLimit: recovery.limit,
        },
      };
      const updated = db.query(
        `
        update runs
        set status = 'done', context_json = $contextJson, updated_at = current_timestamp
        where id = $runId
          and status in ('todo', 'running')
          and not exists (
            select 1 from tasks where run_id = $runId and status in ('todo', 'running')
          )
        `,
      ).run({ $runId: runId, $contextJson: toJson(nextContext) });
      return updated.changes === 1;
    }
    return false;
  }

  clearRunPause(runId: string) {
    return this.updateRun({
      runId,
      contextPatch: {
        runPause: null,
        runPauseClearedAt: new Date().toISOString(),
      },
    });
  }

  createTask(input: CreateTaskInput) {
    const id = input.id ?? makeId("task");
    return withDatabase(this.dbPath, (db) => this.createTaskWithDb(db, { ...input, id }));
  }

  createTaskWithDb(db: HarnessDatabase, input: CreateTaskInput) {
    const id = input.id ?? makeId("task");
    assertTaskGovernanceBoundaryWithDb(db, input);
    const cycleId = resolveTaskCycleId(db, {
      id,
      role: input.role,
      parentId: input.parentId ?? null,
      dependsOn: input.dependsOn ?? [],
      cycleId: input.cycleId ?? null,
    });
    db.query(
      `
      insert into tasks (
        id, run_id, parent_id, cycle_id, status, role, goal, prompt,
        depends_on_json, done_when_json, worktree_path, config_json
      )
      values (
        $id, $runId, $parentId, $cycleId, 'todo', $role, $goal, $prompt,
        $dependsOnJson, $doneWhenJson, $worktreePath, $configJson
      )
      `,
    ).run({
      $id: id,
      $runId: input.runId,
      $parentId: input.parentId ?? null,
      $cycleId: cycleId,
      $role: input.role,
      $goal: input.goal,
      $prompt: input.prompt,
      $dependsOnJson: toJson(input.dependsOn ?? []),
      $doneWhenJson: toJson(input.doneWhen ?? []),
      $worktreePath: input.worktreePath ?? null,
      $configJson: toJson(input.config ?? {}),
    });
    return id;
  }

  assertTaskExecutionAllowed(input: { taskId: string }) {
    return withDatabase(this.dbPath, (db) => this.assertTaskExecutionAllowedWithDb(db, input.taskId));
  }

  assertTaskExecutionAllowedWithDb(db: HarnessDatabase, taskId: string) {
    const taskRow = db.query("select * from tasks where id = $taskId").get({ $taskId: taskId }) as TaskRow | null;
    if (!taskRow) {
      throw new Error(`task not found: ${taskId}`);
    }
    assertTaskGovernanceBoundaryWithDb(db, {
      id: taskRow.id,
      runId: taskRow.run_id,
      parentId: taskRow.parent_id,
      cycleId: taskRow.cycle_id,
      role: taskRow.role,
      goal: taskRow.goal,
      prompt: taskRow.prompt,
      dependsOn: JSON.parse(taskRow.depends_on_json) as string[],
      doneWhen: JSON.parse(taskRow.done_when_json) as string[],
      worktreePath: taskRow.worktree_path,
      config: JSON.parse(taskRow.config_json) as Record<string, unknown>,
    });
    return true;
  }

  getRun(id: string) {
    return withDatabase(this.dbPath, (db) => {
      const row = db
        .query(
          `
          select runs.*, projects.root_path as project_root
          from runs
          left join projects on projects.id = runs.project_id
          where runs.id = $id
          `,
        )
        .get({ $id: id }) as RunRow | null;
      return row ? runFromRow(row) : null;
    });
  }

  // Transaction-aware variant for callers that already hold a database
  // transaction (e.g. createRunsFromDesign verifying canonical state inside
  // the same atomic step that creates the run, task, and external reference).
  getRunWithDb(db: HarnessDatabase, id: string) {
    const row = db
      .query(
        `
        select runs.*, projects.root_path as project_root
        from runs
        left join projects on projects.id = runs.project_id
        where runs.id = $id
        `,
      )
      .get({ $id: id }) as RunRow | null;
    return row ? runFromRow(row) : null;
  }

  getTask(id: string) {
    return withDatabase(this.dbPath, (db) => {
      const row = db.query("select * from tasks where id = $id").get({ $id: id }) as TaskRow | null;
      return row ? taskFromRow(row) : null;
    });
  }

  getAttempt(id: string) {
    return withDatabase(this.dbPath, (db) => {
      const row = db.query("select * from attempts where id = $id").get({ $id: id }) as AttemptRow | null;
      return row ? attemptFromRow(row) : null;
    });
  }

  getAttemptWithDb(db: HarnessDatabase, id: string) {
    const row = db.query("select * from attempts where id = $id").get({ $id: id }) as AttemptRow | null;
    return row ? attemptFromRow(row) : null;
  }

  listRunningAttempts(input: ListRunningAttemptsInput) {
    return withDatabase(this.dbPath, (db) => {
      const rows = db
        .query(
          `
          select attempts.*
          from attempts
          join tasks on tasks.id = attempts.task_id
          where tasks.run_id = $runId and attempts.status = 'running'
          order by attempts.started_at, attempts.id
          `,
        )
        .all({ $runId: input.runId }) as AttemptRow[];
      return rows.map(attemptFromRow);
    });
  }

  interruptRunningAttemptsByOwner(input: { runId: string; pid: number; reason: string }) {
    return withDatabase(this.dbPath, (db) =>
      db.transaction(() => {
        ensureExecutionThreads(db);
        const rows = db.query(
          `
          select attempts.id as attempt_id, tasks.id as task_id, execution_threads.id as thread_id
          from execution_threads
          join attempts on attempts.id = execution_threads.attempt_id
          join tasks on tasks.id = attempts.task_id
          where execution_threads.run_id = $runId
            and execution_threads.pid = $pid
            and execution_threads.status = 'running'
            and attempts.status = 'running'
            and tasks.status = 'running'
          order by attempts.started_at, attempts.id
          `,
        ).all({ $runId: input.runId, $pid: input.pid }) as Array<{
          attempt_id: string;
          task_id: string;
          thread_id: string;
        }>;
        for (const row of rows) {
          this.finishAttemptWithDb(db, {
            attemptId: row.attempt_id,
            output: {
              status: "blocked",
              summary: "Runner interrupted before the attempt reached a terminal result",
              changedFiles: [],
              checks: [{ name: "runner interruption", status: "failed", evidence: input.reason }],
              artifacts: [{
                kind: "runner_interruption",
                runId: input.runId,
                taskId: row.task_id,
                attemptId: row.attempt_id,
                threadId: row.thread_id,
                ownerPid: input.pid,
              }],
              problems: [input.reason],
            },
          });
          db.query(
            `
            update execution_threads
            set status = 'interrupted',
                interrupt_reason = $reason,
                interrupted_at = coalesce(interrupted_at, current_timestamp),
                updated_at = current_timestamp
            where id = $threadId and status = 'running'
            `,
          ).run({ $threadId: row.thread_id, $reason: input.reason });
        }
        return rows.map((row) => ({
          runId: input.runId,
          taskId: row.task_id,
          attemptId: row.attempt_id,
          threadId: row.thread_id,
          status: "blocked" as const,
          reason: input.reason,
        }));
      }).immediate(),
    );
  }

  recoverRunningAttempt(input: {
    attemptId: string;
    reason: string;
    maxRecoveries?: number;
    output?: AttemptOutput;
  }) {
    if (input.maxRecoveries !== undefined && (!Number.isInteger(input.maxRecoveries) || input.maxRecoveries < 0)) {
      throw new Error("maxRecoveries must be a non-negative integer");
    }
    return withDatabase(this.dbPath, (db) =>
      db.transaction(() => this.recoverRunningAttemptWithDb(db, input)).immediate(),
    );
  }

  recoverRunningAttemptWithDb(db: HarnessDatabase, input: {
    attemptId: string;
    reason: string;
    maxRecoveries?: number;
    output?: AttemptOutput;
  }): ReclaimedRunningTask | null {
    const row = db.query(
      `
      select tasks.*, attempts.input_json as source_attempt_input_json,
             execution_threads.pid as owner_pid
      from attempts
      join tasks on tasks.id = attempts.task_id
      left join execution_threads on execution_threads.attempt_id = attempts.id
        and execution_threads.status = 'running'
      where attempts.id = $attemptId
        and attempts.status = 'running'
        and tasks.status = 'running'
      limit 1
      `,
    ).get({ $attemptId: input.attemptId }) as (TaskRow & {
      source_attempt_input_json: string;
      owner_pid: number | null;
    }) | null;
    if (!row) {
      return null;
    }
    const task = taskFromRow(row);
    const previousRecovery = task.config?.deadAttemptRecovery;
    const previousCount = typeof previousRecovery === "object" && previousRecovery !== null
      && Number.isInteger((previousRecovery as { count?: unknown }).count)
      && Number((previousRecovery as { count: number }).count) >= 0
      ? Number((previousRecovery as { count: number }).count)
      : 0;
    const requestedLimit = input.maxRecoveries ?? 1;
    const recoveryLimit = typeof previousRecovery === "object" && previousRecovery !== null
      && Number.isInteger((previousRecovery as { limit?: unknown }).limit)
      && Number((previousRecovery as { limit: number }).limit) >= 0
      ? Number((previousRecovery as { limit: number }).limit)
      : requestedLimit;
    let canRetry = previousCount < recoveryLimit;
    let governanceBlocker: string | null = null;
    if (canRetry) {
      try {
        assertTaskGovernanceBoundaryWithDb(db, {
          id: task.id,
          runId: task.runId,
          parentId: task.parentId,
          cycleId: task.cycleId,
          role: task.role,
          goal: task.goal,
          prompt: task.prompt,
          dependsOn: task.dependsOn,
          doneWhen: task.doneWhen,
          worktreePath: task.worktreePath,
          config: task.config,
        });
      } catch (error) {
        governanceBlocker = error instanceof Error ? error.message : String(error);
        canRetry = false;
      }
    }
    const recoveryCount = canRetry ? previousCount + 1 : recoveryLimit;
    const eventRows = db.query(
      `select id from attempt_events where attempt_id = $attemptId order by sequence desc limit 8`,
    ).all({ $attemptId: input.attemptId }) as Array<{ id: string }>;
    const durableEventRefs = eventRows.map((event) => event.id).reverse();
    const output: AttemptOutput = input.output
      ? {
          ...input.output,
          status: "blocked",
          artifacts: [
            ...(input.output.artifacts ?? []),
            {
              kind: "resumable_control_plane_failure",
              taskId: task.id,
              attemptId: input.attemptId,
              ownerPid: row.owner_pid,
              durableEventRefs,
              reason: input.reason,
            },
          ],
          problems: [...(input.output.problems ?? []), input.reason, ...(governanceBlocker ? [governanceBlocker] : [])],
        }
      : {
          status: "blocked",
          summary: "Running attempt owner exited without terminal output",
          changedFiles: [],
          checks: [{ name: "execution owner pid", status: "failed", evidence: String(row.owner_pid) }],
          artifacts: [{
            kind: "dead_execution_lease",
            taskId: task.id,
            attemptId: input.attemptId,
            ownerPid: row.owner_pid,
            durableEventRefs,
          }],
          problems: [input.reason, ...(governanceBlocker ? [governanceBlocker] : [])],
        };
    this.finishAttemptWithDb(db, { attemptId: input.attemptId, output });
    db.query(
      `
      update execution_threads
      set status = $status, interrupt_reason = $reason,
          interrupted_at = coalesce(interrupted_at, current_timestamp), updated_at = current_timestamp
      where attempt_id = $attemptId and status = 'running'
      `,
    ).run({
      $attemptId: input.attemptId,
      $status: governanceBlocker ? "interrupted" : "orphaned",
      $reason: governanceBlocker ?? input.reason,
    });

    let recoveryTaskId: string | null = null;
    if (canRetry) {
      recoveryTaskId = `task_recovery_${input.attemptId.replace(/^attempt_/, "")}`;
      const sourceAttemptInput = JSON.parse(row.source_attempt_input_json) as Record<string, unknown>;
      const inheritedExecutionContract = Object.fromEntries(
        ["sandbox", "permissionMode", "browserProcessPolicy", "forbidBrowser", "forbidImplementation"]
          .flatMap((key) => sourceAttemptInput[key] === undefined ? [] : [[key, sourceAttemptInput[key]]]),
      );
      const eventList = durableEventRefs.length > 0 ? durableEventRefs.join(", ") : "none recorded";
      this.createTaskWithDb(db, {
        id: recoveryTaskId,
        runId: task.runId,
        parentId: task.id,
        cycleId: task.cycleId,
        role: task.role,
        goal: task.goal,
        prompt: [
          `Recover the interrupted ${task.role} task under its existing frozen contract.`,
          `Source task: ${task.id}`,
          `Source attempt: ${input.attemptId}`,
          `Durable event refs: ${eventList}`,
          `Latest control-plane failure: ${input.reason}`,
          "Continue from those persisted event references. Do not repeat the full evidence scan and do not broaden the role or permissions.",
          "Return one structured terminal result.",
        ].join("\n"),
        dependsOn: task.dependsOn,
        doneWhen: task.doneWhen,
        worktreePath: task.worktreePath,
        config: {
          ...inheritedExecutionContract,
          ...(task.config ?? {}),
          deadAttemptRecovery: {
            count: recoveryCount,
            limit: recoveryLimit,
            sourceTaskId: task.id,
            sourceAttemptId: input.attemptId,
            durableEventRefs,
          },
        },
      });
    }
    return {
      taskId: task.id,
      sessionRef: task.sessionRef,
      worktreePath: task.worktreePath,
      reason: input.reason,
      status: canRetry ? "todo" : "blocked",
      recoveryCount,
      recoveryLimit,
      attemptId: null,
      sourceAttemptId: input.attemptId,
      recoveryTaskId,
    };
  }

  reclaimRunningTasksWithoutAttempts(input: ReclaimRunningTasksInput): ReclaimedRunningTask[] {
    return withDatabase(this.dbPath, (db) => {
      ensureExecutionThreads(db);
      const recoveryLimit = input.maxRecoveries ?? 3;
      if (!Number.isInteger(recoveryLimit) || recoveryLimit < 0) {
        throw new Error("maxRecoveries must be a non-negative integer");
      }
      return db.transaction(() => {
        const rows = db
          .query(
            `
            select tasks.*
            from tasks
            left join attempts on attempts.task_id = tasks.id and attempts.status = 'running'
            where tasks.run_id = $runId
              and tasks.status = 'running'
              and attempts.id is null
            order by tasks.created_at, tasks.id
            `,
          )
          .all({ $runId: input.runId }) as TaskRow[];
        const reclaimed: ReclaimedRunningTask[] = [];
        for (const task of rows.map(taskFromRow)) {
          const previousRecovery = task.config?.orphanedLeaseRecovery;
          const previousCount = typeof previousRecovery === "object" && previousRecovery !== null
            && Number.isInteger((previousRecovery as { count?: unknown }).count)
            && Number((previousRecovery as { count: number }).count) >= 0
            ? Number((previousRecovery as { count: number }).count)
            : 0;
          const storedLimit = typeof previousRecovery === "object" && previousRecovery !== null
            && Number.isInteger((previousRecovery as { limit?: unknown }).limit)
            && Number((previousRecovery as { limit: number }).limit) >= 0
            ? Number((previousRecovery as { limit: number }).limit)
            : recoveryLimit;
          const canRetry = previousCount < storedLimit;
          const recoveryCount = canRetry ? previousCount + 1 : storedLimit;
          const recovery = { count: recoveryCount, limit: storedLimit };
          const config = { ...(task.config ?? {}), orphanedLeaseRecovery: recovery };
          const reason = canRetry
            ? "running task has no running attempt"
            : `orphaned task lease recovery exhausted (${storedLimit}/${storedLimit})`;
          let attemptId: string | null = null;
          db.query(
            `
            update tasks
            set status = $status,
                config_json = $configJson,
                updated_at = current_timestamp
            where id = $taskId and status = 'running'
            `,
          ).run({
            $taskId: task.id,
            $status: canRetry ? "todo" : "running",
            $configJson: toJson(config),
          });
          db.query(
            `
            update execution_threads
            set status = 'orphaned',
                interrupt_reason = $reason,
                interrupted_at = coalesce(interrupted_at, current_timestamp),
                updated_at = current_timestamp
            where task_id = $taskId and attempt_id is null and status = 'running'
            `,
          ).run({ $taskId: task.id, $reason: reason });
          if (!canRetry) {
            attemptId = this.recordAttemptWithDb(db, {
              taskId: task.id,
              input: {
                recovery: "orphaned-lease",
                recoveryCount,
                recoveryLimit: storedLimit,
                sessionRef: task.sessionRef,
                worktreePath: task.worktreePath,
              },
              output: {
                status: "blocked",
                summary: "orphaned task lease recovery exhausted",
                changedFiles: [],
                checks: [{ name: "orphaned lease recovery budget", status: "failed" }],
                artifacts: [{
                  type: "orphaned_lease_recovery",
                  taskId: task.id,
                  recoveryCount,
                  recoveryLimit: storedLimit,
                }],
                problems: [reason],
              },
            });
          }
          reclaimed.push({
            taskId: task.id,
            sessionRef: task.sessionRef,
            worktreePath: task.worktreePath,
            reason,
            status: canRetry ? "todo" : "blocked",
            recoveryCount,
            recoveryLimit: storedLimit,
            attemptId,
          });
        }

        const runningAttemptRows = db
          .query(
            `
            select tasks.*,
                   attempts.id as source_attempt_id,
                   execution_threads.pid as owner_pid
            from tasks
            join attempts on attempts.task_id = tasks.id and attempts.status = 'running'
            join execution_threads on execution_threads.attempt_id = attempts.id
              and execution_threads.status = 'running'
            where tasks.run_id = $runId
              and tasks.status = 'running'
            order by tasks.created_at, tasks.id, attempts.started_at, attempts.id
            `,
          )
          .all({ $runId: input.runId }) as Array<TaskRow & {
            source_attempt_id: string;
            owner_pid: number | null;
          }>;
        for (const row of runningAttemptRows) {
          if (row.owner_pid === null || processIsAlive(row.owner_pid)) {
            continue;
          }
          const recovered = this.recoverRunningAttemptWithDb(db, {
            attemptId: row.source_attempt_id,
            reason: "running attempt owner exited without terminal output",
            maxRecoveries: recoveryLimit,
          });
          if (recovered) {
            reclaimed.push(recovered);
          }
        }
        return reclaimed;
      }).immediate();
    });
  }

  listLatestAttemptsForTasks(taskIds: string[]): DependencyAttempt[] {
    if (taskIds.length === 0) {
      return [];
    }

    return withDatabase(this.dbPath, (db) => {
      const latestAttemptQuery = db.query(`
        select *
        from attempts
        where task_id = $taskId
        order by finished_at desc, started_at desc, rowid desc
        limit 1
      `);
      return taskIds.flatMap((taskId) => {
        const row = latestAttemptQuery.get({ $taskId: taskId }) as AttemptRow | null;
        if (!row) {
          return [];
        }
        const attempt = attemptFromRow(row);
        return [
          {
            taskId,
            attemptId: attempt.id,
            status: attempt.output.status,
            summary: attempt.output.summary,
            changedFiles: attempt.output.changedFiles ?? [],
            checks: attempt.output.checks ?? [],
            artifacts: attempt.output.artifacts ?? [],
            problems: attempt.output.problems ?? [],
          },
        ];
      });
    });
  }

  nextReadyTask(runId: string) {
    return withDatabase(this.dbPath, (db) => {
      const taskRows = db
        .query(
          `
          select *
          from tasks
          where run_id = $runId and status = 'todo'
          order by created_at, id
          `,
        )
        .all({ $runId: runId }) as TaskRow[];
      const allTaskRows = db.query("select * from tasks where run_id = $runId").all({ $runId: runId }) as TaskRow[];
      const dependencyIsSatisfied = createDependencyReadiness(allTaskRows.map(taskFromRow));

      for (const row of taskRows) {
        const task = taskFromRow(row);
        if (task.dependsOn.every((dependencyId) => dependencyIsSatisfied(dependencyId, task))) {
          return task;
        }
      }
      return null;
    });
  }

  blockUnfinishedTasksForRun(input: BlockUnfinishedTasksForRunInput): BlockedUnfinishedTask[] {
    return withDatabase(this.dbPath, (db) => {
      ensureExecutionThreads(db);
      const rows = db
        .query(
          `
          select *
          from tasks
          where run_id = $runId and status in ('todo', 'running')
          order by created_at, id
          `,
        )
        .all({ $runId: input.runId }) as TaskRow[];
      const blocked = rows.map(taskFromRow).map((task) => ({
        taskId: task.id,
        role: task.role,
        previousStatus: task.status as Extract<Status, "todo" | "running">,
        reason: input.reason,
      }));
      if (blocked.length === 0) {
        return blocked;
      }
      const output = {
        status: "blocked",
        summary: `Task was blocked because its run was retired: ${input.reason}`,
        changedFiles: [],
        checks: [{ name: "run retirement", status: "blocked", evidence: input.reason }],
        artifacts: [],
        problems: [input.reason],
      };
      return db.transaction(() => {
        for (const task of blocked) {
          db.query(
            `
            update attempts
            set status = 'blocked',
                output_json = $outputJson,
                checks_json = $checksJson,
                artifacts_json = '[]',
                error = $error,
                finished_at = current_timestamp
            where task_id = $taskId and status = 'running'
            `,
          ).run({
            $taskId: task.taskId,
            $outputJson: toJson(output),
            $checksJson: toJson(output.checks),
            $error: input.reason,
          });
          db.query(
            `
            update tasks
            set status = 'blocked', updated_at = current_timestamp
            where id = $taskId and status in ('todo', 'running')
            `,
          ).run({ $taskId: task.taskId });
          db.query(
            `
            update execution_threads
            set status = 'interrupted',
                interrupt_reason = $reason,
                interrupted_at = coalesce(interrupted_at, current_timestamp),
                updated_at = current_timestamp
            where task_id = $taskId and status = 'running'
            `,
          ).run({ $taskId: task.taskId, $reason: input.reason });
        }
        return blocked;
      })();
    });
  }

  blockTasksWithBlockedDependencies(input: BlockTasksWithBlockedDependenciesInput): BlockedDependencyTask[] {
    return withDatabase(this.dbPath, (db) => {
      const rows = db
        .query(
          `
          select *
          from tasks
          where run_id = $runId
          order by created_at, id
          `,
        )
        .all({ $runId: input.runId }) as TaskRow[];
      const tasks = rows.map(taskFromRow);
      const tasksById = new Map(tasks.map((task) => [task.id, task]));
      const dependencyIsSatisfied = createDependencyReadiness(tasks);
      const blocked = tasks
        .filter((task) => task.status === "todo")
        .flatMap((task) => {
          const dependencyIds = task.dependsOn.filter((dependencyId) => {
            const dependency = tasksById.get(dependencyId);
            return dependency?.status === "blocked" && !dependencyIsSatisfied(dependencyId, task);
          });
          if (dependencyIds.length === 0) {
            return [];
          }
          return [{
            taskId: task.id,
            role: task.role,
            previousStatus: task.status as Extract<Status, "todo">,
            dependencyIds,
            reason: input.reason,
          }];
        });

      if (blocked.length === 0) {
        return blocked;
      }

      return db.transaction(() => {
        for (const task of blocked) {
          const output = {
            status: "blocked" as const,
            summary: `Task blocked because dependencies are blocked: ${task.dependencyIds.join(", ")}`,
            changedFiles: [],
            checks: [
              { name: "blocked dependencies", status: "failed", evidence: task.dependencyIds.join(",") },
            ],
            artifacts: [
              {
                kind: "blocked_dependency_task",
                taskId: task.taskId,
                dependencyIds: task.dependencyIds,
                reason: task.reason,
              },
            ],
            problems: [task.reason],
          };
          const attemptId = makeId("attempt");
          db.query(
            `
            insert into attempts (
              id, task_id, status, input_json, output_json,
              checks_json, artifacts_json, error, finished_at
            )
            values (
              $id, $taskId, 'blocked', $inputJson, $outputJson,
              $checksJson, $artifactsJson, $error, current_timestamp
            )
            `,
          ).run({
            $id: attemptId,
            $taskId: task.taskId,
            $inputJson: toJson({ executor: "harness", reason: task.reason }),
            $outputJson: toJson(output),
            $checksJson: toJson(output.checks),
            $artifactsJson: toJson(output.artifacts),
            $error: task.reason,
          });
          db.query(
            `
            update tasks
            set status = 'blocked', updated_at = current_timestamp
            where id = $taskId and status = 'todo'
            `,
          ).run({ $taskId: task.taskId });
          const lesson = lessonForAttempt(output);
          db.query(
            `
            insert into lessons (
              id, run_id, task_id, attempt_id, kind, summary, evidence_json
            )
            values (
              $id, $runId, $taskId, $attemptId, $kind, $summary, $evidenceJson
            )
            `,
          ).run({
            $id: makeId("lesson"),
            $runId: input.runId,
            $taskId: task.taskId,
            $attemptId: attemptId,
            $kind: lesson.kind,
            $summary: lesson.summary,
            $evidenceJson: toJson(lesson.evidence),
          });
        }
        return blocked;
      })();
    });
  }

  blockTasksWithSharedRootCause(input: BlockTasksWithSharedRootCauseInput): BlockTasksWithSharedRootCauseResult {
    return withDatabase(this.dbPath, (db) => {
      const rows = db
        .query(
          `
          select *
          from tasks
          where run_id = $runId
          order by created_at, id
          `,
        )
        .all({ $runId: input.runId }) as TaskRow[];
      const tasks = rows.map(taskFromRow);
      const tasksById = new Map(tasks.map((task) => [task.id, task]));
      const dependencyIsSatisfied = createDependencyReadiness(tasks);
      const blockedRoots = new Map<string, { task: Task; reason: string; rootCauseAttempt: AttemptRow | null }>();
      const resolvedRoots = new Map<string, string[]>();
      const latestAttemptForTask = (taskId: string) =>
        db
          .query(
            `
            select *
            from attempts
            where task_id = $taskId
            order by finished_at desc, rowid desc
            limit 1
            `,
          )
          .get({ $taskId: taskId }) as AttemptRow | null;
      const resolveBlockedRootIds = (taskId: string, visiting = new Set<string>()): string[] => {
        const cached = resolvedRoots.get(taskId);
        if (cached) {
          return cached;
        }
        const task = tasksById.get(taskId);
        if (!task || visiting.has(taskId)) {
          return [taskId];
        }
        const rootCauseAttempt = latestAttemptForTask(taskId);
        if (rootCauseAttempt) {
          blockedRoots.set(taskId, { task, reason: input.reason, rootCauseAttempt });
          resolvedRoots.set(taskId, [taskId]);
          return [taskId];
        }
        const nextVisiting = new Set(visiting).add(taskId);
        const upstreamBlockedIds = task.dependsOn.filter((dependencyId) => {
          const dependency = tasksById.get(dependencyId);
          return dependency?.status === "blocked" && !dependencyIsSatisfied(dependencyId, task);
        });
        if (upstreamBlockedIds.length === 0) {
          blockedRoots.set(taskId, { task, reason: input.reason, rootCauseAttempt: null });
          resolvedRoots.set(taskId, [taskId]);
          return [taskId];
        }
        const rootIds = [...new Set(upstreamBlockedIds.flatMap((dependencyId) =>
          resolveBlockedRootIds(dependencyId, nextVisiting),
        ))];
        resolvedRoots.set(taskId, rootIds);
        return rootIds;
      };
      const descendants = tasks
        .filter((task) => task.status === "todo")
        .flatMap((task) => {
          const dependencyIds = task.dependsOn.filter((dependencyId) => {
            const dependency = tasksById.get(dependencyId);
            return dependency?.status === "blocked" && !dependencyIsSatisfied(dependencyId, task);
          });
          if (dependencyIds.length === 0) {
            return [];
          }
          const rootTaskIds = [...new Set(dependencyIds.flatMap((dependencyId) =>
            resolveBlockedRootIds(dependencyId),
          ))];
          return [
            {
              taskId: task.id,
              role: task.role,
              previousStatus: task.status as Extract<Status, "todo">,
              dependencyIds,
              rootTaskIds,
              reason: input.reason,
            },
          ];
        });

      if (descendants.length === 0) {
        return { blocked: descendants, sharedRootCauses: [] };
      }

      const sharedRootCauses: SharedRootCauseRecord[] = [];
      const now = new Date().toISOString();
      for (const [rootTaskId, info] of blockedRoots) {
        const descendantTaskIds = descendants
          .filter((descendant) => descendant.rootTaskIds.includes(rootTaskId))
          .map((descendant) => descendant.taskId);
        const rootOutput = info.rootCauseAttempt
          ? (attemptFromRow(info.rootCauseAttempt).output as AttemptOutput | null)
          : null;
        const terminalReason =
          (rootOutput?.artifacts?.find(
            (artifact): artifact is Record<string, unknown> =>
              artifact != null &&
              typeof artifact === "object" &&
              (artifact as Record<string, unknown>).kind === "acpx_terminal_evidence" &&
              typeof (artifact as Record<string, unknown>).terminalReason === "string",
          ))?.terminalReason as string | undefined;
        sharedRootCauses.push({
          rootTaskId,
          rootAttemptId: info.rootCauseAttempt?.id ?? undefined,
          reason: info.reason,
          terminalReason,
          descendantTaskIds,
          recordedAt: now,
        });
      }

      return db.transaction(() => {
        for (const task of descendants) {
          const sharedCauseForTask = sharedRootCauses.filter((cause) =>
            task.rootTaskIds.includes(cause.rootTaskId),
          );
          const causesList = sharedCauseForTask
            .map((cause) => `${cause.rootTaskId}${cause.terminalReason ? `(${cause.terminalReason})` : ""}`)
            .join(",");
          db.query(
            `
            update tasks
            set status = 'blocked', updated_at = current_timestamp
            where id = $taskId and status = 'todo'
            `,
          ).run({ $taskId: task.taskId });
          const evidenceAttemptId = sharedCauseForTask.find((cause) => cause.rootAttemptId)?.rootAttemptId;
          if (evidenceAttemptId) {
            db.query(
              `
              insert into lessons (
                id, run_id, task_id, attempt_id, kind, summary, evidence_json
              )
              values (
                $id, $runId, $taskId, $attemptId, $kind, $summary, $evidenceJson
              )
              `,
            ).run({
              $id: makeId("lesson"),
              $runId: input.runId,
              $taskId: task.taskId,
              $attemptId: evidenceAttemptId,
              $kind: "lesson",
              $summary: `Task blocked by shared root cause: ${causesList}`,
              $evidenceJson: toJson({
                sharedRootCauses: sharedCauseForTask.map((cause) => ({
                  rootTaskId: cause.rootTaskId,
                  rootAttemptId: cause.rootAttemptId,
                  terminalReason: cause.terminalReason,
                  reason: cause.reason,
                })),
                dependencyIds: task.dependencyIds,
                reason: task.reason,
                syntheticAttempt: false,
              }),
            });
          }
        }
        return {
          blocked: descendants.map(({ rootTaskIds: _rootTaskIds, ...task }) => task),
          sharedRootCauses,
        };
      })();
    });
  }


  leaseReadyTasks(input: LeaseReadyTasksInput) {
    return withDatabase(this.dbPath, (db) =>
      db.transaction(() => {
        const runState = db
          .query(
            `
            select json_extract(context_json, '$.retired') as retired
            from runs
            where id = $runId
            `,
          )
          .get({ $runId: input.runId }) as { retired: number | null } | null;
        if (runState?.retired === 1) {
          return [];
        }
        const taskRows = db
          .query(
            `
            select *
            from tasks
            where run_id = $runId and status = 'todo'
            order by created_at, id
            `,
          )
          .all({ $runId: input.runId }) as TaskRow[];
        const allTasks = (db
          .query("select * from tasks where run_id = $runId")
          .all({ $runId: input.runId }) as TaskRow[]).map(taskFromRow);
        const dependencyIsSatisfied = createDependencyReadiness(allTasks);
        const selected: Task[] = [];
        for (const task of taskRows.map(taskFromRow)) {
          if (selected.length >= input.limit) break;
          if (!task.dependsOn.every((dependencyId) => dependencyIsSatisfied(dependencyId, task))) continue;
          if (!verifierLeaseIsAvailable(task, allTasks, selected)) continue;
          selected.push(task);
        }

        const leased: Task[] = [];
        for (const task of selected) {
          const sessionRef = input.sessionForTask(task);
          const worktreePath = input.worktreeForTask?.(task) ?? task.worktreePath;
          const update = db.query(
            `
            update tasks
            set status = 'running',
                session_ref = $sessionRef,
                worktree_path = $worktreePath,
                updated_at = current_timestamp
            where id = $taskId and status = 'todo'
            `,
          ).run({
            $sessionRef: sessionRef,
            $worktreePath: worktreePath,
            $taskId: task.id,
          });
          if (update.changes !== 1) continue;
          task.status = "running";
          task.sessionRef = sessionRef;
          task.worktreePath = worktreePath;
          leased.push(task);
        }
        return leased;
      }).immediate(),
    );
  }

  recordAttempt(input: RecordAttemptInput) {
    return withDatabase(this.dbPath, (db) =>
      db.transaction(() => this.recordAttemptWithDb(db, input))(),
    );
  }

  recordAttemptWithDb(db: HarnessDatabase, input: RecordAttemptInput) {
    const output = normalizeAttemptOutput(input.output);
    if (output.status !== "done" && output.status !== "blocked") {
      throw new Error("attempt output status must be 'done' or 'blocked'");
    }

    const id = input.id ?? makeId("attempt");
    const problems = output.problems ?? [];
    db.query(
      `
      insert into attempts (
        id, task_id, status, input_json, output_json,
        checks_json, artifacts_json, error, finished_at
      )
      values (
        $id, $taskId, $status, $inputJson, $outputJson,
        $checksJson, $artifactsJson, $error, current_timestamp
      )
      `,
    ).run({
      $id: id,
      $taskId: input.taskId,
      $status: output.status,
      $inputJson: toJson(input.input),
      $outputJson: toJson(output),
      $checksJson: toJson(output.checks ?? []),
      $artifactsJson: toJson(output.artifacts ?? []),
      $error: problems.length > 0 ? problems.join("\n") : null,
    });
    db.query(
      `
      update tasks
      set status = $status, updated_at = current_timestamp
      where id = $taskId
      `,
    ).run({
      $status: output.status,
      $taskId: input.taskId,
    });
    const taskRow = db.query("select * from tasks where id = $taskId").get({ $taskId: input.taskId }) as
      | TaskRow
      | null;
    if (taskRow) {
      const lesson = lessonForAttempt(output);
      db.query(
        `
        insert into lessons (
          id, run_id, task_id, attempt_id, kind, summary, evidence_json
        )
        values (
          $id, $runId, $taskId, $attemptId, $kind, $summary, $evidenceJson
        )
        `,
      ).run({
        $id: makeId("lesson"),
        $runId: taskRow.run_id,
        $taskId: input.taskId,
        $attemptId: id,
        $kind: lesson.kind,
        $summary: lesson.summary,
        $evidenceJson: toJson(lesson.evidence),
      });
      this.reconcileDrainedResearchRecoveryRunWithDb(db, taskRow.run_id);
    }
    return id;
  }

  startAttempt(input: StartAttemptInput) {
    const id = input.id ?? makeId("attempt");
    return withDatabase(this.dbPath, (db) => {
      db.transaction(() => {
        this.assertTaskExecutionAllowedWithDb(db, input.taskId);
        const runState = db
          .query(
            `
            select runs.id as runId,
                   json_extract(runs.context_json, '$.retired') as retired
            from tasks
            join runs on runs.id = tasks.run_id
            where tasks.id = $taskId
            `,
          )
          .get({ $taskId: input.taskId }) as { runId: string; retired: number | null } | null;
        if (runState?.retired === 1) {
          throw new Error(`run ${runState.runId} is retired and cannot start attempts`);
        }
        db.query(
          `
          insert into attempts (
            id, task_id, status, input_json, output_json,
            checks_json, artifacts_json, error, finished_at
          )
          values (
            $id, $taskId, 'running', $inputJson, '{}',
            '[]', '[]', null, null
          )
          `,
        ).run({
          $id: id,
          $taskId: input.taskId,
          $inputJson: toJson(input.input),
        });
        db.query(
          `
          update tasks
          set status = 'running', updated_at = current_timestamp
          where id = $taskId
          `,
        ).run({ $taskId: input.taskId });
      })();
      return id;
    });
  }

  finishAttempt(input: FinishAttemptInput) {
    return withDatabase(this.dbPath, (db) =>
      db.transaction(() => this.finishAttemptWithDb(db, input))(),
    );
  }

  finishAttemptWithDb(db: HarnessDatabase, input: FinishAttemptInput) {
    const output = normalizeAttemptOutput(input.output);
    if (output.status !== "done" && output.status !== "blocked") {
      throw new Error("attempt output status must be 'done' or 'blocked'");
    }

    const problems = output.problems ?? [];
    db.query(
      `
      update attempts
      set status = $status,
          output_json = $outputJson,
          checks_json = $checksJson,
          artifacts_json = $artifactsJson,
          error = $error,
          finished_at = current_timestamp
      where id = $attemptId and status = 'running'
      `,
    ).run({
      $status: output.status,
      $outputJson: toJson(output),
      $checksJson: toJson(output.checks ?? []),
      $artifactsJson: toJson(output.artifacts ?? []),
      $error: problems.length > 0 ? problems.join("\n") : null,
      $attemptId: input.attemptId,
    });
    const attemptRow = db.query("select * from attempts where id = $attemptId").get({
      $attemptId: input.attemptId,
    }) as AttemptRow | null;
    if (!attemptRow) {
      throw new Error(`attempt not found: ${input.attemptId}`);
    }
    db.query(
      `
      update tasks
      set status = $status, updated_at = current_timestamp
      where id = $taskId
      `,
    ).run({
      $status: output.status,
      $taskId: attemptRow.task_id,
    });
    const taskRow = db.query("select * from tasks where id = $taskId").get({ $taskId: attemptRow.task_id }) as
      | TaskRow
      | null;
    if (taskRow) {
      const lesson = lessonForAttempt(output);
      db.query(
        `
        insert into lessons (
          id, run_id, task_id, attempt_id, kind, summary, evidence_json
        )
        values (
          $id, $runId, $taskId, $attemptId, $kind, $summary, $evidenceJson
        )
        `,
      ).run({
        $id: makeId("lesson"),
        $runId: taskRow.run_id,
        $taskId: attemptRow.task_id,
        $attemptId: input.attemptId,
        $kind: lesson.kind,
        $summary: lesson.summary,
        $evidenceJson: toJson(lesson.evidence),
      });
      this.reconcileDrainedResearchRecoveryRunWithDb(db, taskRow.run_id);
    }
  }

  updateAttemptInput(input: UpdateAttemptInputInput) {
    return withDatabase(this.dbPath, (db) => {
      db.query(
        `
        update attempts
        set input_json = $inputJson
        where id = $attemptId
        `,
      ).run({
        $inputJson: toJson(input.input),
        $attemptId: input.attemptId,
      });
    });
  }

  recordAttemptEvent(input: RecordAttemptEventInput) {
    const id = input.id ?? makeId("event");
    for (let retry = 0; retry <= ATTEMPT_EVENT_BUSY_RETRIES; retry += 1) {
      try {
        return withDatabase(this.dbPath, (db) => {
          db.query(
            `
            insert into attempt_events (
              id, attempt_id, sequence, stream, text, payload_json
            )
            values (
              $id, $attemptId, $sequence, $stream, $text, $payloadJson
            )
            on conflict(attempt_id, sequence) do update set
              stream = excluded.stream,
              text = excluded.text,
              payload_json = excluded.payload_json
            `,
          ).run({
            $id: id,
            $attemptId: input.attemptId,
            $sequence: input.sequence,
            $stream: input.stream,
            $text: input.text ?? null,
            $payloadJson: toJson(input.payload ?? {}),
          });
          return id;
        });
      } catch (error) {
        if (!isSqliteBusyError(error) || retry === ATTEMPT_EVENT_BUSY_RETRIES) {
          throw error;
        }
        sleepSync(25 * (retry + 1));
      }
    }
    return id;
  }

  listAttemptEvents(attemptId: string): AttemptEvent[] {
    return withDatabase(this.dbPath, (db) => {
      const rows = db
        .query(
          `
          select *
          from attempt_events
          where attempt_id = $attemptId
          order by sequence asc
          `,
        )
        .all({ $attemptId: attemptId }) as AttemptEventRow[];
      return rows.map(attemptEventFromRow);
    });
  }

  listRuns(input: ListRunsInput = {}) {
    return withDatabase(this.dbPath, (db) => this.listRunsWithDb(db, input));
  }

  listRunsWithDb(db: HarnessDatabase, input: ListRunsInput = {}) {
    const limit = input.limit && input.limit > 0 ? Math.floor(input.limit) : 100;
    const statuses = input.statuses?.filter((status) =>
      status === "todo" || status === "running" || status === "done" || status === "blocked"
    ) ?? [];
    const rows = statuses.length > 0
      ? db
        .query(
          `
          select runs.*, projects.root_path as project_root
          from runs
          left join projects on projects.id = runs.project_id
          where runs.status in (${statuses.map((_, index) => `$status${index}`).join(", ")})
          order by runs.created_at, runs.id
          limit $limit
          `,
        )
        .all(Object.fromEntries([
          ...statuses.map((status, index) => [`$status${index}`, status]),
          ["$limit", limit],
        ])) as RunRow[]
      : db
        .query(
          `
          select runs.*, projects.root_path as project_root
          from runs
          left join projects on projects.id = runs.project_id
          order by runs.created_at, runs.id
          limit $limit
          `,
        )
        .all({ $limit: limit }) as RunRow[];
    return rows.map(runFromRow);
  }

  countRunsByStatus() {
    return withDatabase(this.dbPath, (db) => {
      const counts = { todo: 0, running: 0, done: 0, blocked: 0 };
      const rows = db
        .query(
          `
          select status, count(*) as count
          from runs
          where json_extract(context_json, '$.retired') is not 1
          group by status
          `,
        )
        .all() as { status: Status; count: number }[];
      for (const row of rows) {
        counts[row.status] = Number(row.count);
      }
      return counts;
    });
  }

  recordHarnessActionEvent(input: RecordHarnessActionEventInput) {
    const id = input.id ?? makeId("action");
    return withDatabase(this.dbPath, (db) =>
      db.transaction(() => this.recordHarnessActionEventWithDb(db, { ...input, id })).immediate(),
    );
  }

  recordHarnessActionEventWithDb(db: HarnessDatabase, input: RecordHarnessActionEventInput) {
    const id = input.id ?? makeId("action");
    ensureHarnessActionEvents(db);
    db.query(
      `
      insert into harness_action_events (
        id, action_type, status, request_json, result_json
      )
      values (
        $id, $actionType, $status, $requestJson, $resultJson
      )
      `,
    ).run({
      $id: id,
      $actionType: input.actionType,
      $status: input.status,
      $requestJson: toJson(input.request),
      $resultJson: toJson(input.result),
    });
    return id;
  }

  listHarnessActionEvents(input: ListHarnessActionEventsInput = {}) {
    return withDatabase(this.dbPath, (db) => this.listHarnessActionEventsWithDb(db, input));
  }

  listHarnessActionEventsForRunIds(runIds: string[]) {
    const uniqueRunIds = [...new Set(runIds)].sort();
    if (uniqueRunIds.length === 0) {
      return [];
    }
    return withDatabase(this.dbPath, (db) => {
      ensureHarnessActionEvents(db);
      const events = new Map<string, ReturnType<typeof harnessActionEventFromRow>>();
      for (let offset = 0; offset < uniqueRunIds.length; offset += 100) {
        const chunk = uniqueRunIds.slice(offset, offset + 100);
        const placeholders = chunk.map((_, index) => `$runId${index}`);
        const bindings = Object.fromEntries(chunk.map((runId, index) => [`$runId${index}`, runId]));
        const rows = db.query(
          `
          select distinct event.*
          from harness_action_events event
          where json_extract(event.request_json, '$.runId') in (${placeholders.join(", ")})
             or json_extract(event.request_json, '$.rootRunId') in (${placeholders.join(", ")})
             or exists (
               select 1
               from json_each(event.result_json, '$.artifacts') artifact
               where json_extract(artifact.value, '$.runId') in (${placeholders.join(", ")})
             )
          order by event.rowid desc
          `,
        ).all(bindings) as HarnessActionEventRow[];
        for (const row of rows) {
          const event = harnessActionEventFromRow(row);
          events.set(event.id, event);
        }
      }
      return [...events.values()];
    });
  }

  listHarnessActionEventsWithDb(db: HarnessDatabase, input: ListHarnessActionEventsWithDbInput = {}) {
    ensureHarnessActionEvents(db);
    // Preserve the original public semantics: `input.limit ?? 50`. Callers that
    // explicitly pass `0` receive an empty list (SQLite `LIMIT 0`), matching the
    // behavior the public method exposed before the WithDb split. Other list
    // helpers (`listStrategySignals`, `listDesignProposals`) keep their own
    // positive-integer normalization unchanged.
    const limit = input.limit ?? 50;
    const where: string[] = [];
    const bindings: Record<string, string | number> = { $limit: limit };
    if (input.actionType) {
      where.push("action_type = $actionType");
      bindings.$actionType = input.actionType;
    }
    if (input.statuses && input.statuses.length > 0) {
      where.push(`status in (${input.statuses.map((_, index) => `$status${index}`).join(", ")})`);
      for (const [index, status] of input.statuses.entries()) {
        bindings[`$status${index}`] = status;
      }
    }
    if (input.requestType) {
      where.push("json_extract(request_json, '$.type') = $requestType");
      bindings.$requestType = input.requestType;
    }
    if (input.requestRunId) {
      where.push("json_extract(request_json, '$.runId') = $requestRunId");
      bindings.$requestRunId = input.requestRunId;
    }
    if (input.requestTaskId) {
      where.push("json_extract(request_json, '$.taskId') = $requestTaskId");
      bindings.$requestTaskId = input.requestTaskId;
    }
    const whereClause = where.length > 0 ? `where ${where.join(" and ")}` : "";
    const rows = db
      .query(
        `
        select *
        from harness_action_events
        ${whereClause}
        order by rowid desc
        limit $limit
        `,
      )
      .all(bindings) as HarnessActionEventRow[];
    return rows.map(harnessActionEventFromRow);
  }

  getHarnessActionEvent(input: GetHarnessActionEventInput) {
    return withDatabase(this.dbPath, (db) => this.getHarnessActionEventWithDb(db, input));
  }

  getHarnessActionEventWithDb(db: HarnessDatabase, input: GetHarnessActionEventInput) {
    ensureHarnessActionEvents(db);
    const row = db.query("select * from harness_action_events where id = $id").get({ $id: input.id }) as
      | HarnessActionEventRow
      | null;
    return row ? harnessActionEventFromRow(row) : null;
  }

  upsertExecutionThread(input: UpsertExecutionThreadInput) {
    const id = input.id ?? makeId("thread");
    return withDatabase(this.dbPath, (db) => {
      ensureExecutionThreads(db);
      db.query(
        `
        insert into execution_threads (
          id, run_id, task_id, attempt_id, parent_thread_id,
          owner_type, owner_id, role, status, pid,
          session_name, agent_session_id, worktree_path, heartbeat_at, interrupt_reason
        )
        values (
          $id, $runId, $taskId, $attemptId, $parentThreadId,
          $ownerType, $ownerId, $role, $status, $pid,
          $sessionName, $agentSessionId, $worktreePath, coalesce($heartbeatAt, current_timestamp), $interruptReason
        )
        on conflict(id) do update set
          run_id = excluded.run_id,
          task_id = excluded.task_id,
          attempt_id = excluded.attempt_id,
          parent_thread_id = excluded.parent_thread_id,
          owner_type = excluded.owner_type,
          owner_id = excluded.owner_id,
          role = excluded.role,
          status = excluded.status,
          pid = excluded.pid,
          session_name = excluded.session_name,
          agent_session_id = excluded.agent_session_id,
          worktree_path = excluded.worktree_path,
          heartbeat_at = coalesce(excluded.heartbeat_at, execution_threads.heartbeat_at, current_timestamp),
          interrupt_reason = excluded.interrupt_reason,
          updated_at = current_timestamp
        `,
      ).run({
        $id: id,
        $runId: input.runId,
        $taskId: input.taskId ?? null,
        $attemptId: input.attemptId ?? null,
        $parentThreadId: input.parentThreadId ?? null,
        $ownerType: input.ownerType,
        $ownerId: input.ownerId ?? null,
        $role: input.role,
        $status: input.status ?? "running",
        $pid: input.pid ?? null,
        $sessionName: input.sessionName ?? null,
        $agentSessionId: input.agentSessionId ?? null,
        $worktreePath: input.worktreePath ?? null,
        $heartbeatAt: input.heartbeatAt ?? null,
        $interruptReason: input.interruptReason ?? null,
      });
      return id;
    });
  }

  updateExecutionThread(input: UpdateExecutionThreadInput) {
    return withDatabase(this.dbPath, (db) => {
      ensureExecutionThreads(db);
      const existing = db.query("select * from execution_threads where id = $id").get({ $id: input.id }) as
        | ExecutionThreadRow
        | null;
      if (!existing) {
        return;
      }
      const status = input.status ?? existing.status;
      db.query(
        `
        update execution_threads
        set status = $status,
            owner_id = $ownerId,
            pid = $pid,
            session_name = $sessionName,
            agent_session_id = $agentSessionId,
            worktree_path = $worktreePath,
            heartbeat_at = case when $heartbeat then current_timestamp else heartbeat_at end,
            interrupted_at = case when $interrupted then current_timestamp else interrupted_at end,
            interrupt_reason = $interruptReason,
            updated_at = current_timestamp
        where id = $id
        `,
      ).run({
        $id: input.id,
        $status: status,
        $ownerId: input.ownerId ?? existing.owner_id,
        $pid: input.pid ?? existing.pid,
        $sessionName: input.sessionName ?? existing.session_name,
        $agentSessionId: input.agentSessionId ?? existing.agent_session_id,
        $worktreePath: input.worktreePath ?? existing.worktree_path,
        $heartbeat: input.heartbeat === true ? 1 : 0,
        $interrupted: status === "interrupted" ? 1 : 0,
        $interruptReason: input.interruptReason ?? existing.interrupt_reason,
      });
    });
  }

  listExecutionThreads(input: ListExecutionThreadsInput) {
    return withDatabase(this.dbPath, (db) => {
      ensureExecutionThreads(db);
      const rows = db
        .query(
          `
          select *
          from execution_threads
          where run_id = $runId
          order by created_at, id
          `,
        )
        .all({ $runId: input.runId }) as ExecutionThreadRow[];
      return rows.map(executionThreadFromRow);
    });
  }

  getRunOverview(input: GetRunOverviewInput) {
    return withDatabase(this.dbPath, (db) => this.getRunOverviewWithDb(db, input));
  }

  getRunOverviewWithDb(db: HarnessDatabase, input: GetRunOverviewInput) {
      const runRow = db
        .query(
          `
          select runs.*, projects.root_path as project_root
          from runs
          left join projects on projects.id = runs.project_id
          where runs.id = $runId
          `,
        )
        .get({ $runId: input.runId }) as RunRow | null;
      const projectRow = runRow?.project_id
        ? (db.query("select * from projects where id = $projectId").get({ $projectId: runRow.project_id }) as
            | ProjectRow
            | null)
        : null;
      const taskRows = db
        .query(
          `
          select *
          from tasks
          where run_id = $runId
          order by rowid
          `,
        )
        .all({ $runId: input.runId }) as TaskRow[];
      const tasks = taskRows.map(taskFromRow);
      const taskById = new Map(tasks.map((task) => [task.id, task]));
      const attemptRows = db
        .query(
          `
          select attempts.*, attempts.started_at as started_at, attempts.finished_at as finished_at
          from attempts
          join tasks on tasks.id = attempts.task_id
          where tasks.run_id = $runId
          order by attempts.rowid
          `,
        )
        .all({ $runId: input.runId }) as Array<AttemptRow & { started_at: string | null; finished_at: string | null }>;
      const eventQuery = db.query(
        `
        select *
        from attempt_events
        where attempt_id = $attemptId
        order by sequence desc
        limit $limit
        `,
      );
      const eventLimit = input.eventLimit ?? 25;
      const sessions = attemptRows.flatMap((row) => {
        const attempt = attemptFromRow(row);
        const task = taskById.get(attempt.taskId);
        if (!task) {
          return [];
        }
        const events = (eventQuery.all({ $attemptId: attempt.id, $limit: eventLimit }) as AttemptEventRow[])
          .map(attemptEventFromRow)
          .reverse();
        return [
          {
            role: task.role,
            taskId: task.id,
            taskGoal: task.goal,
            attemptId: attempt.id,
            status: attempt.status,
            output: attempt.output,
            verifierExecutionEnvironmentReceipt: objectOrNull(
              attempt.input.verifierExecutionEnvironmentReceipt,
            ),
            model: objectOrNull(attempt.input.model),
            backend: objectOrNull(attempt.input.backend),
            sessionName: stringOrNull(attempt.input.sessionName),
            codexSessionId: stringOrNull(attempt.input.codexSessionId),
            cwd: stringOrNull(attempt.input.cwd),
            worktreePath: task.worktreePath,
            startedAt: row.started_at,
            finishedAt: row.finished_at,
            latestText: latestEventText(events),
            events,
          },
        ];
      });
      const lessonRows = db
        .query(
          `
          select *
          from lessons
          where run_id = $runId
          order by created_at, rowid
          `,
        )
        .all({ $runId: input.runId }) as LessonRow[];
      ensureExecutionThreads(db);
      const threadRows = db
        .query(
          `
          select *
          from execution_threads
          where run_id = $runId
          order by created_at, id
          `,
        )
        .all({ $runId: input.runId }) as ExecutionThreadRow[];
      return {
        run: runRow ? runFromRow(runRow) : null,
        project: projectRow ? projectFromRow(projectRow) : null,
        tasks,
        sessions,
        threads: threadRows.map(executionThreadFromRow),
        lessons: lessonRows.map(lessonFromRow),
        controlPlaneWatchdog: runRow ? readWatchdogState(runFromRow(runRow).context) ?? undefined : undefined,
      };
  }

  retryTask(input: RetryTaskInput) {
    return withDatabase(this.dbPath, (db) => {
      const task = db.query("select * from tasks where id = $taskId").get({ $taskId: input.taskId }) as TaskRow | null;
      db.query(
        `
        update tasks
        set status = 'todo', updated_at = current_timestamp
        where id = $taskId
        `,
      ).run({ $taskId: input.taskId });
      if (task) {
        const runRow = db.query("select * from runs where id = $runId").get({ $runId: task.run_id }) as RunRow | null;
        if (runRow) {
          const run = runFromRow(runRow);
          db.query(
            `
            update runs
            set context_json = $contextJson,
                updated_at = current_timestamp
            where id = $runId
            `,
          ).run({
            $runId: task.run_id,
            $contextJson: toJson({
              ...run.context,
              runPause: null,
              runPauseClearedAt: new Date().toISOString(),
            }),
          });
        }
      }
    });
  }

  retireTask(input: RetireTaskInput) {
    return withDatabase(this.dbPath, (db) => {
      const row = db.query("select * from tasks where id = $taskId").get({ $taskId: input.taskId }) as TaskRow | null;
      if (!row) {
        return null;
      }
      const task = taskFromRow(row);
      if (task.status !== "todo") {
        return { task, retired: false };
      }
      const result = db.query(
        `
        update tasks
        set status = 'blocked', updated_at = current_timestamp
        where id = $taskId and status = 'todo'
        `,
      ).run({ $taskId: input.taskId });
      if (result.changes !== 1) {
        const current = db.query("select * from tasks where id = $taskId").get({ $taskId: input.taskId }) as TaskRow;
        return { task: taskFromRow(current), retired: false };
      }
      return { task: { ...task, status: "blocked" as const }, retired: true };
    });
  }

  createExternalRef(input: CreateExternalRefInput) {
    const id = input.id ?? makeId("ref");
    return withDatabase(this.dbPath, (db) => {
      db.query(
        `
        insert into external_refs (
          id, local_type, local_id, provider, external_type, external_id, external_url
        )
        values (
          $id, $localType, $localId, $provider, $externalType, $externalId, $externalUrl
        )
        `,
      ).run({
        $id: id,
        $localType: input.localType,
        $localId: input.localId,
        $provider: input.provider,
        $externalType: input.externalType,
        $externalId: input.externalId,
        $externalUrl: input.externalUrl ?? null,
      });
      return id;
    });
  }

  ensureExternalRef(input: EnsureExternalRefInput): EnsureExternalRefResult {
    if (!input.id) {
      throw new Error("ensureExternalRef requires a deterministic id");
    }
    return withDatabase(this.dbPath, (db) => {
      return this.ensureExternalRefWithDb(db, input);
    });
  }

  // Idempotent create-or-reuse keyed on the unique constraint
  // (local_type, local_id, provider, external_type, external_id). A prior row
  // with the same target identity is reused without mutating its id, url, or
  // created_at; the deterministic id supplied by the caller is used only when a
  // new row is inserted. Used by the design-action path to link one Linear
  // issue to one planning run inside the createRunsFromDesign transaction.
  ensureExternalRefWithDb(db: HarnessDatabase, input: EnsureExternalRefInput): EnsureExternalRefResult {
    if (!input.id) {
      throw new Error("ensureExternalRef requires a deterministic id");
    }
    const existing = db
      .query(
        `
        select *
        from external_refs
        where local_type = $localType
          and local_id = $localId
          and provider = $provider
          and external_type = $externalType
          and external_id = $externalId
        `,
      )
      .get({
        $localType: input.localType,
        $localId: input.localId,
        $provider: input.provider,
        $externalType: input.externalType,
        $externalId: input.externalId,
      }) as ExternalRefRow | null;

    if (existing) {
      return { ref: externalRefFromRow(existing), created: false };
    }

    db.query(
      `
      insert into external_refs (
        id, local_type, local_id, provider, external_type, external_id, external_url
      )
      values (
        $id, $localType, $localId, $provider, $externalType, $externalId, $externalUrl
      )
      `,
    ).run({
      $id: input.id,
      $localType: input.localType,
      $localId: input.localId,
      $provider: input.provider,
      $externalType: input.externalType,
      $externalId: input.externalId,
      $externalUrl: input.externalUrl ?? null,
    });
    const row = db
      .query("select * from external_refs where id = $id")
      .get({ $id: input.id }) as ExternalRefRow;
    return { ref: externalRefFromRow(row), created: true };
  }

  listExternalRefs(input: ListExternalRefsInput) {
    return withDatabase(this.dbPath, (db) => {
      const rows = db
        .query(
          `
          select *
          from external_refs
          where local_type = $localType and local_id = $localId
          order by created_at, id
          `,
        )
        .all({
          $localType: input.localType,
          $localId: input.localId,
        }) as ExternalRefRow[];
      return rows.map(externalRefFromRow);
    });
  }

  // Look up external_refs by their external identity (provider, external_type,
  // external_id), optionally restricted to a local_type (e.g. "run"). Used by
  // the design-action path to enforce one canonical run-to-issue reference per
  // immutable Linear issue: any prior reference for the same issue must point
  // at the same canonical planning run, regardless of which proposal or action
  // replay produced it. The lookup is read-only and safe to call inside a
  // caller's transaction. A copy of this helper accepts a caller-supplied
  // database handle for use inside createRunsFromDesign's atomic step.
  findExternalRefs(input: FindExternalRefsInput) {
    return withDatabase(this.dbPath, (db) => {
      return this.findExternalRefsWithDb(db, input);
    });
  }

  findExternalRefsWithDb(db: HarnessDatabase, input: FindExternalRefsInput) {
    const rows = db
      .query(
        `
        select *
        from external_refs
        where provider = $provider
          and external_type = $externalType
          and external_id = $externalId
          ${input.localType ? "and local_type = $localType" : ""}
        order by created_at, id
        `,
      )
      .all({
        $provider: input.provider,
        $externalType: input.externalType,
        $externalId: input.externalId,
        $localType: input.localType ?? null,
      }) as ExternalRefRow[];
    return rows.map(externalRefFromRow);
  }

  createInboxEvent(input: CreateInboxEventInput) {
    const id = input.id ?? makeId("inbox");
    const status = input.status ?? "todo";
    return withDatabase(this.dbPath, (db) => {
      db.query(
        `
        insert into inbox_events (
          id, provider, event_type, external_id, payload_json, status
        )
        values (
          $id, $provider, $eventType, $externalId, $payloadJson, $status
        )
        `,
      ).run({
        $id: id,
        $provider: input.provider,
        $eventType: input.eventType,
        $externalId: input.externalId,
        $payloadJson: toJson(input.payload),
        $status: status,
      });
      const row = db.query("select * from inbox_events where id = $id").get({ $id: id }) as InboxEventRow;
      return inboxEventFromRow(row);
    });
  }

  ensureInboxEvent(input: EnsureInboxEventInput): EnsureInboxEventResult {
    if (!input.id) {
      throw new Error("ensureInboxEvent requires a deterministic id");
    }
    return withDatabase(this.dbPath, (db) => {
      return db.transaction(() => {
        const existing = db
          .query(
            `
            select *
            from inbox_events
            where id = $id
            `,
          )
          .get({ $id: input.id }) as InboxEventRow | null;

        if (existing) {
          if (
            existing.provider !== input.provider ||
            existing.event_type !== input.eventType ||
            existing.external_id !== input.externalId
          ) {
            throw new Error(
              `deterministic id collision: inbox event ${input.id} already exists with different provider, event type, or external id`,
            );
          }
          return { event: inboxEventFromRow(existing), created: false };
        }

        db.query(
          `
          insert into inbox_events (
            id, provider, event_type, external_id, payload_json, status
          )
          values (
            $id, $provider, $eventType, $externalId, $payloadJson, $status
          )
          `,
        ).run({
          $id: input.id,
          $provider: input.provider,
          $eventType: input.eventType,
          $externalId: input.externalId,
          $payloadJson: toJson(input.payload),
          $status: "todo",
        });
        const row = db
          .query("select * from inbox_events where id = $id")
          .get({ $id: input.id }) as InboxEventRow;
        return { event: inboxEventFromRow(row), created: true };
      })();
    });
  }

  transitionInboxEvent(input: TransitionInboxEventInput): TransitionInboxEventResult {
    if (!isValidInboxTransition(input.from, input.to)) {
      throw new Error(
        `invalid inbox transition: ${input.from} -> ${input.to}`,
      );
    }
    return withDatabase(this.dbPath, (db) => {
      return db.transaction(() => {
        const row = db
          .query("select * from inbox_events where id = $id")
          .get({ $id: input.id }) as InboxEventRow | null;
        if (!row) {
          throw new Error(`inbox event not found: ${input.id}`);
        }
        if (row.status !== input.from) {
          throw new Error(
            `expected inbox event ${input.id} to be ${input.from}, found ${row.status}`,
          );
        }
        const stampProcessedAt = input.to === "done" || input.to === "blocked";
        const result = db
          .query(
            `
            update inbox_events
            set status = $to,
                processed_at = case when $stamp = 1 then current_timestamp else null end
            where id = $id and status = $from
            `,
          )
          .run({
            $to: input.to,
            $stamp: stampProcessedAt ? 1 : 0,
            $id: input.id,
            $from: input.from,
          });
        const updated = result.changes > 0;
        const refreshed = db
          .query("select * from inbox_events where id = $id")
          .get({ $id: input.id }) as InboxEventRow;
        return { event: inboxEventFromRow(refreshed), updated };
      })();
    });
  }

  // Transaction-aware variant for callers that already hold a database
  // transaction (e.g. createRunsFromDesign finalizing an intake inbox event in
  // the same atomic step that creates the run, task, and external reference).
  // Performs the same compare-and-set transition as transitionInboxEvent but
  // does not open its own transaction — the caller's commit/rollback governs
  // the result. Returns updated:false when the row's current status does not
  // match `from` (so the caller can treat replay-safe completion as success).
  transitionInboxEventWithDb(
    db: HarnessDatabase,
    input: TransitionInboxEventInput,
  ): TransitionInboxEventResult {
    if (!isValidInboxTransition(input.from, input.to)) {
      throw new Error(
        `invalid inbox transition: ${input.from} -> ${input.to}`,
      );
    }
    const row = db
      .query("select * from inbox_events where id = $id")
      .get({ $id: input.id }) as InboxEventRow | null;
    if (!row) {
      throw new Error(`inbox event not found: ${input.id}`);
    }
    if (row.status !== input.from) {
      throw new Error(
        `expected inbox event ${input.id} to be ${input.from}, found ${row.status}`,
      );
    }
    const stampProcessedAt = input.to === "done" || input.to === "blocked";
    const result = db
      .query(
        `
        update inbox_events
        set status = $to,
            processed_at = case when $stamp = 1 then current_timestamp else null end
        where id = $id and status = $from
        `,
      )
      .run({
        $to: input.to,
        $stamp: stampProcessedAt ? 1 : 0,
        $id: input.id,
        $from: input.from,
      });
    const updated = result.changes > 0;
    const refreshed = db
      .query("select * from inbox_events where id = $id")
      .get({ $id: input.id }) as InboxEventRow;
    return { event: inboxEventFromRow(refreshed), updated };
  }

  getInboxEvent(input: GetInboxEventInput) {
    return withDatabase(this.dbPath, (db) => {
      const row = db.query("select * from inbox_events where id = $id").get({ $id: input.id }) as
        | InboxEventRow
        | null;
      return row ? inboxEventFromRow(row) : null;
    });
  }

  listInboxEvents(input: ListInboxEventsInput = {}) {
    return withDatabase(this.dbPath, (db) => {
      const where: string[] = [];
      const bindings: Record<string, string | number> = { $limit: input.limit ?? 100 };
      if (input.provider) {
        where.push("provider = $provider");
        bindings.$provider = input.provider;
      }
      if (input.status) {
        where.push("status = $status");
        bindings.$status = input.status;
      }
      const whereClause = where.length ? `where ${where.join(" and ")}` : "";
      const rows = db
        .query(
          `
          select *
          from inbox_events
          ${whereClause}
          order by created_at, id
          limit $limit
          `,
        )
        .all(bindings) as InboxEventRow[];
      return rows.map(inboxEventFromRow);
    });
  }

  listLessons(input: ListLessonsInput) {
    return withDatabase(this.dbPath, (db) => {
      const rows = db
        .query(
          `
          select *
          from lessons
          where run_id = $runId
          order by created_at, rowid
          limit $limit
          `,
        )
        .all({ $runId: input.runId, $limit: input.limit ?? 50 }) as LessonRow[];
      return rows.map(lessonFromRow);
    });
  }

  getPromptTemplate(key: string) {
    return withDatabase(this.dbPath, (db) => {
      const row = db.query("select * from prompt_templates where key = $key").get({ $key: key }) as
        | PromptTemplateRow
        | null;
      return row ? promptTemplateFromRow(row) : null;
    });
  }

  setPromptTemplate(input: SetPromptTemplateInput) {
    return withDatabase(this.dbPath, (db) => {
      db.query(
        `
        insert into prompt_templates (key, content_md)
        values ($key, $contentMd)
        on conflict(key) do update set
          content_md = excluded.content_md,
          updated_at = current_timestamp
        `,
      ).run({ $key: input.key, $contentMd: input.contentMd });
      const row = db.query("select * from prompt_templates where key = $key").get({ $key: input.key }) as
        | PromptTemplateRow
        | null;
      return promptTemplateFromRow(row!);
    });
  }

  createFounderCharter(input: CreateFounderCharterInput) {
    const id = input.id ?? makeId("charter");
    const charter: FounderCharterData = {
      mission: input.mission,
      ...(input.charter ?? {}),
    };
    const mission = input.mission;
    return withDatabase(this.dbPath, (db) => {
      ensureStrategyTables(db);
      return db.transaction(() => {
        const versionRow = db
          .query(
            `
            select coalesce(max(version), 0) + 1 as next_version
            from founder_charters
            where project_id is $projectId
            `,
          )
          .get({ $projectId: input.projectId }) as { next_version: number };
        const version = versionRow.next_version;
        db.query(
          `
          insert into founder_charters (
            id, project_id, version, is_active, mission, charter_json, activated_at
          )
          values (
            $id, $projectId, $version, 0, $mission, $charterJson, null
          )
          `,
        ).run({
          $id: id,
          $projectId: input.projectId,
          $version: version,
          $mission: mission,
          $charterJson: toJson(charter),
        });
        if (input.activate) {
          activateCharterInternal(db, id);
        }
        const row = db.query("select * from founder_charters where id = $id").get({ $id: id }) as FounderCharterRow;
        return founderCharterFromRow(row);
      })();
    });
  }

  activateFounderCharter(input: ActivateFounderCharterInput) {
    return withDatabase(this.dbPath, (db) => {
      ensureStrategyTables(db);
      return db.transaction(() => {
        activateCharterInternal(db, input.charterId);
        const row = db
          .query("select * from founder_charters where id = $id")
          .get({ $id: input.charterId }) as FounderCharterRow;
        return row ? founderCharterFromRow(row) : null;
      })();
    });
  }

  getFounderCharter(input: GetFounderCharterInput) {
    return withReadOnlyDatabase(this.dbPath, (db) => this.getFounderCharterWithDb(db, input));
  }

  getFounderCharterWithDb(db: HarnessDatabase, input: GetFounderCharterInput) {
    const row = db
      .query("select * from founder_charters where id = $id")
      .get({ $id: input.id }) as FounderCharterRow | null;
    return row ? founderCharterFromRow(row) : null;
  }

  getActiveFounderCharter(input: GetActiveFounderCharterInput) {
    return withReadOnlyDatabase(this.dbPath, (db) => this.getActiveFounderCharterWithDb(db, input));
  }

  getActiveFounderCharterWithDb(db: HarnessDatabase, input: GetActiveFounderCharterInput) {
    const row = db
      .query(
        `
        select *
        from founder_charters
        where project_id is $projectId and is_active = 1
        order by version desc, created_at desc
        limit 1
        `,
      )
      .get({ $projectId: input.projectId }) as FounderCharterRow | null;
    return row ? founderCharterFromRow(row) : null;
  }

  listFounderCharters(input: ListFounderChartersInput) {
    return withReadOnlyDatabase(this.dbPath, (db) => {
      const limit = input.limit && input.limit > 0 ? Math.floor(input.limit) : 100;
      const includeInactive = input.includeInactive ?? false;
      const where = includeInactive
        ? "where project_id is $projectId"
        : "where project_id is $projectId and is_active = 1";
      const rows = db
        .query(
          `
          select *
          from founder_charters
          ${where}
          order by version desc, created_at desc
          limit $limit
          `,
        )
        .all({ $projectId: input.projectId, $limit: limit }) as FounderCharterRow[];
      return rows.map(founderCharterFromRow);
    });
  }

  createStrategySignal(input: CreateStrategySignalInput) {
    const id = input.id ?? makeId("signal");
    return withDatabase(this.dbPath, (db) => this.createStrategySignalWithDb(db, { ...input, id }));
  }

  createStrategySignalWithDb(db: HarnessDatabase, input: CreateStrategySignalInput) {
    const id = input.id ?? makeId("signal");
    ensureStrategyTables(db);
    db.query(
      `
      insert into strategy_signals (
        id, project_id, signal_class, source, title, summary,
        observation_time, confidence, evidence_json, expires_at,
        status, conflicting_signal_ids_json, proposal_id,
        run_id, task_id, attempt_id, payload_json
      )
      values (
        $id, $projectId, $signalClass, $source, $title, $summary,
        $observationTime, $confidence, $evidenceJson, $expiresAt,
        $status, $conflictingSignalIdsJson, $proposalId,
        $runId, $taskId, $attemptId, $payloadJson
      )
      `,
    ).run({
      $id: id,
      $projectId: input.projectId,
      $signalClass: input.signalClass,
      $source: input.source,
      $title: input.title,
      $summary: input.summary,
      $observationTime: input.observationTime,
      $confidence: input.confidence,
      $evidenceJson: toJson(input.evidence ?? []),
      $expiresAt: input.expiresAt ?? null,
      $status: input.status ?? "active",
      $conflictingSignalIdsJson: toJson(input.conflictingSignalIds ?? []),
      $proposalId: input.proposalId ?? null,
      $runId: input.runId ?? null,
      $taskId: input.taskId ?? null,
      $attemptId: input.attemptId ?? null,
      $payloadJson: toJson(input.payload ?? {}),
    });
    const row = db
      .query("select * from strategy_signals where id = $id")
      .get({ $id: id }) as StrategySignalRow;
    return strategySignalFromRow(row);
  }

  getStrategySignal(input: GetStrategySignalInput) {
    return withReadOnlyDatabase(this.dbPath, (db) => this.getStrategySignalWithDb(db, input));
  }

  getStrategySignalWithDb(db: HarnessDatabase, input: GetStrategySignalInput) {
    const row = db
      .query("select * from strategy_signals where id = $id")
      .get({ $id: input.id }) as StrategySignalRow | null;
    return row ? strategySignalFromRow(row) : null;
  }

  listStrategySignals(input: ListStrategySignalsInput = {}) {
    return withReadOnlyDatabase(this.dbPath, (db) => this.listStrategySignalsWithDb(db, input));
  }

  listStrategySignalsWithDb(db: HarnessDatabase, input: ListStrategySignalsInput = {}) {
    const limit = input.limit && input.limit > 0 ? Math.floor(input.limit) : 100;
    const where: string[] = [];
    const bindings: Record<string, string | number> = { $limit: limit };
    if (input.projectId) {
      where.push("project_id is $projectId");
      bindings.$projectId = input.projectId;
    }
    if (input.signalClass) {
      where.push("signal_class = $signalClass");
      bindings.$signalClass = input.signalClass;
    }
    if (input.statuses && input.statuses.length > 0) {
      where.push(`status in (${input.statuses.map((_, index) => `$status${index}`).join(", ")})`);
      for (const [index, status] of input.statuses.entries()) {
        bindings[`$status${index}`] = status;
      }
    }
    const whereClause = where.length > 0 ? `where ${where.join(" and ")}` : "";
    const rows = db
      .query(
        `
        select *
        from strategy_signals
        ${whereClause}
        order by observation_time desc, created_at desc, id desc
        limit $limit
        `,
      )
      .all(bindings) as StrategySignalRow[];
    return rows.map(strategySignalFromRow);
  }

  createDesignProposal(input: CreateDesignProposalInput) {
    const id = input.id ?? makeId("design");
    return withDatabase(this.dbPath, (db) => this.createDesignProposalWithDb(db, { ...input, id }));
  }

  createDesignProposalWithDb(db: HarnessDatabase, input: CreateDesignProposalInput) {
    const id = input.id ?? makeId("design");
    const status = input.status ?? "draft";
    ensureStrategyTables(db);
    db.query(
      `
      insert into design_proposals (
        id, project_id, run_id, task_id, attempt_id, charter_id,
        title, problem, recommendation, status, proposal_json
      )
      values (
        $id, $projectId, $runId, $taskId, $attemptId, $charterId,
        $title, $problem, $recommendation, $status, $proposalJson
      )
      `,
    ).run({
      $id: id,
      $projectId: input.projectId,
      $runId: input.runId ?? null,
      $taskId: input.taskId ?? null,
      $attemptId: input.attemptId ?? null,
      $charterId: input.charterId ?? null,
      $title: input.title,
      $problem: input.problem,
      $recommendation: input.recommendation,
      $status: status,
      $proposalJson: toJson(input.proposal),
    });
    const row = db
      .query("select * from design_proposals where id = $id")
      .get({ $id: id }) as DesignProposalRow;
    return designProposalFromRow(row);
  }

  updateDesignProposalStatus(input: UpdateDesignProposalStatusInput) {
    return withDatabase(this.dbPath, (db) => this.updateDesignProposalStatusWithDb(db, input));
  }

  updateDesignProposalStatusWithDb(db: HarnessDatabase, input: UpdateDesignProposalStatusInput) {
    ensureStrategyTables(db);
    db.query(
      `
      update design_proposals
      set status = $status, updated_at = current_timestamp
      where id = $proposalId
      `,
    ).run({ $proposalId: input.proposalId, $status: input.status });
    const row = db
      .query("select * from design_proposals where id = $proposalId")
      .get({ $proposalId: input.proposalId }) as DesignProposalRow | null;
    return row ? designProposalFromRow(row) : null;
  }

  getDesignProposal(input: GetDesignProposalInput) {
    return withReadOnlyDatabase(this.dbPath, (db) => this.getDesignProposalWithDb(db, input));
  }

  getDesignProposalWithDb(db: HarnessDatabase, input: GetDesignProposalInput) {
    const row = db
      .query("select * from design_proposals where id = $id")
      .get({ $id: input.id }) as DesignProposalRow | null;
    return row ? designProposalFromRow(row) : null;
  }

  listDesignProposals(input: ListDesignProposalsInput = {}) {
    return withReadOnlyDatabase(this.dbPath, (db) => this.listDesignProposalsWithDb(db, input));
  }

  listDesignProposalsWithDb(db: HarnessDatabase, input: ListDesignProposalsInput = {}) {
    const limit = input.limit && input.limit > 0 ? Math.floor(input.limit) : 100;
    const where: string[] = [];
    const bindings: Record<string, string | number> = { $limit: limit };
    if (input.projectId) {
      where.push("project_id is $projectId");
      bindings.$projectId = input.projectId;
    }
    if (input.statuses && input.statuses.length > 0) {
      where.push(`status in (${input.statuses.map((_, index) => `$status${index}`).join(", ")})`);
      for (const [index, status] of input.statuses.entries()) {
        bindings[`$status${index}`] = status;
      }
    }
    const whereClause = where.length > 0 ? `where ${where.join(" and ")}` : "";
    const rows = db
      .query(
        `
        select *
        from design_proposals
        ${whereClause}
        order by created_at desc, id desc
        limit $limit
        `,
      )
      .all(bindings) as DesignProposalRow[];
    return rows.map(designProposalFromRow);
  }

  recordDesignDecision(input: RecordDesignDecisionInput) {
    const id = input.id ?? makeId("decision");
    return withDatabase(this.dbPath, (db) => this.recordDesignDecisionWithDb(db, { ...input, id }));
  }

  recordDesignDecisionWithDb(db: HarnessDatabase, input: RecordDesignDecisionInput) {
    const id = input.id ?? makeId("decision");
    ensureStrategyTables(db);
    db.query(
      `
      insert into design_decisions (
        id, proposal_id, charter_id, decision, actor_kind, actor_ref,
        reasons_json, authority_json, payload_json
      )
      values (
        $id, $proposalId, $charterId, $decision, $actorKind, $actorRef,
        $reasonsJson, $authorityJson, $payloadJson
      )
      `,
    ).run({
      $id: id,
      $proposalId: input.proposalId,
      $charterId: input.charterId ?? null,
      $decision: input.decision,
      $actorKind: input.actorKind,
      $actorRef: input.actorRef ?? null,
      $reasonsJson: toJson(input.reasons ?? []),
      $authorityJson: toJson(input.authority ?? {}),
      $payloadJson: toJson(input.payload ?? {}),
    });
    const row = db
      .query("select * from design_decisions where id = $id")
      .get({ $id: id }) as DesignDecisionRow;
    return designDecisionFromRow(row);
  }

  listDesignDecisions(input: ListDesignDecisionsInput) {
    return withReadOnlyDatabase(this.dbPath, (db) => this.listDesignDecisionsWithDb(db, input));
  }

  listDesignDecisionsWithDb(db: HarnessDatabase, input: ListDesignDecisionsInput) {
    const limit = input.limit && input.limit > 0 ? Math.floor(input.limit) : 100;
    const rows = db
      .query(
        `
        select *
        from design_decisions
        where proposal_id = $proposalId
        order by rowid, id
        limit $limit
        `,
      )
      .all({ $proposalId: input.proposalId, $limit: limit }) as DesignDecisionRow[];
    return rows.map(designDecisionFromRow);
  }

  recordDesignOutcome(input: RecordDesignOutcomeInput) {
    const id = input.id ?? makeId("outcome");
    return withDatabase(this.dbPath, (db) => this.recordDesignOutcomeWithDb(db, { ...input, id }));
  }

  recordDesignOutcomeWithDb(db: HarnessDatabase, input: RecordDesignOutcomeInput) {
    const id = input.id ?? makeId("outcome");
    ensureStrategyTables(db);
    db.query(
      `
      insert into design_outcomes (
        id, proposal_id, run_id, task_id, attempt_id,
        stage, recommendation,
        baseline_json, observed_json, evidence_json, unexpected_effects_json,
        review_at, payload_json
      )
      values (
        $id, $proposalId, $runId, $taskId, $attemptId,
        $stage, $recommendation,
        $baselineJson, $observedJson, $evidenceJson, $unexpectedEffectsJson,
        $reviewAt, $payloadJson
      )
      `,
    ).run({
      $id: id,
      $proposalId: input.proposalId,
      $runId: input.runId ?? null,
      $taskId: input.taskId ?? null,
      $attemptId: input.attemptId ?? null,
      $stage: input.stage,
      $recommendation: input.recommendation,
      $baselineJson: toJson(input.baseline ?? {}),
      $observedJson: toJson(input.observed ?? {}),
      $evidenceJson: toJson(input.evidence ?? []),
      $unexpectedEffectsJson: toJson(input.unexpectedEffects ?? []),
      $reviewAt: input.reviewAt ?? null,
      $payloadJson: toJson(input.payload ?? {}),
    });
    const row = db
      .query("select * from design_outcomes where id = $id")
      .get({ $id: id }) as DesignOutcomeRow;
    return designOutcomeFromRow(row);
  }

  listDesignOutcomes(input: ListDesignOutcomesInput = {}) {
    return withReadOnlyDatabase(this.dbPath, (db) => this.listDesignOutcomesWithDb(db, input));
  }

  listDesignOutcomesWithDb(db: HarnessDatabase, input: ListDesignOutcomesInput = {}) {
    const limit = input.limit && input.limit > 0 ? Math.floor(input.limit) : 100;
    const where: string[] = [];
    const bindings: Record<string, string | number> = { $limit: limit };
    if (input.proposalId) {
      where.push("design_outcomes.proposal_id = $proposalId");
      bindings.$proposalId = input.proposalId;
    }
    if (input.projectId) {
      where.push("design_proposals.project_id is $projectId");
      bindings.$projectId = input.projectId;
    }
    if (input.stage) {
      where.push("design_outcomes.stage = $stage");
      bindings.$stage = input.stage;
    }
    if (input.dueBefore) {
      where.push("(design_outcomes.review_at is not null and design_outcomes.review_at <= $dueBefore)");
      bindings.$dueBefore = input.dueBefore;
    }
    const whereClause = where.length > 0 ? `where ${where.join(" and ")}` : "";
    const rows = db
      .query(
        `
        select design_outcomes.*
        from design_outcomes
        left join design_proposals on design_proposals.id = design_outcomes.proposal_id
        ${whereClause}
        order by design_outcomes.rowid, design_outcomes.id
        limit $limit
        `,
      )
      .all(bindings) as DesignOutcomeRow[];
    return rows.map(designOutcomeFromRow);
  }

  linkProposalOutcomeReview(input: LinkProposalOutcomeReviewInput): LinkProposalOutcomeReviewResult {
    return withDatabase(this.dbPath, (db) => this.linkProposalOutcomeReviewWithDb(db, input));
  }

  linkProposalOutcomeReviewWithDb(db: HarnessDatabase, input: LinkProposalOutcomeReviewInput): LinkProposalOutcomeReviewResult {
    ensureStrategyTables(db);
    const run = this.getRun(input.runId);
    if (!run) {
      return {
        proposalId: null,
        proposalStatus: null,
        outcomeReviewTaskId: null,
        reviewDue: false,
        reviewAt: null,
        reason: "run not found",
      };
    }
    const proposalIdRaw = run.context?.designProposalId;
    if (typeof proposalIdRaw !== "string" || proposalIdRaw.length === 0) {
      return {
        proposalId: null,
        proposalStatus: null,
        outcomeReviewTaskId: null,
        reviewDue: false,
        reviewAt: null,
        reason: "no designProposalId on run context",
      };
    }
    const proposal = this.getDesignProposalWithDb(db, { id: proposalIdRaw });
    if (!proposal) {
      return {
        proposalId: proposalIdRaw,
        proposalStatus: null,
        outcomeReviewTaskId: null,
        reviewDue: false,
        reviewAt: null,
        reason: "design proposal not found",
      };
    }
    const reviewAtRaw = readReviewAt(proposal);
    const now = input.now ?? Date.now();
    const immediate = input.immediateProxyReview === true;
    const reviewDue = immediate || reviewAtRaw === null || reviewAtRaw.length === 0 || Date.parse(reviewAtRaw) <= now;
    const nextStatus: DesignProposalStatus = "measuring";
    if (proposal.status !== nextStatus) {
      this.updateDesignProposalStatusWithDb(db, { proposalId: proposal.id, status: nextStatus });
    }
    // Idempotent: if an outcome-review task already exists for this proposal in
    // this run, do not create a second one. The reviewer records the formal
    // outcome; we only need one task.
    const existing = db
      .query(
        `
        select id from tasks
        where run_id = $runId
          and role = 'outcome-review'
          and config_json like $proposalMatch
        limit 1
        `,
      )
      .get({
        $runId: input.runId,
        $proposalMatch: `%"designProposalId":"${proposal.id}"%`,
      }) as { id?: string } | null;
    let outcomeReviewTaskId: string | null = existing?.id ?? null;
    if (reviewDue && !outcomeReviewTaskId) {
      outcomeReviewTaskId = this.createTaskWithDb(db, {
        runId: input.runId,
        role: "outcome-review",
        goal: `Measure design proposal ${proposal.id}: ${proposal.title}`,
        prompt: this.outcomeReviewPrompt(proposal),
        doneWhen: [
          `Proposal ${proposal.id} evaluation contract is referenced`,
          "Observed metrics are compared against baseline and success metrics",
          "A retain, revise, or retire recommendation is recorded through recordDesignOutcome",
        ],
        config: {
          designProposalId: proposal.id,
          designEvaluationContract: proposal.proposal.evaluationContract,
          designBaseline: proposal.proposal.evaluationContract?.baseline ?? [],
          designSuccessMetrics: proposal.proposal.evaluationContract?.successMetrics ?? [],
          designGuardMetrics: proposal.proposal.evaluationContract?.guardMetrics ?? [],
          designReviewAt: reviewAtRaw ?? null,
        },
      });
    }
    return {
      proposalId: proposal.id,
      proposalStatus: nextStatus,
      outcomeReviewTaskId,
      reviewDue,
      reviewAt: reviewAtRaw,
      reason: reviewDue ? "due" : "future",
    };
  }

  private outcomeReviewPrompt(proposal: DesignProposal) {
    const contract = proposal.proposal.evaluationContract;
    return [
      "Act as the Ouroboros Outcome Reviewer for an integrated design proposal.",
      "",
      `Proposal: ${proposal.id}`,
      `Title: ${proposal.title}`,
      `Problem: ${proposal.problem}`,
      `Recommendation: ${proposal.recommendation}`,
      "",
      "Frozen evaluation contract:",
      `- Baseline: ${JSON.stringify(contract?.baseline ?? [])}`,
      `- Success metrics: ${JSON.stringify(contract?.successMetrics ?? [])}`,
      `- Guard metrics: ${JSON.stringify(contract?.guardMetrics ?? [])}`,
      `- Required evidence: ${JSON.stringify(contract?.requiredEvidence ?? [])}`,
      contract?.reviewAt ? `- Scheduled review: ${contract.reviewAt}` : "- Scheduled review: immediate proxy review",
      "",
      "Inspect post-integration run evidence, lessons, repository changes, verifier checks, and any unexpected effects.",
      "Compare observed metrics to baseline and the frozen success metrics.",
      "Return one of the following outcomes through the `actions` array:",
      "- `recordDesignOutcome` with stage `review`, a retain/revise/retire recommendation, observed metrics, evidence, and unexpected effects.",
      "- If the proposal misread the problem or the integration regressed a guard metric, recommend `revise` or `retire` and capture the discrepancy as evidence and unexpected effects.",
      "",
      "Do not weaken the frozen evaluation contract. Do not reopen completed delivery tasks; if the outcome disagrees with the design, feed the discrepancy back as a strategy signal via `recordSignal`.",
    ].join("\n");
  }

  private seedPromptTemplates() {
    return withDatabase(this.dbPath, (db) => {
      const insertQuery = db.query(`
        insert or ignore into prompt_templates (key, content_md)
        values ($key, $contentMd)
      `);
      for (const template of [
        { key: "task", contentMd: DEFAULT_TASK_PROMPT_TEMPLATE },
        { key: "verifier-task", contentMd: DEFAULT_VERIFIER_TASK_PROMPT_TEMPLATE },
        { key: "repair-task", contentMd: DEFAULT_REPAIR_TASK_PROMPT_TEMPLATE },
        { key: "context-summary", contentMd: DEFAULT_CONTEXT_SUMMARY_PROMPT_TEMPLATE },
      ]) {
        insertQuery.run({
          $key: template.key,
          $contentMd: template.contentMd,
        });
      }

      const taskTemplate = db.query("select content_md from prompt_templates where key = 'task'").get() as
        | { content_md: string }
        | null;
      if (taskTemplate && LEGACY_DEFAULT_TASK_PROMPT_TEMPLATES.includes(taskTemplate.content_md)) {
        db.query(
          `
          update prompt_templates
          set content_md = $contentMd,
              updated_at = current_timestamp
          where key = 'task'
          `,
        ).run({ $contentMd: DEFAULT_TASK_PROMPT_TEMPLATE });
      }
    });
  }
}

function processIsAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function assertTaskGovernanceBoundaryWithDb(db: HarnessDatabase, input: CreateTaskInput) {
  if (input.role !== "worker") {
    return;
  }
  const runRow = db.query("select * from runs where id = $runId").get({ $runId: input.runId }) as RunRow | null;
  if (!runRow) {
    throw new Error(`run not found: ${input.runId}`);
  }
  const run = runFromRow(runRow);
  if (run.context.source === "target-system-design") {
    throw new Error(
      `target-system-design root ${run.id} cannot create or start a Worker; accepted design delivery must pass authority and createRunsFromDesign into a child run with a Planner`,
    );
  }
  if (run.context.source !== "design") {
    return;
  }
  const parentRunId = typeof run.context.parentRunId === "string" ? run.context.parentRunId : "";
  const proposalId = typeof run.context.designProposalId === "string" ? run.context.designProposalId : "";
  const decisionId = typeof run.context.designDecisionId === "string" ? run.context.designDecisionId : "";
  const parentRow = parentRunId
    ? db.query("select * from runs where id = $runId").get({ $runId: parentRunId }) as RunRow | null
    : null;
  const parent = parentRow ? runFromRow(parentRow) : null;
  const governedDesignChild = parent?.context.source === "target-system-design"
    || proposalId.length > 0
    || decisionId.length > 0
    || run.context.designDeliveryPlan !== undefined;
  if (!governedDesignChild) {
    return;
  }
  const authority = proposalId && decisionId
    ? db.query(
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
      }) as { id: string } | null
    : null;
  if (
    !parent
    || parent.context.source !== "target-system-design"
    || parent.projectId !== run.projectId
    || !authority
  ) {
    throw new Error(
      `design child ${run.id} cannot create or start a Worker without an accepted design proposal and approved authority decision bound to its target-system-design parent`,
    );
  }
  const tasks = (db.query("select * from tasks where run_id = $runId").all({ $runId: run.id }) as TaskRow[])
    .map(taskFromRow);
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const pending = [...(input.dependsOn ?? []), ...(input.parentId ? [input.parentId] : [])];
  const visited = new Set<string>();
  let plannerFound = false;
  while (pending.length > 0 && !plannerFound) {
    const taskId = pending.shift()!;
    if (visited.has(taskId)) continue;
    visited.add(taskId);
    const ancestor = tasksById.get(taskId);
    if (!ancestor) continue;
    if (ancestor.role === "planner") {
      plannerFound = true;
      break;
    }
    pending.push(...ancestor.dependsOn, ...(ancestor.parentId ? [ancestor.parentId] : []));
  }
  if (!plannerFound) {
    throw new Error(`design child ${run.id} Worker must be downstream of its frozen Planner task`);
  }
}

function evolutionRecordProjectId(value: unknown, label: string): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const projectId = (value as { projectId?: unknown }).projectId;
  if (typeof projectId !== "string" || projectId.length === 0) {
    throw new Error(`${label}.projectId must be a non-empty string`);
  }
  return projectId;
}

function requireProjectWithDb(db: HarnessDatabase, projectId: string): void {
  const row = db
    .query("select id from projects where id = $projectId")
    .get({ $projectId: projectId }) as { id: string } | null;
  if (!row) {
    throw new Error(`project not found: ${projectId}`);
  }
}

function requireEvolutionProfileWithDb(
  db: HarnessDatabase,
  projectId: string,
  profileId: string,
  ownerLabel: string,
): EvolutionProfile {
  const row = db
    .query("select * from evolution_profiles where project_id = $projectId and id = $profileId")
    .get({ $projectId: projectId, $profileId: profileId }) as EvolutionProfileRow | null;
  if (!row) {
    throw new Error(`${ownerLabel} profile not found: ${profileId}`);
  }
  return evolutionProfileFromRow(row);
}

function requireSameEvolutionScope(
  record: { projectId: string; profileId: string },
  profile: EvolutionProfile,
  label: string,
  id: string,
): void {
  if (record.projectId !== profile.projectId || record.profileId !== profile.id) {
    throw new Error(
      `${label} ${id} must use the same project and profile as ${profile.id}`,
    );
  }
}

function requireIdenticalEvolutionRecord(
  storedJson: string,
  candidateJson: string,
  label: string,
  id: string,
): void {
  if (storedJson !== candidateJson) {
    throw new Error(`${label} conflict: ${id} already exists with different record_json`);
  }
}

function requireEvolutionReadback<T>(
  stored: T | null,
  candidateJson: string,
  label: string,
  id: string,
): asserts stored is T {
  if (!stored || toJson(stored) !== candidateJson) {
    throw new Error(`${label} readback mismatch: ${id}`);
  }
}

function evolutionScopeFilters(
  input: ListEvolutionRecordsInput,
  role?: HarnessVariant["role"],
): { sql: string; params: Record<string, string> } {
  const where: string[] = [];
  const params: Record<string, string> = {};
  if (input.projectId) {
    where.push("project_id = $projectId");
    params.$projectId = input.projectId;
  }
  if (input.profileId) {
    where.push("profile_id = $profileId");
    params.$profileId = input.profileId;
  }
  if (role) {
    where.push("role = $role");
    params.$role = role;
  }
  return {
    sql: where.length > 0 ? `where ${where.join(" and ")}` : "",
    params,
  };
}

function requireHarnessVariantWithDb(
  db: HarnessDatabase,
  projectId: string,
  profileId: string,
  variantId: string,
  expectedRole: HarnessVariant["role"],
): HarnessVariant {
  const row = db
    .query(
      `select * from harness_variants
       where project_id = $projectId and profile_id = $profileId and id = $variantId`,
    )
    .get({ $projectId: projectId, $profileId: profileId, $variantId: variantId }) as HarnessVariantRow | null;
  if (!row) {
    throw new Error(`MatchedExperiment ${expectedRole} variant not found: ${variantId}`);
  }
  return harnessVariantFromRow(row);
}

function requireVariantForExperiment(
  variant: HarnessVariant,
  experiment: MatchedExperiment,
  expectedRole: HarnessVariant["role"],
): void {
  if (variant.role !== expectedRole) {
    throw new Error(
      `MatchedExperiment ${experiment.id} ${expectedRole} variant has ${variant.role} role: ${variant.id}`,
    );
  }
  if (variant.projectId !== experiment.projectId || variant.profileId !== experiment.profileId) {
    throw new Error(
      `MatchedExperiment ${experiment.id} ${expectedRole} variant must use the same project and profile`,
    );
  }
}

function requireExperimentEpisodesWithDb(
  db: HarnessDatabase,
  experiment: MatchedExperiment,
): void {
  const sourceSplit = new Map<string, string>();
  const leakageGroupSplit = new Map<string, string>();
  const snapshotSplit = new Map<string, string>();
  const splits = [
    ["development", experiment.developmentEpisodeRefs],
    ["heldout", experiment.heldoutEpisodeRefs],
    ["unrelated", experiment.unrelatedEpisodeRefs],
  ] as const;

  for (const [split, episodeIds] of splits) {
    for (const episodeId of episodeIds) {
      const row = db
        .query(
          `select * from production_episodes
           where project_id = $projectId and profile_id = $profileId and id = $episodeId`,
        )
        .get({
          $projectId: experiment.projectId,
          $profileId: experiment.profileId,
          $episodeId: episodeId,
        }) as ProductionEpisodeRow | null;
      if (!row) {
        throw new Error(`MatchedExperiment ${experiment.id} episode not found: ${episodeId}`);
      }
      const episode = productionEpisodeFromRow(row);
      if (
        episode.id !== episodeId ||
        episode.projectId !== experiment.projectId ||
        episode.profileId !== experiment.profileId
      ) {
        throw new Error(
          `MatchedExperiment ${experiment.id} episode must use the same project and profile: ${episodeId}`,
        );
      }
      requireSplitIsolation(sourceSplit, episode.sourceRef, split, "sourceRef", experiment.id);
      requireSplitIsolation(
        leakageGroupSplit,
        episode.leakageGroupId,
        split,
        "leakageGroupId",
        experiment.id,
      );
      requireSplitIsolation(
        snapshotSplit,
        episode.inputSnapshotSha256,
        split,
        "snapshot hash",
        experiment.id,
      );
      requireSplitIsolation(
        snapshotSplit,
        episode.outcomeSnapshotSha256,
        split,
        "snapshot hash",
        experiment.id,
      );
    }
  }
}

function requireSplitIsolation(
  observedSplit: Map<string, string>,
  value: string,
  split: string,
  label: string,
  experimentId: string,
): void {
  const priorSplit = observedSplit.get(value);
  if (priorSplit && priorSplit !== split) {
    throw new Error(
      `MatchedExperiment ${experimentId} ${label} crosses ${priorSplit} and ${split} splits: ${value}`,
    );
  }
  observedSplit.set(value, split);
}

function readReviewAt(proposal: DesignProposal): string | null {
  const raw = (proposal.proposal.evaluationContract as { reviewAt?: unknown } | undefined)?.reviewAt;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

function resolveRunProjectId(
  db: Parameters<Parameters<typeof withDatabase>[1]>[0],
  input: CreateRunInput,
) {
  if (input.projectId) {
    const row = db.query("select id from projects where id = $projectId").get({ $projectId: input.projectId }) as
      | { id: string }
      | null;
    if (!row) {
      throw new Error(`project not found: ${input.projectId}`);
    }
    return input.projectId;
  }
  if (!input.projectRoot) {
    return null;
  }
  const rootPath = resolve(input.projectRoot);
  const existing = db.query("select id from projects where root_path = $rootPath").get({ $rootPath: rootPath }) as
    | { id: string }
    | null;
  if (existing) {
    return existing.id;
  }
  const id = makeId("project");
  db.query(
    `
    insert into projects (id, name, root_path, context_json)
    values ($id, $name, $rootPath, '{}')
    `,
  ).run({
    $id: id,
    $name: basename(rootPath) || rootPath,
    $rootPath: rootPath,
  });
  return id;
}

function stringOrNull(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function objectOrNull(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function verifierLeaseIsAvailable(task: Task, allTasks: Task[], selectedCandidates: Task[]) {
  if (task.role !== "verifier") {
    return true;
  }
  const workerDependencies = task.dependsOn.filter((dependencyId) =>
    allTasks.some((candidate) => candidate.id === dependencyId && candidate.role === "worker")
  );
  if (workerDependencies.length === 0) {
    return true;
  }
  const sharesWorker = (candidate: Task) =>
    candidate.role === "verifier"
    && candidate.id !== task.id
    && candidate.dependsOn.some((dependencyId) => workerDependencies.includes(dependencyId));
  return !allTasks.some((candidate) => candidate.status === "running" && sharesWorker(candidate))
    && !selectedCandidates.some(sharesWorker);
}

function createDependencyReadiness(tasks: Task[]) {
  const statuses = new Map(tasks.map((task) => [task.id, task.status]));
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const repairTasksByParent = new Map<string, Task[]>();
  const verifiedRepairIds = new Set<string>();

  for (const task of tasks) {
    if (task.role === "worker" && task.status === "done" && task.parentId) {
      const repairTasks = repairTasksByParent.get(task.parentId) ?? [];
      repairTasks.push(task);
      repairTasksByParent.set(task.parentId, repairTasks);
    }

    if (task.role === "verifier" && task.status === "done") {
      for (const dependencyId of task.dependsOn) {
        verifiedRepairIds.add(dependencyId);
      }
    }
  }

  return (taskId: string, dependentTask?: Task) => {
    const status = statuses.get(taskId);
    if (status === "done") {
      return true;
    }
    if (status !== "blocked") {
      return false;
    }

    const dependency = tasksById.get(taskId);
    if (
      dependentTask?.role === "worker" &&
      dependency?.role === "verifier" &&
      dependentTask.goal.toLowerCase().startsWith("repair")
    ) {
      return true;
    }

    return (repairTasksByParent.get(taskId) ?? []).some((repairTask) => verifiedRepairIds.has(repairTask.id));
  };
}

function ensureExecutionThreads(db: { exec: (sql: string) => void }) {
  db.exec(`
    create table if not exists execution_threads (
      id text primary key,
      run_id text not null references runs(id) on delete cascade,
      task_id text references tasks(id) on delete set null,
      attempt_id text references attempts(id) on delete set null,
      parent_thread_id text references execution_threads(id) on delete set null,
      owner_type text not null,
      owner_id text,
      role text not null,
      status text not null check (status in ('running', 'done', 'blocked', 'interrupted', 'orphaned')),
      pid integer,
      session_name text,
      agent_session_id text,
      worktree_path text,
      heartbeat_at text not null default current_timestamp,
      interrupted_at text,
      interrupt_reason text,
      created_at text not null default current_timestamp,
      updated_at text not null default current_timestamp
    );
    create index if not exists idx_execution_threads_run_status on execution_threads(run_id, status);
    create index if not exists idx_execution_threads_attempt on execution_threads(attempt_id);
  `);
  try {
    db.exec("alter table execution_threads add column agent_session_id text");
  } catch {
    // The column already exists on databases created after the thread registry landed.
  }
  try {
    db.exec("update execution_threads set agent_session_id = codex_session_id where agent_session_id is null");
  } catch {
    // Older and newer schemas only have one of these columns.
  }
}

function ensureHarnessActionEvents(db: { exec: (sql: string) => void }) {
  db.exec(`
    create table if not exists harness_action_events (
      id text primary key,
      action_type text not null,
      status text not null check (status in ('done', 'blocked')),
      request_json text not null,
      result_json text not null,
      created_at text not null default current_timestamp
    );
    create index if not exists idx_harness_action_events_created on harness_action_events(created_at, id);
  `);
}

function ensureStrategyTables(db: { exec: (sql: string) => void }) {
  db.exec(`
    create table if not exists founder_charters (
      id text primary key,
      project_id text references projects(id) on delete set null,
      version integer not null,
      is_active integer not null default 0,
      mission text not null,
      charter_json text not null default '{}',
      activated_at text,
      superseded_at text,
      created_at text not null default current_timestamp,
      updated_at text not null default current_timestamp,
      unique (project_id, version)
    );

    create unique index if not exists idx_founder_charters_active_project
      on founder_charters(project_id) where is_active = 1;
    create index if not exists idx_founder_charters_project
      on founder_charters(project_id, version);

    create table if not exists strategy_signals (
      id text primary key,
      project_id text references projects(id) on delete cascade,
      signal_class text not null check (signal_class in ('user','delivery','technology','market','economics','system')),
      source text not null,
      title text not null,
      summary text not null,
      observation_time text not null,
      confidence real not null,
      evidence_json text not null default '[]',
      expires_at text,
      status text not null default 'active' check (status in ('active','expired','superseded')),
      conflicting_signal_ids_json text not null default '[]',
      proposal_id text references design_proposals(id) on delete set null,
      run_id text references runs(id) on delete set null,
      task_id text references tasks(id) on delete set null,
      attempt_id text references attempts(id) on delete set null,
      payload_json text not null default '{}',
      created_at text not null default current_timestamp,
      updated_at text not null default current_timestamp
    );

    create index if not exists idx_strategy_signals_project_status
      on strategy_signals(project_id, status);
    create index if not exists idx_strategy_signals_class_observed
      on strategy_signals(signal_class, observation_time);
    create index if not exists idx_strategy_signals_expires
      on strategy_signals(expires_at);

    create table if not exists design_proposals (
      id text primary key,
      project_id text references projects(id) on delete cascade,
      run_id text references runs(id) on delete set null,
      task_id text references tasks(id) on delete set null,
      attempt_id text references attempts(id) on delete set null,
      charter_id text references founder_charters(id) on delete set null,
      title text not null,
      problem text not null,
      recommendation text not null,
      status text not null default 'draft' check (
        status in (
          'draft','proposed','experimenting','accepted',
          'implemented','measuring','retained',
          'rejected','retired','revise'
        )
      ),
      proposal_json text not null default '{}',
      created_at text not null default current_timestamp,
      updated_at text not null default current_timestamp
    );

    create index if not exists idx_design_proposals_project_status
      on design_proposals(project_id, status);

    create table if not exists design_decisions (
      id text primary key,
      proposal_id text not null references design_proposals(id) on delete cascade,
      charter_id text references founder_charters(id) on delete set null,
      decision text not null check (decision in ('approved','rejected','deferred','retired','revise')),
      actor_kind text not null check (actor_kind in ('auto','human','governance')),
      actor_ref text,
      reasons_json text not null default '[]',
      authority_json text not null default '{}',
      payload_json text not null default '{}',
      created_at text not null default current_timestamp
    );

    create index if not exists idx_design_decisions_proposal
      on design_decisions(proposal_id, created_at);

    create table if not exists design_outcomes (
      id text primary key,
      proposal_id text not null references design_proposals(id) on delete cascade,
      run_id text references runs(id) on delete set null,
      task_id text references tasks(id) on delete set null,
      attempt_id text references attempts(id) on delete set null,
      stage text not null check (stage in ('experiment','release','review')),
      recommendation text not null check (recommendation in ('retain','revise','retire')),
      baseline_json text not null default '{}',
      observed_json text not null default '{}',
      evidence_json text not null default '[]',
      unexpected_effects_json text not null default '[]',
      review_at text,
      payload_json text not null default '{}',
      created_at text not null default current_timestamp
    );

    create index if not exists idx_design_outcomes_proposal
      on design_outcomes(proposal_id, created_at);
    create index if not exists idx_design_outcomes_review
      on design_outcomes(review_at);
  `);
}

function activateCharterInternal(
  db: Parameters<Parameters<typeof withDatabase>[1]>[0],
  charterId: string,
) {
  const target = db
    .query("select project_id, version from founder_charters where id = $id")
    .get({ $id: charterId }) as { project_id: string | null; version: number } | null;
  if (!target) {
    throw new Error(`founder charter not found: ${charterId}`);
  }
  db.query(
    `
    update founder_charters
    set is_active = 0,
        superseded_at = coalesce(superseded_at, current_timestamp),
        updated_at = current_timestamp
    where project_id is $projectId
      and is_active = 1
      and id != $charterId
    `,
  ).run({ $projectId: target.project_id, $charterId: charterId });
  db.query(
    `
    update founder_charters
    set is_active = 1,
        activated_at = coalesce(activated_at, current_timestamp),
        superseded_at = null,
        updated_at = current_timestamp
    where id = $charterId
    `,
  ).run({ $charterId: charterId });
}

function resolveTaskCycleId(
  db: Parameters<Parameters<typeof withDatabase>[1]>[0],
  input: { id: string; role: string; parentId: string | null; dependsOn: string[]; cycleId: string | null },
) {
  if (input.cycleId) {
    return input.cycleId;
  }
  if (input.role === "planner" || input.role === "goal-review") {
    return input.id;
  }
  const linkedIds = [input.parentId, ...input.dependsOn].filter((id): id is string => typeof id === "string");
  const query = db.query("select cycle_id from tasks where id = $id");
  for (const id of linkedIds) {
    const row = query.get({ $id: id }) as { cycle_id: string | null } | null;
    if (row?.cycle_id) {
      return row.cycle_id;
    }
  }
  return input.id;
}

function latestEventText(events: Array<{ text: string | null; payload: Record<string, unknown> }>) {
  for (const event of [...events].reverse()) {
    for (const key of ["delta", "message", "text", "content"]) {
      const value = event.payload[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
      }
    }
  }
  for (const event of [...events].reverse()) {
    if (event.text && event.text.trim().length > 0) {
      return event.text.trim();
    }
  }
  return "";
}

function normalizeAttemptOutput(output: RecordAttemptInput["output"]) {
  return {
    ...output,
    summary: readableValue(output.summary),
    problems: readableList(output.problems),
  };
}

function isDeadAttemptRecovery(value: unknown): value is {
  count: number;
  limit: number;
  sourceTaskId: string;
  sourceAttemptId: string;
  durableEventRefs: string[];
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Number.isInteger(record.count)
    && Number(record.count) >= 1
    && Number.isInteger(record.limit)
    && Number(record.limit) >= Number(record.count)
    && typeof record.sourceTaskId === "string"
    && record.sourceTaskId.length > 0
    && typeof record.sourceAttemptId === "string"
    && record.sourceAttemptId.length > 0
    && Array.isArray(record.durableEventRefs)
    && record.durableEventRefs.every((ref) => typeof ref === "string" && ref.length > 0);
}

function lessonForAttempt(output: RecordAttemptInput["output"]) {
  if (output.status === "done") {
    return {
      kind: "experience" as const,
      summary: readableValue(output.summary) || "Task completed successfully",
      evidence: {
        changedFiles: output.changedFiles ?? [],
        checks: output.checks ?? [],
        artifacts: output.artifacts ?? [],
      },
    };
  }

  return {
    kind: "lesson" as const,
    summary: readableList(output.problems)[0] || readableValue(output.summary) || "Task was blocked",
    evidence: {
      summary: output.summary,
      checks: output.checks ?? [],
      artifacts: output.artifacts ?? [],
      problems: output.problems ?? [],
    },
  };
}

function isSqliteBusyError(error: unknown) {
  return error instanceof Error && "code" in error && (error as { code?: unknown }).code === "SQLITE_BUSY";
}

function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const INBOX_TRANSITIONS: Record<"todo" | "running", readonly InboxTransitionTarget[]> = {
  todo: ["running"],
  running: ["done", "blocked"],
};

export function isValidInboxTransition(
  from: "todo" | "running",
  to: InboxTransitionTarget,
): boolean {
  return INBOX_TRANSITIONS[from].includes(to);
}
