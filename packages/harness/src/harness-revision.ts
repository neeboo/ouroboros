import { createHash } from "node:crypto";
import type {
  HarnessRevisionComponentKind,
  HarnessRevisionComponentV1,
  HarnessRevisionV1,
} from "./types";

export const HARNESS_REVISION_COMPONENT_ORDER = Object.freeze([
  "prompt",
  "knowledge",
  "skills",
  "tools",
  "agent-policy",
] as const satisfies readonly HarnessRevisionComponentKind[]);

export const HARNESS_REVISION_LIMITS = Object.freeze({
  maxRefLength: 512,
  maxEvidenceRefs: 200,
});

const COMPONENT_KIND_SET = new Set<HarnessRevisionComponentKind>(HARNESS_REVISION_COMPONENT_ORDER);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const REF_PATTERN = /^[a-z][a-z0-9+.-]*:(?:\/\/)?[A-Za-z0-9][A-Za-z0-9._~:/@+-]*$/;
const SENSITIVE_REF_PATTERN = /credential|authorization|bearer|token|secret|password|api[-_.]?key/i;
const GLOB_PATTERN = /[*?\[\]{}!]/;

type HarnessRevisionBodyV1 = Omit<HarnessRevisionV1, "contentSha256">;

export function parseHarnessRevisionV1(
  value: unknown,
  expectedProjectId: string,
  label = "harnessRevision",
): HarnessRevisionV1 {
  const record = strictObject(
    value,
    [
      "schemaVersion",
      "projectId",
      "version",
      "parentSha256",
      "variant",
      "components",
      "evidenceRefs",
      "contentSha256",
    ],
    label,
  );
  const body = parseHarnessRevisionBody(record, expectedProjectId, label);
  const contentSha256 = requireSha256(record.contentSha256, `${label}.contentSha256`);
  const expectedContentSha256 = hashHarnessRevisionBody(body);
  if (contentSha256 !== expectedContentSha256) {
    throw new Error(`${label}.contentSha256 must match the canonical revision body ${expectedContentSha256}`);
  }
  return { ...body, contentSha256 };
}

export function canonicalHarnessRevisionContentSha256(
  value: unknown,
  expectedProjectId?: string,
  label = "harnessRevision",
): string {
  const record = strictObject(
    value,
    [
      "schemaVersion",
      "projectId",
      "version",
      "parentSha256",
      "variant",
      "components",
      "evidenceRefs",
      "contentSha256",
    ],
    label,
  );
  const projectId = expectedProjectId ?? requireProjectId(record.projectId, `${label}.projectId`);
  return hashHarnessRevisionBody(parseHarnessRevisionBody(record, projectId, label));
}

function parseHarnessRevisionBody(
  record: Record<string, unknown>,
  expectedProjectId: string,
  label: string,
): HarnessRevisionBodyV1 {
  if (record.schemaVersion !== 1) {
    throw new Error(`${label}.schemaVersion must be 1`);
  }
  const expected = requireProjectId(expectedProjectId, `${label} expected projectId`);
  const projectId = requireProjectId(record.projectId, `${label}.projectId`);
  if (projectId !== expected) {
    throw new Error(`${label}.projectId must equal expected projectId ${expected}`);
  }
  const version = requirePositiveInteger(record.version, `${label}.version`);
  const parentSha256 = record.parentSha256 === null
    ? null
    : requireSha256(record.parentSha256, `${label}.parentSha256`);
  if (version === 1 && parentSha256 !== null) {
    throw new Error(`${label}.parentSha256 must be null for version 1`);
  }
  if (version > 1 && parentSha256 === null) {
    throw new Error(`${label}.parentSha256 must be a SHA-256 digest after version 1`);
  }
  return {
    schemaVersion: 1,
    projectId,
    version,
    parentSha256,
    variant: parseVariantRef(record.variant, `${label}.variant`),
    components: parseComponents(record.components, `${label}.components`),
    evidenceRefs: parseEvidenceRefs(record.evidenceRefs, `${label}.evidenceRefs`),
  };
}

