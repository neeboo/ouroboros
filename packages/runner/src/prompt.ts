import type { PromptInput } from "./types";

export function buildTaskPrompt(input: PromptInput) {
  return [
    "# Ouroboros Task",
    "",
    `Run Goal: ${input.run.goal}`,
    "",
    "## Run Context",
    fencedJson(input.run.context),
    "",
    "## Task",
    `Task ID: ${input.task.id}`,
    `Role: ${input.task.role}`,
    `Goal: ${input.task.goal}`,
    "",
    "## Instructions",
    input.task.prompt,
    "",
    "## Done When",
    ...input.task.doneWhen.map((item) => `- ${item}`),
    "",
    "## Dependency Attempts",
    fencedJson(input.dependencyAttempts),
    "",
    "## Required Output",
    "Return only JSON with this shape:",
    fencedJson({
      status: "done",
      summary: "Short completion summary",
      changedFiles: [],
      checks: [],
      artifacts: [],
      problems: [],
    }),
  ].join("\n");
}

function fencedJson(value: unknown) {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}
