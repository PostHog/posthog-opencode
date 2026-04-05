import { describe, it, expect } from "vitest"
import { redactForPrivacy, serializeAttribute, serializeError } from "./utils.js"

describe("redactForPrivacy", () => {
  it("returns value when privacy mode is off", () => {
    expect(redactForPrivacy("hello", false)).toBe("hello")
    expect(redactForPrivacy({ key: "val" }, false)).toEqual({ key: "val" })
  })

  it("returns null when privacy mode is on", () => {
    expect(redactForPrivacy("hello", true)).toBeNull()
    expect(redactForPrivacy({ key: "val" }, true)).toBeNull()
  })
})

describe("serializeAttribute", () => {
  it("serializes simple values", () => {
    expect(serializeAttribute({ a: 1 }, 1000)).toBe('{"a":1}')
    expect(serializeAttribute("hello", 1000)).toBe("hello")
  })

  it("redacts sensitive keys in objects", () => {
    const input = {
      command: "curl",
      api_key: "sk-secret-123",
      apiKey: "another-secret",
      token: "my-token",
      password: "pass123",
      authorization: "Bearer xyz",
      normal_field: "visible",
    }
    const result = serializeAttribute(input, 10000)
    expect(result).toContain("[REDACTED]")
    expect(result).not.toContain("sk-secret-123")
    expect(result).not.toContain("another-secret")
    expect(result).not.toContain("my-token")
    expect(result).not.toContain("pass123")
    expect(result).not.toContain("Bearer xyz")
    expect(result).toContain("curl")
    expect(result).toContain("visible")
  })

  it("redacts nested sensitive keys", () => {
    const input = {
      headers: { Authorization: "Bearer secret" },
      config: { api_key: "hidden" },
    }
    const result = serializeAttribute(input, 10000)
    expect(result).not.toContain("secret")
    expect(result).not.toContain("hidden")
  })

  it("redacts sensitive values embedded in strings", () => {
    const jsonStr = '{"api_key":"sk-secret-123","name":"test"}'
    const result = serializeAttribute(jsonStr, 10000)
    expect(result).not.toContain("sk-secret-123")
    expect(result).toContain("[REDACTED]")
  })

  it("redacts key=value patterns in strings", () => {
    const cmdOutput = "config loaded: password=hunter2 host=localhost"
    const result = serializeAttribute(cmdOutput, 10000)
    expect(result).not.toContain("hunter2")
    expect(result).toContain("[REDACTED]")
  })

  it("truncates long output", () => {
    const longStr = "a".repeat(200)
    const result = serializeAttribute(longStr, 50)
    expect(result).not.toBeNull()
    expect(result!.length).toBeLessThan(200)
    expect(result).toContain("...[truncated")
  })

  it("handles circular references", () => {
    const obj: Record<string, unknown> = { name: "test" }
    obj.self = obj
    const result = serializeAttribute(obj, 1000)
    expect(result).toContain("[Circular]")
    expect(result).toContain("test")
  })

  it("handles deep nesting", () => {
    let obj: Record<string, unknown> = { value: "deep" }
    for (let i = 0; i < 20; i++) {
      obj = { nested: obj }
    }
    const result = serializeAttribute(obj, 10000)
    expect(result).toContain("[DepthLimit]")
  })

  it("returns null for undefined and null", () => {
    expect(serializeAttribute(undefined, 1000)).toBeNull()
    expect(serializeAttribute(null, 1000)).toBeNull()
  })
})

describe("serializeError", () => {
  it("serializes error objects to JSON", () => {
    const error = { name: "UnknownError", data: { message: "boom" } }
    const result = serializeError(error)
    expect(result).toBe('{"name":"UnknownError","data":{"message":"boom"}}')
  })

  it("returns null for undefined", () => {
    expect(serializeError(undefined)).toBeNull()
  })

  it("falls back to error name on serialization failure", () => {
    const circular: Record<string, unknown> = { name: "BadError" }
    circular.self = circular
    const result = serializeError(circular as { name: string; data?: Record<string, unknown> })
    expect(result).toBe("BadError")
  })
})
