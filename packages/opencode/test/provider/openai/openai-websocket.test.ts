import { describe, expect, mock, test } from "bun:test"
import type { LanguageModelV3Prompt } from "@ai-sdk/provider"
import { createOpenAI } from "@/provider/sdk/openai/openai-provider"
import { FakeWebSocket } from "../../lib/websocket"

const TEST_PROMPT: LanguageModelV3Prompt = [{ role: "user", content: [{ type: "text", text: "Hello" }] }]

async function readStream<T>(stream: ReadableStream<T>) {
  const reader = stream.getReader()
  const result: T[] = []

  while (true) {
    const chunk = await reader.read()
    if (chunk.done) return result
    result.push(chunk.value)
  }
}

function responseEvents() {
  return [
    {
      type: "response.created",
      response: {
        id: "resp_test",
        created_at: 1_700_000_000,
        model: "gpt-5",
        service_tier: null,
      },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "msg_1" },
    },
    {
      type: "response.output_text.delta",
      item_id: "msg_1",
      delta: "Hello",
      logprobs: null,
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "message", id: "msg_1" },
    },
    {
      type: "response.completed",
      response: {
        incomplete_details: null,
        service_tier: null,
        usage: {
          input_tokens: 2,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 1,
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    },
  ]
}

function createSseResponse(events: ReturnType<typeof responseEvents>) {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const event of events) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`))
        }
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
        controller.close()
      },
    }),
    {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    },
  )
}

describe("bundled openai websocket transport", () => {
  test("sends response.create over websocket and maps streamed events", async () => {
    const socket = new FakeWebSocket("wss://api.openai.com/v1/responses")
    const model = createOpenAI({
      apiKey: "test-api-key",
      websocket: true,
      createWebSocket: () => {
        queueMicrotask(() => socket.open())
        return socket as unknown as WebSocket
      },
    }).responses("gpt-5")

    const { stream } = await model.doStream({
      prompt: TEST_PROMPT,
      includeRawChunks: false,
    })

    const request = JSON.parse(socket.sent[0]!)

    expect(request).toMatchObject({
      type: "response.create",
      model: "gpt-5",
    })
    expect(request.stream).toBeUndefined()

    for (const event of responseEvents()) {
      socket.message(JSON.stringify(event))
    }

    const parts = await readStream(stream)
    expect(parts).toMatchObject([
      { type: "stream-start", warnings: [] },
      { type: "response-metadata", id: "resp_test", modelId: "gpt-5" },
      { type: "text-start", id: "msg_1" },
      { type: "text-delta", id: "msg_1", delta: "Hello" },
      { type: "text-end", id: "msg_1" },
      {
        type: "finish",
        finishReason: { unified: "stop" },
        usage: {
          inputTokens: { total: 2 },
          outputTokens: { total: 1 },
        },
      },
    ])
  })

  test("falls back to SSE when websocket fails before open", async () => {
    const socket = new FakeWebSocket("wss://api.openai.com/v1/responses")
    const fetchFn = mock(async () => createSseResponse(responseEvents()))
    const model = createOpenAI({
      apiKey: "test-api-key",
      websocket: true,
      fetch: fetchFn as unknown as typeof fetch,
      createWebSocket: () => {
        queueMicrotask(() => socket.emit("error", {}))
        return socket as unknown as WebSocket
      },
    }).responses("gpt-5")

    const { stream, request } = await model.doStream({
      prompt: TEST_PROMPT,
      includeRawChunks: false,
    })
    const parts = await readStream(stream)

    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect((request?.body as { stream?: boolean }).stream).toBeUndefined()
    expect(parts.find((part) => part.type === "text-delta")).toMatchObject({
      type: "text-delta",
      delta: "Hello",
    })
  })
})
