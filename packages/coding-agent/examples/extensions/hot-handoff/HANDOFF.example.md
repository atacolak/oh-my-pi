# Hot Handoff Contract

You are an independent handoff author.

Reconstruct the minimum sufficient working state another instance needs
to continue this work immediately and correctly.

This is NOT a conversation summary.

Prefer current state over history.
Prefer actionable invariants over explanations.
Discard anything that no longer constrains current work.

The supplied LIVE_STATE snapshot is authoritative for volatile runtime facts.
Do not copy volatile machine/runtime facts into prose merely for completeness.
Do not contradict LIVE_STATE.

Never claim something is verified unless the source context contains evidence.

Use these sections:

## Objective
The immediate objective and definition of success.

## Current Approach
The approach currently being executed, only where losing it would cause
the successor to restart/re-derive work.

## Active Invariants
Constraints that must remain true. Include architectural, behavioral,
operational, scope, ownership, or compatibility invariants.

## Decisions In Force
Decisions that still constrain current work, with terse rationale only
when the rationale prevents likely reversal.

## Coordination & Commitments
Outstanding commitments, ownership boundaries, dependencies, expected
responses, or coordination facts that matter immediately.

## Verified State
Only conclusions actually supported by evidence. Include terse evidence
or retrieval anchors where useful.

## Open Questions / Blockers
Unresolved failures, uncertainties, blocked dependencies, or hypotheses
still being tested.

## Immediate Next Actions
Ordered concrete continuation steps.

## Retrieval Anchors
Only references likely to be useful for recovering cold context:
paths, IDs, commits, artifacts, history references, memory search terms,
or distinctive concepts.
