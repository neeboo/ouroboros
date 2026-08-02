import type {
  DesignDecision,
  DesignOutcome,
  DesignProposal,
  FounderCharter,
  StrategySignal,
} from "@ouroboros/harness";

const MAX_LINE_CHARS = 200;
const MAX_SUMMARY_CHARS = 160;
const SHORT_ID_LENGTH = 12;

export interface DesignStatusSummary {
  charter: FounderCharter | null;
  currentProposal: DesignProposal | null;
  latestDecision: DesignDecision | null;
  nextOutcomeReview: DesignOutcome | null;
  recentOutcomes: DesignOutcome[];
  activeSignalCount: number;
  proposalCountsByStatus: Record<string, number>;
}

export interface ListSignalsResult {
  signals: StrategySignal[];
  totalCount: number;
}

export interface ShowDesignResult {
  proposal: DesignProposal;
  decisions: DesignDecision[];
  outcomes: DesignOutcome[];
}

export interface BuildDesignStatusInput {
  projectId: string;
  loadCharter: () => FounderCharter | null;
  loadCurrentProposal: () => DesignProposal | null;
  loadLatestDecision: (proposalId: string) => DesignDecision | null;
  loadOutcomes: (proposalId: string) => DesignOutcome[];
  countActiveSignals: () => number;
  loadProposalCounts: () => Record<string, number>;
}

export function buildDesignStatus(input: BuildDesignStatusInput): DesignStatusSummary {
  const charter = input.loadCharter();
  const currentProposal = input.loadCurrentProposal();
  const latestDecision = currentProposal ? input.loadLatestDecision(currentProposal.id) ?? null : null;
  const outcomes = currentProposal ? input.loadOutcomes(currentProposal.id) : [];
  const nextOutcomeReview = outcomes.find((outcome) => outcome.reviewAt) ?? null;
  const recentOutcomes = outcomes.slice(0, 5);
  const activeSignalCount = input.countActiveSignals();
  const proposalCountsByStatus = input.loadProposalCounts();
  return {
    charter,
    currentProposal,
    latestDecision,
    nextOutcomeReview,
    recentOutcomes,
    activeSignalCount,
    proposalCountsByStatus,
  };
}

export function formatDesignStatus(summary: DesignStatusSummary): string {
  const lines: string[] = [];
  lines.push("Designer status");
  lines.push("");
  formatCharterLines(lines, summary.charter);
  lines.push("");
  formatCurrentProposalLines(lines, summary.currentProposal, summary.latestDecision);
  lines.push("");
  formatOutcomeLines(lines, summary.nextOutcomeReview, summary.recentOutcomes);
  lines.push("");
  formatSignalAndProposalCounts(lines, summary.activeSignalCount, summary.proposalCountsByStatus);
  return lines.join("\n");
}

function formatCharterLines(lines: string[], charter: FounderCharter | null) {
  lines.push("Active charter");
  if (!charter) {
    lines.push("  (none)");
    return;
  }
  lines.push(`  id: ${charter.id}`);
  lines.push(`  version: v${charter.version}`);
  lines.push(`  mission: ${clamp(charter.mission, MAX_SUMMARY_CHARS)}`);
  if (charter.activatedAt) {
    lines.push(`  activated: ${charter.activatedAt}`);
  }
  const capital = charter.charter.capitalPolicy;
  if (capital) {
    const budgetParts: string[] = [];
    if (typeof capital.monthlyBudget === "number") {
      budgetParts.push(`monthly ${formatCurrency(capital.monthlyBudget, capital.currency)}`);
    }
    if (typeof capital.experimentBudget === "number") {
      budgetParts.push(`experiment ${formatCurrency(capital.experimentBudget, capital.currency)}`);
    }
    if (typeof capital.recurringSpendApprovalAbove === "number") {
      budgetParts.push(
        `recurring approval > ${formatCurrency(capital.recurringSpendApprovalAbove, capital.currency)}`,
      );
    }
    if (typeof capital.runwayFloorMonths === "number") {
      budgetParts.push(`runway floor ${capital.runwayFloorMonths}mo`);
    }
    if (budgetParts.length > 0) {
      lines.push(`  budget: ${budgetParts.join(", ")}`);
    }
    if (capital.portfolio) {
      const portfolio = [];
      if (typeof capital.portfolio.core === "number") portfolio.push(`core ${capital.portfolio.core}%`);
      if (typeof capital.portfolio.growth === "number") portfolio.push(`growth ${capital.portfolio.growth}%`);
      if (typeof capital.portfolio.exploration === "number") {
        portfolio.push(`exploration ${capital.portfolio.exploration}%`);
      }
      if (portfolio.length > 0) {
        lines.push(`  portfolio: ${portfolio.join(", ")}`);
      }
    }
  }
  const authority = charter.charter.authority;
  if (authority) {
    const flags: string[] = [];
    if (authority.autoResearch) flags.push("auto-research");
    if (authority.autoReversibleExperiments) flags.push("auto-experiments");
    if (authority.autoIntegrateVerifiedCode) flags.push("auto-integrate");
    if (flags.length > 0) {
      lines.push(`  authority: ${flags.join(", ")}`);
    }
    if (Array.isArray(authority.requireHumanFor) && authority.requireHumanFor.length > 0) {
      lines.push(`  human checkpoints: ${authority.requireHumanFor.join(", ")}`);
    }
  }
  if (typeof charter.charter.reviewCadenceDays === "number") {
    lines.push(`  review cadence: every ${charter.charter.reviewCadenceDays}d`);
  }
}

