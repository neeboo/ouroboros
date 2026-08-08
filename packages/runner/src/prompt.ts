import { DEFAULT_TASK_PROMPT_TEMPLATE } from "@ouroboros/harness";
import type { Lesson } from "@ouroboros/harness";
import type { PromptInput } from "./types";
import { prettyJson, renderPromptTemplate } from "./template";

const MAX_PROMPT_LESSONS = 12;
const MAX_LESSON_SUMMARY_CHARS = 320;
const MAX_ACTIVE_GUARDRAILS = 8;
const FROZEN_LINEAR_EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const FROZEN_LINEAR_EVIDENCE_FUTURE_SKEW_MS = 5 * 60 * 1000;

export function buildTaskPrompt(input: PromptInput) {
  const compactRecentLessons = compactLessons(input.lessons ?? []);
  const template = input.template ?? DEFAULT_TASK_PROMPT_TEMPLATE;
  const frozenLinearImplementationGate = renderFrozenLinearImplementationGate(
    input.run.context,
    input.task.config,
    input.task.role,
  );
  const prompt = renderPromptTemplate(template, {
    runGoal: input.run.goal,
    runContextJson: prettyJson(input.run.context),
    taskId: input.task.id,
    taskRole: input.task.role,
    taskGoal: input.task.goal,
    taskConfigJson: prettyJson(input.task.config ?? {}),
    taskPrompt: input.task.prompt,
    doneWhenMarkdown: input.task.doneWhen.map((item) => `- ${item}`).join("\n"),
    dependencyAttemptsJson: prettyJson(input.dependencyAttempts),
    activeGuardrailsMarkdown: [
      frozenLinearImplementationGate,
      renderActiveGuardrails(input.run.context, input.task.role),
    ].filter(Boolean).join("\n"),
    candidateGuardrailsMarkdown: renderCandidateGuardrails(compactRecentLessons),
    reusableExperienceEvidenceMarkdown: renderReusableExperienceEvidence(compactRecentLessons),
    runLessonsJson: prettyJson(compactRecentLessons),
    requiredOutputJson: prettyJson(requiredOutputForRole(input.task.role, input.task.config)),
  });
  if (frozenLinearImplementationGate && !template.includes("{{activeGuardrailsMarkdown}}")) {
    return `${prompt}\n\n${frozenLinearImplementationGate}`;
  }
  return prompt;
}

interface LinearDeliveryScope {
  issueId: string;
  identifier: string;
  teamKey: string;
  state: string;
  stateId: string;
}

