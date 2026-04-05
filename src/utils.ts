import { hostname } from 'node:os'
import { basename } from 'node:path'
import type { PluginConfig } from './types.js'

export function loadConfig(): PluginConfig {
    const tags: Record<string, string> = {}
    const tagsEnv = process.env.POSTHOG_TAGS
    if (tagsEnv) {
        for (const pair of tagsEnv.split(',')) {
            const colonIdx = pair.indexOf(':')
            if (colonIdx > 0) {
                const key = pair.slice(0, colonIdx).trim()
                const val = pair.slice(colonIdx + 1).trim()
                if (key.length > 0 && val.length > 0) {
                    tags[key] = val
                }
            }
        }
    }

    let distinctId = process.env.POSTHOG_DISTINCT_ID
    if (!distinctId) {
        try {
            distinctId = hostname()
        } catch {
            distinctId = 'opencode-user'
        }
    }

    return {
        apiKey: process.env.POSTHOG_API_KEY ?? '',
        host: process.env.POSTHOG_HOST ?? 'https://us.i.posthog.com',
        privacyMode: process.env.POSTHOG_PRIVACY_MODE === 'true',
        enabled: process.env.POSTHOG_ENABLED !== 'false',
        distinctId,
        projectName: process.env.POSTHOG_PROJECT_NAME || basename(process.cwd()) || 'opencode-project',
        tags,
        maxAttributeLength: parseInt(process.env.POSTHOG_MAX_ATTRIBUTE_LENGTH ?? '12000', 10) || 12000,
    }
}

const SENSITIVE_KEY_PATTERN = /api[-_]?key|token|secret|password|authorization|credential|private[-_]?key/i

/**
 * Patterns to detect sensitive values embedded in strings.
 *
 * JSON-style: `"api_key": "sk-secret-123"` or `"token":"abc"`
 * Matches the full `"key":"value"` including the quoted value.
 */
const SENSITIVE_JSON_PATTERN =
    /"(?:api[-_]?key|token|secret|password|authorization|credential|private[-_]?key)"\s*:\s*"[^"]*"/gi

/**
 * Header/env-style: `Authorization: Bearer secret-token` or `password=hunter2`
 * Matches the key and everything to the next comma, semicolon, newline, or
 * end-of-string so multi-word values like `Bearer xyz` are fully consumed.
 */
const SENSITIVE_KV_PATTERN =
    /(?:api[-_]?key|token|secret|password|authorization|credential|private[-_]?key)\s*[=:]\s*[^\n,;]*/gi

/**
 * Redact sensitive values found inline in a string. Handles both JSON-like
 * `"key":"value"` patterns and `key=value` / `key: value` patterns.
 */
function redactStringValues(str: string): string {
    return str.replace(SENSITIVE_JSON_PATTERN, '[REDACTED]').replace(SENSITIVE_KV_PATTERN, '[REDACTED]')
}

function redactSensitive(value: unknown, seen: WeakSet<object>, depth: number): unknown {
    if (depth > 8) return '[DepthLimit]'
    if (value === null || value === undefined) return value
    if (typeof value === 'string') return redactStringValues(value)
    if (typeof value !== 'object') return value
    if (seen.has(value)) return '[Circular]'
    seen.add(value)

    if (Array.isArray(value)) {
        return value.map((item) => redactSensitive(item, seen, depth + 1))
    }

    const output: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(value)) {
        if (SENSITIVE_KEY_PATTERN.test(key)) {
            output[key] = '[REDACTED]'
        } else {
            output[key] = redactSensitive(nested, seen, depth + 1)
        }
    }
    return output
}

function truncate(value: string, maxLength: number): string {
    if (maxLength <= 0) return ''
    if (value.length <= maxLength) return value
    const omitted = value.length - maxLength
    return `${value.slice(0, maxLength)}...[truncated ${omitted} chars]`
}

export function serializeAttribute(value: unknown, maxLength: number): string | null {
    if (value === undefined || value === null) return null

    const redacted = redactSensitive(value, new WeakSet<object>(), 0)

    if (typeof redacted === 'string') {
        return truncate(redacted, maxLength)
    }

    try {
        const json = JSON.stringify(redacted)
        if (json === undefined) return null
        return truncate(json, maxLength)
    } catch {
        return '[Unserializable]'
    }
}

export function redactForPrivacy<T>(value: T, privacyMode: boolean): T | null {
    return privacyMode ? null : value
}

export function serializeError(
    error: { name: string; data?: Record<string, unknown> } | undefined,
    maxLength: number = 12000
): string | null {
    if (!error) return null
    return serializeAttribute(error, maxLength)
}
