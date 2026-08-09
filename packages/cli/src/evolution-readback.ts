import {
  canonicalEvolutionRecordSha256,
  canonicalEvolutionValueSha256,
  Harness,
  withReadOnlyDatabase,
} from "@ouroboros/harness";
import type {
  EvolutionProfile,
  HarnessDatabase,
  HarnessVariant,
  MatchedExperiment,
  ProductionEpisode,
} from "@ouroboros/harness";

export const EVOLUTION_READBACK_KINDS = [
  "profile",
  "episode",
  "variant",
  "experiment",
] as const;

export type EvolutionReadbackKind = (typeof EVOLUTION_READBACK_KINDS)[number];
type EvolutionReadbackRecord =
  | EvolutionProfile
  | ProductionEpisode
  | HarnessVariant
  | MatchedExperiment;

const ACTION_TYPE_BY_KIND: Record<EvolutionReadbackKind, string> = {
  profile: "registerEvolutionProfile",
  episode: "recordProductionEpisode",
  variant: "registerHarnessVariant",
  experiment: "freezeMatchedExperiment",
};

const ACTION_ARTIFACT_KIND_BY_KIND: Record<EvolutionReadbackKind, string> = {
  profile: "evolution_profile",
  episode: "production_episode",
  variant: "harness_variant",
  experiment: "matched_experiment",
};

interface HarnessActionEventReadRow {
  id: string;
  action_type: string;
  status: "done" | "blocked";
  request_json: string;
  result_json: string;
  created_at: string;
}

interface EvolutionActionReceiptReadRow {
  action_event_id: string;
  action_type: string;
  source_run_id: string;
  project_id: string;
  record_kind: EvolutionReadbackKind;
  record_id: string;
  record_sha256: string;
  created_at: string;
  event_action_type: string;
  event_status: "done" | "blocked";
  request_json: string;
  result_json: string;
  event_created_at: string;
}

interface SafeEvolutionActionAudit {
  id: string;
  actionType: string;
  status: "done";
  createdAt: string;
  sourceRunId: string;
  artifactKind: string;
  entityKind: EvolutionReadbackKind;
  projectId: string;
  recordId: string;
  recordSha256: string;
  replayed: boolean;
  receiptCount: number;
}

export function parseEvolutionReadbackKind(value: string): EvolutionReadbackKind {
  if ((EVOLUTION_READBACK_KINDS as readonly string[]).includes(value)) {
    return value as EvolutionReadbackKind;
  }
  throw new Error("--kind must be profile, episode, variant, or experiment");
}

export function showEvolutionRecord(input: {
  harness: Harness;
  dbPath: string;
  kind: EvolutionReadbackKind;
  projectId: string;
  id: string;
}) {
  requireProject(input.harness, input.projectId);
  const record = getRecord(input.harness, input.kind, input.projectId, input.id);
  if (!record) {
    throw new Error(
      `evolution ${input.kind} record not found: ${input.id} for project ${input.projectId}`,
    );
  }
  const recordSha256 = canonicalEvolutionRecordSha256(record);
  const presentedRecord = presentEvolutionRecord({
    kind: input.kind,
    projectId: input.projectId,
    record,
  });
  return {
    kind: input.kind,
    projectId: input.projectId,
    id: record.id,
    recordSha256,
    record: presentedRecord,
    actionAudit: readDoneEvolutionActionAudit({
      dbPath: input.dbPath,
      kind: input.kind,
      projectId: input.projectId,
      recordId: record.id,
      recordSha256,
    }),
  };
}

function getRecord(
  harness: Harness,
  kind: EvolutionReadbackKind,
  projectId: string,
  id: string,
): EvolutionReadbackRecord | null {
  switch (kind) {
    case "profile":
      return harness.getEvolutionProfile({ projectId, id });
    case "episode":
      return harness.getProductionEpisode({ projectId, id });
    case "variant":
      return harness.getHarnessVariant({ projectId, id });
    case "experiment":
      return harness.getMatchedExperiment({ projectId, id });
  }
}

