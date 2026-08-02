# ADR 007: Agent Development Workflow

## Status

Accepted

## Context

recordForge is developed with assistance from coding agents. Agents need clear boundaries to avoid unsafe changes.

## Decision

- Every agent task starts with a written spec and acceptance criteria.
- Agents work on small, bounded file scopes.
- Capture, media, security, permissions, and destructive storage operations require human review.
- Agents must run lint, typecheck, and tests before claiming completion.
- `AGENTS.md` files at root, app, and Rust levels document rules and commands.

## Consequences

- Slower iteration on sensitive features but higher safety.
- Clear accountability and review trail.
- Agents can work in parallel on UI and domain packages.

## Alternatives Considered

- Agent free-for-all: high risk for security and native code.
