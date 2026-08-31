import { AwsV4Signer } from "aws4fetch"
import { Effect } from "effect"
import { Headers } from "effect/unstable/http"
import { Auth, type AuthInput } from "../../route/auth.js"
import type { AIError } from "../../schema/index.js"
import { ProviderShared } from "../shared.js"
import { BedrockCredentials, type Exported } from "./bedrock-credentials.js"

/**
 * AWS credentials for SigV4 signing. Bedrock also supports Bearer API key auth,
 * which provider facades configure as route auth instead of SigV4.
 *
 * Explicitly configured credentials are used as-is and never refreshed. When they
 * are absent, a configured `profile` lets the route re-export STS-vended
 * credentials from the `aws` CLI on every request, refreshing them before they
 * expire — see {@link BedrockCredentials}.
 */
export interface Credentials {
  readonly region: string
  readonly accessKeyId: string
  readonly secretAccessKey: string
  readonly sessionToken?: string
}

export interface SigV4Options {
  readonly service?: string
  readonly name?: string
  /** AWS profile used to export credentials via the `aws` CLI when none are configured statically. */
  readonly profile?: string
  /** Region used for signing when credentials come from the CLI, which does not vend one. */
  readonly region?: string
  /** @internal Seam for tests; defaults to the process-wide `aws` CLI cache. */
  readonly resolveProfile?: (profile: string) => Effect.Effect<Exported, AIError>
}

const signRequest = (input: {
  readonly url: string
  readonly body: string
  readonly headers: Headers.Headers
  readonly credentials: Credentials
  readonly service: string
  readonly name: string
}) =>
  Effect.tryPromise({
    try: async () => {
      const signed = await new AwsV4Signer({
        url: input.url,
        method: "POST",
        headers: Object.entries(input.headers),
        body: input.body,
        region: input.credentials.region,
        accessKeyId: input.credentials.accessKeyId,
        secretAccessKey: input.credentials.secretAccessKey,
        sessionToken: input.credentials.sessionToken,
        service: input.service,
      }).sign()
      return Object.fromEntries(signed.headers.entries())
    },
    catch: (error) =>
      ProviderShared.invalidRequest(
        `${input.name} SigV4 signing failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
  })

const configured = (credentials: Credentials) => credentials.accessKeyId !== "" && credentials.secretAccessKey !== ""

/**
 * Resolve the credentials to sign one request with. Runs per request, so a
 * profile-backed route picks up refreshed CLI credentials without being rebuilt.
 */
const resolveCredentials = (
  credentials: Credentials | undefined,
  options: SigV4Options,
): Effect.Effect<Credentials, AIError> => {
  // Statically configured credentials win and are never refreshed.
  if (credentials !== undefined && configured(credentials)) return Effect.succeed(credentials)

  const region = credentials?.region ?? options.region
  if (options.profile === undefined || region === undefined)
    return Effect.fail(
      ProviderShared.invalidRequest(
        `${options.name ?? "Bedrock Converse"} requires either route bearer auth or AWS credentials configured on the route`,
      ),
    )

  return (options.resolveProfile ?? BedrockCredentials.fromProfile)(options.profile).pipe(
    Effect.map((exported) => ({
      region,
      accessKeyId: exported.accessKeyId,
      secretAccessKey: exported.secretAccessKey,
      ...(exported.sessionToken === undefined ? {} : { sessionToken: exported.sessionToken }),
    })),
  )
}

/** Sign the exact JSON bytes with SigV4 using credentials resolved for this request. */
export const sigV4 = (credentials: Credentials | undefined, options: SigV4Options = {}) =>
  Auth.custom((input: AuthInput) => {
    return Effect.gen(function* () {
      const resolved = yield* resolveCredentials(credentials, options)
      const headersForSigning = Headers.set(input.headers, "content-type", "application/json")
      const signed = yield* signRequest({
        url: input.url,
        body: input.body,
        headers: headersForSigning,
        credentials: resolved,
        service: options.service ?? "bedrock",
        name: options.name ?? "Bedrock Converse",
      })
      return Headers.setAll(headersForSigning, signed)
    })
  })

/** Bedrock route auth defaults to SigV4 and expects credentials from route configuration. */
export const auth = sigV4(undefined)

export * as BedrockAuth from "./bedrock-auth.js"
