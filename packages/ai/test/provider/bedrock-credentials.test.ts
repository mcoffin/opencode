import { describe, expect } from "bun:test"
import { Effect, Ref } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { BedrockCredentials, type Exported } from "../../src/protocols/utils/bedrock-credentials.js"
import { it } from "../lib/effect.js"

const MINUTE = 60_000

// A loader that counts invocations and hands back the expiry the test asks for.
const counting = (expires: () => number) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0)
    const load = (profile: string): Effect.Effect<Exported> =>
      Effect.gen(function* () {
        yield* Ref.update(calls, (count) => count + 1)
        // Yield so concurrent callers actually interleave rather than running to completion.
        yield* Effect.yieldNow
        return { accessKeyId: `AKIA-${profile}`, secretAccessKey: "secret", sessionToken: "token", expires: expires() }
      })
    return { calls, load }
  })

describe("BedrockCredentials.parse", () => {
  it.effect("decodes the aws CLI process-credential payload", () =>
    Effect.gen(function* () {
      const parsed = yield* BedrockCredentials.parse(
        "default",
        JSON.stringify({
          Version: 1,
          AccessKeyId: "AKIAIOSFODNN7EXAMPLE",
          SecretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
          SessionToken: "FwoGZXIvYXdzEExample",
          Expiration: "2026-09-01T05:42:18+00:00",
        }),
      )

      expect(parsed).toEqual({
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        sessionToken: "FwoGZXIvYXdzEExample",
        expires: Date.parse("2026-09-01T05:42:18+00:00"),
      })
    }),
  )

  it.effect("treats a payload without an Expiration as non-expiring", () =>
    Effect.gen(function* () {
      const parsed = yield* BedrockCredentials.parse(
        "static",
        JSON.stringify({ Version: 1, AccessKeyId: "AKIA", SecretAccessKey: "secret" }),
      )

      expect(parsed.expires).toBe(Number.POSITIVE_INFINITY)
      expect(parsed.sessionToken).toBeUndefined()
    }),
  )

  it.effect("rejects an unparseable expiration rather than signing with it", () =>
    Effect.gen(function* () {
      const error = yield* BedrockCredentials.parse(
        "broken",
        JSON.stringify({ AccessKeyId: "AKIA", SecretAccessKey: "secret", Expiration: "not-a-date" }),
      ).pipe(Effect.flip)

      expect(error.message).toContain("invalid credential expiration")
      expect(error.message).toContain("broken")
    }),
  )
})

describe("BedrockCredentials.cached", () => {
  it.effect("reuses a cached entry while it is comfortably unexpired", () =>
    Effect.gen(function* () {
      const { calls, load } = yield* counting(() => 60 * MINUTE)
      const resolve = BedrockCredentials.cached(load)

      yield* resolve("dev")
      yield* TestClock.adjust(MINUTE)
      const second = yield* resolve("dev")

      expect(yield* Ref.get(calls)).toBe(1)
      expect(second.accessKeyId).toBe("AKIA-dev")
    }),
  )

  it.effect("re-exports once the entry falls inside the refresh skew", () =>
    Effect.gen(function* () {
      const { calls, load } = yield* counting(() => 10 * MINUTE)
      const resolve = BedrockCredentials.cached(load)

      yield* resolve("dev")
      // 4 minutes of validity left, inside the 5-minute skew.
      yield* TestClock.adjust(6 * MINUTE)
      yield* resolve("dev")

      expect(yield* Ref.get(calls)).toBe(2)
    }),
  )

  it.effect("caches per profile", () =>
    Effect.gen(function* () {
      const { calls, load } = yield* counting(() => 60 * MINUTE)
      const resolve = BedrockCredentials.cached(load)

      const dev = yield* resolve("dev")
      const prod = yield* resolve("prod")
      yield* resolve("dev")

      expect(yield* Ref.get(calls)).toBe(2)
      expect(dev.accessKeyId).toBe("AKIA-dev")
      expect(prod.accessKeyId).toBe("AKIA-prod")
    }),
  )

  it.effect("collapses concurrent misses into a single export", () =>
    Effect.gen(function* () {
      const { calls, load } = yield* counting(() => 60 * MINUTE)
      const resolve = BedrockCredentials.cached(load)

      yield* Effect.all([resolve("dev"), resolve("dev"), resolve("dev")], { concurrency: "unbounded" })

      expect(yield* Ref.get(calls)).toBe(1)
    }),
  )
})
