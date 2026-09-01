import { Auth } from "../route/auth.js"
import { Route, type RouteDefaultsInput } from "../route/client.js"
import type { ProviderPackage } from "../provider-package.js"
import { AnthropicMessages } from "../protocols/anthropic-messages.js"
import { OpenAIChat } from "../protocols/openai-chat.js"
import { OpenAIResponses } from "../protocols/openai-responses.js"
import { BedrockAuth, type Credentials } from "../protocols/utils/bedrock-auth.js"
import { ProviderID, type ModelID } from "../schema/index.js"
import { withOpenAIOptions, type OpenAIProviderOptionsInput } from "./openai-options.js"

export const id = ProviderID.make("amazon-bedrock")

/** Endpoint + credential inputs shared by every Mantle route, independent of protocol. */
interface Connection {
  readonly apiKey?: string
  readonly baseURL?: string
  readonly credentials?: Credentials
  readonly region?: string
  /** AWS profile used to export credentials via the `aws` CLI when `credentials` is absent or expired. */
  readonly profile?: string
}

type RouteConfig = RouteDefaultsInput & Connection

export type Config = RouteConfig & {
  readonly providerOptions?: OpenAIProviderOptionsInput
}

/** Mantle's Anthropic Messages surface takes Anthropic provider options, not OpenAI ones. */
export type AnthropicConfig = RouteConfig & {
  readonly providerOptions?: AnthropicMessages.ProviderOptionsInput
}

// `ProviderPackage.Settings` carries a string index signature, so `Omit` over it erases
// the named fields. The protocol-specific settings share this explicit base instead.
interface BaseSettings extends ProviderPackage.Settings {
  readonly apiKey?: string
  readonly auth?: "bearer" | "sigv4"
  readonly baseURL?: string
  readonly credentials?: Credentials
  readonly region?: string
  readonly profile?: string
  readonly topP?: number
}

export interface Settings extends BaseSettings {
  readonly providerOptions?: OpenAIProviderOptionsInput
}

export interface AnthropicSettings extends BaseSettings {
  readonly providerOptions?: AnthropicMessages.ProviderOptionsInput
}

const responsesRoute = Route.make({
  id: "bedrock-mantle-responses",
  provider: id,
  providerMetadataKey: "mantle",
  protocol: OpenAIResponses.protocol,
  endpoint: OpenAIResponses.route.endpoint,
  auth: OpenAIResponses.route.auth,
  transport: OpenAIResponses.httpTransport,
  defaults: OpenAIResponses.route.defaults,
})

const chatRoute = OpenAIChat.route.with({
  id: "bedrock-mantle-chat",
  provider: id,
  providerMetadataKey: "mantle",
})

// Mantle's Anthropic endpoint is wire-compatible with the stock Messages API, so the
// shared route carries over unchanged apart from identity — including its
// `anthropic-version` header and the `/messages` path (the `?beta=true` variant is
// scoped to the `anthropic` provider itself).
const anthropicRoute = AnthropicMessages.route.with({
  id: "bedrock-mantle-anthropic",
  provider: id,
  providerMetadataKey: "mantle",
})

export const routes = [responsesRoute, chatRoute, anthropicRoute]

const resolvedRegion = (input: Connection) => input.region ?? input.credentials?.region ?? "us-east-1"

const mantleBaseURL = (input: Connection, region: string) =>
  input.baseURL ?? `https://bedrock-mantle.${region}.api.aws/v1`

/**
 * Mantle serves the Anthropic Messages API on a sibling path of its OpenAI base, which
 * ships as either `/v1` or `/openai/v1` depending on the model. Rewriting whichever form
 * is configured onto `/anthropic/v1` keeps one `baseURL` setting driving all three routes.
 */
const anthropicBaseURL = (baseURL: string) =>
  `${baseURL.replace(/\/+$/, "").replace(/(?:\/openai)?\/v1$/, "")}/anthropic/v1`

