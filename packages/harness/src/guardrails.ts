import type { Lesson } from "./types";

export interface GuardrailProposal extends Record<string, unknown> {
  id: string;
  summary: string;
  count: number;
  sourceLessonIds: string[];
  sourceAttemptIds: string[];
  roles: string[];
  source: "lesson";
  active: false;
  accepted: boolean;
}

export interface AcceptedGuardrail extends Record<string, unknown> {
  id: string;
  active: true;
  accepted: true;
  acceptedBy: string;
  acceptedAt: string;
}

export function proposeGuardrailsFromLessons(input: {
  lessons: Lesson[];
  existingProposals?: unknown;
  minCount?: number;
}) {
  const minCount = input.minCount ?? 2;
  const groups = repeatedLessonProposalGroups(input.lessons, minCount);
  const existingProposals = guardrailProposalArray(input.existingProposals);
  const existingById = new Map(existingProposals.map((proposal) => [proposal.id, proposal]));
  const proposals = groups.map((group) => {
    const existing = existingById.get(group.id);
    return {
      ...existing,
      id: group.id,
      summary: group.summary,
      count: group.count,
      sourceLessonIds: group.sourceLessonIds,
      sourceAttemptIds: group.sourceAttemptIds,
      roles: Array.isArray(existing?.roles) ? existing.roles : ["*"],
      source: "lesson" as const,
      active: false as const,
      accepted: existing?.accepted === true,
      ...(typeof existing?.acceptedBy === "string" ? { acceptedBy: existing.acceptedBy } : {}),
      ...(typeof existing?.acceptedAt === "string" ? { acceptedAt: existing.acceptedAt } : {}),
    };
  });
  const proposalIds = new Set(proposals.map((proposal) => proposal.id));
  const nextProposals = [
    ...existingProposals.filter((proposal) => !proposalIds.has(proposal.id)),
    ...proposals,
  ];

  return {
    minCount,
    proposed: proposals.length,
    proposals,
    nextProposals,
  };
}

export function acceptGuardrailProposal(input: {
  context: Record<string, unknown>;
  proposalId: string;
  acceptedBy: string;
  acceptedAt?: string;
}) {
  const proposals = guardrailProposalArray(input.context.guardrailProposals);
  const proposal = proposals.find((candidate) => candidate.id === input.proposalId);
  if (!proposal) {
    return null;
  }

  const acceptedAt = input.acceptedAt ?? new Date().toISOString();
  const guardrail: AcceptedGuardrail = {
    ...proposal,
    active: true,
    accepted: true,
    acceptedBy: input.acceptedBy,
    acceptedAt,
  };
  const existingGuardrails = guardrailArray(input.context.guardrails);
  const nextGuardrails = existingGuardrails.some((candidate) => candidate.id === guardrail.id)
    ? existingGuardrails.map((candidate) => (candidate.id === guardrail.id ? guardrail : candidate))
    : [...existingGuardrails, guardrail];
  const nextProposals = proposals.map((candidate) =>
    candidate.id === proposal.id
      ? {
          ...candidate,
          active: false,
          accepted: true,
          acceptedBy: input.acceptedBy,
          acceptedAt,
        }
      : { ...candidate, active: candidate.active === true ? false : candidate.active },
  );

  return {
    proposal,
    guardrail,
    nextGuardrails,
    nextProposals,
  };
}

export function repeatedLessonProposalGroups(lessons: Lesson[], minCount: number) {
  const groups = new Map<
    string,
    { id: string; count: number; summary: string; sourceLessonIds: string[]; sourceAttemptIds: string[] }
  >();
  for (const lesson of lessons) {
    if (lesson.kind !== "lesson") {
      continue;
    }
    const key = normalizedLessonSummary(lesson.summary);
    if (!key) {
      continue;
    }
    const group = groups.get(key);
    if (group) {
      group.count += 1;
      group.sourceLessonIds.push(lesson.id);
      group.sourceAttemptIds.push(lesson.attemptId);
      continue;
    }
    groups.set(key, {
      id: guardrailIdForLessonSummary(key),
      count: 1,
      summary: lesson.summary.replace(/\s+/g, " ").trim(),
      sourceLessonIds: [lesson.id],
      sourceAttemptIds: [lesson.attemptId],
    });
  }

  return Array.from(groups.values())
    .filter((group) => group.count >= minCount)
    .sort((left, right) => right.count - left.count || left.summary.localeCompare(right.summary));
}

export function normalizedLessonSummary(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[.;:!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function guardrailIdForLessonSummary(normalizedSummary: string) {
  const slug = normalizedSummary
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 72)
    .replace(/_+$/g, "");
  return `guardrail_${slug || "lesson"}`;
}

function guardrailProposalArray(value: unknown): Array<Record<string, unknown> & { id: string }> {
  return recordArrayWithIds(value);
}

function guardrailArray(value: unknown): Array<Record<string, unknown> & { id: string }> {
  return recordArrayWithIds(value);
}

function recordArrayWithIds(value: unknown): Array<Record<string, unknown> & { id: string }> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }
    const record = item as Record<string, unknown>;
    return typeof record.id === "string" && record.id.trim() ? [{ ...record, id: record.id.trim() }] : [];
  });
}