export function listEvolutionRecords(input: {
  harness: Harness;
  dbPath: string;
  kind: EvolutionReadbackKind;
  projectId: string;
  profileId?: string;
}) {
  requireProject(input.harness, input.projectId);
  if (input.kind === "profile" && input.profileId !== undefined) {
    throw new Error("--profile-id is not valid for profile records");
  }
  const records = listRecords(input);
  return {
    kind: input.kind,
    projectId: input.projectId,
    profileId: input.profileId ?? null,
    totalCount: records.length,
    records: records.map((record) => {
      const recordSha256 = canonicalEvolutionRecordSha256(record);
      return {
        id: record.id,
        recordSha256,
        record: presentEvolutionRecord({
          kind: input.kind,
          projectId: input.projectId,
          record,
        }),
        actionAudit: readDoneEvolutionActionAudit({
          dbPath: input.dbPath,
          kind: input.kind,
          projectId: input.projectId,
          recordId: record.id,
          recordSha256,
        }),
      };
    }),
  };
}

function presentEvolutionRecord(input: {
  kind: EvolutionReadbackKind;
  projectId: string;
  record: EvolutionReadbackRecord;
}): Record<string, unknown> {
  if (input.kind === "experiment") {
    const experiment = input.record as MatchedExperiment;
    const {
      developmentEpisodeRefs,
      heldoutEpisodeRefs,
      unrelatedEpisodeRefs,
      evidenceRefs,
      ...safeRecord
    } = experiment;
    return {
      ...safeRecord,
      developmentEpisodeCount: developmentEpisodeRefs.length,
      developmentCommitmentSha256: splitCommitment(experiment, "development", developmentEpisodeRefs),
      heldoutEpisodeCount: heldoutEpisodeRefs.length,
      heldoutCommitmentSha256: splitCommitment(experiment, "heldout", heldoutEpisodeRefs),
      unrelatedEpisodeCount: unrelatedEpisodeRefs.length,
      unrelatedCommitmentSha256: splitCommitment(experiment, "unrelated", unrelatedEpisodeRefs),
      evidenceCount: evidenceRefs.length,
    };
  }
  if (input.kind !== "episode") {
    return { ...input.record };
  }
  const episode = input.record as ProductionEpisode;
  return {
    schemaVersion: episode.schemaVersion,
    id: episode.id,
    projectId: episode.projectId,
    profileId: episode.profileId,
    contentDisclosure: "commitment-only",
    observedAt: episode.observedAt,
    inputSnapshotSha256: episode.inputSnapshotSha256,
    outcomeSnapshotSha256: episode.outcomeSnapshotSha256,
    metricCount: Object.keys(episode.metrics).length,
    evidenceCount: episode.evidenceRefs.length,
    sideEffectCounterCount: Object.keys(episode.sideEffectCounters).length,
    privacyReview: {
      status: episode.privacyReview.status,
      policySha256: episode.privacyReview.policySha256,
      dataClassification: episode.privacyReview.dataClassification,
      inputSnapshotSha256: episode.privacyReview.inputSnapshotSha256,
      outcomeSnapshotSha256: episode.privacyReview.outcomeSnapshotSha256,
      evidenceCount: episode.privacyReview.evidenceRefs.length,
    },
  };
}

function splitCommitment(
  experiment: MatchedExperiment,
  split: "development" | "heldout" | "unrelated",
  episodeRefs: string[],
) {
  return canonicalEvolutionValueSha256({
    schemaVersion: 1,
    commitmentType: "evolution-episode-split",
    split,
    projectId: experiment.projectId,
    profileId: experiment.profileId,
    episodeIds: episodeRefs.slice().sort(),
  });
}

