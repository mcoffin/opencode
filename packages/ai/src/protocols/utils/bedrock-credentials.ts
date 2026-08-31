import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { Clock, Effect, Schema, Semaphore } from "effect"
import type { AIError } from "../../schema/index.js"
import { ProviderShared } from "../shared.js"

/**
 * Credentials exported by `aws configure export-credentials`. The AWS CLI owns
 * every hard part of resolution here — SSO token refresh, `credential_process`,
 * assume-role chains — so this package never links the AWS SDK.
 */
export interface Exported {
  readonly accessKeyId: string
  readonly secretAccessKey: string
  readonly sessionToken?: string
  /** Epoch millis, or `Infinity` when the CLI reported no expiration (static keys). */
  readonly expires: number
}

/** Refresh this far ahead of the reported expiry so an in-flight request cannot outlive its credentials. */
const REFRESH_SKEW = 5 * 60_000

const CLI_TIMEOUT = 10_000

const Payload = Schema.Struct({
  Version: Schema.optional(Schema.Number),
  AccessKeyId: Schema.NonEmptyString,
  SecretAccessKey: Schema.NonEmptyString,
  SessionToken: Schema.optional(Schema.NonEmptyString),
  Expiration: Schema.optional(Schema.NonEmptyString),
})

const decodePayload = Schema.decodeUnknownEffect(Schema.fromJsonString(Payload))

const run = promisify(execFile)

const errorCode = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined

const errorDetail = (error: unknown) => {
  // execFile rejections carry the child's stderr, which is where the CLI puts the
  // real reason (expired SSO session, unknown profile, bad config).
  const stderr =
    typeof error === "object" && error !== null && "stderr" in error ? String(error.stderr).trim() : undefined
  if (stderr) return stderr
  return error instanceof Error ? error.message : String(error)
}

/** Decode one `aws configure export-credentials` payload. Never echoes credential material into errors. */
export const parse = (profile: string, stdout: string): Effect.Effect<Exported, AIError> =>
  decodePayload(stdout).pipe(
    Effect.mapError(() =>
      ProviderShared.invalidRequest(`AWS CLI returned an unrecognized credentials payload for profile "${profile}"`),
    ),
    Effect.flatMap((payload) => {
      const withExpiry = (expires: number): Exported => ({
        accessKeyId: payload.AccessKeyId,
        secretAccessKey: payload.SecretAccessKey,
        ...(payload.SessionToken === undefined ? {} : { sessionToken: payload.SessionToken }),
        expires,
      })
      // Long-lived keys come back without an Expiration and never need re-exporting.
      if (payload.Expiration === undefined) return Effect.succeed(withExpiry(Number.POSITIVE_INFINITY))
      const expires = Date.parse(payload.Expiration)
      if (Number.isNaN(expires))
        return Effect.fail(
          ProviderShared.invalidRequest(`AWS CLI returned an invalid credential expiration for profile "${profile}"`),
        )
      return Effect.succeed(withExpiry(expires))
    }),
  )

/** Shell out to `aws configure export-credentials --profile <profile>`. */
export const exportFromCli = (profile: string): Effect.Effect<Exported, AIError> =>
  Effect.tryPromise({
    try: () =>
      run("aws", ["configure", "export-credentials", "--profile", profile, "--output", "json"], {
        timeout: CLI_TIMEOUT,
        windowsHide: true,
      }),
    catch: (error) =>
      errorCode(error) === "ENOENT"
        ? ProviderShared.invalidRequest(
            `Bedrock profile "${profile}" requires the aws CLI, which was not found on PATH`,
            error,
          )
        : ProviderShared.invalidRequest(
            `aws configure export-credentials failed for profile "${profile}": ${errorDetail(error)}`,
            error,
          ),
  }).pipe(Effect.flatMap((result) => parse(profile, result.stdout)))

/**
 * Memoize a credential loader per profile, refreshing `REFRESH_SKEW` before expiry.
 *
 * Refreshes are serialized behind one permit and re-check the cache inside it, so
 * concurrent requests for the same profile share a single `aws` invocation.
 */
export const cached = (load: (profile: string) => Effect.Effect<Exported, AIError>) => {
  const entries = new Map<string, Exported>()
  const gate = Semaphore.makeUnsafe(1)
  const fresh = (entry: Exported, now: number) => entry.expires - now > REFRESH_SKEW

  return (profile: string): Effect.Effect<Exported, AIError> =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const entry = entries.get(profile)
      if (entry !== undefined && fresh(entry, now)) return entry
      return yield* gate.withPermit(
        Effect.gen(function* () {
          const current = entries.get(profile)
          const at = yield* Clock.currentTimeMillis
          if (current !== undefined && fresh(current, at)) return current
          const loaded = yield* load(profile)
          entries.set(profile, loaded)
          return loaded
        }),
      )
    })
}

/** Process-wide cache shared by every configured Bedrock route. */
export const fromProfile = cached(exportFromCli)

export * as BedrockCredentials from "./bedrock-credentials.js"
