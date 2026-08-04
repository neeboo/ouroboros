import { isStrictIsoTimestamp } from "./iso-timestamp";
import type {
  AuthorityActorContext,
  AuthorityBudgetEvaluation,
  AuthorityCharterContext,
  AuthorityDisposition,
  AuthorityEvidenceEvaluation,
  AuthorityEvidenceReference,
  AuthorityEvaluation,
  AuthorityEvaluationInput,
  AuthorityHardRule,
  AuthorityPortfolioEvaluation,
  AuthorityPortfolioUsage,
  AuthorityProposalRiskSurface,
  AuthorityReason,
  AuthorityReasonKind,
} from "./types";

const HIGH_RISK_FLAG_FIELDS: ReadonlyArray<{
  field: keyof AuthorityProposalRiskSurface;
  kind: AuthorityReasonKind;
  label: string;
}> = [
  { field: "amendsMission", kind: "charter-amendment-mission", label: "mission amendment" },
  { field: "amendsCapitalPolicy", kind: "charter-amendment-capital", label: "capital policy amendment" },
  { field: "legalOrPrivacy", kind: "legal-or-privacy", label: "legal or privacy obligation" },
  { field: "sensitiveData", kind: "sensitive-data", label: "sensitive-data change" },
  { field: "destructiveOperation", kind: "destructive-operation", label: "destructive operation" },
  { field: "productionDeployment", kind: "production-deployment", label: "production deployment" },
  { field: "unplannedDependency", kind: "unplanned-dependency", label: "unplanned dependency" },
  { field: "schemaMigration", kind: "schema-migration", label: "schema migration" },
  { field: "recurringInfrastructure", kind: "recurring-infrastructure", label: "recurring infrastructure commitment" },
];

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

const KNOWN_PORTFOLIO_CATEGORIES: ReadonlyArray<AuthorityProposalRiskSurface["portfolio"]> = [
  "core",
  "growth",
  "exploration",
];

const COST_HUMAN_CATEGORIES = new Set([
  "budget",
  "capital",
  "capital-policy-amendment",
  "cost",
  "purchase",
  "purchasing",
  "recurring-infrastructure",
  "spend",
]);

const COST_ONLY_AUTONOMOUS_REJECT_REASONS = new Set<AuthorityReasonKind>([
  "charter-inactive",
  "conflicting-evidence",
  "expired-evidence",
  "invalid-conflict-metadata",
  "invalid-cost-shape",
  "invalid-evidence-expiry",
  "malformed-evidence-item",
  "missing-evidence",
  "unknown-risk-data",
]);

