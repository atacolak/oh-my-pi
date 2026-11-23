A graceful restart of this conversation was requested.

- Finish the current safe step; preserve your unfinished responsibilities.
- Save the outcome, remaining work, evidence and next action in the journal or work item.
- Collect and save session-owned tool, subagent and background-job results. Do not cancel working children merely to restart.
- This conversation's UUID, journal, durable name and saved work persist. Unsaved in-memory state, local variables, tool kernels and process-local handles reset; save what the next boot needs.
- The owner reloads the conversation with the selected runtime and current configuration. Re-check ephemeral handles after boot; do not replay interrupted side effects or assume an old job is still running.
- Call `upgrade_runtime` with request `{{requestId}}` only after saving the checkpoint, then finish this turn. The owner waits for acknowledgment, turn completion, owned work to settle and its results to be consumed before restarting.
