import { createServer } from 'node:http'
import { gunzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PostHogPlugin } from './index.js'

type AnyEvent = { type: string; properties: Record<string, unknown> }

const originalEnv = {
    apiKey: process.env.POSTHOG_API_KEY,
    enabled: process.env.POSTHOG_ENABLED,
    host: process.env.POSTHOG_HOST,
    timezone: process.env.TZ,
}

afterEach(() => {
    vi.useRealTimers()
    for (const [key, value] of Object.entries({
        POSTHOG_API_KEY: originalEnv.apiKey,
        POSTHOG_ENABLED: originalEnv.enabled,
        POSTHOG_HOST: originalEnv.host,
        TZ: originalEnv.timezone,
    })) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
    }
})

describe('event timestamps', () => {
    it('lets posthog-node add an exact UTC timestamp to the serialized event', async () => {
        process.env.TZ = 'America/Los_Angeles'
        const localTime = new Date(2024, 6, 1, 12, 34, 56, 789)
        expect(localTime.getTimezoneOffset()).toBe(420)
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(localTime)

        const bodies: Buffer[] = []
        const server = createServer((request, response) => {
            const chunks: Buffer[] = []
            request.on('data', (chunk: Buffer) => chunks.push(chunk))
            request.on('end', () => {
                const body = Buffer.concat(chunks)
                bodies.push(request.headers['content-encoding'] === 'gzip' ? gunzipSync(body) : body)
                response.writeHead(200, { 'content-type': 'application/json' })
                response.end('{}')
            })
        })
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

        try {
            const address = server.address()
            if (!address || typeof address === 'string') throw new Error('Expected TCP server address')
            process.env.POSTHOG_API_KEY = 'phc_test'
            process.env.POSTHOG_ENABLED = 'true'
            process.env.POSTHOG_HOST = `http://127.0.0.1:${address.port}`

            const hooks = (await PostHogPlugin({} as never)) as {
                event: (input: { event: AnyEvent }) => Promise<void>
                dispose: () => Promise<void>
            }
            const sessionID = 'session-timestamp'
            const messageID = 'message-timestamp'

            await hooks.event({
                event: {
                    type: 'message.updated',
                    properties: {
                        info: {
                            role: 'assistant',
                            id: messageID,
                            sessionID,
                            modelID: 'test-model',
                            providerID: 'test-provider',
                        },
                    },
                },
            })
            await hooks.event({
                event: {
                    type: 'message.part.updated',
                    properties: {
                        part: {
                            type: 'step-finish',
                            sessionID,
                            messageID,
                            tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
                            cost: 0,
                            reason: 'stop',
                        },
                    },
                },
            })
            await hooks.dispose()

            expect(bodies).toHaveLength(1)
            const payload = JSON.parse(bodies[0].toString()) as {
                sent_at: string
                batch: Array<{ event: string; timestamp: string }>
            }
            expect(payload.sent_at).toBe('2024-07-01T19:34:56.789Z')
            expect(payload.batch).toHaveLength(1)
            expect(payload.batch[0]).toMatchObject({
                event: '$ai_generation',
                timestamp: '2024-07-01T19:34:56.789Z',
            })
        } finally {
            await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
        }
    })
})