function formatCurrentProposalLines(
  lines: string[],
  proposal: DesignProposal | null,
  decision: DesignDecision | null,
) {
  lines.push("Current proposal");
  if (!proposal) {
    lines.push("  (none)");
    return;
  }
  lines.push(`  id: ${proposal.id}`);
  lines.push(`  status: ${proposal.status}`);
  lines.push(`  title: ${clamp(proposal.title, MAX_SUMMARY_CHARS)}`);
  lines.push(`  recommendation: ${clamp(proposal.recommendation, MAX_SUMMARY_CHARS)}`);
  const investment = proposal.proposal.investment;
  if (investment) {
    const investParts: string[] = [];
    if (typeof investment.oneTimeCost === "number") {
      investParts.push(`one-time ${investment.oneTimeCost}`);
    }
    if (typeof investment.recurringCost === "number") {
      investParts.push(`recurring ${investment.recurringCost}`);
    }
    if (investment.reversibility) {
      investParts.push(`reversibility ${investment.reversibility}`);
    }
    if (investment.portfolio) {
      investParts.push(`portfolio ${investment.portfolio}`);
    }
    if (investParts.length > 0) {
      lines.push(`  investment: ${investParts.join(", ")}`);
    }
  }
  if (decision) {
    lines.push(
      `  latest decision: ${decision.decision} by ${decision.actorKind}` +
        (decision.actorRef ? ` (${decision.actorRef})` : ""),
    );
    if (decision.reasons.length > 0) {
      lines.push(`    reasons: ${clamp(decision.reasons.join("; "), MAX_SUMMARY_CHARS)}`);
    }
  }
  const evaluation = proposal.proposal.evaluationContract;
  if (evaluation?.reviewAt) {
    lines.push(`  next review: ${evaluation.reviewAt}`);
  }
}

function formatOutcomeLines(
  lines: string[],
  nextOutcomeReview: DesignOutcome | null,
  recentOutcomes: DesignOutcome[],
) {
  lines.push("Outcomes");
  if (nextOutcomeReview) {
    lines.push(
      `  next review: ${nextOutcomeReview.id} stage=${nextOutcomeReview.stage}` +
        ` recommendation=${nextOutcomeReview.recommendation}` +
        (nextOutcomeReview.reviewAt ? ` at=${nextOutcomeReview.reviewAt}` : ""),
    );
  } else {
    lines.push("  next review: (none scheduled)");
  }
  if (recentOutcomes.length === 0) {
    lines.push("  recent: (none recorded)");
  } else {
    for (const outcome of recentOutcomes.slice(0, 3)) {
      lines.push(
        `  - ${shortId(outcome.id)} stage=${outcome.stage}` +
          ` recommendation=${outcome.recommendation}` +
          (outcome.reviewAt ? ` review=${outcome.reviewAt}` : ""),
      );
    }
  }
}