function listRecords(input: {
  harness: Harness;
  kind: EvolutionReadbackKind;
  projectId: string;
  profileId?: string;
}): EvolutionReadbackRecord[] {
  switch (input.kind) {
    case "profile":
      return input.harness.listEvolutionProfiles({ projectId: input.projectId });
    case "episode":
      return input.harness.listProductionEpisodes({
        projectId: input.projectId,
        profileId: input.profileId,
      });
    case "variant":
      return input.harness.listHarnessVariants({
        projectId: input.projectId,
        profileId: input.profileId,
      });
    case "experiment":
      return input.harness.listMatchedExperiments({
        projectId: input.projectId,
        profileId: input.profileId,
      });
  }
}

function requireProject(harness: Harness, projectId: string) {
  if (!harness.getProject(projectId)) {
    throw new Error(`project not found: ${projectId}`);
  }
}

function readDoneEvolutionActionAudit(input: {
  dbPath: string;
  kind: EvolutionReadbackKind;
  projectId: string;
  recordId: string;
  recordSha256: string;
}): SafeEvolutionActionAudit {
  return withReadOnlyDatabase(input.dbPath, (db) => {
    try {
      const eventRows = db.query(
        `
        select id, action_type, status, request_json, result_json, created_at
        from harness_action_events
        where action_type = $actionType
          and status = 'done'
          and json_extract(request_json, '$.entityKind') = $recordKind
          and json_extract(request_json, '$.recordId') = $recordId
        order by rowid desc
        limit 101
        `,
      ).all({
        $actionType: ACTION_TYPE_BY_KIND[input.kind],
        $recordKind: input.kind,
        $recordId: input.recordId,
      }) as HarnessActionEventReadRow[];
      const receiptRows = db.query(
        `
        select
          receipt.action_event_id,
          receipt.action_type,
          receipt.source_run_id,
          receipt.project_id,
          receipt.record_kind,
          receipt.record_id,
          receipt.record_sha256,
          receipt.created_at,
          event.action_type as event_action_type,
          event.status as event_status,
          event.request_json,
          event.result_json,
          event.created_at as event_created_at
        from evolution_action_receipts receipt
        join harness_action_events event on event.id = receipt.action_event_id
        where receipt.project_id = $projectId
          and receipt.record_kind = $recordKind
          and receipt.record_id = $recordId
        order by receipt.created_at desc, receipt.action_event_id desc
        limit 101
        `,
      ).all({
        $projectId: input.projectId,
        $recordKind: input.kind,
        $recordId: input.recordId,
      }) as EvolutionActionReceiptReadRow[];
      if (eventRows.length === 0 && receiptRows.length === 0) {
        throw new Error("evolution action audit receipt not found");
      }
      if (eventRows.length > 100 || receiptRows.length > 100) {
        throw new Error("more than 100 matching done action receipts");
      }

      const validatedEvents = new Map(
        eventRows.map((row) => [row.id, validateEvolutionAuditRow(db, row, input)]),
      );
      const receiptIds = new Set(receiptRows.map((row) => row.action_event_id));
      if (
        receiptRows.length !== eventRows.length
        || eventRows.some((row) => !receiptIds.has(row.id))
      ) {
        throw new Error("matching done action event is missing its immutable evolution receipt");
      }
      for (const receipt of receiptRows) {
        validateEvolutionReceiptRow(receipt, input, validatedEvents.get(receipt.action_event_id));
      }
      const receipts = receiptRows.map((row) => validatedEvents.get(row.action_event_id)!);
      const sourceRunId = receipts[0].sourceRunId;
      if (receipts.some((receipt) => receipt.sourceRunId !== sourceRunId)) {
        throw new Error("matching done action receipts disagree on sourceRunId");
      }
      return {
        ...receipts[0],
        receiptCount: receipts.length,
      };
    } catch (error) {
      throw new Error(
        `evolution action audit readback mismatch for ${input.kind} ${input.recordId}: ${(error as Error).message}`,
      );
    }
  });
}