const mantleAuth = (input: Connection, region: string) =>
  input.apiKey === undefined
    ? BedrockAuth.sigV4(input.credentials === undefined ? undefined : { ...input.credentials, region }, {
        service: "bedrock-mantle",
        name: "Bedrock Mantle",
        profile: input.profile,
        region,
      })
    : Auth.bearer(input.apiKey)

const configuredRoute = <Body, Prepared>(route: Route<Body, Prepared>, input: Connection, baseURL: string) =>
  route.with({
    endpoint: { baseURL },
    auth: mantleAuth(input, resolvedRegion(input)),
  })

const defaults = (input: RouteConfig) => {
  const { apiKey: _, baseURL: _baseURL, credentials: _credentials, region: _region, profile: _profile, ...rest } = input
  return rest
}

/**
 * Anthropic model factory shared by `configure` and `configureAnthropic`. Deliberately
 * skips `withOpenAIOptions` — its `store: false` and GPT-5 reasoning defaults are
 * meaningless in an Anthropic Messages body.
 */
const anthropicFactory = (input: RouteConfig) => {
  const region = resolvedRegion(input)
  const route = configuredRoute(anthropicRoute, input, anthropicBaseURL(mantleBaseURL(input, region)))
  const modelDefaults = defaults(input)
  return (modelID: string | ModelID) =>
    route.with(modelDefaults).model<AnthropicMessages.ProviderOptionsInput>({ id: modelID })
}

export const configure = (input: Config = {}) => {
  const region = resolvedRegion(input)
  const baseURL = mantleBaseURL(input, region)
  const configuredResponsesRoute = configuredRoute(responsesRoute, input, baseURL)
  const configuredChatRoute = configuredRoute(chatRoute, input, baseURL)
  const modelDefaults = defaults(input)
  const responses = (modelID: string | ModelID) =>
    configuredResponsesRoute
      .with(withOpenAIOptions(modelID, modelDefaults))
      .model<OpenAIProviderOptionsInput>({ id: modelID })
  const chat = (modelID: string | ModelID) =>
    configuredChatRoute
      .with(withOpenAIOptions(modelID, modelDefaults))
      .model<OpenAIProviderOptionsInput>({ id: modelID })
  const anthropic = anthropicFactory(input)

  return {
    id,
    model: responses,
    chat,
    responses,
    anthropic,
    configure,
  }
}

export const configureAnthropic = (input: AnthropicConfig = {}) => ({
  id,
  model: anthropicFactory(input),
  configure: configureAnthropic,
})

export const provider = configure()

const config = (settings: BaseSettings): Omit<Config, "providerOptions"> => {
  if (settings.auth === "bearer" && settings.apiKey === undefined)
    throw new Error("Amazon Bedrock Mantle bearer auth requires apiKey")
  if (settings.auth === "sigv4" && settings.apiKey !== undefined)
    throw new Error("Amazon Bedrock Mantle SigV4 auth does not accept apiKey")
  return {
    apiKey: settings.auth === "sigv4" ? undefined : settings.apiKey,
    baseURL: settings.baseURL,
    credentials: settings.credentials,
    generation: settings.topP === undefined ? undefined : { topP: settings.topP },
    headers: settings.headers === undefined ? undefined : { ...settings.headers },
    http: settings.body === undefined ? undefined : { body: { ...settings.body } },
    region: settings.region,
    profile: settings.profile,
  }
}

export const chatModel: ProviderPackage.Definition<Settings, OpenAIProviderOptionsInput>["model"] = (
  modelID,
  settings,
) => configure({ ...config(settings), providerOptions: settings.providerOptions }).chat(modelID)
export const responsesModel: ProviderPackage.Definition<Settings, OpenAIProviderOptionsInput>["model"] = (
  modelID,
  settings,
) => configure({ ...config(settings), providerOptions: settings.providerOptions }).responses(modelID)
export const anthropicModel: ProviderPackage.Definition<
  AnthropicSettings,
  AnthropicMessages.ProviderOptionsInput
>["model"] = (modelID, settings) =>
  configureAnthropic({ ...config(settings), providerOptions: settings.providerOptions }).model(modelID)
export const model = responsesModel
