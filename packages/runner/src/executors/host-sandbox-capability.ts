import type { AttemptOutput } from "@ouroboros/harness";
import type { CodexSandbox } from "./types";

export function hostSandboxCapabilityOutput(
  requestedSandbox: CodexSandbox,
  phase: string,
): AttemptOutput | null {
  if (requestedSandbox === "danger-full-access") {
    return capabilityOutput({
      phase,
      requestedSandbox,
      hostSandbox: process.env.CODEX_SANDBOX === "seatbelt" ? "seatbelt" : "none",
      recoverable: false,
      problem: "danger-full-access is prohibited for Ouroboros Codex executors. Use read-only or workspace-write.",
    });
  }
  if (
    process.platform !== "darwin" ||
    process.env.CODEX_SANDBOX !== "seatbelt"
  ) {
    return null;
  }

  return capabilityOutput({
    phase,
    requestedSandbox,
    hostSandbox: "seatbelt",
    recoverable: true,
    problem: "The current host is already inside macOS Seatbelt. Starting another Codex workspace sandbox would fail with sandbox_apply exit 71. Relaunch the supervisor outside Seatbelt while keeping the requested Codex sandbox unchanged.",
  });
}

export function acpxCodexHostCapabilityOutput(input: {
  phase: string;
  browserProcessPolicy: "allow" | "deny" | undefined;
}): AttemptOutput | null {
  if (process.platform !== "darwin") return null;
  const nestedHost = process.env.CODEX_SANDBOX === "seatbelt";
  if (!nestedHost && input.browserProcessPolicy !== "deny") return null;
  return capabilityOutput({
    phase: input.phase,
    requestedSandbox: "workspace-write",
    hostSandbox: nestedHost ? "seatbelt" : "browser-deny-seatbelt",
    recoverable: true,
    executor: "acpx-codex",
    problem: "ACPX cannot safely start Codex beneath the current macOS Seatbelt policy. Route this task to codex-resumable so the native Codex workspace sandbox and host browser hook can be applied without nesting.",
  });
}

function capabilityOutput(input: {
  phase: string;
  requestedSandbox: CodexSandbox;
  hostSandbox: string;
  recoverable: boolean;
  problem: string;
  executor?: string;
}): AttemptOutput {
  return {
    status: "blocked",
    summary: `host_sandbox_capability_unavailable: ${input.phase} cannot safely provide ${input.requestedSandbox}`,
    changedFiles: [],
    checks: [{ name: "host sandbox capability preflight", status: "failed" }],
    artifacts: [
      {
        kind: "host_sandbox_capability",
        platform: "darwin",
        hostSandbox: input.hostSandbox,
        requestedSandbox: input.requestedSandbox,
        recoverable: input.recoverable,
        ...(input.executor ? { executor: input.executor } : {}),
      },
    ],
    problems: [input.problem],
  };
}
