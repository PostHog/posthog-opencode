import { describe, it, expect } from "vitest"
import { buildAiGeneration, buildAiSpan, buildAiTrace, mapStopReason } from "./events.js"
import type { PluginConfig, TraceState, AssistantInfo } from "./types.js"
import type { StepFinishPart, ToolStateCompleted, ToolStateError } from "@opencode-ai/sdk"

const defaultConfig: PluginConfig = {
  apiKey: "test-key",
  host: "https://us.i.posthog.com",
  privacyMode: false,
  enabled: true,
  distinctId: "test-host",
  projectName: "my-project",
  tags: {},
  maxAttributeLength: 12000,
}

const privacyConfig: PluginConfig = {
  ...defaultConfig,
  privacyMode: true,
}

const configWithTags: PluginConfig = {
  ...defaultConfig,
  tags: { team: "platform", env: "staging" },
}

function makeStepFinish(overrides?: Partial<StepFinishPart>): StepFinishPart {
  return {
    id: "part-1",
    sessionID: "session-1",
    messageID: "msg-1",
    type: "step-finish",
    reason: "stop",
    cost: 0.003,
    tokens: {
      input: 100,
      output: 50,
      reasoning: 10,
      cache: { read: 5, write: 3 },
    },
    ...overrides,
  }
}

function makeTrace(overrides?: Partial<TraceState>): TraceState {
  return {
    traceId: "trace-123",
    sessionId: "session-1",
    startTime: Date.now() - 5000,
    totalInputTokens: 500,
    totalOutputTokens: 200,
    totalCost: 0.01,
    hadError: false,
    agentName: "my-project",
    currentGenerationSpanId: "gen-span-1",
    userPrompt: "Hello",
    lastAssistantText: "Hi there!",
    stepInputMessages: [{ role: "user", content: "Hello" }],
    stepAssistantText: "Hi there!",
    messageIds: new Set<string>(),
    ...overrides,
  }
}

function makeAssistantInfo(overrides?: Partial<AssistantInfo>): AssistantInfo {
  return {
    messageID: "msg-1",
    modelID: "claude-sonnet-4-20250514",
    providerID: "anthropic",
    ...overrides,
  }
}

describe("mapStopReason", () => {
  it("maps known stop reasons", () => {
    expect(mapStopReason("stop")).toBe("stop")
    expect(mapStopReason("length")).toBe("length")
    expect(mapStopReason("tool-calls")).toBe("tool_calls")
    expect(mapStopReason("error")).toBe("error")
  })

  it("returns null for undefined", () => {
    expect(mapStopReason(undefined)).toBeNull()
  })

  it("passes through unknown reasons", () => {
    expect(mapStopReason("custom_reason")).toBe("custom_reason")
  })
})

