import { readableValue } from "@ouroboros/harness";
import type { AttemptOutput } from "@ouroboros/harness";
import type { ContextSubagent, ContextSubagentOutput, StopHook, StopHookInput } from "../types";

export interface ContextSubagentHookOptions {
  summarize?: ContextSubagent;
}

export function createContextSummaryHook(options: ContextSubagentHookOptions = {}): StopHook {
  const summarize = options.summarize ?? deterministicContextSummary;

  return async (input) => {
    try {
      const archive = normalizeArchive(await summarize(input), input);
      const outputPatch = patchOutputWithContext(input.output, archive);

      return {
        decision: "exit" as const,
        outputPatch,
        checks: [{ name: "context subagent", status: "passed" }],
        artifacts: [
          {
            kind: "context_experience_archive",
            taskId: input.task.id,
            summary: archive.experience.summary,
            evidence: archive.experience.evidence ?? {},
          },
          {
            kind: "context_lesson_archive",
            taskId: input.task.id,
            summary: archive.lesson.summary,
            evidence: archive.lesson.evidence ?? {},
          },
        ],
      };
    } catch (error) {
      return {
        decision: "exit" as const,
        checks: [
          {
            name: "context subagent",
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
  };
}

export const createContextSubagentHook = createContextSummaryHook;

function patchOutputWithContext(output: AttemptOutput, archive: ContextSubagentOutput) {
  if (output.status === "done") {
    return {
      summary: archive.experience.summary,
    };
  }

  return {
    summary: archive.lesson.summary,
    problems: [archive.lesson.summary, ...(output.problems ?? [])],
  };
}

function deterministicContextSummary(input: StopHookInput): ContextSubagentOutput {
  const evidence = {
    status: input.output.status,
    summary: input.output.summary,
    changedFiles: input.output.changedFiles ?? [],
    checks: input.output.checks ?? [],
    artifacts: input.output.artifacts ?? [],
    problems: input.output.problems ?? [],
  };

  if (input.output.status === "done") {
    return {
      experience: {
        summary: compact(input.output.summary || `Completed ${input.task.goal}.`),
        evidence,
      },
      lesson: {
        summary: "No failure pattern recorded for this successful attempt.",
        evidence: { status: input.output.status },
      },
    };
  }

  const firstProblem = input.output.problems?.map((problem) => readableValue(problem)).find((problem) => problem.length > 0);
  return {
    experience: {
      summary: "No reusable success pattern recorded for this blocked attempt.",
      evidence: { status: input.output.status },
    },
    lesson: {
      summary: compact(firstProblem ?? input.output.summary ?? `Blocked while working on ${input.task.goal}.`),
      evidence,
    },
  };
}

function normalizeArchive(archive: ContextSubagentOutput, input: StopHookInput): ContextSubagentOutput {
  return {
    experience: {
      summary: compact(archive.experience?.summary || deterministicContextSummary(input).experience.summary),
      evidence: archive.experience?.evidence ?? {},
    },
    lesson: {
      summary: compact(archive.lesson?.summary || deterministicContextSummary(input).lesson.summary),
      evidence: archive.lesson?.evidence ?? {},
    },
  };
}

function compact(value: unknown) {
  const normalized = readableValue(value);
  if (normalized.length <= 240) {
    return normalized;
  }
  return `${normalized.slice(0, 237)}...`;
}
