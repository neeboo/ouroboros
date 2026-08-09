# Meta-evolution runtime V1

## Goal

Add a verifiable declared-runtime layer beneath the existing `designed`
target-system package and freeze a future shadow experiment specification
without granting production mutation authority or claiming that instrumentation
or shadow execution has already happened.

The first reference target is Hodor. This implementation lives entirely in
Ouroboros and must not modify Hodor, hodor-web, Pancat, provider accounts, or
their runtime databases.

## Responsibility boundary

- The Designer chooses the hypothesis, candidate surface, evidence split, and
  success criteria.
- Fixed parsers reject malformed or cross-project runtime records.
- Fixed harness actions rebuild authority from the stored accepted proposal,
  approved decision, and frozen charter; persist one immutable record; and read
  it back in the same transaction.
- V1 freezes a future shadow comparison but does not execute either arm. The
  later executor must have a literal zero budget for paid calls, provider
  calls, Pancat writes, production publishes, real asset deletion, and
  cross-project memory access.
- A V1 experiment remains `pending`. Result recording and promotion remain
  unavailable until isolated arm receipts, holdout sealing, exact target
  readback, canary evidence, authority, and rollback execution exist.

## Runtime records

### EvolutionProfile

Content-addressed declaration binding one target project, one accepted pack,
one active founder charter, and the mutation surfaces allowed for a cycle. Its
runtime state is `declared`; later evidence must advance maturity explicitly.

### ProductionEpisode

Content-addressed observation commitment. It stores hashes, bounded metrics,
side-effect counters, and opaque evidence references. Its privacy review must
resolve to a completed same-project verifier attempt whose structured receipt
binds the same input and outcome hashes, redaction policy, data classification,
and retention rule. Raw input and output contents are outside the record.

`sourceRef` connects the immutable episode to exactly one evidence reference
from the frozen development, holdout, or unrelated split.

### HarnessVariant

Content-addressed control or candidate declaration. Its exact changed paths and
mutation surface identifiers must be a subset of the registered profile and
accepted pack. `model` is not a valid runtime mutation target. Independent
artifact attestation remains a later maturity requirement.

### MatchedExperiment

Content-addressed, immutable specification for comparing one control and one
candidate over three non-empty, mutually exclusive episode sets. Its budget
and metric contract must match the frozen design comparison. Its own declared
side-effect budget must be zero. The V1 record remains `pending`; later arm and
side-effect receipts are required before a result can be recorded.

### Draft promotion receipt

Internal draft only. V1 deliberately exports no public promotion-receipt parser
and exposes no action that creates or applies one.

## Fixed actions

V1 adds four narrow actions:

1. `registerEvolutionProfile`
2. `recordProductionEpisode`
3. `registerHarnessVariant`
4. `freezeMatchedExperiment`

Every action:

- names a design-delivery source run;
- rebuilds the contract from the stored accepted proposal, latest approved
  authority decision, and frozen active charter;
- rejects any mismatch in the repeated run-context views and prevents the
  generic context action from overwriting frozen design keys;
- requires the run and record to belong to the same target project;
- validates the complete record through the production parser;
- validates referenced records through the same database transaction;
- inserts once or reuses an identical content-addressed record;
- treats an existing different record as a conflict;
- reads the inserted record transactionally before returning `done`;
- writes a bounded minimal harness action event and immutable action receipt;
- performs no network request, provider call, repository mutation, or target
  project write.

## State transitions

```text
accepted design package
        |
        v
EvolutionProfile (declared)
        |
        +--> ProductionEpisode x N
        |
        +--> control HarnessVariant
        +--> candidate HarnessVariant
                    |
                    v
             MatchedExperiment (pending specification)
                    |
             future isolated executor
                    |
             no result or promotion action in V1
```

## Failure-closed checks

- missing or mismatched project, profile, charter, pack, run, or mutation
  surface;
- non-content-addressed or conflicting record identity;
- raw episode input/output fields;
- missing, failed, cross-project, or mismatched privacy verifier receipt;
- heldout metrics or heldout result evidence before independent evaluation;
- missing, repeated, overlapping, or wrongly classified evidence splits;
- any source, leakage-group, input-snapshot, or outcome-snapshot collision
  across development, heldout, and unrelated splits;
- control/candidate role mismatch;
- model mutation target;
- changed path outside the accepted mutation surfaces;
- glob expressions where an exact changed file path is required;
- budget or metric drift from the frozen comparison;
- any non-zero shadow side-effect counter;
- any experiment outcome other than `pending` in V1;
- a candidate win presented as an applied promotion;
- replay with a different payload under the same identifier.

## Verification

- parser tests for every record and rejection class;
- storage migration and immutable replay tests;
- action tests for project/run/profile/variant/episode relationships;
- readback mismatch and audit rollback tests;
- forged audit event and missing immutable receipt tests;
- CLI action smoke tests;
- existing target-evolution, runner, CLI, full repository, typecheck, and
  diff checks;
- independent architecture and security review before merge.
