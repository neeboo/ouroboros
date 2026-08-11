import { describe, expect, test } from "bun:test";
import {
  canonicalHarnessRevisionContentSha256,
  HARNESS_REVISION_LIMITS,
  parseHarnessRevisionV1,
  type HarnessRevisionComponentKind,
  type HarnessRevisionV1,
} from "../packages/harness/src";

const PROJECT_ID = "project_continual_harness";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);
const SHA_E = "e".repeat(64);
const COMPONENT_ORDER: HarnessRevisionComponentKind[] = [
  "prompt",
  "knowledge",
  "skills",
  "tools",
  "agent-policy",
];

function revisionBody(): Omit<HarnessRevisionV1, "contentSha256"> {
  return {
    schemaVersion: 1,
    projectId: PROJECT_ID,
    version: 2,
    parentSha256: SHA_A,
    variant: {
      id: `variant_${SHA_B}`,
      recordSha256: SHA_B,
      contentSha256: SHA_C,
    },
    components: [
      { kind: "tools", ref: "repo:orbs/tools-v2.json", sha256: SHA_D },
      { kind: "prompt", ref: "repo:prompts/continual-v2.md", sha256: SHA_A },
      { kind: "agent-policy", ref: "content:agent-policy-v2", sha256: SHA_E },
      { kind: "skills", ref: "mcp://orbs/skills/v2", sha256: SHA_C },
      { kind: "knowledge", ref: "mcp://project/knowledge/v2", sha256: SHA_B },
    ],
    evidenceRefs: ["attempt:verified-harness-v2", "action:activate-harness-v2"],
  };
}

function validRevision(): HarnessRevisionV1 {
  const body = revisionBody();
  return {
    ...body,
    contentSha256: canonicalHarnessRevisionContentSha256(body),
  };
}

