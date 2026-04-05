import type { Plugin } from "@opencode-ai/plugin"
import type {
  Event,
  AssistantMessage,
  StepFinishPart,
  ToolPart,
  TextPart,
  ToolStateCompleted,
  ToolStateError,
} from "@opencode-ai/sdk"
import { randomUUID } from "node:crypto"
import { loadConfig } from "./utils.js"
import { buildAiGeneration, buildAiSpan, buildAiTrace } from "./events.js"
import type { AssistantInfo, TraceState } from "./types.js"
import type { CaptureEvent } from "./events.js"

export const PostHogPlugin: Plugin = async () => {
  const config = loadConfig()

  if (!config.enabled || !config.apiKey) return {}

  let client: import("posthog-node").PostHog | null = null

  async function ensureClient(): Promise<import("posthog-node").PostHog | null> {
    if (client) return client
    try {
      const { PostHog } = await import("posthog-node")
      client = new PostHog(config.apiKey, {
        host: config.host,
        flushAt: 20,
        flushInterval: 10_000,
      })
      return client
    } catch {
      return null
    }
  }

  function safeCapture(phClient: import("posthog-node").PostHog, event: CaptureEvent) {
    try {
      phClient.capture({
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
  const messageRoles = new Map<string, "user" | "assistant">()
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
      }
      traces.set(sessionId, trace)
    }
    return trace
  }

  function handleMessageUpdated(event: Event) {
    if (event.type !== "message.updated") return
    const msg = event.properties.info

    if (msg.role === "user") {
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
      }
      traces.set(msg.sessionID, trace)
      messageRoles.set(msg.id, "user")
    } else if (msg.role === "assistant") {
      const assistant = msg as AssistantMessage
      messageRoles.set(assistant.id, "assistant")

      const info: AssistantInfo = {
        messageID: assistant.id,
        modelID: assistant.modelID,
        providerID: assistant.providerID,
        error: assistant.error,
      }
      assistantMessages.set(assistant.id, info)

      // Update trace with current assistant info
      const trace = getOrCreateTrace(assistant.sessionID)
      trace.currentAssistantMsg = info
      if (assistant.error) {
        trace.hadError = true
        trace.lastError = JSON.stringify(assistant.error)
      }
    }
  }

  async function handlePartUpdated(event: Event) {
    if (event.type !== "message.part.updated") return
    const part = event.properties.part

    switch (part.type) {
      case "text":
        handleTextPart(part)
        break
      case "step-finish":
        await handleStepFinish(part)
        break
      case "tool":
        await handleToolPart(part)
        break
    }
  }

  function handleTextPart(part: TextPart) {
    const role = messageRoles.get(part.messageID)
    if (!role) return

    const trace = traces.get(part.sessionID)
    if (!trace) return

    if (role === "user") {
      trace.userPrompt = part.text
    } else if (role === "assistant") {
      trace.lastAssistantText = part.text
    }
  }

  async function handleStepFinish(part: StepFinishPart) {
    const phClient = await ensureClient()
    if (!phClient) return

    const trace = traces.get(part.sessionID)
    if (!trace) return

    const assistantInfo = trace.currentAssistantMsg

    // Accumulate tokens and cost
    trace.totalInputTokens += part.tokens.input
    trace.totalOutputTokens += part.tokens.output
    trace.totalCost += part.cost

    const generation = buildAiGeneration(part, assistantInfo, trace, config)
    safeCapture(phClient, generation)
  }

  async function handleToolPart(part: ToolPart) {
    if (part.state.status !== "completed" && part.state.status !== "error") return

    const phClient = await ensureClient()
    if (!phClient) return

    const trace = traces.get(part.sessionID)
    if (!trace) return

    const toolState = part.state as ToolStateCompleted | ToolStateError
    const span = buildAiSpan(part.tool, toolState, trace, config)
    safeCapture(phClient, span)

    if (part.state.status === "error") {
      trace.hadError = true
      trace.lastError = (part.state as ToolStateError).error
    }
  }

  async function handleSessionIdle(event: Event) {
    if (event.type !== "session.idle") return

    const phClient = await ensureClient()
    if (!phClient) return

    const sessionId = event.properties.sessionID
    const trace = traces.get(sessionId)
    if (!trace) return

    const traceEvent = buildAiTrace(trace, config)
    safeCapture(phClient, traceEvent)

    try {
      await phClient.flush()
    } catch {
      // ignore flush errors
    }

    // Clean up state for this trace cycle
    traces.delete(sessionId)
    // Clean up message roles for this session
    for (const [msgId, _] of messageRoles) {
      // We can't efficiently filter by session, so we leave them
      // They'll be overwritten on next use and are lightweight
    }
  }

  async function handleSessionError(event: Event) {
    if (event.type !== "session.error") return

    const sessionId = event.properties.sessionID
    if (!sessionId) return

    const trace = traces.get(sessionId)
    if (trace) {
      trace.hadError = true
      if (event.properties.error) {
        trace.lastError = JSON.stringify(event.properties.error)
      }
    }
  }

  // Initialize client eagerly
  await ensureClient()

  return {
    event: async ({ event }) => {
      try {
        switch (event.type) {
          case "message.updated":
            handleMessageUpdated(event)
            break
          case "message.part.updated":
            await handlePartUpdated(event)
            break
          case "session.idle":
            await handleSessionIdle(event)
            break
          case "session.error":
            await handleSessionError(event)
            break
        }
      } catch {
        // never crash OpenCode
      }
    },
  }
}
