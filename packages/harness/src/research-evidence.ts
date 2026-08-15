import { createHash } from "node:crypto";
import type { Harness } from "./harness";

export type ResearchEvidenceGrade = "A" | "B" | "C" | "D";

export interface ResearchEvidenceArtifactRef {
  artifactId: string;
  artifactIndex: number;
  sha256: string;
  evidenceGrade: ResearchEvidenceGrade;
}

export interface ResearchEvidenceLinkV1 {
  schemaVersion: 1;
  signalId: string;
  projectId: string;
  sourceRunId: string;
  sourceTaskId: string;
  sourceAttemptId: string;
  outputSha256: string;
  observedAt: string;
  linkedAt: string;
  expiresAt: string;
  eventRefs: string[];
  artifacts: ResearchEvidenceArtifactRef[];
  evaluationContractArtifactRef: ResearchEvidenceArtifactRef | null;
}

export function canonicalResearchEvidenceArtifactSha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value)), "utf8").digest("hex");
}

export function listResearchEvidenceLinks(
  harness: Harness,
  input: { projectId: string; includeExpired?: boolean; limit?: number },
): ResearchEvidenceLinkV1[] {
  const statuses = input.includeExpired ? undefined : ["active"] as const;
  return harness.listStrategySignals({
    projectId: input.projectId,
    statuses: statuses ? [...statuses] : undefined,
    limit: input.limit ?? 100,
  }).flatMap((signal) => {
    const link = researchEvidenceLinkFromSignal(signal.id, signal.projectId, signal.payload);
    return link ? [link] : [];
  }).filter((link) => input.includeExpired || Date.parse(link.expiresAt) > Date.now());
}

export function readResearchEvidenceArtifact(
  harness: Harness,
  input: { projectId: string; signalId: string; artifactId: string },
) {
  const signal = harness.getStrategySignal({ id: input.signalId });
  if (!signal || signal.projectId !== input.projectId) {
    throw new Error(`research evidence link is not visible to project ${input.projectId}`);
  }
  const link = researchEvidenceLinkFromSignal(signal.id, signal.projectId, signal.payload);
  if (!link) {
    throw new Error(`strategy signal ${input.signalId} is not a research evidence link`);
  }
  const ref = link.artifacts.find((artifact) => artifact.artifactId === input.artifactId);
  if (!ref) {
    throw new Error(`research artifact not found: ${input.artifactId}`);
  }
  const attempt = harness.getAttempt(link.sourceAttemptId);
  if (!attempt || attempt.status !== "done") {
    throw new Error(`research source attempt is not done: ${link.sourceAttemptId}`);
  }
  const artifacts = Array.isArray(attempt.output.artifacts) ? attempt.output.artifacts : [];
  const artifact = artifacts[ref.artifactIndex];
  if (artifactId(artifact) !== ref.artifactId) {
    throw new Error(`research artifact identity drift: ${ref.artifactId}`);
  }
  const actualSha256 = canonicalResearchEvidenceArtifactSha256(artifact);
  if (actualSha256 !== ref.sha256) {
    throw new Error(`research artifact hash drift: ${ref.artifactId}`);
  }
  return { link, ref, artifact };
}

export function parseResearchEvidenceLinkPayload(
  signalId: string,
  projectId: string | null,
  payload: Record<string, unknown>,
): ResearchEvidenceLinkV1 | null {
  return researchEvidenceLinkFromSignal(signalId, projectId, payload);
}

function researchEvidenceLinkFromSignal(
  signalId: string,
  projectId: string | null,
  payload: Record<string, unknown>,
): ResearchEvidenceLinkV1 | null {
  if (payload.kind !== "research-evidence-link" || !projectId) return null;
  const value = payload.link;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || record.signalId !== signalId || record.projectId !== projectId) return null;
  const artifacts = parseArtifactRefs(record.artifacts);
  const eventRefs = stringList(record.eventRefs);
  if (!artifacts || !eventRefs) return null;
  const evaluation = record.evaluationContractArtifactRef === null
    ? null
    : parseArtifactRef(record.evaluationContractArtifactRef);
  if (record.evaluationContractArtifactRef !== null && !evaluation) return null;
  const requiredStrings = [
    "sourceRunId",
    "sourceTaskId",
    "sourceAttemptId",
    "outputSha256",
    "observedAt",
    "linkedAt",
    "expiresAt",
  ] as const;
  if (requiredStrings.some((key) => typeof record[key] !== "string" || record[key] === "")) return null;
  return {
    schemaVersion: 1,
    signalId,
    projectId,
    sourceRunId: record.sourceRunId as string,
    sourceTaskId: record.sourceTaskId as string,
    sourceAttemptId: record.sourceAttemptId as string,
    outputSha256: record.outputSha256 as string,
    observedAt: record.observedAt as string,
    linkedAt: record.linkedAt as string,
    expiresAt: record.expiresAt as string,
    eventRefs,
    artifacts,
    evaluationContractArtifactRef: evaluation,
  };
}

function parseArtifactRefs(value: unknown): ResearchEvidenceArtifactRef[] | null {
  if (!Array.isArray(value)) return null;
  const parsed = value.map(parseArtifactRef);
  return parsed.every((item): item is ResearchEvidenceArtifactRef => item !== null) ? parsed : null;
}

function parseArtifactRef(value: unknown): ResearchEvidenceArtifactRef | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.artifactId !== "string"
    || !Number.isSafeInteger(record.artifactIndex)
    || (record.artifactIndex as number) < 0
    || typeof record.sha256 !== "string"
    || !/^[0-9a-f]{64}$/.test(record.sha256)
    || !isEvidenceGrade(record.evidenceGrade)) return null;
  return {
    artifactId: record.artifactId,
    artifactIndex: record.artifactIndex as number,
    sha256: record.sha256,
    evidenceGrade: record.evidenceGrade,
  };
}

function artifactId(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = (value as Record<string, unknown>).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function stringList(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0)
    ? value as string[]
    : null;
}

function isEvidenceGrade(value: unknown): value is ResearchEvidenceGrade {
  return value === "A" || value === "B" || value === "C" || value === "D";
}

function canonicalize(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalize(record[key])]));
}
