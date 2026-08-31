import { describe, expect } from "bun:test"
import { Effect, Ref } from "effect"
import { Headers } from "effect/unstable/http"
import { Auth } from "../../src/route/auth.js"
import { BedrockAuth } from "../../src/protocols/utils/bedrock-auth.js"
import type { Exported } from "../../src/protocols/utils/bedrock-credentials.js"
import { it } from "../lib/effect.js"

const exported: Exported = {
  accessKeyId: "ASIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  sessionToken: "FwoGZXIvYXdzEExample",
  expires: Number.POSITIVE_INFINITY,
}

const staticCredentials = {
  region: "us-east-1",
  accessKeyId: "AKIACONFIGUREDEXAMPLE",
  secretAccessKey: "configured-secret",
}

// Drive one auth definition the way the http transport does on every request.
const sign = (auth: Auth.Definition) =>
  Auth.toEffect(auth)({
    request: {},
    method: "POST",
    url: "https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude/converse-stream",
    body: '{"messages":[]}',
    headers: Headers.empty,
  })

describe("BedrockAuth.sigV4 profile credentials", () => {
  it.effect("signs with credentials exported for the configured profile", () =>
    Effect.gen(function* () {
      const headers = yield* sign(
        BedrockAuth.sigV4(undefined, {
          profile: "dev",
          region: "us-east-1",
          resolveProfile: () => Effect.succeed(exported),
        }),
      )

      expect(headers["x-amz-security-token"]).toBe(exported.sessionToken)
      expect(headers.authorization).toContain(exported.accessKeyId)
    }),
  )

  it.effect("re-resolves on every request so refreshed credentials are picked up", () =>
    Effect.gen(function* () {
      const current = yield* Ref.make(exported)
      const auth = BedrockAuth.sigV4(undefined, {
        profile: "dev",
        region: "us-east-1",
        resolveProfile: () => Ref.get(current),
      })

      const first = yield* sign(auth)
      yield* Ref.set(current, { ...exported, accessKeyId: "ASIAROTATEDEXAMPLE", sessionToken: "rotated-token" })
      const second = yield* sign(auth)

      expect(first.authorization).toContain(exported.accessKeyId)
      expect(second.authorization).toContain("ASIAROTATEDEXAMPLE")
      expect(second["x-amz-security-token"]).toBe("rotated-token")
    }),
  )

  it.effect("prefers explicitly configured credentials over the profile", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      const headers = yield* sign(
        BedrockAuth.sigV4(staticCredentials, {
          profile: "dev",
          region: "us-east-1",
          resolveProfile: () => Ref.update(calls, (count) => count + 1).pipe(Effect.as(exported)),
        }),
      )

      expect(yield* Ref.get(calls)).toBe(0)
      expect(headers.authorization).toContain(staticCredentials.accessKeyId)
      expect(headers["x-amz-security-token"]).toBeUndefined()
    }),
  )

  it.effect("reports the route name when neither credentials nor a profile are configured", () =>
    Effect.gen(function* () {
      const error = yield* sign(BedrockAuth.sigV4(undefined, { name: "Bedrock Mantle", region: "us-east-1" })).pipe(
        Effect.flip,
      )

      expect(error.message).toContain("Bedrock Mantle requires either route bearer auth or AWS credentials")
    }),
  )
})
