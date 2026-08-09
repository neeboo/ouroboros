import {
  canonicalEvolutionRecordSha256,
  Harness,
  withReadOnlyDatabase,
} from "@ouroboros/harness";
import type {
  EvolutionProfile,
  HarnessActionEvent,
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
  profile: "activateEvolutionProfile",
  episode: "recordProductionEpisode",
  variant: "registerHarnessVariant",
  experiment: "freezeMatchedExperiment",
};

const ACTION_REQUEST_RECORD_KEY_BY_KIND: Record<EvolutionReadbackKind, string> = {
  profile: "profile",
  episode: "episode",
  variant: "variant",
  experiment: "experiment",
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
  return {
    kind: input.kind,
    projectId: input.projectId,
    id: record.id,
    recordSha256,
    record,
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
    records: records.map((record) => ({
      id: record.id,
      recordSha256: canonicalEvolutionRecordSha256(record),
      record,
    })),
  };
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
}): HarnessActionEvent | null {
  return withReadOnlyDatabase(input.dbPath, (db) => {
    const requestRecordKey = ACTION_REQUEST_RECORD_KEY_BY_KIND[input.kind];
    const row = db.query(
      `
      select id, action_type, status, request_json, result_json, created_at
      from harness_action_events
      where action_type = $actionType
        and status = 'done'
        and json_extract(request_json, '$.${requestRecordKey}.id') = $recordId
        and json_extract(request_json, '$.${requestRecordKey}.projectId') = $projectId
      order by rowid desc
      limit 1
      `,
    ).get({
      $actionType: ACTION_TYPE_BY_KIND[input.kind],
      $recordId: input.recordId,
      $projectId: input.projectId,
    }) as HarnessActionEventReadRow | null;
    if (!row) {
      return null;
    }
    try {
      const event: HarnessActionEvent = {
        id: row.id,
        actionType: row.action_type,
        status: row.status,
        request: JSON.parse(row.request_json) as Record<string, unknown>,
        result: JSON.parse(row.result_json) as Record<string, unknown>,
        createdAt: row.created_at,
      };
      const artifacts = event.result.artifacts;
      const artifact = Array.isArray(artifacts) ? artifacts[0] : null;
      if (
        !artifact
        || typeof artifact !== "object"
        || Array.isArray(artifact)
        || artifact.kind !== ACTION_ARTIFACT_KIND_BY_KIND[input.kind]
        || artifact.entityKind !== input.kind
        || artifact.recordId !== input.recordId
        || artifact.projectId !== input.projectId
        || artifact.recordSha256 !== input.recordSha256
      ) {
        throw new Error("artifact fields do not match the immutable evolution record");
      }
      return event;
    } catch (error) {
      throw new Error(
        `evolution action audit readback mismatch for ${input.kind} ${input.recordId}: ${(error as Error).message}`,
      );
    }
  });
}