describe("HarnessRevisionV1", () => {
  test("normalizes exactly five components into canonical order and verifies the body hash", () => {
    const input = validRevision();
    const parsed = parseHarnessRevisionV1(input, PROJECT_ID);
    const expectedComponents = COMPONENT_ORDER.map((kind) =>
      input.components.find((component) => component.kind === kind)!,
    ) as typeof parsed.components;

    expect(parsed).toEqual({
      ...input,
      components: expectedComponents,
    });
    expect(parsed.components.map((component) => component.kind)).toEqual(COMPONENT_ORDER);
    expect(parsed.contentSha256).toBe(canonicalHarnessRevisionContentSha256(parsed));
  });

  test("computes the same content hash from differently ordered component inputs", () => {
    const body = revisionBody();
    const reversed = { ...body, components: [...body.components].reverse() };

    expect(canonicalHarnessRevisionContentSha256(reversed)).toBe(
      canonicalHarnessRevisionContentSha256(body),
    );
  });

  test.each(COMPONENT_ORDER)("rejects a revision missing the %s component", (kind) => {
    const revision = validRevision();
    revision.components = revision.components.filter((component) => component.kind !== kind);

    expect(() => parseHarnessRevisionV1(revision, PROJECT_ID)).toThrow(/components|exactly|missing/i);
  });

  test("rejects duplicate and unknown component kinds", () => {
    const duplicate = validRevision();
    duplicate.components[4] = { ...duplicate.components[0]! };
    expect(() => parseHarnessRevisionV1(duplicate, PROJECT_ID)).toThrow(/duplicate|kind/i);

    const unknown = validRevision() as unknown as Record<string, unknown> & {
      components: Array<Record<string, unknown>>;
    };
    unknown.components[0] = { ...unknown.components[0], kind: "memory" };
    expect(() => parseHarnessRevisionV1(unknown, PROJECT_ID)).toThrow(/kind|memory/i);
  });

  test("rejects a project mismatch and invalid version lineage", () => {
    expect(() => parseHarnessRevisionV1(validRevision(), "project_other")).toThrow(/projectId/i);

    for (const patch of [
      { version: 0 },
      { version: 1, parentSha256: SHA_A },
      { version: 2, parentSha256: null },
      { version: 1.5 },
    ]) {
      expect(() => parseHarnessRevisionV1({ ...validRevision(), ...patch }, PROJECT_ID)).toThrow(
        /version|parentSha256/i,
      );
    }
  });

  test("rejects invalid SHA-256 fields and a mismatched content digest", () => {
    const cases: Array<(revision: ReturnType<typeof validRevision>) => void> = [
      (revision) => { revision.parentSha256 = "BAD"; },
      (revision) => { revision.variant.recordSha256 = "BAD"; },
      (revision) => { revision.variant.contentSha256 = "BAD"; },
      (revision) => { revision.components[0]!.sha256 = "BAD"; },
    ];
    for (const mutate of cases) {
      const revision = validRevision();
      mutate(revision);
      expect(() => parseHarnessRevisionV1(revision, PROJECT_ID)).toThrow(/sha256/i);
    }

    const mismatched = validRevision();
    mismatched.contentSha256 = SHA_E;
    expect(() => parseHarnessRevisionV1(mismatched, PROJECT_ID)).toThrow(/contentSha256|match/i);
  });

  test("rejects unsafe refs, invalid variant ids, and duplicate evidence refs", () => {
    const unsafeComponent = validRevision();
    unsafeComponent.components[0]!.ref = "../private/token";
    expect(() => parseHarnessRevisionV1(unsafeComponent, PROJECT_ID)).toThrow(/ref/i);

    const invalidVariant = validRevision();
    invalidVariant.variant.id = "variant_latest";
    expect(() => parseHarnessRevisionV1(invalidVariant, PROJECT_ID)).toThrow(/variant.*id/i);

    const duplicateEvidence = validRevision();
    duplicateEvidence.evidenceRefs = ["attempt:same", "attempt:same"];
    expect(() => parseHarnessRevisionV1(duplicateEvidence, PROJECT_ID)).toThrow(/evidenceRefs|duplicate/i);
  });

  test.each([
    "https://alice:hunter2@example.com/harness.json",
    "mcp://user:plainpass@orbs/skills/v2",
  ])("rejects URI userinfo credentials in refs: %s", (ref) => {
    const revision = validRevision();
    revision.components[0]!.ref = ref;

    expect(() => parseHarnessRevisionV1(revision, PROJECT_ID)).toThrow(/userinfo|credential|ref/i);
  });

  test("allows @ inside a URI path segment when the authority has no userinfo", () => {
    const revision = validRevision();
    revision.components[0]!.ref = "mcp://orbs/skills/@scope/v2";
    revision.contentSha256 = canonicalHarnessRevisionContentSha256(revision);

    expect(parseHarnessRevisionV1(revision, PROJECT_ID).components[3]).toMatchObject({
      kind: "tools",
      ref: "mcp://orbs/skills/@scope/v2",
    });
  });

  test("enforces explicit ref and evidence-ref count limits", () => {
    const atRefLimit = validRevision();
    atRefLimit.components[0]!.ref = `content:${"a".repeat(
      HARNESS_REVISION_LIMITS.maxRefLength - "content:".length,
    )}`;
    atRefLimit.contentSha256 = canonicalHarnessRevisionContentSha256(atRefLimit);
    expect(parseHarnessRevisionV1(atRefLimit, PROJECT_ID).components[3]!.ref).toHaveLength(
      HARNESS_REVISION_LIMITS.maxRefLength,
    );

    const overRefLimit = validRevision();
    overRefLimit.components[0]!.ref = `content:${"a".repeat(
      HARNESS_REVISION_LIMITS.maxRefLength + 1 - "content:".length,
    )}`;
    expect(() => parseHarnessRevisionV1(overRefLimit, PROJECT_ID)).toThrow(/ref/i);

    const atEvidenceLimit = validRevision();
    atEvidenceLimit.evidenceRefs = Array.from(
      { length: HARNESS_REVISION_LIMITS.maxEvidenceRefs },
      (_, index) => `attempt:evidence-${index}`,
    );
    atEvidenceLimit.contentSha256 = canonicalHarnessRevisionContentSha256(atEvidenceLimit);
    expect(parseHarnessRevisionV1(atEvidenceLimit, PROJECT_ID).evidenceRefs).toHaveLength(
      HARNESS_REVISION_LIMITS.maxEvidenceRefs,
    );

    const overEvidenceLimit = validRevision();
    overEvidenceLimit.evidenceRefs = Array.from(
      { length: HARNESS_REVISION_LIMITS.maxEvidenceRefs + 1 },
      (_, index) => `attempt:evidence-${index}`,
    );
    expect(() => parseHarnessRevisionV1(overEvidenceLimit, PROJECT_ID)).toThrow(/at most|evidenceRefs/i);
  });

  test("rejects unknown fields at every contract level", () => {
    const outer = { ...validRevision(), surprise: true };
    expect(() => parseHarnessRevisionV1(outer, PROJECT_ID)).toThrow(/unknown field|surprise/i);

    const variant = validRevision() as ReturnType<typeof validRevision> & {
      variant: ReturnType<typeof validRevision>["variant"] & { surprise?: boolean };
    };
    variant.variant.surprise = true;
    expect(() => parseHarnessRevisionV1(variant, PROJECT_ID)).toThrow(/unknown field|surprise/i);

    const component = validRevision() as ReturnType<typeof validRevision> & {
      components: Array<ReturnType<typeof validRevision>["components"][number] & { surprise?: boolean }>;
    };
    component.components[0]!.surprise = true;
    expect(() => parseHarnessRevisionV1(component, PROJECT_ID)).toThrow(/unknown field|surprise/i);
  });
});
