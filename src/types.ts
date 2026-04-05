export interface PluginConfig {
    apiKey: string
    host: string
    privacyMode: boolean
    enabled: boolean
    distinctId: string
    projectName: string
    tags: Record<string, string>
    maxAttributeLength: number
}

export interface InputMessage {
    role: string
    content: string
}

export interface TraceState {
    traceId: string
    sessionId: string
    startTime: number
    totalInputTokens: number
    totalOutputTokens: number
    totalCost: number
    hadError: boolean
    lastError?: string
    userPrompt?: string
    lastAssistantText?: string
    /** Accumulated input context across steps (user prompt + tool results from prior steps). */
    stepInputMessages: InputMessage[]
    /** Snapshot of stepInputMessages taken at step-start, used as $ai_input for the generation. */
    stepInputSnapshot: InputMessage[]
    /** Assistant text accumulated during the current step, reset on each step-start. */
    stepAssistantText?: string
    currentAssistantMsg?: AssistantInfo
    currentGenerationSpanId?: string
    agentName?: string
    /** Message IDs belonging to this trace, for cleanup. */
    messageIds: Set<string>
}

export interface AssistantInfo {
    messageID: string
    modelID: string
    providerID: string
    error?: { name: string; data?: Record<string, unknown> }
}