function formatSignalAndProposalCounts(
  lines: string[],
  activeSignalCount: number,
  proposalCountsByStatus: Record<string, number>,
) {
  lines.push("Signals and proposals");
  lines.push(`  active signals: ${activeSignalCount}`);
  const counts = Object.entries(proposalCountsByStatus).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  if (counts.length === 0) {
    lines.push("  proposals: (none recorded)");
  } else {
    lines.push(`  proposals: ${counts.map(([status, count]) => `${status}=${count}`).join(", ")}`);
  }
}

export function formatListSignals(result: ListSignalsResult): string {
  const lines: string[] = [];
  lines.push(`Strategy signals (${result.totalCount})`);
  if (result.signals.length === 0) {
    lines.push("  (none)");
    return lines.join("\n");
  }
  for (const signal of result.signals) {
    lines.push(
      `  - ${shortId(signal.id)} [${signal.signalClass}] ${signal.status}` +
        (signal.confidence !== undefined ? ` confidence=${signal.confidence}` : "") +
        (signal.expiresAt ? ` expires=${signal.expiresAt}` : ""),
    );
    lines.push(`    source: ${signal.source}`);
    lines.push(`    title: ${clamp(signal.title, MAX_SUMMARY_CHARS)}`);
    if (signal.summary) {
      lines.push(`    summary: ${clamp(signal.summary, MAX_SUMMARY_CHARS)}`);
    }
  }
  return lines.join("\n");
}