function renderFrozenLinearImplementationGate(
  runContext: Record<string, unknown>,
  taskConfig: Record<string, unknown> | undefined,
  role: string,
) {
  if (role !== "planner" && role !== "worker") {
    return "";
  }

  const taskContract = asRecord(taskConfig?.linearDelivery);
  const linearDelivery = asRecord(runContext.linearDelivery);
  if (!taskContract && !linearDelivery) {
    return "";
  }

  const supervisorEvidence = asRecord(runContext.externalSupervisorEvidence);
  const supervisorLinear = asRecord(supervisorEvidence?.linear);
  const usesSupervisorEvidence = supervisorLinear !== null;
  const contractRecord = taskContract ?? (usesSupervisorEvidence ? linearDelivery : null);
  const evidenceRecord = usesSupervisorEvidence ? supervisorLinear : taskContract ? linearDelivery : null;
  const contract = linearScope(contractRecord);
  const evidence = linearScope(evidenceRecord);
  const problems: string[] = [];

  if (!contract) {
    problems.push("current task contract is missing an exact issueId, identifier, teamKey, state, or stateId");
  }
  if (!evidence) {
    problems.push("frozen evidence is missing an exact issueId, identifier, teamKey, state, or stateId");
  }
  const verifiedBy = readString(evidenceRecord, usesSupervisorEvidence ? "verifiedBy" : "statusVerifiedBy");
  const outcome = readString(evidenceRecord, usesSupervisorEvidence ? "outcome" : "statusOutcome");
  if (evidenceRecord && verifiedBy !== "independent_readback") {
    problems.push("frozen evidence verifiedBy is not independent_readback");
  }
  if (evidenceRecord && outcome !== "verified") {
    problems.push("frozen evidence outcome is not verified");
  }
  if (usesSupervisorEvidence && supervisorEvidence?.version !== 1) {
    problems.push("frozen evidence version is not v1");
  }
  if (usesSupervisorEvidence && contractRecord === linearDelivery && linearDelivery) {
    if (readString(linearDelivery, "statusVerifiedBy") !== "independent_readback") {
      problems.push("linearDelivery statusVerifiedBy is not independent_readback");
    }
    if (readString(linearDelivery, "statusOutcome") !== "verified") {
      problems.push("linearDelivery statusOutcome is not verified");
    }
  }
  const observedAt = readString(usesSupervisorEvidence ? supervisorEvidence : evidenceRecord, "observedAt");
  const freshness = frozenEvidenceFreshness(observedAt);
  if (freshness === "missing") {
    problems.push("frozen evidence has no observation time");
  } else if (freshness === "invalid") {
    problems.push("frozen evidence observation time is invalid");
  } else if (freshness === "expired") {
    problems.push("frozen evidence is expired");
  }
  if (contract && evidence) {
    for (const field of ["issueId", "identifier", "teamKey", "state", "stateId"] as const) {
      if (contract[field] !== evidence[field]) {
        problems.push(`${field} does not match the current task contract`);
      }
    }
  }

  const finalGate =
    "This start gate does not satisfy final delivery gates. After implementation, independently read back the final Linear evidence comment, the Linear Done state, and every Git remote SHA; fail closed if any final readback is missing or mismatched.";
  if (problems.length > 0) {
    return [
      "## Frozen Linear Implementation Gate",
      "Status: NOT SATISFIED.",
      ...problems.map((problem) => `- ${problem}`),
      "Fail closed: do not treat this frozen evidence as permission to start local implementation. Complete the task contract's required preflight, and block if fresh independent readback is unavailable.",
      finalGate,
      "",
    ].join("\n");
  }

  return [
    "## Frozen Linear Implementation Gate",
    "Status: SATISFIED by fresh independent readback matching the current task contract.",
    `- issueId: ${contract!.issueId}`,
    `- identifier: ${contract!.identifier}`,
    `- teamKey: ${contract!.teamKey}`,
    `- state: ${contract!.state}`,
    `- stateId: ${contract!.stateId}`,
    "This is sufficient for this planner or worker to start local implementation. Do not repeat Linear or GitHub OAuth/network preflight before starting local implementation, and do not block local work merely because those repeated network calls are unavailable.",
    finalGate,
    "",
  ].join("\n");
}

function linearScope(record: Record<string, unknown> | null): LinearDeliveryScope | null {
  if (!record) {
    return null;
  }
  const scope = {
    issueId: readString(record, "issueId"),
    identifier: readString(record, "identifier"),
    teamKey: readString(record, "teamKey"),
    state: readString(record, "state"),
    stateId: readString(record, "stateId"),
  };
  return Object.values(scope).every(Boolean) ? scope as LinearDeliveryScope : null;
}

