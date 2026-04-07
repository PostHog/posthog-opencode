# opencode-posthog

PostHog LLM Analytics plugin for [OpenCode](https://opencode.ai). Captures LLM generations, tool executions, and conversation traces, sending them to PostHog as structured `$ai_*` events for the LLM Analytics dashboard.

## Installation

Add `opencode-posthog` to your `opencode.json`:

```json
{
    "$schema": "https://opencode.ai/config.json",
    "plugin": ["opencode-posthog"]
}
```

The package is installed automatically at startup and cached in `~/.cache/opencode/node_modules/`.

### Local development

Place the plugin source in your project's `.opencode/plugins/` directory (or `~/.config/opencode/plugins/` for global use). Add `posthog-node` to `.opencode/package.json` so OpenCode installs it at startup:

```json
{
    "dependencies": {
        "posthog-node": "^5.0.0"
    }
}
```

## Configuration

All configuration is via environment variables:

| Variable                       | Default                    | Description                                     |
| ------------------------------ | -------------------------- | ----------------------------------------------- |
| `POSTHOG_API_KEY`              | _(required)_               | PostHog project API key                         |
| `POSTHOG_HOST`                 | `https://us.i.posthog.com` | PostHog instance URL                            |
| `POSTHOG_PRIVACY_MODE`         | `false`                    | Redact all LLM input/output content when `true` |
| `POSTHOG_ENABLED`              | `true`                     | Set `false` to disable                          |
| `POSTHOG_DISTINCT_ID`          | machine hostname           | The `distinct_id` for all events                |
| `POSTHOG_PROJECT_NAME`         | cwd basename               | Project name in all events                      |
| `POSTHOG_TAGS`                 | _(none)_                   | Custom tags: `key1:val1,key2:val2`              |
| `POSTHOG_MAX_ATTRIBUTE_LENGTH` | `12000`                    | Max length for serialized tool input/output     |

If `POSTHOG_API_KEY` is not set, the plugin is a no-op.

## Events

### `$ai_generation` — per LLM call

Emitted for each LLM roundtrip (step-finish part). Properties include:

- `$ai_model`, `$ai_provider` — model and provider identifiers
- `$ai_input_tokens`, `$ai_output_tokens`, `$ai_reasoning_tokens` — token counts
- `$ai_cache_read_input_tokens`, `$ai_cache_creation_input_tokens` — cache token counts
- `$ai_total_cost_usd` — cost in USD
- `$ai_latency` — not available per-step (use trace-level latency)
- `$ai_stop_reason` — `stop`, `tool_calls`, `error`, etc.
- `$ai_input`, `$ai_output_choices` — message content (null in privacy mode)
- `$ai_trace_id`, `$ai_span_id`, `$ai_session_id` — correlation IDs

### `$ai_span` — per tool execution

Emitted when a tool call completes or errors. Properties include:

- `$ai_span_name` — tool name (`read`, `write`, `bash`, `edit`, etc.)
- `$ai_latency` — execution time in seconds
- `$ai_input_state`, `$ai_output_state` — tool input/output (null in privacy mode)
- `$ai_parent_id` — span ID of the generation that triggered this tool
- `$ai_is_error`, `$ai_error` — error status

### `$ai_trace` — per user prompt

Emitted on `session.idle` (agent finished responding). Properties include:

- `$ai_trace_id`, `$ai_session_id` — correlation IDs
- `$ai_latency` — total trace time in seconds
- `$ai_total_input_tokens`, `$ai_total_output_tokens` — accumulated token counts
- `$ai_input_state`, `$ai_output_state` — user prompt and final response
- `$ai_is_error` — whether any step/tool errored

## Privacy

When `POSTHOG_PRIVACY_MODE=true`, all content fields (`$ai_input`, `$ai_output_choices`, `$ai_input_state`, `$ai_output_state`) are set to `null`. Token counts, costs, latency, and model metadata still flow.

Sensitive keys (matching `api_key`, `token`, `secret`, `password`, `authorization`, `credential`, `private_key`) are always redacted in tool inputs/outputs regardless of privacy mode.

## License

MIT
