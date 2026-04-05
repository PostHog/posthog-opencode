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
  currentAssistantMsg?: AssistantInfo
  currentGenerationSpanId?: string
  agentName?: string
}

export interface AssistantInfo {
  messageID: string
  modelID: string
  providerID: string
  error?: { name: string; data?: Record<string, unknown> }
}
