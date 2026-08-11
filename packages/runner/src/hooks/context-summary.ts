import { readableValue } from "@ouroboros/harness";
import type { AttemptOutput } from "@ouroboros/harness";
import { boundedDiagnosticText, compactAttemptEvidence, latestRootCause } from "../bounded-diagnostic";
import type { ContextSubagent, ContextSubagentOutput, StopHook, StopHookInput } from "../types";

export interface ContextSubagentHookOptions {
  summarize?: ContextSubagent;
}

export function createContextSummaryHook(options: ContextSubagentHookOptions = {}): StopHook {
  const summarize = options.summarize ?? deterministicContextSummary;

  return async (input) => {
    try {
      const archive = normalizeArchive(await summarize(input), input);
      const evidence = compactAttemptEvidence(input.output);
      const outputPatch = patchOutputWithContext(input.output, archive, evidence.originalEvidence);
      input.output.checks = evidence.checks.items;
      input.output.artifacts = evidence.artifacts.items;

      return {
        decision: "exit" as const,
        outputPatch,
        checks: [{ name: "context subagent", status: "passed" }],
        artifacts: [
          {
            kind: "context_experience_archive",
            taskId: input.task.id,
            summary: archive.experience.summary,
            evidence,
          },
          {
            kind: "context_lesson_archive",
            taskId: input.task.id,
            summary: archive.lesson.summary,
            evidence,
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

function patchOutputWithContext(
  output: AttemptOutput,
  archive: ContextSubagentOutput,
  originalEvidence: { sha256: string; characterCount: number; truncated: boolean },
) {
  if (output.status === "done") {
    return {
      summary: archive.experience.summary,
      changedFiles: compactAttemptEvidence(output).changedFiles.items,
    };
  }

  const rootCause = latestRootCause(output);
  return {
    summary: archive.lesson.summary,
    changedFiles: compactAttemptEvidence(output).changedFiles.items,
    problems: [
      rootCause,
      `Prior verifier evidence sha256=${originalEvidence.sha256}; originalChars=${originalEvidence.characterCount}; truncated=${originalEvidence.truncated}.`,
    ],
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

  return {
    experience: {
      summary: "No reusable success pattern recorded for this blocked attempt.",
      evidence: { status: input.output.status },
    },
    lesson: {
      summary: compact(latestRootCause(input.output)),
      evidence,
    },
  };
}

function normalizeArchive(archive: ContextSubagentOutput, input: StopHookInput): ContextSubagentOutput {
  return {
    experience: {
      summary: compact(archive.experience?.summary || deterministicContextSummary(input).experience.summary),
      evidence: {},
    },
    lesson: {
      summary: compact(archive.lesson?.summary || deterministicContextSummary(input).lesson.summary),
      evidence: {},
    },
  };
}

function compact(value: unknown) {
  const normalized = boundedDiagnosticText(readableValue(value), 240).text;
  if (normalized.length <= 240) {
    return normalized;
  }
  return `${normalized.slice(0, 237)}...`;
}
