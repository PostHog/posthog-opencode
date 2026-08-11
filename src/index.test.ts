import { describe, it, expect, beforeEach, vi } from 'vitest'

// Capture everything the plugin sends, without touching the network.
const captured: Array<{ event: string; properties: Record<string, unknown> }> = []

vi.mock('posthog-node', () => ({
    PostHog: class {
        capture(e: { event: string; properties: Record<string, unknown> }) {
            captured.push(e)
        }
        async flush() {}
        async shutdown() {}
    },
}))

import { PostHogPlugin } from './index.js'

type AnyEvent = { type: string; properties: Record<string, unknown> }

async function run(events: AnyEvent[]) {
    process.env.POSTHOG_API_KEY = 'phc_test'
    const hooks = (await PostHogPlugin({} as never)) as { event: (i: { event: AnyEvent }) => Promise<void> }
    // oxlint-disable-next-line no-await-in-loop -- Event order is significant.
    for (const event of events) await hooks.event({ event })
}

const S = 'ses_test'
const U = 'msg_user_1'
const A = 'msg_asst_1'

beforeEach(() => {
    captured.length = 0
})

describe('trace state machine (real OpenCode event ordering)', () => {
    it('captures input and model even when the user message.updated repeats (regression: trace reset)', async () => {
        // OpenCode emits message.updated for the same user message several times
        // per turn. A repeat must not reset the trace and wipe accumulated state.
        await run([
            {
                type: 'message.updated',
                properties: { info: { role: 'user', id: U, sessionID: S, time: { created: 1 }, agent: 'build' } },
            },
            {
                type: 'message.part.updated',
                properties: { part: { type: 'text', messageID: U, sessionID: S, text: 'tell me a joke' } },
            },
            {
                type: 'message.updated',
                properties: {
                    info: {
                        role: 'assistant',
                        id: A,
                        sessionID: S,
                        modelID: 'gpt-5.4-mini',
                        providerID: 'openai',
                        time: { created: 1 },
                    },
                },
            },
            // duplicate user update — previously reset the trace
            {
                type: 'message.updated',
                properties: { info: { role: 'user', id: U, sessionID: S, time: { created: 1 }, agent: 'build' } },
            },
            { type: 'message.part.updated', properties: { part: { type: 'step-start', sessionID: S, messageID: A } } },
            {
                type: 'message.part.updated',
                properties: {
                    part: { type: 'text', messageID: A, sessionID: S, text: 'Because light attracts bugs.' },
                },
            },
            {
                type: 'message.part.updated',
                properties: {
                    part: {
                        type: 'step-finish',
                        sessionID: S,
                        messageID: A,
                        tokens: { input: 22436, output: 18, reasoning: 0, cache: { read: 0, write: 0 } },
                        cost: 0,
                        reason: 'stop',
                    },
                },
            },
            // another duplicate user update after step-finish
            {
                type: 'message.updated',
                properties: { info: { role: 'user', id: U, sessionID: S, time: { created: 1 }, agent: 'build' } },
            },
            { type: 'session.idle', properties: { sessionID: S } },
        ])

        const gen = captured.find((e) => e.event === '$ai_generation')
        const trace = captured.find((e) => e.event === '$ai_trace')

        expect(gen).toBeDefined()
        expect(gen!.properties.$ai_model).toBe('gpt-5.4-mini')
        expect(gen!.properties.$ai_provider).toBe('openai')
        expect(gen!.properties.$ai_input).toEqual([{ role: 'user', content: 'tell me a joke' }])

        expect(trace).toBeDefined()
        expect(trace!.properties.$ai_input_state).toBe('tell me a joke')

        // exactly one trace per user message (no duplicate traces from repeats)
        expect(captured.filter((e) => e.event === '$ai_trace')).toHaveLength(1)
    })

    it("attributes each step's tool calls in invocation order when parallel tools finish out of order", async () => {
        // Two steps: the first calls parallel tools, the second answers from their results.
        const tool = (name: string, id: string, status: 'running' | 'completed') => ({
            type: 'message.part.updated',
            properties: {
                part: {
                    type: 'tool',
                    id,
                    callID: id,
                    sessionID: S,
                    messageID: A,
                    tool: name,
                    state:
                        status === 'running'
                            ? {
                                  status,
                                  input: { path: 'a.txt' },
                                  time: { start: 0 },
                              }
                            : {
                                  status,
                                  input: { path: 'a.txt' },
                                  output: 'file contents',
                                  time: { start: 0, end: 1000 },
                              },
                },
            },
        })
        const stepFinish = () => ({
            type: 'message.part.updated',
            properties: {
                part: {
                    type: 'step-finish',
                    sessionID: S,
                    messageID: A,
                    tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
                    cost: 0,
                    reason: 'tool-calls',
                },
            },
        })

        await run([
            {
                type: 'message.updated',
                properties: { info: { role: 'user', id: U, sessionID: S, time: { created: 1 }, agent: 'build' } },
            },
            {
                type: 'message.part.updated',
                properties: { part: { type: 'text', messageID: U, sessionID: S, text: 'read a.txt' } },
            },
            {
                type: 'message.updated',
                properties: {
                    info: {
                        role: 'assistant',
                        id: A,
                        sessionID: S,
                        modelID: 'gpt-5.4-mini',
                        providerID: 'openai',
                        time: { created: 1 },
                    },
                },
            },
            // step 1 — invokes read before edit, but edit completes first
            { type: 'message.part.updated', properties: { part: { type: 'step-start', sessionID: S, messageID: A } } },
            tool('read', 'part-tool-1', 'running'),
            tool('edit', 'part-tool-2', 'running'),
            tool('edit', 'part-tool-2', 'completed'),
            tool('read', 'part-tool-1', 'completed'),
            stepFinish(),
            // step 2 — pure text answer, no tools
            { type: 'message.part.updated', properties: { part: { type: 'step-start', sessionID: S, messageID: A } } },
            {
                type: 'message.part.updated',
                properties: { part: { type: 'text', messageID: A, sessionID: S, text: 'Done.' } },
            },
            stepFinish(),
            { type: 'session.idle', properties: { sessionID: S } },
        ])

        const generations = captured.filter((e) => e.event === '$ai_generation')
        expect(generations).toHaveLength(2)

        // Step 1 reports both tools in invocation order, as a canonical string;
        // step 2 reports none.
        expect(generations[0].properties.$ai_tools_called).toBe('read,edit')
        expect(generations[1].properties.$ai_tools_called).toBeNull()

        // Spans still arrive in completion order and are parented to the same generation.
        const spans = captured.filter((e) => e.event === '$ai_span')
        expect(spans.map((s) => s.properties.$ai_span_name)).toEqual(['edit', 'read'])
        for (const span of spans) {
            expect(span.properties.$ai_parent_id).toBe(generations[0].properties.$ai_span_id)
        }
    })
})
