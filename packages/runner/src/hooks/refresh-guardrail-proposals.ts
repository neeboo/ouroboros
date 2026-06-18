import { refreshGuardrailProposalsForRun, type Harness } from "@ouroboros/harness";
import type { StopHook } from "../types";

export function createRefreshGuardrailProposalsHook(options: { harness: Harness }): StopHook {
  return ({ run, task, output }) => {
    if (task.role !== "goal-review" || output.status !== "done") {
      return {};
    }

    const result = refreshGuardrailProposalsForRun({
      harness: options.harness,
      runId: run.id,
    });
    if (!result.updated) {
      return {};
    }

    return {
      checks: [
        { name: "guardrail proposals refreshed", status: "passed", evidence: `${result.proposed} proposal(s)` },
      ],
      artifacts: [
        {
          kind: "guardrail_proposals",
          runId: run.id,
          proposed: result.proposed,
          proposalIds: result.proposals.map((proposal) => proposal.id),
        },
      ],
    };
  };
}
