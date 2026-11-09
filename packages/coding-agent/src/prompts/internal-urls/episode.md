`episode://` — the session's indexed agent runs, joined to their transcripts (read-only).
- `episode://search?q=<term>` — full-text lookup over focus title, trigger summary, recap and tool targets.
- `episode://<id>` — overview: intent plus one bounded line per tool call, for orientation.
- `episode://<id>/<call_id>` — the untruncated arguments and output of that one call, for recovery.
