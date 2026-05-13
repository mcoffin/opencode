import type { LanguageModelV3 } from "@ai-sdk/provider"
import {
  createOpenAI as createBaseOpenAI,
  type OpenAIProvider,
  type OpenAIProviderSettings,
} from "@ai-sdk/openai"
import { loadApiKey, loadOptionalSetting, withoutTrailingSlash, withUserAgentSuffix } from "@ai-sdk/provider-utils"
import { OpenAIResponsesLanguageModel } from "../copilot/responses/openai-responses-language-model"
import type { OpenAIWebSocketFactory } from "../copilot/responses/openai-config"

export interface OpenCodeOpenAIProviderSettings extends OpenAIProviderSettings {
  websocket?: boolean
  createWebSocket?: OpenAIWebSocketFactory
  timeout?: number | false
  chunkTimeout?: number
}

export function createOpenAI(options: OpenCodeOpenAIProviderSettings = {}): OpenAIProvider {
  const base = createBaseOpenAI(options)
  const baseURL =
    withoutTrailingSlash(
      loadOptionalSetting({
        settingValue: options.baseURL,
        environmentVariableName: "OPENAI_BASE_URL",
      }),
    ) ?? "https://api.openai.com/v1"
  const providerName = options.name ?? "openai"
  const getHeaders = () =>
    withUserAgentSuffix(
      {
        Authorization: `Bearer ${loadApiKey({
          apiKey: options.apiKey,
          environmentVariableName: "OPENAI_API_KEY",
          description: "OpenAI",
        })}`,
        "OpenAI-Organization": options.organization,
        "OpenAI-Project": options.project,
        ...options.headers,
      },
      "ai-sdk/openai",
    )
  const createResponsesModel = (modelId: string): LanguageModelV3 =>
    new OpenAIResponsesLanguageModel(modelId, {
      provider: `${providerName}.responses`,
      providerOptionsName: "openai",
      url: ({ path }) => `${baseURL}${path}`,
      headers: getHeaders,
      fetch: options.fetch,
      websocket: options.websocket,
      createWebSocket: options.createWebSocket,
      timeout: options.timeout,
      chunkTimeout: options.chunkTimeout,
      fileIdPrefixes: ["file-"],
    })

  const provider = function (modelId: string) {
    return createResponsesModel(modelId)
  }

  provider.specificationVersion = "v3"
  provider.languageModel = createResponsesModel
  provider.responses = createResponsesModel
  provider.chat = base.chat
  provider.completion = base.completion
  provider.embedding = base.embedding
  provider.embeddingModel = base.embeddingModel
  provider.textEmbedding = base.textEmbedding
  provider.textEmbeddingModel = base.textEmbeddingModel
  provider.image = base.image
  provider.imageModel = base.imageModel
  provider.transcription = base.transcription
  provider.transcriptionModel = base.transcriptionModel
  provider.speech = base.speech
  provider.speechModel = base.speechModel
  provider.tools = base.tools

  return provider as OpenAIProvider
}
