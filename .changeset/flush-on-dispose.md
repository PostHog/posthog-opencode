---
'@posthog/opencode': patch
---

Flush and shut down the PostHog client on plugin dispose so short-lived `opencode run` invocations reliably deliver their final events. Previously the plugin only flushed on `session.idle`, but `posthog-node`'s `flush()` resolves before the HTTP request completes, so a process that exits immediately could drop its last generation, span, and trace.