describe("buildAiGeneration", () => {
  it("builds generation event with all fields", () => {
    const part = makeStepFinish()
    const trace = makeTrace()
    const assistant = makeAssistantInfo()

    const result = buildAiGeneration(part, assistant, trace, defaultConfig)

    expect(result.event).toBe("$ai_generation")
    expect(result.distinctId).toBe("test-host")
    expect(result.properties.$ai_model).toBe("claude-sonnet-4-20250514")
    expect(result.properties.$ai_provider).toBe("anthropic")
    expect(result.properties.$ai_input_tokens).toBe(100)
    expect(result.properties.$ai_output_tokens).toBe(50)
    expect(result.properties.$ai_reasoning_tokens).toBe(10)
    expect(result.properties.$ai_cache_read_input_tokens).toBe(5)
    expect(result.properties.$ai_cache_creation_input_tokens).toBe(3)
    expect(result.properties.$ai_total_cost_usd).toBe(0.003)
    expect(result.properties.$ai_stop_reason).toBe("stop")
    expect(result.properties.$ai_is_error).toBe(false)
    expect(result.properties.$ai_trace_id).toBe("trace-123")
    expect(result.properties.$ai_span_id).toBe("gen-span-1")
    expect(result.properties.$ai_session_id).toBe("session-1")
    expect(result.properties.$ai_lib).toBe("opencode-posthog")
    expect(result.properties.$ai_framework).toBe("opencode")
    expect(result.properties.$ai_project_name).toBe("my-project")
    expect(result.properties.$ai_agent_name).toBe("my-project")
  })

  it("uses pre-allocated span ID from trace", () => {
    const trace = makeTrace({ currentGenerationSpanId: "pre-allocated-id" })
    const result = buildAiGeneration(makeStepFinish(), makeAssistantInfo(), trace, defaultConfig)
    expect(result.properties.$ai_span_id).toBe("pre-allocated-id")
  })

  it("falls back to random UUID when no pre-allocated span ID", () => {
    const trace = makeTrace({ currentGenerationSpanId: undefined })
    const result = buildAiGeneration(makeStepFinish(), makeAssistantInfo(), trace, defaultConfig)
    expect(result.properties.$ai_span_id).toBeDefined()
    expect(typeof result.properties.$ai_span_id).toBe("string")
  })

  it("includes input and output content from step messages", () => {
    const trace = makeTrace({
      userPrompt: "What is 2+2?",
      stepInputMessages: [{ role: "user", content: "What is 2+2?" }],
      stepAssistantText: "4",
      lastAssistantText: "4",
    })
    const result = buildAiGeneration(makeStepFinish(), makeAssistantInfo(), trace, defaultConfig)
    expect(result.properties.$ai_input).toEqual([{ role: "user", content: "What is 2+2?" }])
    expect(result.properties.$ai_output_choices).toEqual([{ role: "assistant", content: "4" }])
  })

  it("includes tool results in input for multi-step generations", () => {
    const trace = makeTrace({
      stepInputMessages: [
        { role: "user", content: "Read the file" },
        { role: "tool", content: "[read] file contents here" },
      ],
      stepAssistantText: "I read the file.",
    })
    const result = buildAiGeneration(makeStepFinish(), makeAssistantInfo(), trace, defaultConfig)
    expect(result.properties.$ai_input).toEqual([
      { role: "user", content: "Read the file" },
      { role: "tool", content: "[read] file contents here" },
    ])
    expect(result.properties.$ai_output_choices).toEqual([
      { role: "assistant", content: "I read the file." },
    ])
  })

  it("redacts content in privacy mode", () => {
    const trace = makeTrace()
    const result = buildAiGeneration(makeStepFinish(), makeAssistantInfo(), trace, privacyConfig)
    expect(result.properties.$ai_input).toBeNull()
    expect(result.properties.$ai_output_choices).toBeNull()
  })

  it("marks error generations", () => {
    const assistant = makeAssistantInfo({
      error: { name: "UnknownError", data: { message: "Rate limited" } },
    })
    const result = buildAiGeneration(makeStepFinish(), assistant, makeTrace(), defaultConfig)
    expect(result.properties.$ai_is_error).toBe(true)
    expect(result.properties.$ai_error).toContain("Rate limited")
  })

  it("falls back to unknown model when no assistant info", () => {
    const result = buildAiGeneration(makeStepFinish(), undefined, makeTrace(), defaultConfig)
    expect(result.properties.$ai_model).toBe("unknown")
    expect(result.properties.$ai_provider).toBe("unknown")
  })

  it("includes custom tags", () => {
    const result = buildAiGeneration(
      makeStepFinish(),
      makeAssistantInfo(),
      makeTrace(),
      configWithTags,
    )
    expect(result.properties.team).toBe("platform")
    expect(result.properties.env).toBe("staging")
  })
})

