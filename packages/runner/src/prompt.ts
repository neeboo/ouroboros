import { DEFAULT_TASK_PROMPT_TEMPLATE } from "@ouroboros/harness";
import type { Lesson } from "@ouroboros/harness";
import type { PromptInput } from "./types";
import { prettyJson, renderPromptTemplate } from "./template";

const MAX_PROMPT_LESSONS = 12;
const MAX_LESSON_SUMMARY_CHARS = 320;

export function buildTaskPrompt(input: PromptInput) {
  const compactRecentLessons = compactLessons(input.lessons ?? []);
  return renderPromptTemplate(input.template ?? DEFAULT_TASK_PROMPT_TEMPLATE, {
    runGoal: input.run.goal,
    runContextJson: prettyJson(input.run.context),
    taskId: input.task.id,
    taskRole: input.task.role,
    taskGoal: input.task.goal,
    taskPrompt: input.task.prompt,
    doneWhenMarkdown: input.task.doneWhen.map((item) => `- ${item}`).join("\n"),
    dependencyAttemptsJson: prettyJson(input.dependencyAttempts),
    candidateGuardrailsMarkdown: renderCandidateGuardrails(compactRecentLessons),
    reusableExperienceEvidenceMarkdown: renderReusableExperienceEvidence(compactRecentLessons),
    runLessonsJson: prettyJson(compactRecentLessons),
    requiredOutputJson: prettyJson({
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
    }),
  });
}

type CompactLesson = ReturnType<typeof compactLessons>[number];

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

function normalizedLessonSummary(value: string) {
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
