# Ouroboros

Ouroboros is a minimal local harness for self-prompting agent loops.

The system has two separate parts:

- **local harness**: owns runs, tasks, attempts, worktrees, sessions, verification, and repair loops.
- **Linear bridge**: listens to external collaboration events and mirrors useful progress back to Linear and PRs.

Linear is the collaboration surface. GitHub is the code surface. The harness database is the local control plane.

## Core Idea

The harness does not treat prompts as state. It derives prompts from database state, runs an agent, validates structured output, then updates the database.

```text
goal -> task graph -> ready task -> prompt -> agent attempt
     -> structured result -> verification -> done / repair / blocked
```

## Minimal Pieces

```text
docs/protocol.md                 Minimal runtime protocol
packages/harness/schema.sql      SQLite schema for the harness and bridge
packages/harness/src/            Local harness library
packages/cli/src/                Local CLI wrapper
```

## Boundaries

The local harness handles:

- task dependency scheduling
- worktree assignment
- session assignment
- prompt generation
- attempt recording
- verification result handling
- repair task creation

The Linear bridge handles:

- Linear issue events
- Linear comments
- PR status updates
- mapping external issues to local runs or tasks
- posting progress and verifier summaries back to Linear

The bridge writes external events into the harness inbox. The harness decides what those events mean.
