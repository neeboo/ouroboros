import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Harness,
  canonicalEvolutionRecordSha256,
  initDatabase,
  withDatabase,
  type EvolutionProfile,
  type HarnessVariant,
  type MatchedExperiment,
  type ProductionEpisode,
} from "../packages/harness/src";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);
const ZERO_SIDE_EFFECTS = {
  paidUsd: 0,
  realProviderCalls: 0,
  pancatWrites: 0,
  productionPublishes: 0,
  realAssetDeletes: 0,
  crossProjectMemoryReads: 0,
  crossProjectMemoryWrites: 0,
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function contentAddress<T extends Record<string, unknown>>(
  prefix: "profile" | "episode" | "variant" | "experiment",
  value: T,
): T & { id: string } {
  const digest = createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
  return { id: `${prefix}_${digest}`, ...value };
}

function evolutionProfile(projectId: string, surfaceIds = ["surface_spatial_policy"] as string[]): EvolutionProfile {
  return contentAddress("profile", {
    schemaVersion: 1,
    projectId,
    pack: { id: "pack_hodor_v1", version: 1, contentSha256: SHA_A },
    charter: { id: "charter_hodor_v1", version: 1, contentSha256: SHA_B },
    runtimeMaturity: "declared",
    allowedSurfaceIds: surfaceIds,
    registeredAt: "2026-08-09T00:00:00.000Z",
  }) as EvolutionProfile;
}

function productionEpisode(
  projectId: string,
  profileId: string,
  sourceRef: string,
  marker: string,
  snapshotOverrides: {
    inputSnapshotSha256?: string;
    outcomeSnapshotSha256?: string;
  } = {},
): ProductionEpisode {
  const inputSnapshotSha256 = snapshotOverrides.inputSnapshotSha256
    ?? createHash("sha256").update(`input:${marker}`).digest("hex");
  const outcomeSnapshotSha256 = snapshotOverrides.outcomeSnapshotSha256
    ?? createHash("sha256").update(`outcome:${marker}`).digest("hex");
  return contentAddress("episode", {
    schemaVersion: 1,
    projectId,
    profileId,
    observedAt: "2026-08-09T01:00:00.000Z",
    inputSnapshotSha256,
    outcomeSnapshotSha256,
    policyRef: "policy_hodor_spatial_v1",
    metrics: { falsePositiveRate: 0.1 },
    sideEffectCounters: ZERO_SIDE_EFFECTS,
    sourceRef,
    leakageGroupId: `leakage-group:${marker}`,
    evidenceRefs: [`evidence:episode:${marker}`],
    privacyReview: {
      status: "approved",
      policySha256: SHA_D,
      reviewerRef: "reviewer:privacy-test",
      dataClassification: "internal",
      retentionPolicyRef: "retention:ephemeral-test",
      inputSnapshotSha256,
      outcomeSnapshotSha256,
      evidenceRefs: [`evidence:privacy-review:${marker}`],
    },
  }) as ProductionEpisode;
}

function harnessVariant(
  projectId: string,
  profileId: string,
  role: "control" | "candidate",
  marker: string,
  mutationSurfaceIds = ["surface_spatial_policy"] as string[],
): HarnessVariant {
  return contentAddress("variant", {
    schemaVersion: 1,
    projectId,
    profileId,
    role,
    evolutionTargets: ["artifact", "harness"],
    contentSha256: createHash("sha256").update(`variant:${marker}`).digest("hex"),
    mutationSurfaceIds,
    changedPaths: [`policies/${marker}.json`],
    toolPolicySha256: SHA_C,
    createdFromEvidenceRefs: [`evidence:variant:${marker}`],
  }) as HarnessVariant;
}

function matchedExperiment(
  projectId: string,
  profileId: string,
  controlVariantId: string,
  candidateVariantId: string,
  splitEpisodeIds: { development: string[]; heldout: string[]; unrelated: string[] },
  overrides: Record<string, unknown> = {},
): MatchedExperiment {
  return contentAddress("experiment", {
    schemaVersion: 1,
    projectId,
    profileId,
    controlVariantId,
    candidateVariantId,
    developmentEpisodeRefs: splitEpisodeIds.development,
    heldoutEpisodeRefs: splitEpisodeIds.heldout,
    unrelatedEpisodeRefs: splitEpisodeIds.unrelated,
    corpusSnapshotSha256: SHA_D,
    equalBudget: {
      model: "fixture-replay-no-provider",
      reasoningEffort: "high",
      wallClockMs: 120_000,
      maxAttempts: 1,
      maxTokens: 20_000,
      toolPolicySha256: SHA_C,
      concurrency: 1,
    },
    primaryMetric: "spatial-risk false-positive rate",
    guardMetrics: ["blocking-safety regressions"],
    outcome: "pending",
    sideEffectCounters: ZERO_SIDE_EFFECTS,
    evidenceRefs: ["evidence:experiment:summary"],
    ...overrides,
  }) as MatchedExperiment;
}

describe("evolution runtime storage", () => {
  let dir: string;
  let harness: Harness;
  let projectId: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ouroboros-evolution-storage-"));
    harness = new Harness(join(dir, "ouroboros.db"));
    harness.init();
    projectId = harness.createProject({
      id: "project_hodor_reference",
      name: "Hodor",
      rootPath: join(dir, "hodor"),
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function recordCompleteGraph(targetHarness = harness, targetProjectId = projectId) {
    const profile = evolutionProfile(targetProjectId);
    const development = productionEpisode(
      targetProjectId,
      profile.id,
      "episode:hodor:development:001",
      "development",
    );
    const heldout = productionEpisode(
      targetProjectId,
      profile.id,
      "episode:hodor:heldout:001",
      "heldout",
    );
    const unrelated = productionEpisode(
      targetProjectId,
      profile.id,
      "episode:hodor:unrelated:001",
      "unrelated",
    );
    const control = harnessVariant(targetProjectId, profile.id, "control", "control");
    const candidate = harnessVariant(targetProjectId, profile.id, "candidate", "candidate");

    expect(targetHarness.recordEvolutionProfile(profile)).toEqual({ record: profile, reused: false });
    for (const episode of [development, heldout, unrelated]) {
      expect(targetHarness.recordProductionEpisode(episode)).toEqual({ record: episode, reused: false });
    }
    expect(targetHarness.recordHarnessVariant(control)).toEqual({ record: control, reused: false });
    expect(targetHarness.recordHarnessVariant(candidate)).toEqual({ record: candidate, reused: false });

    const experiment = matchedExperiment(
      targetProjectId,
      profile.id,
      control.id,
      candidate.id,
      {
        development: [development.id],
        heldout: [heldout.id],
        unrelated: [unrelated.id],
      },
    );
    expect(targetHarness.recordMatchedExperiment(experiment)).toEqual({ record: experiment, reused: false });
    return { profile, development, heldout, unrelated, control, candidate, experiment };
  }

  test("initializes a new database and round-trips all four immutable records", () => {
    const graph = recordCompleteGraph();

    expect(harness.getEvolutionProfile({ projectId, id: graph.profile.id })).toEqual(graph.profile);
    expect(harness.getProductionEpisode({ projectId, id: graph.development.id })).toEqual(graph.development);
    expect(harness.getHarnessVariant({ projectId, id: graph.control.id })).toEqual(graph.control);
    expect(harness.getMatchedExperiment({ projectId, id: graph.experiment.id })).toEqual(graph.experiment);
    expect(harness.recordEvolutionProfile(graph.profile)).toEqual({ record: graph.profile, reused: true });
    expect(harness.recordProductionEpisode(graph.development)).toEqual({
      record: graph.development,
      reused: true,
    });
    expect(harness.recordHarnessVariant(graph.control)).toEqual({ record: graph.control, reused: true });
    expect(harness.recordMatchedExperiment(graph.experiment)).toEqual({
      record: graph.experiment,
      reused: true,
    });

    withDatabase(harness.dbPath, (db) => {
      const tables = db
        .query(
          `select name from sqlite_master where type = 'table' and name in
           ('evolution_profiles','production_episodes','harness_variants','matched_experiments')
           order by name`,
        )
        .all() as Array<{ name: string }>;
      expect(tables.map((row) => row.name)).toEqual([
        "evolution_profiles",
        "harness_variants",
        "matched_experiments",
        "production_episodes",
      ]);
    });
  });

  test("the static new-database schema uses declared runtime profile columns", () => {
    const staticDbPath = join(dir, "static-schema.db");
    const db = new Database(staticDbPath);
    try {
      db.exec(readFileSync(join(import.meta.dir, "..", "packages", "harness", "schema.sql"), "utf8"));
      const columns = db.query("pragma table_info(evolution_profiles)").all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toContain("runtime_maturity");
      expect(columns.map((column) => column.name)).toContain("registered_at");
      expect(columns.map((column) => column.name)).not.toContain("maturity");
    } finally {
      db.close();
    }
  });

  test("migrates an old database without evolution tables and preserves existing rows", () => {
    const legacyDbPath = join(dir, "legacy.db");
    const legacy = new Harness(legacyDbPath);
    legacy.init();
    const legacyProjectId = legacy.createProject({
      id: "project_legacy",
      name: "Legacy",
      rootPath: join(dir, "legacy-project"),
      context: { preserved: true },
    });
    withDatabase(legacyDbPath, (db) => {
      db.exec(`
        drop table evolution_action_receipts;
        drop table matched_experiments;
        drop table harness_variants;
        drop table production_episodes;
        drop table evolution_profiles;
      `);
    });

    initDatabase(legacyDbPath);
    const migrated = new Harness(legacyDbPath);
    expect(migrated.getProject(legacyProjectId)).toMatchObject({
      id: legacyProjectId,
      context: { preserved: true },
    });
    const profile = evolutionProfile(legacyProjectId);
    expect(migrated.recordEvolutionProfile(profile)).toEqual({ record: profile, reused: false });
    withDatabase(legacyDbPath, (db) => {
      const profileColumns = db.query("pragma table_info(evolution_profiles)").all() as Array<{ name: string }>;
      expect(profileColumns.map((column) => column.name)).toEqual(
        expect.arrayContaining(["runtime_maturity", "registered_at"]),
      );
      expect(
        db.query(
          "select name from sqlite_master where type = 'table' and name = 'evolution_action_receipts'",
        ).get(),
      ).toEqual({ name: "evolution_action_receipts" });
    });
  });

  test("reuses exact sequential replays and rejects a different stored canonical record", () => {
    const profile = evolutionProfile(projectId);
    expect(harness.recordEvolutionProfile(profile)).toEqual({ record: profile, reused: false });
    expect(harness.recordEvolutionProfile(structuredClone(profile))).toEqual({ record: profile, reused: true });

    const conflictTarget = evolutionProfile(projectId, ["surface_conflict_target"]);
    const conflictingProfile = evolutionProfile(projectId, ["surface_other"]);
    withDatabase(harness.dbPath, (db) => {
      db.query(
        `insert into evolution_profiles
         (id, schema_version, project_id, runtime_maturity, registered_at, record_sha256, record_json)
         values ($id, 1, $projectId, $runtimeMaturity, $registeredAt, $recordSha256, $recordJson)`,
      ).run({
        $id: conflictTarget.id,
        $projectId: projectId,
        $runtimeMaturity: conflictTarget.runtimeMaturity,
        $registeredAt: conflictTarget.registeredAt,
        $recordSha256: conflictTarget.id.slice("profile_".length),
        $recordJson: JSON.stringify(conflictingProfile),
      });
    });
    expect(() => harness.recordEvolutionProfile(conflictTarget)).toThrow(/conflict|collision|different/i);
    withDatabase(harness.dbPath, (db) => {
      expect(
        (db.query("select count(*) as count from evolution_profiles").get() as { count: number }).count,
      ).toBe(2);
      expect(() =>
        db.query(
          `insert into evolution_profiles
           (id, schema_version, project_id, runtime_maturity, registered_at, record_sha256, record_json)
           values ($id, 1, $projectId, $runtimeMaturity, $registeredAt, $recordSha256, $recordJson)`,
        ).run({
          $id: `profile_${"f".repeat(64)}`,
          $projectId: projectId,
          $runtimeMaturity: profile.runtimeMaturity,
          $registeredAt: profile.registeredAt,
          $recordSha256: profile.id.slice("profile_".length),
          $recordJson: JSON.stringify(profile),
        }),
      ).toThrow(/unique/i);
    });
  });

  test("keeps WithDb writes inside the caller transaction", () => {
    const profile = evolutionProfile(projectId);
    expect(() =>
      harness.runInTransaction((db) => {
        harness.recordEvolutionProfileWithDb(db, profile);
        throw new Error("audit write failed");
      }),
    ).toThrow("audit write failed");
    expect(harness.getEvolutionProfile({ projectId, id: profile.id })).toBeNull();
  });

  test("links a successful evolution action event to its runtime record in the same transaction", () => {
    const runId = harness.createRun({ projectId, goal: "Activate evolution profile" });
    const profile = evolutionProfile(projectId);
    const recordSha256 = canonicalEvolutionRecordSha256(profile);
    const eventId = "action_evolution_profile_receipt";

    harness.runInTransaction((db) => {
      harness.recordEvolutionProfileWithDb(db, profile);
      harness.recordHarnessActionEventWithDb(db, {
        id: eventId,
        actionType: "registerEvolutionProfile",
        status: "done",
        request: {
          type: "registerEvolutionProfile",
          runId,
          entityKind: "profile",
          recordId: profile.id,
          recordSha256,
        },
        result: {
          actionType: "registerEvolutionProfile",
          status: "done",
          summary: "Recorded profile.",
          checks: [],
          artifacts: [{
            kind: "evolution_profile",
            entityKind: "profile",
            recordId: profile.id,
            recordSha256,
            projectId,
            sourceRunId: runId,
            replayed: false,
            externalEffectsApplied: false,
            promotionApplied: false,
          }],
          problems: [],
        },
      });
    });

    withDatabase(harness.dbPath, (db) => {
      const receipt = db
        .query("select * from evolution_action_receipts where action_event_id = $eventId")
        .get({ $eventId: eventId }) as Record<string, unknown> | null;
      expect(receipt).toMatchObject({
        action_event_id: eventId,
        action_type: "registerEvolutionProfile",
        source_run_id: runId,
        project_id: projectId,
        record_kind: "profile",
        record_id: profile.id,
        record_sha256: recordSha256,
        profile_id: profile.id,
        episode_id: null,
        variant_id: null,
        experiment_id: null,
      });
      expect(() =>
        db.query("update evolution_action_receipts set record_sha256 = record_sha256 where action_event_id = $eventId")
          .run({ $eventId: eventId }),
      ).toThrow(/immutable/i);
      expect(() =>
        db.query("update harness_action_events set request_json = '{}' where id = $eventId")
          .run({ $eventId: eventId }),
      ).toThrow(/immutable/i);
      expect(() =>
        db.query("delete from harness_action_events where id = $eventId").run({ $eventId: eventId }),
      ).toThrow(/immutable|foreign key|constraint/i);
    });

    expect(() =>
      harness.runInTransaction((db) => {
        harness.recordHarnessActionEventWithDb(db, {
          id: "action_evolution_profile_forged",
          actionType: "registerEvolutionProfile",
          status: "done",
          request: {
            type: "registerEvolutionProfile",
            runId,
            entityKind: "profile",
            recordId: profile.id,
            recordSha256,
          },
          result: {
            actionType: "registerEvolutionProfile",
            status: "done",
            summary: "Forged result.",
            checks: [],
            artifacts: [{
              kind: "evolution_profile",
              entityKind: "profile",
              recordId: profile.id,
              recordSha256: "f".repeat(64),
              projectId,
              sourceRunId: runId,
              replayed: false,
              externalEffectsApplied: false,
              promotionApplied: false,
            }],
            problems: [],
          },
        });
      }),
    ).toThrow(/receipt|artifact|hash|mismatch/i);
    expect(harness.getHarnessActionEvent({ id: "action_evolution_profile_forged" })).toBeNull();
  });

  test("rejects missing and foreign projects or profiles", () => {
    const missingProjectProfile = evolutionProfile("project_missing");
    expect(() => harness.recordEvolutionProfile(missingProjectProfile)).toThrow(/project.*not found/i);

    const profile = evolutionProfile(projectId);
    harness.recordEvolutionProfile(profile);
    const foreignProjectId = harness.createProject({
      id: "project_foreign",
      name: "Foreign",
      rootPath: join(dir, "foreign"),
    });
    const missingProfileEpisode = productionEpisode(
      projectId,
      `profile_${"1".repeat(64)}`,
      "episode:missing-profile",
      "missing-profile",
    );
    expect(() => harness.recordProductionEpisode(missingProfileEpisode)).toThrow(/profile.*not found/i);

    const foreignEpisode = productionEpisode(
      foreignProjectId,
      profile.id,
      "episode:foreign-project",
      "foreign-project",
    );
    expect(() => harness.recordProductionEpisode(foreignEpisode)).toThrow(/profile.*not found|same project/i);
  });

  test("rejects variant surfaces outside the profile allowlist", () => {
    const profile = evolutionProfile(projectId);
    harness.recordEvolutionProfile(profile);
    const variant = harnessVariant(projectId, profile.id, "candidate", "outside", ["surface_forbidden"]);
    expect(() => harness.recordHarnessVariant(variant)).toThrow(/surface.*allowed|allowlist/i);
  });

  test("requires control and candidate variants with exact roles and scope", () => {
    const profile = evolutionProfile(projectId);
    harness.recordEvolutionProfile(profile);
    const episodes = [
      productionEpisode(projectId, profile.id, "episode:development", "dev-role"),
      productionEpisode(projectId, profile.id, "episode:heldout", "hold-role"),
      productionEpisode(projectId, profile.id, "episode:unrelated", "unrelated-role"),
    ];
    episodes.forEach((episode) => harness.recordProductionEpisode(episode));
    const firstCandidate = harnessVariant(projectId, profile.id, "candidate", "candidate-one");
    const secondCandidate = harnessVariant(projectId, profile.id, "candidate", "candidate-two");
    harness.recordHarnessVariant(firstCandidate);
    harness.recordHarnessVariant(secondCandidate);

    const experiment = matchedExperiment(projectId, profile.id, firstCandidate.id, secondCandidate.id, {
      development: [episodes[0].id],
      heldout: [episodes[1].id],
      unrelated: [episodes[2].id],
    });
    expect(() => harness.recordMatchedExperiment(experiment)).toThrow(/control.*role/i);
  });

  test("accepts only pending immutable experiments", () => {
    const graph = recordCompleteGraph();
    const completed = matchedExperiment(
      projectId,
      graph.profile.id,
      graph.control.id,
      graph.candidate.id,
      {
        development: [graph.development.id],
        heldout: [graph.heldout.id],
        unrelated: [graph.unrelated.id],
      },
      { outcome: "candidate_wins" },
    );
    expect(() => harness.recordMatchedExperiment(completed)).toThrow(/pending outcome/i);
  });

  test("rejects missing, overlapping, and wrongly scoped experiment episodes", () => {
    const profile = evolutionProfile(projectId);
    harness.recordEvolutionProfile(profile);
    const development = productionEpisode(projectId, profile.id, "episode:development", "dev-scope");
    const heldout = productionEpisode(projectId, profile.id, "episode:heldout", "hold-scope");
    const unrelated = productionEpisode(projectId, profile.id, "episode:unrelated", "unrelated-scope");
    [development, heldout, unrelated].forEach((episode) => harness.recordProductionEpisode(episode));
    const control = harnessVariant(projectId, profile.id, "control", "control-scope");
    const candidate = harnessVariant(projectId, profile.id, "candidate", "candidate-scope");
    harness.recordHarnessVariant(control);
    harness.recordHarnessVariant(candidate);

    const missing = matchedExperiment(projectId, profile.id, control.id, candidate.id, {
      development: [`episode_${"1".repeat(64)}`],
      heldout: [heldout.id],
      unrelated: [unrelated.id],
    });
    expect(() => harness.recordMatchedExperiment(missing)).toThrow(/episode.*not found/i);

    const overlap = matchedExperiment(projectId, profile.id, control.id, candidate.id, {
      development: [development.id],
      heldout: [development.id],
      unrelated: [unrelated.id],
    });
    expect(() => harness.recordMatchedExperiment(overlap)).toThrow(/overlap|unique|split/i);

    const otherProfile = evolutionProfile(projectId, ["surface_spatial_policy", "surface_other"]);
    harness.recordEvolutionProfile(otherProfile);
    const wrongProfileEpisode = productionEpisode(
      projectId,
      otherProfile.id,
      "episode:wrong-profile",
      "wrong-profile",
    );
    harness.recordProductionEpisode(wrongProfileEpisode);
    const wrongScope = matchedExperiment(projectId, profile.id, control.id, candidate.id, {
      development: [wrongProfileEpisode.id],
      heldout: [heldout.id],
      unrelated: [unrelated.id],
    });
    expect(() => harness.recordMatchedExperiment(wrongScope)).toThrow(/episode.*not found|same profile/i);
  });

  test("rejects every snapshot hash collision that crosses experiment splits", () => {
    const profile = evolutionProfile(projectId);
    harness.recordEvolutionProfile(profile);
    const control = harnessVariant(projectId, profile.id, "control", "snapshot-control");
    const candidate = harnessVariant(projectId, profile.id, "candidate", "snapshot-candidate");
    harness.recordHarnessVariant(control);
    harness.recordHarnessVariant(candidate);

    const collisionSha256 = "e".repeat(64);
    const cases = [
      ["input", "input"],
      ["input", "outcome"],
      ["outcome", "input"],
      ["outcome", "outcome"],
    ] as const;
    for (const [developmentField, heldoutField] of cases) {
      const marker = `${developmentField}-to-${heldoutField}`;
      const development = productionEpisode(
        projectId,
        profile.id,
        `episode:development:${marker}`,
        `snapshot-development-${marker}`,
        developmentField === "input"
          ? { inputSnapshotSha256: collisionSha256 }
          : { outcomeSnapshotSha256: collisionSha256 },
      );
      const heldout = productionEpisode(
        projectId,
        profile.id,
        `episode:heldout:${marker}`,
        `snapshot-heldout-${marker}`,
        heldoutField === "input"
          ? { inputSnapshotSha256: collisionSha256 }
          : { outcomeSnapshotSha256: collisionSha256 },
      );
      const unrelated = productionEpisode(
        projectId,
        profile.id,
        `episode:unrelated:${marker}`,
        `snapshot-unrelated-${marker}`,
      );
      [development, heldout, unrelated].forEach((episode) =>
        harness.recordProductionEpisode(episode),
      );
      const experiment = matchedExperiment(projectId, profile.id, control.id, candidate.id, {
        development: [development.id],
        heldout: [heldout.id],
        unrelated: [unrelated.id],
      });

      expect(() => harness.recordMatchedExperiment(experiment)).toThrow(/snapshot.*split|split.*snapshot/i);
    }
  });

  test("supports deterministic readback and scoped list filtering", () => {
    const graph = recordCompleteGraph();
    const secondProjectId = harness.createProject({
      id: "project_hodor_second",
      name: "Hodor second",
      rootPath: join(dir, "hodor-second"),
    });
    const second = recordCompleteGraph(harness, secondProjectId);

    expect(harness.getEvolutionProfile({ projectId, id: "profile_missing" })).toBeNull();
    expect(harness.getProductionEpisode({ projectId, id: "episode_missing" })).toBeNull();
    expect(harness.getHarnessVariant({ projectId, id: "variant_missing" })).toBeNull();
    expect(harness.getMatchedExperiment({ projectId, id: "experiment_missing" })).toBeNull();
    expect(harness.getEvolutionProfile({ projectId: secondProjectId, id: graph.profile.id })).toBeNull();
    expect(harness.listEvolutionProfiles({ projectId })).toEqual([graph.profile]);
    expect(harness.listProductionEpisodes({ projectId, profileId: graph.profile.id })).toEqual(
      expect.arrayContaining([graph.development, graph.heldout, graph.unrelated]),
    );
    expect(harness.listHarnessVariants({
      projectId,
      profileId: graph.profile.id,
      role: "candidate",
    })).toEqual([graph.candidate]);
    expect(harness.listMatchedExperiments({ projectId, profileId: graph.profile.id })).toEqual([
      graph.experiment,
    ]);
    expect(harness.listEvolutionProfiles({ projectId: secondProjectId })).toEqual([second.profile]);
  });

  test("exposes no mutation or deletion API for immutable runtime records", () => {
    const graph = recordCompleteGraph();
    for (const method of [
      "updateEvolutionProfile",
      "deleteEvolutionProfile",
      "updateProductionEpisode",
      "deleteProductionEpisode",
      "updateHarnessVariant",
      "deleteHarnessVariant",
      "updateMatchedExperiment",
      "deleteMatchedExperiment",
      "recordPromotionReceipt",
    ]) {
      expect(typeof (harness as unknown as Record<string, unknown>)[method]).toBe("undefined");
    }
    withDatabase(harness.dbPath, (db) => {
      for (const [table, id] of [
        ["evolution_profiles", graph.profile.id],
        ["production_episodes", graph.development.id],
        ["harness_variants", graph.control.id],
        ["matched_experiments", graph.experiment.id],
      ]) {
        expect(() => db.query(`update ${table} set record_json = record_json where id = $id`).run({ $id: id }))
          .toThrow(/immutable/i);
        expect(() => db.query(`delete from ${table} where id = $id`).run({ $id: id }))
          .toThrow(/immutable/i);
      }
    });
  });
});
