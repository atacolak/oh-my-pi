# Hot Handoff Implementation Plan

1. Generic `session.compacting` `model?: string` override. Exclusive to that request. Does not mutate the session model.
2. Sanitized `ctx.getAgentSnapshot()` modeled on `getAsyncJobSnapshot()`.
3. Reusable `examples/extensions/hot-handoff` extension:
   - project `HANDOFF.md` loading + fixed protocol envelope
   - deterministic live-state capsule
   - Snapshot A on `session.compacting`
   - Snapshot B on the next `context` event after `session_compact`
4. Tests for opt-in, independent author, provider-safe path, live-state bounds, ephemeral Snapshot B, and fallbacks.
