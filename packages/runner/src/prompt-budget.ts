import type { AttemptOutput } from "@ouroboros/harness";
import { sha256Text } from "./bounded-diagnostic";

export const MAX_EXECUTOR_PROMPT_CHARACTERS = 900_000;
export const MAX_EXECUTOR_PROMPT_UTF8_BYTES = 900_000;
export const MAX_HANDOFF_PROMPT_CHARACTERS = 64_000;

export interface PromptBudgetEvidence {
  kind: "prompt_input_budget_exceeded";
  phase: string;
  characters: number;
  utf8Bytes: number;
  characterLimit: number;
  utf8ByteLimit: number;
  sha256: string;
}

export interface HandoffContractTooLargeArtifact {
  kind: "handoff_contract_too_large";
  chars: number;
  bytes: number;
  limit: number;
  sha: string;
}

export class HandoffContractTooLargeError extends Error {
  readonly artifact: HandoffContractTooLargeArtifact;

  constructor(artifact: HandoffContractTooLargeArtifact) {
    super("handoff_contract_too_large");
    this.name = "HandoffContractTooLargeError";
    this.artifact = artifact;
  }
}

export function promptBudgetEvidence(prompt: string, phase: string): PromptBudgetEvidence | null {
  const characters = prompt.length;
  const utf8Bytes = Buffer.byteLength(prompt, "utf8");
  if (
    characters <= MAX_EXECUTOR_PROMPT_CHARACTERS
    && utf8Bytes <= MAX_EXECUTOR_PROMPT_UTF8_BYTES
  ) {
    return null;
  }
  return {
    kind: "prompt_input_budget_exceeded",
    phase,
    characters,
    utf8Bytes,
    characterLimit: MAX_EXECUTOR_PROMPT_CHARACTERS,
    utf8ByteLimit: MAX_EXECUTOR_PROMPT_UTF8_BYTES,
    sha256: sha256Text(prompt),
  };
}

export function promptBudgetBlockedOutput(evidence: PromptBudgetEvidence): AttemptOutput {
  return {
    status: "blocked",
    summary: `input_too_large: prompt blocked before ${evidence.phase}`,
    changedFiles: [],
    checks: [{ name: "prompt input budget", status: "failed", evidence }],
    artifacts: [evidence],
    problems: [
      `Prompt input exceeds the internal safety limit before ${evidence.phase}: `
      + `${evidence.characters}/${evidence.characterLimit} characters, `
      + `${evidence.utf8Bytes}/${evidence.utf8ByteLimit} UTF-8 bytes; sha256=${evidence.sha256}.`,
    ],
  };
}

export function promptBudgetAttemptInput(evidence: PromptBudgetEvidence) {
  return { promptBudget: evidence };
}

export function fitPromptAroundFrozenSections(rendered: string, frozenSections: string[]) {
  const frozen = frozenSections.filter(Boolean).join("\n\n");
  if (!frozen) {
    return rendered.length <= MAX_HANDOFF_PROMPT_CHARACTERS
      ? rendered
      : `${rendered.slice(0, MAX_HANDOFF_PROMPT_CHARACTERS - 80)}\n...[prompt body truncated before handoff]`;
  }
  const frozenBytes = Buffer.byteLength(frozen, "utf8");
  if (frozen.length >= MAX_HANDOFF_PROMPT_CHARACTERS) {
    throw new HandoffContractTooLargeError({
      kind: "handoff_contract_too_large",
      chars: frozen.length,
      bytes: frozenBytes,
      limit: MAX_HANDOFF_PROMPT_CHARACTERS,
      sha: sha256Text(frozen),
    });
  }
  const separator = "\n\n";
  const bodyLimit = MAX_HANDOFF_PROMPT_CHARACTERS - frozen.length - separator.length;
  const body = rendered.length <= bodyLimit
    ? rendered
    : `${rendered.slice(0, Math.max(0, bodyLimit - 80))}\n...[historical prompt body truncated before frozen sections]`;
  return `${body}${separator}${frozen}`;
}
