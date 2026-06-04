---
'@posthog/opencode': patch
---

Fix missing `$ai_input` and `$ai_model`/`$ai_provider` on generations and traces. OpenCode emits `message.updated` for the same user message several times per turn, and the plugin was starting a fresh trace on each one — wiping the captured prompt and the assistant model info before the generation was built. A new trace now starts only for a genuinely new user message, and the generation resolves model/provider from the specific assistant message the step belongs to.
