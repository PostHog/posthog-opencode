---
'@posthog/opencode': minor
---

Send LLM traces with posthog-node 6, through PostHog's v1 capture API. `$ai_generation`, `$ai_span` and `$ai_trace` events now go to `/i/v1/ai/events` instead of `/batch/`, so a reverse proxy set as `POSTHOG_HOST` must forward that path. Requires Node 22.22 or later.
