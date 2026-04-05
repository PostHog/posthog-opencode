import { randomUUID } from 'node:crypto'
import type { StepFinishPart, ToolStateCompleted, ToolStateError } from '@opencode-ai/sdk'
import type { AssistantInfo, PluginConfig, TraceState } from './types.js'
import { redactForPrivacy, serializeAttribute, serializeError } from './utils.js'
import { VERSION } from './version.js'

export interface CaptureEvent {
    event: string
    distinctId: string
    properties: Record<string, unknown>
}

const STOP_REASON_MAP: Record<string, string> = {
    stop: 'stop',
    length: 'length',
    'tool-calls': 'tool_calls',
    error: 'error',
}

export function mapStopReason(reason: string | undefined): string | null {
    if (!reason) return null
    return STOP_REASON_MAP[reason] ?? reason
}

export function buildAiGeneration(
    part: StepFinishPart,
    assistantInfo: AssistantInfo | undefined,
    trace: TraceState,
    config: PluginConfig
): CaptureEvent {
    // Use the span ID allocated at step-start so tool spans emitted
    // during this step already reference the correct parent.
    const spanId = trace.currentGenerationSpanId ?? randomUUID()

    // Use accumulated step input messages (includes user prompt + tool results)
    // for accurate per-roundtrip context.
    const inputMessages = redactForPrivacy(
        trace.stepInputMessages.length > 0 ? trace.stepInputMessages : null,
        config.privacyMode
    )

    const outputChoices = redactForPrivacy(
        trace.stepAssistantText ? [{ role: 'assistant', content: trace.stepAssistantText }] : null,
        config.privacyMode
    )

    return {
        event: '$ai_generation',
        distinctId: config.distinctId,
        properties: {
            $ai_trace_id: trace.traceId,
            $ai_session_id: trace.sessionId,
            $ai_span_id: spanId,
            $ai_model: assistantInfo?.modelID ?? 'unknown',
            $ai_provider: assistantInfo?.providerID ?? 'unknown',

            $ai_input_tokens: part.tokens.input,
            $ai_output_tokens: part.tokens.output,
            $ai_reasoning_tokens: part.tokens.reasoning,
            $ai_cache_read_input_tokens: part.tokens.cache.read,
            $ai_cache_creation_input_tokens: part.tokens.cache.write,

            $ai_total_cost_usd: part.cost,
            $ai_stop_reason: mapStopReason(part.reason),

            $ai_input: inputMessages,
            $ai_output_choices: outputChoices,

            $ai_is_error: !!assistantInfo?.error,
            $ai_error: serializeError(assistantInfo?.error, config.maxAttributeLength),

            $ai_lib: 'opencode-posthog',
            $ai_lib_version: VERSION,
            $ai_framework: 'opencode',
            $ai_project_name: config.projectName,
            $ai_agent_name: trace.agentName ?? config.projectName,
            ...config.tags,
        },
    }
}

export function buildAiSpan(
    toolName: string,
    toolState: ToolStateCompleted | ToolStateError,
    trace: TraceState,
    config: PluginConfig
): CaptureEvent {
    const spanId = randomUUID()
    const latency = (toolState.time.end - toolState.time.start) / 1000
    const isError = toolState.status === 'error'

    const inputState = redactForPrivacy(
        serializeAttribute(toolState.input, config.maxAttributeLength),
        config.privacyMode
    )

    let outputState: string | null = null
    if (!config.privacyMode) {
        if (toolState.status === 'completed') {
            outputState = serializeAttribute(toolState.output, config.maxAttributeLength)
        } else {
            outputState = serializeAttribute(toolState.error, config.maxAttributeLength)
        }
    }

    return {
        event: '$ai_span',
        distinctId: config.distinctId,
        properties: {
            $ai_trace_id: trace.traceId,
            $ai_session_id: trace.sessionId,
            $ai_span_id: spanId,
            $ai_parent_id: trace.currentGenerationSpanId ?? null,
            $ai_span_name: toolName,

            $ai_latency: latency,

            $ai_input_state: inputState,
            $ai_output_state: outputState,

            $ai_is_error: isError,
            $ai_error: isError
                ? serializeAttribute((toolState as ToolStateError).error, config.maxAttributeLength)
                : null,

            $ai_lib: 'opencode-posthog',
            $ai_lib_version: VERSION,
            $ai_framework: 'opencode',
            $ai_project_name: config.projectName,
            $ai_agent_name: trace.agentName ?? config.projectName,
            ...config.tags,
        },
    }
}

export function buildAiTrace(trace: TraceState, config: PluginConfig): CaptureEvent {
    const latency = (Date.now() - trace.startTime) / 1000

    return {
        event: '$ai_trace',
        distinctId: config.distinctId,
        properties: {
            $ai_trace_id: trace.traceId,
            $ai_session_id: trace.sessionId,
            $ai_latency: latency,
            $ai_span_name: config.projectName,

            $ai_input_state: redactForPrivacy(trace.userPrompt ?? null, config.privacyMode),
            $ai_output_state: redactForPrivacy(trace.lastAssistantText ?? null, config.privacyMode),

            $ai_total_input_tokens: trace.totalInputTokens,
            $ai_total_output_tokens: trace.totalOutputTokens,

            $ai_is_error: trace.hadError,
            $ai_error: trace.lastError ? serializeAttribute(trace.lastError, config.maxAttributeLength) : null,

            $ai_lib: 'opencode-posthog',
            $ai_lib_version: VERSION,
            $ai_framework: 'opencode',
            $ai_project_name: config.projectName,
            $ai_agent_name: trace.agentName ?? config.projectName,
            ...config.tags,
        },
    }
}