function parseVariantRef(value: unknown, label: string): HarnessRevisionV1["variant"] {
  const record = strictObject(value, ["id", "recordSha256", "contentSha256"], label);
  const recordSha256 = requireSha256(record.recordSha256, `${label}.recordSha256`);
  const id = requireString(record.id, `${label}.id`);
  if (id !== `variant_${recordSha256}`) {
    throw new Error(`${label}.id must equal variant_<recordSha256>`);
  }
  return {
    id,
    recordSha256,
    contentSha256: requireSha256(record.contentSha256, `${label}.contentSha256`),
  };
}

function parseComponents(value: unknown, label: string): HarnessRevisionComponentV1[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  if (value.length !== HARNESS_REVISION_COMPONENT_ORDER.length) {
    throw new Error(`${label} must contain exactly five components`);
  }
  const byKind = new Map<HarnessRevisionComponentKind, HarnessRevisionComponentV1>();
  value.forEach((component, index) => {
    const record = strictObject(component, ["kind", "ref", "sha256"], `${label}[${index}]`);
    const kind = requireComponentKind(record.kind, `${label}[${index}].kind`);
    if (byKind.has(kind)) {
      throw new Error(`${label} contains duplicate component kind ${kind}`);
    }
    byKind.set(kind, {
      kind,
      ref: requireRef(record.ref, `${label}[${index}].ref`),
      sha256: requireSha256(record.sha256, `${label}[${index}].sha256`),
    });
  });
  return HARNESS_REVISION_COMPONENT_ORDER.map((kind) => {
    const component = byKind.get(kind);
    if (!component) {
      throw new Error(`${label} is missing component kind ${kind}`);
    }
    return component;
  });
}

function parseEvidenceRefs(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }
  if (value.length > HARNESS_REVISION_LIMITS.maxEvidenceRefs) {
    throw new Error(`${label} must contain at most ${HARNESS_REVISION_LIMITS.maxEvidenceRefs} refs`);
  }
  const refs = value.map((ref, index) => requireRef(ref, `${label}[${index}]`));
  if (new Set(refs).size !== refs.length) {
    throw new Error(`${label} must not contain duplicate refs`);
  }
  return refs;
}

function requireComponentKind(value: unknown, label: string): HarnessRevisionComponentKind {
  if (typeof value !== "string" || !COMPONENT_KIND_SET.has(value as HarnessRevisionComponentKind)) {
    throw new Error(`${label} must be prompt, knowledge, skills, tools, or agent-policy`);
  }
  return value as HarnessRevisionComponentKind;
}

function requireProjectId(value: unknown, label: string): string {
  const projectId = requireString(value, label);
  if (!PROJECT_ID_PATTERN.test(projectId) || SENSITIVE_REF_PATTERN.test(projectId)) {
    throw new Error(`${label} must be a safe project ID`);
  }
  return projectId;
}

function requireRef(value: unknown, label: string): string {
  const ref = requireString(value, label);
  if (uriAuthorityContainsUserinfo(ref)) {
    throw new Error(`${label} must not contain URI userinfo credentials`);
  }
  if (
    ref.length > HARNESS_REVISION_LIMITS.maxRefLength
    || !REF_PATTERN.test(ref)
    || SENSITIVE_REF_PATTERN.test(ref)
    || GLOB_PATTERN.test(ref)
    || ref.split(/[/:]/).includes("..")
  ) {
    throw new Error(`${label} must be a safe immutable ref`);
  }
  return ref;
}

function uriAuthorityContainsUserinfo(ref: string): boolean {
  const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(ref)?.[1];
  return authority?.includes("@") ?? false;
}

function requireSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new Error(`${label} must be a non-empty trimmed string`);
  }
  return value;
}

function strictObject(
  value: unknown,
  allowedKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(record).find((key) => !allowed.has(key));
  if (unknown) {
    throw new Error(`${label} contains unknown field ${unknown}`);
  }
  return record;
}

function hashHarnessRevisionBody(body: HarnessRevisionBodyV1): string {
  return createHash("sha256").update(JSON.stringify(body), "utf8").digest("hex");
}