describe("buildAiSpan", () => {
  const completedState: ToolStateCompleted = {
    status: "completed",
    input: { command: "ls -la" },
    output: "file1.txt\nfile2.txt",
    title: "bash",
    metadata: {},
    time: { start: 1000, end: 1250 },
  }

  const errorState: ToolStateError = {
    status: "error",
    input: { command: "bad-cmd" },
    error: "command not found",
    time: { start: 1000, end: 1050 },
  }

  it("builds span event for completed tool", () => {
    const trace = makeTrace()
    const result = buildAiSpan("bash", completedState, trace, defaultConfig)

    expect(result.event).toBe("$ai_span")
    expect(result.distinctId).toBe("test-host")
    expect(result.properties.$ai_trace_id).toBe("trace-123")
    expect(result.properties.$ai_parent_id).toBe("gen-span-1")
    expect(result.properties.$ai_span_name).toBe("bash")
    expect(result.properties.$ai_latency).toBe(0.25)
    expect(result.properties.$ai_is_error).toBe(false)
    expect(result.properties.$ai_error).toBeNull()
    expect(result.properties.$ai_input_state).toBe('{"command":"ls -la"}')
    expect(result.properties.$ai_output_state).toBe("file1.txt\nfile2.txt")
    expect(result.properties.$ai_lib).toBe("opencode-posthog")
    expect(result.properties.$ai_framework).toBe("opencode")
  })

  it("uses currentGenerationSpanId as parent", () => {
    const trace = makeTrace({ currentGenerationSpanId: "parent-gen-42" })
    const result = buildAiSpan("read", completedState, trace, defaultConfig)
    expect(result.properties.$ai_parent_id).toBe("parent-gen-42")
  })

  it("sets parent to null when no generation span ID", () => {
    const trace = makeTrace({ currentGenerationSpanId: undefined })
    const result = buildAiSpan("read", completedState, trace, defaultConfig)
    expect(result.properties.$ai_parent_id).toBeNull()
  })

  it("redacts tool input/output in privacy mode", () => {
    const result = buildAiSpan("read", completedState, makeTrace(), privacyConfig)
    expect(result.properties.$ai_input_state).toBeNull()
    expect(result.properties.$ai_output_state).toBeNull()
  })

  it("redacts sensitive keys in tool input", () => {
    const stateWithSecrets: ToolStateCompleted = {
      ...completedState,
      input: {
        command: "curl",
        api_key: "sk-secret-123",
        headers: { authorization: "Bearer tok" },
      },
    }
    const result = buildAiSpan("bash", stateWithSecrets, makeTrace(), defaultConfig)
    const inputState = result.properties.$ai_input_state as string
    expect(inputState).toContain("[REDACTED]")
    expect(inputState).not.toContain("sk-secret-123")
    expect(inputState).not.toContain("Bearer tok")
    expect(inputState).toContain("curl")
  })

  it("captures error info", () => {
    const result = buildAiSpan("bash", errorState, makeTrace(), defaultConfig)
    expect(result.properties.$ai_is_error).toBe(true)
    expect(result.properties.$ai_error).toBe("command not found")
    expect(result.properties.$ai_latency).toBe(0.05)
  })

  it("includes custom tags", () => {
    const result = buildAiSpan("read", completedState, makeTrace(), configWithTags)
    expect(result.properties.team).toBe("platform")
    expect(result.properties.env).toBe("staging")
  })
})

describe("buildAiTrace", () => {
  it("builds trace event with accumulated totals", () => {
    const trace = makeTrace()
    const result = buildAiTrace(trace, defaultConfig)

    expect(result.event).toBe("$ai_trace")
    expect(result.distinctId).toBe("test-host")
    expect(result.properties.$ai_trace_id).toBe("trace-123")
    expect(result.properties.$ai_session_id).toBe("session-1")
    expect(result.properties.$ai_latency).toBeGreaterThan(0)
    expect(result.properties.$ai_total_input_tokens).toBe(500)
    expect(result.properties.$ai_total_output_tokens).toBe(200)
    expect(result.properties.$ai_is_error).toBe(false)
    expect(result.properties.$ai_span_name).toBe("my-project")
    expect(result.properties.$ai_lib).toBe("opencode-posthog")
    expect(result.properties.$ai_framework).toBe("opencode")
  })

  it("includes user prompt and assistant text", () => {
    const trace = makeTrace({
      userPrompt: "Explain X",
      lastAssistantText: "X is...",
    })
    const result = buildAiTrace(trace, defaultConfig)
    expect(result.properties.$ai_input_state).toBe("Explain X")
    expect(result.properties.$ai_output_state).toBe("X is...")
  })

  it("redacts content in privacy mode", () => {
    const trace = makeTrace({
      userPrompt: "secret prompt",
      lastAssistantText: "secret response",
    })
    const result = buildAiTrace(trace, privacyConfig)
    expect(result.properties.$ai_input_state).toBeNull()
    expect(result.properties.$ai_output_state).toBeNull()
    // Metrics still flow
    expect(result.properties.$ai_total_input_tokens).toBe(500)
    expect(result.properties.$ai_total_output_tokens).toBe(200)
  })

  it("captures error traces", () => {
    const trace = makeTrace({
      hadError: true,
      lastError: "Context overflow",
    })
    const result = buildAiTrace(trace, defaultConfig)
    expect(result.properties.$ai_is_error).toBe(true)
    expect(result.properties.$ai_error).toBe("Context overflow")
  })

  it("includes custom tags", () => {
    const result = buildAiTrace(makeTrace(), configWithTags)
    expect(result.properties.team).toBe("platform")
    expect(result.properties.env).toBe("staging")
  })
})