export function formatShowDesign(result: ShowDesignResult): string {
  const lines: string[] = [];
  const proposal = result.proposal;
  lines.push(`Design proposal ${proposal.id}`);
  lines.push(`  status: ${proposal.status}`);
  lines.push(`  title: ${clamp(proposal.title, MAX_SUMMARY_CHARS)}`);
  if (proposal.projectId) {
    lines.push(`  project: ${proposal.projectId}`);
  }
  if (proposal.runId) {
    lines.push(`  run: ${proposal.runId}`);
  }
  if (proposal.attemptId) {
    lines.push(`  attempt: ${proposal.attemptId}`);
  }
  if (proposal.charterId) {
    lines.push(`  charter: ${proposal.charterId}`);
  }
  lines.push(`  problem: ${clamp(proposal.proposal.problem, MAX_LINE_CHARS)}`);
  lines.push(`  recommendation: ${clamp(proposal.recommendation, MAX_LINE_CHARS)}`);
  if (proposal.proposal.targetOutcome) {
    lines.push(`  target outcome: ${clamp(proposal.proposal.targetOutcome, MAX_LINE_CHARS)}`);
  }
  if (Array.isArray(proposal.proposal.evidenceRefs) && proposal.proposal.evidenceRefs.length > 0) {
    lines.push(`  evidence refs: ${proposal.proposal.evidenceRefs.join(", ")}`);
  }
  const options = proposal.proposal.options ?? [];
  if (options.length > 0) {
    lines.push("");
    lines.push("Options");
    for (const option of options) {
      lines.push(`  - ${option.name}`);
      if (Array.isArray(option.benefits) && option.benefits.length > 0) {
        lines.push(`    benefits: ${option.benefits.join("; ")}`);
      }
      if (Array.isArray(option.costs) && option.costs.length > 0) {
        lines.push(`    costs: ${option.costs.join("; ")}`);
      }
      if (Array.isArray(option.risks) && option.risks.length > 0) {
        lines.push(`    risks: ${option.risks.join("; ")}`);
      }
      if (Array.isArray(option.lockIn) && option.lockIn.length > 0) {
        lines.push(`    lock-in: ${option.lockIn.join("; ")}`);
      }
    }
  }
  if (Array.isArray(proposal.proposal.additions) && proposal.proposal.additions.length > 0) {
    lines.push(`Additions: ${proposal.proposal.additions.join("; ")}`);
  }
  if (Array.isArray(proposal.proposal.removals) && proposal.proposal.removals.length > 0) {
    lines.push(`Removals: ${proposal.proposal.removals.join("; ")}`);
  }
  if (Array.isArray(proposal.proposal.assumptions) && proposal.proposal.assumptions.length > 0) {
    lines.push(`Assumptions: ${proposal.proposal.assumptions.join("; ")}`);
  }
  if (Array.isArray(proposal.proposal.uncertainty) && proposal.proposal.uncertainty.length > 0) {
    lines.push(`Uncertainty: ${proposal.proposal.uncertainty.join("; ")}`);
  }
  const contract = proposal.proposal.evaluationContract;
  if (contract) {
    lines.push("");
    lines.push("Evaluation contract (frozen)");
    if (Array.isArray(contract.baseline) && contract.baseline.length > 0) {
      lines.push(`  baseline: ${contract.baseline.join("; ")}`);
    }
    if (Array.isArray(contract.successMetrics) && contract.successMetrics.length > 0) {
      lines.push(`  success metrics: ${contract.successMetrics.join("; ")}`);
    }
    if (Array.isArray(contract.guardMetrics) && contract.guardMetrics.length > 0) {
      lines.push(`  guard metrics: ${contract.guardMetrics.join("; ")}`);
    }
    if (Array.isArray(contract.requiredEvidence) && contract.requiredEvidence.length > 0) {
      lines.push(`  required evidence: ${contract.requiredEvidence.join("; ")}`);
    }
    if (contract.reviewAt) {
      lines.push(`  review at: ${contract.reviewAt}`);
    }
  }
  const investment = proposal.proposal.investment;
  if (investment) {
    lines.push("");
    lines.push("Investment");
    lines.push(`  reversibility: ${investment.reversibility}`);
    lines.push(`  portfolio: ${investment.portfolio}`);
    if (typeof investment.oneTimeCost === "number") {
      lines.push(`  one-time cost: ${investment.oneTimeCost}`);
    }
    if (typeof investment.recurringCost === "number") {
      lines.push(`  recurring cost: ${investment.recurringCost}`);
    }
    if (investment.timeBudget) {
      lines.push(`  time budget: ${investment.timeBudget}`);
    }
  }
  const experiment = proposal.proposal.experiment;
  if (experiment) {
    lines.push("");
    lines.push("Experiment");
    lines.push(`  hypothesis: ${clamp(experiment.hypothesis, MAX_LINE_CHARS)}`);
    lines.push(`  smallest test: ${clamp(experiment.smallestTest, MAX_LINE_CHARS)}`);
    if (Array.isArray(experiment.stopConditions) && experiment.stopConditions.length > 0) {
      lines.push(`  stop conditions: ${experiment.stopConditions.join("; ")}`);
    }
    if (experiment.rollback) {
      lines.push(`  rollback: ${clamp(experiment.rollback, MAX_LINE_CHARS)}`);
    }
  }
  if (result.decisions.length > 0) {
    lines.push("");
    lines.push(`Decisions (${result.decisions.length})`);
    for (const decision of result.decisions) {
      lines.push(
        `  - ${shortId(decision.id)} ${decision.decision} by ${decision.actorKind}` +
          (decision.actorRef ? ` (${decision.actorRef})` : ""),
      );
      if (decision.reasons.length > 0) {
        lines.push(`    reasons: ${clamp(decision.reasons.join("; "), MAX_SUMMARY_CHARS)}`);
      }
    }
  }
  if (result.outcomes.length > 0) {
    lines.push("");
    lines.push(`Outcomes (${result.outcomes.length})`);
    for (const outcome of result.outcomes) {
      lines.push(
        `  - ${shortId(outcome.id)} stage=${outcome.stage} recommendation=${outcome.recommendation}` +
          (outcome.reviewAt ? ` review=${outcome.reviewAt}` : ""),
      );
      if (Array.isArray(outcome.evidence) && outcome.evidence.length > 0) {
        const evidenceText = outcome.evidence
          .map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry)))
          .join("; ");
        lines.push(`    evidence: ${clamp(evidenceText, MAX_SUMMARY_CHARS)}`);
      }
      if (Array.isArray(outcome.unexpectedEffects) && outcome.unexpectedEffects.length > 0) {
        const effectsText = outcome.unexpectedEffects
          .map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry)))
          .join("; ");
        lines.push(`    unexpected effects: ${clamp(effectsText, MAX_SUMMARY_CHARS)}`);
      }
    }
  }
  return lines.join("\n");
}

function clamp(value: string, max: number) {
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max - 1)}…`;
}

function shortId(value: string) {
  return value.length <= SHORT_ID_LENGTH ? value : value.slice(0, SHORT_ID_LENGTH);
}

function formatCurrency(value: number, currency?: string) {
  if (currency) {
    return `${currency} ${value}`;
  }
  return String(value);
}