function isKnownPortfolioCategory(value: unknown): value is AuthorityProposalRiskSurface["portfolio"] {
  return typeof value === "string" && (KNOWN_PORTFOLIO_CATEGORIES as ReadonlyArray<string>).includes(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function evaluateEvidence(
  references: unknown,
  evidence: unknown,
  now: string,
): { evaluation: AuthorityEvidenceEvaluation; reasons: AuthorityReason[] } {
  const reasons: AuthorityReason[] = [];
  // The evidence array must be a real array of records. Anything else cannot
  // be searched by ref and fails closed.
  const safeEvidence: AuthorityEvidenceReference[] = Array.isArray(evidence)
    ? (evidence as AuthorityEvidenceReference[])
    : [];
  const byRef = new Map<string, AuthorityEvidenceReference>();
  let malformedItems = 0;
  for (const item of safeEvidence) {
    // Each evidence entry must be a non-null object. A malformed entry
    // (null, undefined, primitive, number, string, boolean) cannot be
    // inspected and must not be silently skipped — otherwise a single valid
    // record could mask malformed neighbours and authorize automatically.
    if (!item || typeof item !== "object") {
      malformedItems += 1;
      reasons.push({
        kind: "malformed-evidence-item",
        message: `Evidence record ${JSON.stringify(item)} is not a non-null object; cannot be evaluated and fails closed.`,
      });
      continue;
    }
    const candidate = item as { ref?: unknown };
    if (isNonEmptyString(candidate.ref)) {
      // First-seen wins so a stale duplicate cannot shadow the resolved record.
      if (!byRef.has(candidate.ref)) {
        byRef.set(candidate.ref, item as AuthorityEvidenceReference);
      }
    }
  }
  const expired: string[] = [];
  const conflicting: string[] = [];
  const invalidExpiry: string[] = [];
  const invalidConflictMetadata: string[] = [];
  const missing: string[] = [];
  const referenced: string[] = [];
  // `now` must be a strict ISO 8601 UTC timestamp. A non-ISO or non-string
  // value cannot anchor evidence-freshness comparisons and must fail closed.
  const evaluatedAtValid = isStrictIsoTimestamp(now);
  const nowMs = evaluatedAtValid ? Date.parse(now) : Number.NaN;

  // `references` must be an array of non-empty strings. A non-array value
  // (string, undefined, null, object) cannot name real evidence and fails
  // closed. We then iterate only when we have an array — iterating a
  // non-array would throw and authorize nothing for the wrong reason.
  if (!Array.isArray(references) || references.length === 0) {
    reasons.push({
      kind: "missing-evidence",
      message: "Proposal cites no evidence references; automatic authority is unavailable.",
    });
  }

  if (Array.isArray(references)) {
    for (const ref of references) {
      // Each reference must be a non-empty string. Numbers, booleans, objects,
      // and empty strings cannot address a real evidence record and must
      // never authorize. Record the bad value as missing and route to human
      // review.
      if (!isNonEmptyString(ref)) {
        reasons.push({
          kind: "missing-evidence",
          message: `Proposal cites a malformed evidence reference ${JSON.stringify(ref)}; auto-approval is unavailable.`,
        });
        continue;
      }
      referenced.push(ref);
      const item = byRef.get(ref);
      if (!item) {
        missing.push(ref);
        continue;
      }
      // Conflict metadata must be a strict boolean at runtime; absent or
      // non-boolean values cannot be trusted and route to human review.
      if (typeof item.hasConflict !== "boolean") {
        invalidConflictMetadata.push(ref);
        reasons.push({
          kind: "invalid-conflict-metadata",
          message: `Evidence reference ${ref} has non-boolean conflict metadata; cannot authorize automatically.`,
          evidenceRefs: [ref],
        });
      } else if (item.hasConflict) {
        conflicting.push(ref);
      }
      if (item.expiresAt !== null && item.expiresAt !== undefined) {
        // expiresAt must be a strict ISO 8601 UTC timestamp. Numbers, booleans,
        // objects, arrays, empty strings, RFC 2822 dates, and timezone-offset
        // forms cannot be trusted because Date.parse coerces them — e.g.
        // Date.parse(9999) returns a valid future date, which would silently
        // authorize stale or numeric garbage.
        const rawExpiry = item.expiresAt;
        if (!isStrictIsoTimestamp(rawExpiry)) {
          invalidExpiry.push(ref);
          reasons.push({
            kind: "invalid-evidence-expiry",
            message: `Evidence reference ${ref} has a non-ISO expiresAt ${JSON.stringify(rawExpiry)}; cannot be evaluated for freshness.`,
            evidenceRefs: [ref],
          });
        } else {
          const expiresMs = Date.parse(rawExpiry);
          if (!Number.isFinite(expiresMs)) {
            // An unparseable expiry must never silently grant authority. The
            // caller cannot prove the evidence is fresh, so it fails closed.
            invalidExpiry.push(ref);
            reasons.push({
              kind: "invalid-evidence-expiry",
              message: `Evidence reference ${ref} has an invalid expiresAt timestamp and cannot be evaluated for freshness.`,
              evidenceRefs: [ref],
            });
          } else if (evaluatedAtValid && expiresMs <= nowMs) {
            expired.push(ref);
          }
        }
      }
    }
  }
  if (!evaluatedAtValid) {
    reasons.push({
      kind: "unknown-risk-data",
      message: "evaluatedAt is not a valid timestamp; cannot evaluate evidence freshness.",
    });
  }
  return {
    evaluation: {
      referenced,
      expired,
      conflicting,
      invalidExpiry,
      invalidConflictMetadata,
      missing,
      malformedItems,
      evaluatedAtValid,
    },
    reasons,
  };
}

function evaluateBudget(
  charter: AuthorityCharterContext,
  proposal: AuthorityProposalRiskSurface,
): { evaluation: AuthorityBudgetEvaluation; reasons: AuthorityReason[] } {
  const reasons: AuthorityReason[] = [];
  const policy = charter.capitalPolicy;
  // Currency must be a non-empty string. Anything else (null, undefined,
  // numbers, booleans, objects, empty strings) cannot name a real currency
  // and fails closed.
  const rawCurrency = policy?.currency;
  const currency = isNonEmptyString(rawCurrency) ? rawCurrency : null;
  const experimentBudget = isFiniteNonNegative(policy?.experimentBudget) ? (policy!.experimentBudget as number) : null;
  const recurringThreshold = isFiniteNonNegative(policy?.recurringSpendApprovalAbove)
    ? (policy!.recurringSpendApprovalAbove as number)
    : null;
  const oneTimeCost = isFiniteNonNegative(proposal.oneTimeCost) ? proposal.oneTimeCost : Number.NaN;
  const recurringCost = isFiniteNonNegative(proposal.recurringCost) ? proposal.recurringCost : Number.NaN;

  const withinExperimentBudget =
    experimentBudget !== null && Number.isFinite(oneTimeCost) && oneTimeCost <= experimentBudget;
  const withinRecurringThreshold =
    recurringThreshold === null
      ? Number.isFinite(recurringCost) && recurringCost === 0
      : Number.isFinite(recurringCost) && recurringCost <= recurringThreshold;

  if (currency === null) {
    reasons.push({
      kind: "missing-currency-policy",
      message:
        rawCurrency === undefined || rawCurrency === null || rawCurrency === ""
          ? "Charter capital policy does not declare a currency; budget cannot be evaluated."
          : `Charter capital policy declares an invalid currency ${JSON.stringify(rawCurrency)}; budget cannot be evaluated.`,
    });
  }
  if (experimentBudget === null) {
    reasons.push({
      kind: "missing-experiment-budget-policy",
      message: "Charter capital policy does not declare an experiment budget; auto-approval is unavailable.",
    });
  }
  if (recurringThreshold === null) {
    reasons.push({
      kind: "missing-recurring-spend-policy",
      message: "Charter capital policy does not declare a recurring-spend approval threshold; recurring spend defaults to human review.",
    });
  }
  if (experimentBudget !== null && Number.isFinite(oneTimeCost) && oneTimeCost > experimentBudget) {
    reasons.push({
      kind: "budget-experiment-exceeded",
      message: `One-time cost ${oneTimeCost} exceeds configured experiment budget ${experimentBudget}.`,
    });
  }
  if (recurringThreshold !== null && Number.isFinite(recurringCost) && recurringCost > recurringThreshold) {
    reasons.push({
      kind: "recurring-spend-over-threshold",
      message: `Recurring cost ${recurringCost} exceeds human-approval threshold ${recurringThreshold}.`,
    });
  }

  return {
    evaluation: {
      currency,
      oneTimeCost: Number.isFinite(oneTimeCost) ? oneTimeCost : 0,
      recurringCost: Number.isFinite(recurringCost) ? recurringCost : 0,
      experimentBudget,
      recurringThreshold,
      withinExperimentBudget,
      withinRecurringThreshold,
    },
    reasons,
  };
}

function pickShare(
  portfolio: NonNullable<AuthorityCharterContext["capitalPolicy"]>["portfolio"],
  category: AuthorityProposalRiskSurface["portfolio"],
): number | null {
  if (!portfolio) {
    return null;
  }
  const raw = portfolio[category];
  return isFiniteNonNegative(raw) ? raw : null;
}

function evaluatePortfolio(
  charter: AuthorityCharterContext,
  proposal: AuthorityProposalRiskSurface,
  usage: AuthorityPortfolioUsage | null | undefined,
): { evaluation: AuthorityPortfolioEvaluation; reasons: AuthorityReason[] } {
  const reasons: AuthorityReason[] = [];
  const portfolio = charter.capitalPolicy?.portfolio;
  const categoryKnown = isKnownPortfolioCategory(proposal.portfolio);
  const configuredShare = portfolio && categoryKnown ? pickShare(portfolio, proposal.portfolio) : null;

  // Portfolio usage must be supplied for automatic authority. Without it the
  // evaluator cannot prove the proposal stays inside the configured
  // allocation, so it fails closed. A null usage is treated identically to
  // an absent usage: neither can prove the allocation bound.
  let usageMalformed = false;
  if (usage === null || usage === undefined) {
    usageMalformed = true;
    reasons.push({
      kind: "portfolio-usage-unavailable",
      message:
        "Portfolio usage was not provided; the evaluator cannot prove the proposal fits the configured allocation.",
    });
  } else {
    // The usage record must describe the same category as the proposal.
    if (!isKnownPortfolioCategory(usage.category) || usage.category !== proposal.portfolio) {
      usageMalformed = true;
      reasons.push({
        kind: "portfolio-usage-category-mismatch",
        message: `Portfolio usage category "${String(usage.category)}" does not match proposal category "${proposal.portfolio}"; auto-approval is unavailable.`,
      });
    }
    // currentShare must be a finite non-negative number, or null/undefined to
    // signal "no current investments in this category". Anything else (NaN,
    // negative, infinite, wrong type) is untrustworthy.
    const rawShare = usage.currentShare;
    if (rawShare === null || rawShare === undefined) {
      // explicit "no current investments"
    } else if (!isFiniteNonNegative(rawShare)) {
      usageMalformed = true;
      reasons.push({
        kind: "invalid-portfolio-usage",
        message: `Portfolio usage currentShare ${JSON.stringify(rawShare)} is not a finite non-negative number; auto-approval is unavailable.`,
      });
    }
  }

  const currentShare =
    usage && (usage.currentShare === null || usage.currentShare === undefined)
      ? null
      : usage && isFiniteNonNegative(usage.currentShare)
        ? (usage.currentShare as number)
        : null;
  // The first investment counts as one unit. Treating `null` as `proposedShare
  // === null` allowed a zero-allocation category to authorize silently; we
  // now compute proposedShare = currentShare + 1 so a null currentShare
  // (first investment) is compared against the configured allocation.
  const proposedShare = currentShare === null ? 1 : currentShare + 1;
  const withinShare =
    configuredShare === null || usageMalformed ? false : proposedShare <= configuredShare;

  if (!categoryKnown) {
    reasons.push({
      kind: "unknown-risk-data",
      message: `Proposal declares unknown portfolio category "${String(proposal.portfolio)}"; auto-approval is unavailable.`,
    });
  }
  if (!portfolio) {
    reasons.push({
      kind: "portfolio-not-configured",
      message: "Charter capital policy does not declare portfolio allocations; auto-approval is unavailable.",
    });
  } else if (categoryKnown && configuredShare === null) {
    // The selected category exists but its allocation is missing or invalid.
    // The caller cannot prove the proposal fits the configured portfolio, so
    // fail closed with an auditable reason.
    reasons.push({
      kind: "portfolio-allocation-missing",
      message: `Charter capital policy does not declare a valid allocation for the "${proposal.portfolio}" portfolio; auto-approval is unavailable.`,
    });
  } else if (!usageMalformed && configuredShare !== null && proposedShare > configuredShare) {
    reasons.push({
      kind: "portfolio-allocation-exceeded",
      message: `Proposed ${proposal.portfolio} share ${proposedShare} exceeds configured allocation ${configuredShare}.`,
    });
  }

  return {
    evaluation: {
      category: categoryKnown ? proposal.portfolio : "exploration",
      configuredShare,
      currentShare,
      proposedShare,
      withinShare,
    },
    reasons,
  };
}

function collectRiskFlagReasons(proposal: AuthorityProposalRiskSurface): AuthorityReason[] {
  const reasons: AuthorityReason[] = [];
  for (const flag of HIGH_RISK_FLAG_FIELDS) {
    const value = proposal[flag.field] as unknown;
    if (value === true) {
      reasons.push({
        kind: flag.kind,
        message: `Proposal declares ${flag.label}, which is a human checkpoint.`,
      });
    } else if (value !== false) {
      // The type system promises a strict boolean, but at runtime we cannot
      // trust the caller. Anything other than `false` fails closed.
      reasons.push({
        kind: "unknown-risk-data",
        message: `Risk flag ${String(flag.field)} is not a strict boolean; cannot authorize automatically.`,
      });
    }
  }
  return reasons;
}

function collectReversibilityReasons(proposal: AuthorityProposalRiskSurface): AuthorityReason[] {
  if (proposal.reversibility === "hard") {
    return [
      {
        kind: "hard-reversibility",
        message: "Proposal is hard to reverse and requires a human checkpoint.",
      },
    ];
  }
  if (proposal.reversibility === "moderate") {
    return [
      {
        kind: "moderate-reversibility",
        message: "Proposal has moderate reversibility and requires a human checkpoint.",
      },
    ];
  }
  if (proposal.reversibility !== "easy") {
    return [
      {
        kind: "unknown-risk-data",
        message: `Proposal declares unknown reversibility "${String(proposal.reversibility)}"; only "easy" is auto-eligible.`,
      },
    ];
  }
  return [];
}

function collectRequireHumanReasons(
  proposal: AuthorityProposalRiskSurface,
  charter: AuthorityCharterContext,
): AuthorityReason[] {
  const reasons: AuthorityReason[] = [];
  // requireHumanFor must be a real array of strings. Absent (undefined/null)
  // is treated as empty, but a non-array value cannot be intersected and must
  // fail closed with an auditable reason regardless of whether the proposal
  // declares any human categories.
  const rawRequired = charter.authority?.requireHumanFor;
  let required: string[] = [];
  if (rawRequired === undefined || rawRequired === null) {
    required = [];
  } else if (Array.isArray(rawRequired)) {
    required = rawRequired as string[];
    for (const category of rawRequired) {
      if (typeof category !== "string") {
        reasons.push({
          kind: "unknown-risk-data",
          message: `Charter authority requireHumanFor entry ${JSON.stringify(category)} is not a string; cannot evaluate human-only categories.`,
        });
      }
    }
  } else {
    reasons.push({
      kind: "unknown-risk-data",
      message: `Charter authority requireHumanFor ${JSON.stringify(rawRequired)} is not an array of strings; cannot evaluate human-only categories.`,
    });
  }
  // declaredHumanCategories must always be validated before any empty-list
  // early return — otherwise a malformed container (e.g. a stray string)
  // silently authorizes whenever the charter requires no categories.
  if (!Array.isArray(proposal.declaredHumanCategories)) {
    reasons.push({
      kind: "unknown-risk-data",
      message: `Proposal declaredHumanCategories ${JSON.stringify(proposal.declaredHumanCategories as unknown)} is not an array of strings; cannot evaluate human-only categories.`,
    });
    return reasons;
  }
  for (const category of proposal.declaredHumanCategories) {
    if (typeof category !== "string") {
      reasons.push({
        kind: "unknown-risk-data",
        message: `Proposal declaredHumanCategories entry ${JSON.stringify(category)} is not a string; cannot evaluate human-only categories.`,
      });
      continue;
    }
    if (required.includes(category)) {
      reasons.push({
        kind: "require-human-category",
        message: `Proposal declares human-only category "${category}".`,
      });
    }
  }
  return reasons;
}

function proposalRequiresHumanReview(
  proposal: AuthorityProposalRiskSurface,
  charter: AuthorityCharterContext,
): boolean {
  // Any flag that is not strictly `false` is treated as a high-risk signal so
  // runtime-absent or malformed flags route to human review instead of auto.
  if (HIGH_RISK_FLAG_FIELDS.some((flag) => proposal[flag.field] !== false)) {
    return true;
  }
  if (proposal.reversibility !== "easy") {
    return true;
  }
  if (collectRequireHumanReasons(proposal, charter).length > 0) {
    return true;
  }
  return false;
}

function usesCostOnlyHumanApproval(charter: AuthorityCharterContext): boolean {
  return charter.authority?.humanApprovalPolicy === "cost-only";
}

function proposalHasCostImpact(proposal: AuthorityProposalRiskSurface): boolean {
  if (!isFiniteNonNegative(proposal.oneTimeCost) || !isFiniteNonNegative(proposal.recurringCost)) {
    return false;
  }
  if (proposal.oneTimeCost > 0 || proposal.recurringCost > 0) {
    return true;
  }
  if (proposal.amendsCapitalPolicy === true || proposal.recurringInfrastructure === true) {
    return true;
  }
  return Array.isArray(proposal.declaredHumanCategories)
    && proposal.declaredHumanCategories.some(
      (category) => typeof category === "string" && COST_HUMAN_CATEGORIES.has(category.toLowerCase()),
    );
}

function collectCostOnlyShapeReasons(
  proposal: AuthorityProposalRiskSurface,
  charter: AuthorityCharterContext,
): AuthorityReason[] {
  const reasons: AuthorityReason[] = [];
  for (const flag of HIGH_RISK_FLAG_FIELDS) {
    if (typeof proposal[flag.field] !== "boolean") {
      reasons.push({
        kind: "unknown-risk-data",
        message: `Risk flag ${String(flag.field)} is not a strict boolean; cannot make an autonomous decision.`,
      });
    }
  }
  if (proposal.reversibility !== "easy" && proposal.reversibility !== "moderate" && proposal.reversibility !== "hard") {
    reasons.push({
      kind: "unknown-risk-data",
      message: `Proposal declares unknown reversibility ${JSON.stringify(proposal.reversibility)}; cannot make an autonomous decision.`,
    });
  }
  for (const reason of collectRequireHumanReasons(proposal, charter)) {
    if (reason.kind === "unknown-risk-data") {
      reasons.push(reason);
    }
  }
  return reasons;
}

function summarizeReasons(reasons: AuthorityReason[]): string {
  return reasons.map((reason) => `${reason.kind}: ${reason.message}`).join(" | ");
}

export const HARD_AUTHORITY_RULES: ReadonlyArray<AuthorityHardRule> = [
  "expired-evidence",
  "missing-evidence",
  "charter-inactive",
  "budget-experiment-exceeded",
  "portfolio-not-configured",
  "portfolio-allocation-missing",
  "portfolio-allocation-exceeded",
  "portfolio-usage-unavailable",
  "portfolio-usage-category-mismatch",
  "invalid-portfolio-usage",
  "missing-experiment-budget-policy",
  "missing-currency-policy",
  "invalid-cost-shape",
  "invalid-evidence-expiry",
  "invalid-conflict-metadata",
  "malformed-evidence-item",
  "unknown-risk-data",
];

export function isHardAuthorityReason(reason: AuthorityReason): boolean {
  return (HARD_AUTHORITY_RULES as ReadonlyArray<string>).includes(reason.kind);
}

export function evaluateAuthority(input: AuthorityEvaluationInput): AuthorityEvaluation {
  const charter = input.charter;
  const proposal = input.proposal;
  const now = input.evaluatedAt;
  const actor = input.actor;
  const costOnlyHumanApproval = usesCostOnlyHumanApproval(charter);
  const hasCostImpact = proposalHasCostImpact(proposal);

  const reasons: AuthorityReason[] = [];
  let disposition: AuthorityDisposition = "automatic";
  let hardBlocked = false;

  // 1. Charter activation sanity — the active flag must be strictly `true`.
  // Anything else (false, "false", 0, "true", objects, undefined) cannot
  // grant authority and is treated as an inactive charter.
  if (charter.isActive !== true) {
    reasons.push({
      kind: "charter-inactive",
      message:
        charter.isActive === false
          ? "Charter is not active; authority cannot be granted."
          : `Charter isActive flag ${JSON.stringify(charter.isActive)} is not strictly true; authority cannot be granted.`,
    });
    disposition = "rejected";
    hardBlocked = true;
  }

  // 2. Evidence freshness — no actor may authorize investment on stale evidence.
  const evidenceResult = evaluateEvidence(proposal.evidenceRefs, input.evidence, now);
  const evidence = evidenceResult.evaluation;
  for (const reason of evidenceResult.reasons) {
    reasons.push(reason);
    if (
      reason.kind === "invalid-evidence-expiry" ||
      reason.kind === "invalid-conflict-metadata" ||
      reason.kind === "malformed-evidence-item" ||
      reason.kind === "unknown-risk-data" ||
      reason.kind === "missing-evidence"
    ) {
      if (disposition !== "rejected") {
        disposition = "human-required";
      }
      hardBlocked = true;
    }
  }
  for (const ref of evidence.expired) {
    reasons.push({
      kind: "expired-evidence",
      message: `Evidence reference ${ref} has expired and cannot authorize investment.`,
      evidenceRefs: [ref],
    });
  }
  if (evidence.expired.length > 0) {
    disposition = "rejected";
    hardBlocked = true;
  }
  for (const ref of evidence.missing) {
    reasons.push({
      kind: "missing-evidence",
      message: `Proposal cites evidence ${ref} that has no resolved record.`,
      evidenceRefs: [ref],
    });
    if (disposition !== "rejected") {
      disposition = "human-required";
    }
    hardBlocked = true;
  }
  for (const ref of evidence.conflicting) {
    reasons.push({
      kind: "conflicting-evidence",
      message: `Evidence reference ${ref} is marked as conflicting; treat the conclusion as low-confidence.`,
      evidenceRefs: [ref],
    });
    if (disposition !== "rejected") {
      disposition = "human-required";
    }
  }

  // 3. Budget — hard experiment-budget cap rejects; missing policies fail closed for everyone.
  const budgetEvaluation = evaluateBudget(charter, proposal);
  if (!costOnlyHumanApproval || hasCostImpact) {
    for (const reason of budgetEvaluation.reasons) {
      reasons.push(reason);
      if (reason.kind === "budget-experiment-exceeded") {
        disposition = "rejected";
        hardBlocked = true;
      } else if (disposition !== "rejected") {
        disposition = "human-required";
      }
    }
  }

  // 4. Portfolio — allocation must be configured; over-allocation routes to human review.
  const portfolioEvaluation = evaluatePortfolio(charter, proposal, input.portfolioUsage);
  if (!costOnlyHumanApproval || hasCostImpact) {
    for (const reason of portfolioEvaluation.reasons) {
      reasons.push(reason);
      if (
        reason.kind === "portfolio-not-configured" ||
        reason.kind === "portfolio-allocation-missing" ||
        reason.kind === "portfolio-allocation-exceeded" ||
        reason.kind === "unknown-risk-data"
      ) {
        if (disposition !== "rejected") {
          disposition = "human-required";
        }
        hardBlocked = true;
      } else if (disposition !== "rejected") {
        disposition = "human-required";
      }
    }
  }

  // 5. Cost sanity — fail closed on non-finite or negative numeric inputs.
  if (!isFiniteNonNegative(proposal.oneTimeCost) || !isFiniteNonNegative(proposal.recurringCost)) {
    reasons.push({
      kind: "invalid-cost-shape",
      message: "Proposal has non-finite or negative cost data and cannot be authorized automatically.",
    });
    if (disposition !== "rejected") {
      disposition = "human-required";
    }
    hardBlocked = true;
  }

  // The remaining rules only escalate; they never override an existing rejection.
  // High-risk categories always route to human review. The evaluator cannot
  // verify caller-supplied actor identity (anyone can pass `kind: "human"`),
  // so it never grants automatic authority to high-risk work. The actor record
  // is still consulted for audit reasons — proposer vs. non-proposer — but it
  // cannot override the fail-closed disposition.

  // 6. Risk flags — recorded for audit; disposition always flips to human-required.
  if (costOnlyHumanApproval) {
    for (const reason of collectCostOnlyShapeReasons(proposal, charter)) {
      reasons.push(reason);
      disposition = "rejected";
      hardBlocked = true;
    }
  } else {
    const riskFlagReasons = collectRiskFlagReasons(proposal);
    for (const reason of riskFlagReasons) {
      reasons.push(reason);
      if (disposition !== "rejected") {
        disposition = "human-required";
      }
    }

    // 7. Reversibility — easy is the only auto-eligible reversibility.
    for (const reason of collectReversibilityReasons(proposal)) {
      reasons.push(reason);
      if (disposition !== "rejected") {
        disposition = "human-required";
      }
    }

    // 8. Charter requireHumanFor category matches.
    for (const reason of collectRequireHumanReasons(proposal, charter)) {
      reasons.push(reason);
      if (disposition !== "rejected") {
        disposition = "human-required";
      }
    }

    // 9. Charter authority flag — fail closed unless autoReversibleExperiments is
    // explicitly true. Absent, false, or non-boolean values cannot grant any
    // automatic authority; the proposal must go to human review.
    if (charter.authority?.autoReversibleExperiments !== true) {
      reasons.push({
        kind: "auto-reversible-experiments-disabled",
        message:
          "Charter does not explicitly enable automatic reversible experiments; all proposals require human review.",
      });
      if (disposition !== "rejected") {
        disposition = "human-required";
      }
    }

    // 10. Actor provenance audit — recorded so the trail explains which kind of
    // channel is required next. The evaluator never authorizes high-risk work
    // automatically, so a non-proposer actor that would previously have been
    // trusted now receives actor-not-allowed-for-high-risk.
    if (!hardBlocked && proposalRequiresHumanReview(proposal, charter)) {
      if (actor.isProposer) {
        reasons.push({
          kind: "proposer-cannot-self-authorize",
          message: "The proposing Designer cannot act as the human approver for its own high-risk work.",
        });
      } else {
        reasons.push({
          kind: "actor-not-allowed-for-high-risk",
          message:
            "Automatic authorization is unavailable for high-risk work; a separately verified human-approval channel is required.",
        });
      }
      if (disposition !== "rejected") {
        disposition = "human-required";
      }
    }
  }

  if (costOnlyHumanApproval) {
    const mustRejectAutonomously = reasons.some((reason) =>
      COST_ONLY_AUTONOMOUS_REJECT_REASONS.has(reason.kind),
    );
    if (mustRejectAutonomously) {
      disposition = "rejected";
    } else if (hasCostImpact) {
      reasons.push({
        kind: "cost-requires-human-decision",
        message: `Proposal has a cost impact (one-time ${budgetEvaluation.evaluation.oneTimeCost}, recurring ${budgetEvaluation.evaluation.recurringCost}) and requires a human spending decision.`,
      });
      disposition = "human-required";
    } else {
      disposition = "automatic";
    }
  }

  void summarizeReasons; // retained for callers that want a flat audit string

  return {
    disposition,
    reasons,
    charterId: charter.id,
    charterVersion: charter.version,
    proposalId: proposal.proposalId,
    evaluatedAt: now,
    evidence,
    budget: budgetEvaluation.evaluation,
    portfolio: portfolioEvaluation.evaluation,
    reversibility: proposal.reversibility,
    actor: {
      kind: actor.kind,
      ref: actor.ref,
      isProposer: actor.isProposer,
    },
  };
}

export function describeAuthorityEvaluation(evaluation: AuthorityEvaluation): string {
  const summary = summarizeReasons(evaluation.reasons);
  if (summary.length === 0) {
    return `authority=${evaluation.disposition} charter=${evaluation.charterId} v${evaluation.charterVersion}`;
  }
  return `authority=${evaluation.disposition} charter=${evaluation.charterId} v${evaluation.charterVersion} | ${summary}`;
}
