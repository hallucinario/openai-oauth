import { describe, expect, test, vi } from "vitest"

vi.mock("ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("ai")>()
	return { ...actual, generateText: vi.fn() }
})

import { APICallError, generateText } from "ai"
import type { OpenAIOAuthProvider } from "../../openai-oauth-provider/src/index.js"
import { handleChatCompletionsRequest } from "../src/chat-completions.js"

const mockedGenerateText = vi.mocked(generateText)
const provider = (() => ({})) as OpenAIOAuthProvider

const request = (body: Record<string, unknown>) =>
	new Request("http://localhost/v1/chat/completions", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	})

describe("subscription measurement chat completion", () => {
	test.each([
		429, 502,
	])("preserves upstream %s and measurement evidence after the SDK rejects", async (statusCode) => {
		mockedGenerateText.mockRejectedValueOnce(
			new APICallError({
				message: "upstream refused",
				url: "http://127.0.0.1/v1/chat/completions",
				requestBodyValues: {},
				statusCode,
				responseHeaders: {
					"content-type": "application/json",
					"x-oauth-measurement-contract": "subscription-single-attempt-v1",
					"x-oauth-upstream-request-id": "upstream-error-1",
					"x-oauth-upstream-request-count": "1",
				},
				responseBody: JSON.stringify({
					error: {
						type:
							statusCode === 429 ? "rate_limit" : "measurement_evidence_error",
					},
				}),
			}),
		)
		const response = await handleChatCompletionsRequest(
			request({ model: "gpt-5.6-sol", messages: [], max_tokens: 4096 }),
			provider,
			undefined,
			undefined,
			true,
		)
		expect(response.status).toBe(statusCode)
		expect(response.headers.get("x-oauth-upstream-request-id")).toBe(
			"upstream-error-1",
		)
		expect(response.headers.get("x-oauth-upstream-request-count")).toBe("1")
		await expect(response.json()).resolves.toMatchObject({
			error: {
				type: statusCode === 429 ? "rate_limit" : "measurement_evidence_error",
			},
		})
	})

	test("rejects conflicting max_output_tokens before dispatch", async () => {
		mockedGenerateText.mockClear()
		const response = await handleChatCompletionsRequest(
			request({
				model: "gpt-5.6-sol",
				messages: [],
				max_tokens: 4096,
				max_output_tokens: 512,
			}),
			provider,
			undefined,
			undefined,
			true,
		)
		expect(response.status).toBe(400)
		expect(mockedGenerateText).not.toHaveBeenCalled()
	})
	test("disables AI SDK retries and publishes observed upstream evidence", async () => {
		mockedGenerateText.mockResolvedValueOnce({
			text: "measured",
			toolCalls: [],
			finishReason: "stop",
			usage: { inputTokens: 12, outputTokens: 23, totalTokens: 35 },
			response: {
				modelId: "gpt-5.6-sol",
				headers: {
					"x-oauth-measurement-contract": "subscription-single-attempt-v1",
					"x-oauth-upstream-base-url": "https://chatgpt.com/backend-api/codex",
					"x-oauth-upstream-request-id": "upstream-123",
					"x-oauth-upstream-request-count": "1",
					"x-oauth-response-id": "resp_measured",
					"x-oauth-response-model": "gpt-5.6-sol",
					"x-oauth-input-tokens": "12",
					"x-oauth-output-tokens": "23",
					"x-oauth-total-tokens": "35",
				},
			},
		} as never)
		const logger = vi.fn()
		const response = await handleChatCompletionsRequest(
			request({
				model: "gpt-5.6-sol",
				messages: [{ role: "user", content: "hi" }],
				max_tokens: 4096,
			}),
			provider,
			logger,
			undefined,
			true,
		)
		expect(mockedGenerateText).toHaveBeenCalledWith(
			expect.objectContaining({ maxRetries: 0, maxOutputTokens: 4096 }),
		)
		expect(response.status).toBe(200)
		expect(response.headers.get("x-oauth-upstream-request-id")).toBe(
			"upstream-123",
		)
		expect(response.headers.get("x-oauth-measurement-contract")).toBe(
			"subscription-single-attempt-v1",
		)
		expect(response.headers.get("x-oauth-output-tokens")).toBe("23")
		await expect(response.json()).resolves.toMatchObject({
			id: "resp_measured",
			model: "gpt-5.6-sol",
			usage: { prompt_tokens: 12, completion_tokens: 23, total_tokens: 35 },
		})
		expect(logger).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "chat_response",
				upstreamRequestId: "upstream-123",
				responseId: "resp_measured",
				responseModel: "gpt-5.6-sol",
			}),
		)
	})

	test("rejects missing evidence without zero-filling usage", async () => {
		mockedGenerateText.mockResolvedValueOnce({
			text: "unverified",
			toolCalls: [],
			finishReason: "stop",
			usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
			response: { modelId: "gpt-5.6-sol", headers: {} },
		} as never)
		const response = await handleChatCompletionsRequest(
			request({ model: "gpt-5.6-sol", messages: [] }),
			provider,
			undefined,
			undefined,
			true,
		)
		expect(response.status).toBe(502)
		await expect(response.json()).resolves.toMatchObject({
			error: { type: "measurement_evidence_error" },
		})
	})

	test.each([
		["gpt-5.4", 4096, false],
		["gpt-5.6-sol", 512, false],
		["gpt-5.6-sol", 4096, true],
	])("rejects unsupported model, token limit, or streaming before dispatch", async (model, maxTokens, stream) => {
		mockedGenerateText.mockClear()
		const response = await handleChatCompletionsRequest(
			request({ model, max_tokens: maxTokens, stream, messages: [] }),
			provider,
			undefined,
			undefined,
			true,
		)
		expect(response.status).toBe(400)
		expect(mockedGenerateText).not.toHaveBeenCalled()
	})
})