function frozenEvidenceFreshness(observedAt: string | null): "fresh" | "expired" | "invalid" | "missing" {
  if (!observedAt) {
    return "missing";
  }
  const observed = Date.parse(observedAt);
  const now = Date.now();
  if (!Number.isFinite(observed) || observed > now + FROZEN_LINEAR_EVIDENCE_FUTURE_SKEW_MS) {
    return "invalid";
  }
  return now - observed <= FROZEN_LINEAR_EVIDENCE_MAX_AGE_MS ? "fresh" : "expired";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

type RequiredOutputExample = {
  status: string;
  summary: string;
  changedFiles: unknown[];
  checks: unknown[];
  artifacts: unknown[];
  problems: unknown[];
  actions: Array<Record<string, unknown>>;
};

const DEFAULT_REQUIRED_OUTPUT: RequiredOutputExample = {
  status: "done",
  summary: "Short completion summary",
  changedFiles: [],
  checks: [],
  artifacts: [],
  problems: [],
  actions: [
    {
      type: "createTasks",
      payload: {
        tasks: [
          {
            role: "worker",
            goal: "Optional next task goal",
            prompt: "Optional next task instructions",
            dependsOn: [],
            doneWhen: [],
          },
        ],
      },
    },
  ],
};

function requiredOutputForRole(role: string, taskConfig?: Record<string, unknown>): RequiredOutputExample {
  if (role !== "designer") {
    return DEFAULT_REQUIRED_OUTPUT;
  }
  const continuation = afterRecordSignalContinuation(taskConfig);
  const proposeDesign = proposeDesignActionExample(continuation?.signalId);
  if (continuation) {
    return {
      status: "done",
      summary: "Proposed one bounded design anchored to the recorded signal",
      changedFiles: [],
      checks: [],
      artifacts: [],
      problems: [],
      actions: [proposeDesign],
    };
  }
  return {
    status: "done",
    summary: "Short completion summary",
    changedFiles: [],
    checks: [],
    artifacts: [],
    problems: [],
    actions: [
      {
        type: "recordSignal",
        payload: {
          projectId: "<project_id>",
          signalClass: "delivery",
          source: "evidence source",
          title: "short signal title",
          summary: "what the evidence shows",
          observationTime: "2026-08-02T00:00:00Z",
          confidence: 0.5,
          evidence: [{ ref: "evidence reference", kind: "evidence-ref" }],
        },
      },
      proposeDesign,
      {
        type: "decideDesign",
        payload: {
          proposalId: "<proposal id>",
          decision: "rejected",
          reasons: ["why the proposal was rejected, deferred, retired, or revised"],
        },
      },
      {
        type: "recordDesignOutcome",
        payload: {
          proposalId: "<proposal id>",
          stage: "review",
          recommendation: "retain",
          baseline: { metric: 0 },
          observed: { metric: 1 },
          evidence: [{ runId: "<run id>" }],
        },
      },
      {
        type: "createRunsFromDesign",
        payload: {
          proposalId: "<accepted proposal id>",
          runs: [
            {
              goal: "delivery run goal",
              prompt: "initial planner prompt",
              doneWhen: ["verification checks"],
            },
          ],
        },
      },
    ],
  };
}

function proposeDesignActionExample(signalId = "signal_<id>"): Record<string, unknown> {
  return {
    type: "proposeDesign",
    payload: {
      projectId: "<project_id>",
      title: "short proposal title",
      charterId: "<optional charter id>",
      proposal: {
        problem: "demonstrated gap",
        recommendation: "recommended option",
        evidenceRefs: [signalId],
        options: [
          {
            name: "bounded alternative",
            benefits: ["expected benefit"],
            costs: ["maintenance cost"],
            risks: ["failure risk"],
            lockIn: ["migration or lock-in cost"],
          },
        ],
        additions: ["capability to add"],
        removals: ["complexity to remove"],
        targetOutcome: "measurable target outcome",
        assumptions: ["assumption to verify"],
        uncertainty: ["remaining uncertainty"],
        evaluationContract: {
          baseline: ["current behavior"],
          successMetrics: ["measurable outcome"],
          guardMetrics: ["guard metric"],
          requiredEvidence: ["verification evidence"],
          reviewAt: "2026-09-01T00:00:00Z",
        },
        investment: {
          reversibility: "easy",
          portfolio: "core",
          oneTimeCost: 0,
          recurringCost: 0,
          timeBudget: "bounded time budget",
        },
        experiment: {
          hypothesis: "testable hypothesis",
          smallestTest: "smallest bounded test",
          stopConditions: ["stop condition"],
          rollback: "remove experiment artifacts and restore the baseline",
        },
      },
      status: "proposed",
    },
  };
}

function afterRecordSignalContinuation(
  taskConfig: Record<string, unknown> | undefined,
): { signalId: string } | null {
  const continuation = taskConfig?.designContinuation;
  if (!continuation || typeof continuation !== "object" || Array.isArray(continuation)) {
    return null;
  }
  const record = continuation as Record<string, unknown>;
  if (record.kind !== "after-recordSignal") {
    return null;
  }
  return {
    signalId:
      typeof record.signalId === "string" && record.signalId.trim().length > 0
        ? record.signalId
        : "signal_<id>",
  };
}

type CompactLesson = ReturnType<typeof compactLessons>[number];

interface ActiveGuardrail {
  id: string;
  summary: string;
  source?: string;
}

function compactLessons(lessons: Lesson[]) {
  return lessons.slice(-MAX_PROMPT_LESSONS).map((lesson) => ({
    kind: lesson.kind,
    summary: compactText(lesson.summary, MAX_LESSON_SUMMARY_CHARS),
    taskId: lesson.taskId,
    attemptId: lesson.attemptId,
  }));
}

function renderCandidateGuardrails(lessons: CompactLesson[]) {
  const repeatedFailureGroups = repeatedLessonGroups(lessons);
  if (repeatedFailureGroups.length === 0) {
    return "";
  }

  return [
    "## Candidate Guardrails",
    "Candidate guardrail guidance derived from repeated failure lessons. Treat these as prompt-only candidates unless a later task explicitly accepts them as active guardrails.",
    "",
    ...repeatedFailureGroups.map(
      (group) =>
        `- Seen ${group.count} times: ${group.summary}\n  Use as a guardrail before execution and verification for this task.`,
    ),
    "",
  ].join("\n");
}

function renderActiveGuardrails(context: Record<string, unknown>, role: string) {
  const guardrails = activeGuardrailsForRole(context.guardrails, role);
  if (guardrails.length === 0) {
    return "";
  }

  return [
    "## Active Guardrails",
    "These guardrails are accepted for this run and role. Apply them before candidate lessons.",
    "",
    ...guardrails.map((guardrail) => {
      const source = guardrail.source ? ` (source: ${guardrail.source})` : "";
      return `- ${guardrail.id}: ${guardrail.summary}${source}`;
    }),
    "",
  ].join("\n");
}

function activeGuardrailsForRole(value: unknown, role: string): ActiveGuardrail[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => activeGuardrailFromValue(item, role))
    .filter((item): item is ActiveGuardrail => item !== null)
    .slice(-MAX_ACTIVE_GUARDRAILS);
}

