---
'@posthog/opencode': patch
---

Report tool calls on `$ai_generation` so PostHog's AI observability Tools view is populated. Tool calls were only emitted as `$ai_span` events, but PostHog extracts tool usage exclusively from `$ai_generation` — so the Tools tab, Tool trends, and Tool co-occurrence stayed empty for every OpenCode user. Each generation now carries `$ai_tools_called` with the names of the tools that step called, in call order. Spans are unchanged, so the trace timeline keeps its existing shape.
