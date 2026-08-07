# @posthog/opencode

## 0.1.0

### Minor Changes

- b34542d: Align releases with PostHog Pi by publishing pending changesets after they reach `main`.
- 35efee1: Adopt as the official PostHog LLM Analytics plugin for OpenCode and align packaging with the PostHog standard: publish as `@posthog/opencode`, migrate the toolchain from bun to pnpm, and adopt the approval-gated release workflow with npm OIDC trusted publishing and provenance.

### Patch Changes

- 1ab7a60: Fix missing `$ai_input` and `$ai_model`/`$ai_provider` on generations and traces. OpenCode emits `message.updated` for the same user message several times per turn, and the plugin was starting a fresh trace on each one — wiping the captured prompt and the assistant model info before the generation was built. A new trace now starts only for a genuinely new user message, and the generation resolves model/provider from the specific assistant message the step belongs to.
- e64cb41: Flush and shut down the PostHog client on plugin dispose so short-lived `opencode run` invocations reliably deliver their final events. Previously the plugin only flushed on `session.idle`, but `posthog-node`'s `flush()` resolves before the HTTP request completes, so a process that exits immediately could drop its last generation, span, and trace.
