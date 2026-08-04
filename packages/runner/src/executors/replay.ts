import type { Attempt, AttemptOutput, Harness } from "@ouroboros/harness";
import type { AttemptReplayCache } from "./types";

export function createInMemoryAttemptReplayCache(): AttemptReplayCache {
  const initialRequests = new Set<string>();
  const recoveryRequests = new Set<string>();
  const terminalResults = new Map<string, AttemptOutput>();
  return {
    reserveInitialRequest(attemptId) {
      if (!attemptId) {
        return true;
      }
      if (initialRequests.has(attemptId)) {
        return false;
      }
      initialRequests.add(attemptId);
      return true;
    },
    reserveRecoveryRequest(attemptId) {
      if (!attemptId) {
        return true;
      }
      if (recoveryRequests.has(attemptId)) {
        return false;
      }
      recoveryRequests.add(attemptId);
      return true;
    },
    getTerminalResult(attemptId) {
      if (!attemptId) {
        return undefined;
      }
      return terminalResults.get(attemptId);
    },
    recordTerminalResult(attemptId, output) {
      if (!attemptId) {
        return;
      }
      terminalResults.set(attemptId, output);
    },
  };
}

const INITIAL_REQUEST_EVENT_TYPES = new Set([
  "acpx.attempt.started",
  "acpx.attempt.terminal",
  "acpx.attempt.recovery.start",
  "acpx.attempt.recovery.terminal",
  "acpx.attempt.reconnect",
  "acpx.attempt.idle_timeout",
  "acpx.attempt.hard_timeout",
]);

const RECOVERY_REQUEST_EVENT_TYPES = new Set([
  "acpx.attempt.recovery.start",
  "acpx.attempt.recovery.terminal",
  "acpx.attempt.reconnect",
]);

export interface DurableAttemptReplayCacheInput {
  harness: Harness;
  inMemory?: AttemptReplayCache;
}

export function createDurableAttemptReplayCache(
  input: DurableAttemptReplayCacheInput,
): AttemptReplayCache {
  const inMemory = input.inMemory ?? createInMemoryAttemptReplayCache();
  const harness = input.harness;

  function readAttempt(attemptId: string): Attempt | null {
    try {
      return harness.getAttempt(attemptId);
    } catch {
      return null;
    }
  }

  function hasEventOfType(
    attemptId: string,
    eventTypes: Set<string>,
  ): boolean {
    let events;
    try {
      events = harness.listAttemptEvents(attemptId);
    } catch {
      return false;
    }
    for (const event of events) {
      const type = (event.payload as { type?: unknown }).type;
      if (typeof type === "string" && eventTypes.has(type)) {
        return true;
      }
    }
    return false;
  }

  return {
    reserveInitialRequest(attemptId) {
      if (!attemptId) {
        return true;
      }
      if (!inMemory.reserveInitialRequest(attemptId)) {
        return false;
      }
      const attempt = readAttempt(attemptId);
      if (attempt && attempt.status !== "running") {
        return false;
      }
      if (hasEventOfType(attemptId, INITIAL_REQUEST_EVENT_TYPES)) {
        return false;
      }
      return true;
    },
    reserveRecoveryRequest(attemptId) {
      if (!attemptId) {
        return true;
      }
      if (!inMemory.reserveRecoveryRequest(attemptId)) {
        return false;
      }
      const attempt = readAttempt(attemptId);
      if (attempt && attempt.status !== "running") {
        return false;
      }
      if (hasEventOfType(attemptId, RECOVERY_REQUEST_EVENT_TYPES)) {
        return false;
      }
      return true;
    },
    getTerminalResult(attemptId) {
      if (!attemptId) {
        return undefined;
      }
      const cached = inMemory.getTerminalResult(attemptId);
      if (cached) {
        return cached;
      }
      const attempt = readAttempt(attemptId);
      if (attempt && attempt.status !== "running") {
        return attempt.output;
      }
      return undefined;
    },
    recordTerminalResult(attemptId, output) {
      if (!attemptId) {
        return;
      }
      inMemory.recordTerminalResult(attemptId, output);
    },
  };
}
