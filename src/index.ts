import type { Plugin } from '@opencode-ai/plugin'
import type {
    Event,
    AssistantMessage,
    StepStartPart,
    StepFinishPart,
    ToolPart,
    TextPart,
    ToolStateCompleted,
    ToolStateError,
} from '@opencode-ai/sdk'
import { PostHog } from 'posthog-node'
import { randomUUID } from 'node:crypto'
import { loadConfig, serializeAttribute } from './utils.js'
import { buildAiGeneration, buildAiSpan, buildAiTrace } from './events.js'
import type { AssistantInfo, TraceState } from './types.js'
import type { CaptureEvent } from './events.js'

export const PostHogPlugin: Plugin = async () => {
    const config = loadConfig()

    if (!config.enabled || !config.apiKey) return {}

    const client = new PostHog(config.apiKey, {
        host: config.host,
        flushAt: 20,
        flushInterval: 10_000,
    })

    function safeCapture(event: CaptureEvent) {
        try {
            client.capture({
                distinctId: event.distinctId,
                event: event.event,
                properties: event.properties,
            })
        } catch {
            // never crash the host
        }
    }

    // State: sessionID -> trace state
    const traces = new Map<string, TraceState>()
    // State: messageID -> role for correlating parts to messages
    const messageRoles = new Map<string, 'user' | 'assistant'>()
    // State: messageID -> assistant info
    const assistantMessages = new Map<string, AssistantInfo>()

    function getOrCreateTrace(sessionId: string): TraceState {
        let trace = traces.get(sessionId)
        if (!trace) {
            trace = {
                traceId: randomUUID(),
                sessionId,
                startTime: Date.now(),
                totalInputTokens: 0,
                totalOutputTokens: 0,
                totalCost: 0,
                hadError: false,
                stepInputMessages: [],
                stepInputSnapshot: [],
                messageIds: new Set(),
            }
            traces.set(sessionId, trace)
        }
        return trace
    }

    function handleMessageUpdated(event: Event) {
        if (event.type !== 'message.updated') return
        const msg = event.properties.info

        if (msg.role === 'user') {
            // New user message → new trace
            const trace: TraceState = {
                traceId: randomUUID(),
                sessionId: msg.sessionID,
                startTime: msg.time.created,
                totalInputTokens: 0,
                totalOutputTokens: 0,
                totalCost: 0,
                hadError: false,
                agentName: msg.agent,
                stepInputMessages: [],
                stepInputSnapshot: [],
                messageIds: new Set([msg.id]),
            }
            traces.set(msg.sessionID, trace)
            messageRoles.set(msg.id, 'user')
        } else if (msg.role === 'assistant') {
            const assistant = msg as AssistantMessage
            messageRoles.set(assistant.id, 'assistant')

            const info: AssistantInfo = {
                messageID: assistant.id,
                modelID: assistant.modelID,
                providerID: assistant.providerID,
                error: assistant.error,
            }
            assistantMessages.set(assistant.id, info)

            // Update trace with current assistant info
            const trace = getOrCreateTrace(assistant.sessionID)
            trace.messageIds.add(assistant.id)
            trace.currentAssistantMsg = info
            if (assistant.error) {
                trace.hadError = true
                trace.lastError = serializeAttribute(assistant.error, config.maxAttributeLength) ?? assistant.error.name
            }
        }
    }

    function handlePartUpdated(event: Event) {
        if (event.type !== 'message.part.updated') return
        const part = event.properties.part

        switch (part.type) {
            case 'text':
                handleTextPart(part)
                break
            case 'step-start':
                handleStepStart(part)
                break
            case 'step-finish':
                handleStepFinish(part)
                break
            case 'tool':
                handleToolPart(part)
                break
        }
    }

    function handleTextPart(part: TextPart) {
        const role = messageRoles.get(part.messageID)
        if (!role) return

        const trace = traces.get(part.sessionID)
        if (!trace) return

        if (role === 'user') {
            trace.userPrompt = part.text
            trace.stepInputMessages.push({ role: 'user', content: part.text })
        } else if (role === 'assistant') {
            trace.lastAssistantText = part.text
            trace.stepAssistantText = part.text
        }
    }

    function handleStepStart(part: StepStartPart) {
        const trace = traces.get(part.sessionID)
        if (!trace) return
        // Allocate the generation span ID eagerly so that tool spans
        // emitted during this step can reference it as their parent.
        trace.currentGenerationSpanId = randomUUID()
        // Snapshot current input messages before tools run, so the
        // generation reports only what the model saw as input, not
        // the tool results from the current step.
        trace.stepInputSnapshot = [...trace.stepInputMessages]
        // Reset per-step assistant text for the new generation
        trace.stepAssistantText = undefined
    }

    function handleStepFinish(part: StepFinishPart) {
        const trace = traces.get(part.sessionID)
        if (!trace) return

        const assistantInfo = trace.currentAssistantMsg

        // Accumulate tokens and cost
        trace.totalInputTokens += part.tokens.input
        trace.totalOutputTokens += part.tokens.output
        trace.totalCost += part.cost

        const generation = buildAiGeneration(part, assistantInfo, trace, config)
        safeCapture(generation)
    }

    function handleToolPart(part: ToolPart) {
        if (part.state.status !== 'completed' && part.state.status !== 'error') return

        const trace = traces.get(part.sessionID)
        if (!trace) return

        const toolState = part.state as ToolStateCompleted | ToolStateError
        const span = buildAiSpan(part.tool, toolState, trace, config)
        safeCapture(span)

        // Feed tool result into step input so subsequent generations include
        // the tool context the model actually saw. Redact and truncate to
        // match the treatment applied to $ai_span fields.
        if (toolState.status === 'completed') {
            const redacted = serializeAttribute(toolState.output, config.maxAttributeLength) ?? ''
            trace.stepInputMessages.push({
                role: 'tool',
                content: `[${part.tool}] ${redacted}`,
            })
        } else {
            const redacted = serializeAttribute(toolState.error, config.maxAttributeLength) ?? ''
            trace.stepInputMessages.push({
                role: 'tool',
                content: `[${part.tool}] ERROR: ${redacted}`,
            })
            trace.hadError = true
            trace.lastError = toolState.error
        }
    }

    async function handleSessionIdle(event: Event) {
        if (event.type !== 'session.idle') return

        const sessionId = event.properties.sessionID
        const trace = traces.get(sessionId)
        if (!trace) return

        const traceEvent = buildAiTrace(trace, config)
        safeCapture(traceEvent)

        try {
            await client.flush()
        } catch {
            // ignore flush errors
        }

        // Clean up per-message state for this trace
        for (const msgId of trace.messageIds) {
            messageRoles.delete(msgId)
            assistantMessages.delete(msgId)
        }
        traces.delete(sessionId)
    }

    function handleSessionError(event: Event) {
        if (event.type !== 'session.error') return

        const sessionId = event.properties.sessionID
        if (!sessionId) return

        const trace = traces.get(sessionId)
        if (trace) {
            trace.hadError = true
            if (event.properties.error) {
                trace.lastError =
                    serializeAttribute(event.properties.error, config.maxAttributeLength) ?? 'unknown error'
            }
        }
    }

    let disposed = false

    return {
        event: async ({ event }) => {
            try {
                switch (event.type) {
                    case 'message.updated':
                        handleMessageUpdated(event)
                        break
                    case 'message.part.updated':
                        handlePartUpdated(event)
                        break
                    case 'session.idle':
                        await handleSessionIdle(event)
                        break
                    case 'session.error':
                        handleSessionError(event)
                        break
                }
            } catch {
                // never crash OpenCode
            }
        },
        // Flush and shut down the PostHog client when OpenCode tears the plugin
        // down. posthog-node's flush() resolves before the HTTP send actually
        // completes, so a short-lived `opencode run` invocation would otherwise
        // exit and drop its final events. shutdown() drains all pending events and
        // awaits the network round-trip. OpenCode awaits this dispose hook during
        // teardown (it is registered as a scope finalizer).
        dispose: async () => {
            if (disposed) return
            disposed = true
            try {
                await client.shutdown()
            } catch {
                // never crash OpenCode
            }
        },
    }
}