function validateEvolutionAuditRow(
  db: HarnessDatabase,
  row: HarnessActionEventReadRow,
  input: {
    kind: EvolutionReadbackKind;
    projectId: string;
    recordId: string;
    recordSha256: string;
  },
): Omit<SafeEvolutionActionAudit, "receiptCount"> {
  const request = JSON.parse(row.request_json) as Record<string, unknown>;
  const result = JSON.parse(row.result_json) as Record<string, unknown>;
  const artifacts = result.artifacts;
  const matchingArtifacts = Array.isArray(artifacts)
    ? artifacts.filter((value) =>
      value !== null
      && typeof value === "object"
      && !Array.isArray(value)
      && (value as Record<string, unknown>).kind === ACTION_ARTIFACT_KIND_BY_KIND[input.kind]
    )
    : [];
  const artifact = matchingArtifacts.length === 1
    ? matchingArtifacts[0] as Record<string, unknown>
    : null;
  const requestKeys = Object.keys(request).sort();
  const expectedRequestKeys = ["entityKind", "recordId", "recordSha256", "runId", "type"];
  if (
    requestKeys.length !== expectedRequestKeys.length
    || requestKeys.some((key, index) => key !== expectedRequestKeys[index])
    || request.type !== ACTION_TYPE_BY_KIND[input.kind]
    || typeof request.runId !== "string"
    || request.entityKind !== input.kind
    || request.recordId !== input.recordId
    || request.recordSha256 !== input.recordSha256
    || result.status !== "done"
    || result.actionType !== ACTION_TYPE_BY_KIND[input.kind]
    || !artifact
    || artifact.entityKind !== input.kind
    || artifact.recordId !== input.recordId
    || artifact.projectId !== input.projectId
    || artifact.recordSha256 !== input.recordSha256
    || artifact.sourceRunId !== request.runId
    || artifact.externalEffectsApplied !== false
    || artifact.promotionApplied !== false
  ) {
    throw new Error("artifact fields do not match the immutable evolution record");
  }
  const sourceRun = db
    .query("select id, project_id from runs where id = $id")
    .get({ $id: artifact.sourceRunId }) as { id: string; project_id: string | null } | null;
  if (!sourceRun) {
    throw new Error(`evolution action audit source run not found: ${artifact.sourceRunId}`);
  }
  if (sourceRun.project_id !== input.projectId) {
    throw new Error(
      `evolution action audit source run project mismatch: ${sourceRun.id} belongs to ${sourceRun.project_id ?? "none"}`,
    );
  }
  return {
    id: row.id,
    actionType: row.action_type,
    status: "done",
    createdAt: row.created_at,
    sourceRunId: sourceRun.id,
    artifactKind: ACTION_ARTIFACT_KIND_BY_KIND[input.kind],
    entityKind: input.kind,
    projectId: input.projectId,
    recordId: input.recordId,
    recordSha256: input.recordSha256,
    replayed: artifact.replayed === true,
  };
}

function validateEvolutionReceiptRow(
  row: EvolutionActionReceiptReadRow,
  input: {
    kind: EvolutionReadbackKind;
    projectId: string;
    recordId: string;
    recordSha256: string;
  },
  event: Omit<SafeEvolutionActionAudit, "receiptCount"> | undefined,
): void {
  if (
    !event
    || row.action_event_id !== event.id
    || row.action_type !== ACTION_TYPE_BY_KIND[input.kind]
    || row.event_action_type !== ACTION_TYPE_BY_KIND[input.kind]
    || row.event_status !== "done"
    || row.source_run_id !== event.sourceRunId
    || row.project_id !== input.projectId
    || row.record_kind !== input.kind
    || row.record_id !== input.recordId
    || row.record_sha256 !== input.recordSha256
    || row.event_created_at !== event.createdAt
  ) {
    throw new Error("immutable evolution receipt fields do not match the action event and record");
  }
}
