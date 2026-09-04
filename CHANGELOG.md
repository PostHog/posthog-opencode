# @posthog/opencode

## 0.2.0

### Minor Changes

- 892f87f: Support OpenCode 1.0.69 and later, and pin development dependencies to the minimum supported version for compatibility testing.

## 0.1.1

### Patch Changes

- 22c1c34: Report tool calls on `$ai_generation` so PostHog's AI observability Tools view is populated. Tool calls were only emitted as `$ai_span` events, but PostHog extracts tool usage exclusively from `$ai_generation` — so the Tools tab, Tool trends, and Tool co-occurrence stayed empty for every OpenCode user. Each generation now carries `$ai_tools_called` with the names of the tools that step called, in call order. Spans are unchanged, so the trace timeline keeps its existing shape.

## 0.1.0

### Minor Changes

- b34542d: Align releases with PostHog Pi by publishing pending changesets after they reach `main`.
- 35efee1: Adopt as the official PostHog LLM Analytics plugin for OpenCode and align packaging with the PostHog standard: publish as `@posthog/opencode`, migrate the toolchain from bun to pnpm, and adopt the approval-gated release workflow with npm OIDC trusted publishing and provenance.

### Patch Changes

- 1ab7a60: Fix missing `$ai_input` and `$ai_model`/`$ai_provider` on generations and traces. OpenCode emits `message.updated` for the same user message several times per turn, and the plugin was starting a fresh trace on each one — wiping the captured prompt and the assistant model info before the generation was built. A new trace now starts only for a genuinely new user message, and the generation resolves model/provider from the specific assistant message the step belongs to.
- e64cb41: Flush and shut down the PostHog client on plugin dispose so short-lived `opencode run` invocations reliably deliver their final events. Previously the plugin only flushed on `session.idle`, but `posthog-node`'s `flush()` resolves before the HTTP request completes, so a process that exits immediately could drop its last generation, span, and trace.