function activeGuardrailFromValue(value: unknown, role: string): ActiveGuardrail | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.active === false) {
    return null;
  }
  if (!guardrailAppliesToRole(record, role)) {
    return null;
  }
  const summary = typeof record.summary === "string" ? compactText(record.summary, MAX_LESSON_SUMMARY_CHARS) : "";
  if (!summary) {
    return null;
  }
  const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : "guardrail";
  const source = typeof record.source === "string" && record.source.trim() ? record.source.trim() : undefined;
  return { id, summary, source };
}

function guardrailAppliesToRole(record: Record<string, unknown>, role: string) {
  const roles = Array.isArray(record.roles)
    ? record.roles.filter((item): item is string => typeof item === "string")
    : typeof record.role === "string"
      ? [record.role]
      : [];
  return roles.length === 0 || roles.includes(role) || roles.includes("*");
}

function renderReusableExperienceEvidence(lessons: CompactLesson[]) {
  const experiences = lessons.filter((lesson) => lesson.kind === "experience");
  if (experiences.length === 0) {
    return "";
  }

  return [
    "## Reusable Experience Evidence",
    ...experiences.map((experience) => `- ${experience.summary} (source: ${experience.taskId} / ${experience.attemptId})`),
    "",
  ].join("\n");
}

function repeatedLessonGroups(lessons: CompactLesson[]) {
  const groups = new Map<string, { count: number; summary: string }>();
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
    } else {
      groups.set(key, { count: 1, summary: lesson.summary });
    }
  }

  return Array.from(groups.values())
    .filter((group) => group.count >= 2)
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

function compactText(value: string, maxChars: number) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars - 3)}...`;
}
