import { generateText } from "ai"
import { DEFAULT_CODEX_BASE_URL } from "../../openai-oauth-core/src/index.js"
import {
	MEASUREMENT_CONTRACT,
	MEASUREMENT_MAX_OUTPUT_TOKENS,
	MEASUREMENT_MODELS,
} from "../../openai-oauth-core/src/measurement.js"
import type { OpenAIOAuthProvider } from "../../openai-oauth-provider/src/index.js"
import {
	createToolSet,
	toModelMessages,
	toToolChoice,
} from "./chat-messages.js"
import { streamChatCompletions } from "./chat-stream.js"
import { emitRequestLog } from "./logging.js"
import {
	isRecord,
	mapFinishReason,
	summarizeChatRequest,
	toErrorResponse,
	toJsonResponse,
	toUsage,
} from "./shared.js"
import type {
	ChatCompletionResultShape,
	ChatRequest,
	OpenAIOAuthServerLogEvent,
} from "./types.js"

const isChatRequest = (value: unknown): value is ChatRequest =>
	isRecord(value) &&
	(value.messages === undefined || Array.isArray(value.messages))

type MeasurementEvidence = {
	responseId: string
	responseModel: string
	upstreamRequestId: string
	usage: ReturnType<typeof toUsage>
	headers: Headers
}

const readMeasurementEvidence = (
	responseHeaders: Record<string, string> | undefined,
	requestedModel: string,
): MeasurementEvidence | string => {
	const headers = new Headers(responseHeaders)
	const responseId = headers.get("x-oauth-response-id")
	const responseModel = headers.get("x-oauth-response-model")
	const upstreamRequestId = headers.get("x-oauth-upstream-request-id")
	const input = headers.get("x-oauth-input-tokens")
	const output = headers.get("x-oauth-output-tokens")
	const total = headers.get("x-oauth-total-tokens")
	const isCount = (value: string | null): value is string =>
		value !== null && /^\d+$/.test(value) && Number.isSafeInteger(Number(value))
	if (
		!responseId ||
		!upstreamRequestId ||
		responseModel !== requestedModel ||
		headers.get("x-oauth-measurement-contract") !== MEASUREMENT_CONTRACT ||
		headers.get("x-oauth-upstream-base-url") !== DEFAULT_CODEX_BASE_URL ||
		headers.get("x-oauth-upstream-request-count") !== "1" ||
		!isCount(input) ||
		!isCount(output) ||
		!isCount(total)
	) {
		return "Upstream model, request ID, response ID, or token usage evidence is missing or mismatched."
	}
	if (Number(output) > MEASUREMENT_MAX_OUTPUT_TOKENS) {
		return "Observed output exceeded 4096 tokens."
	}
	const cached = headers.get("x-oauth-cached-input-tokens")
	const reasoning = headers.get("x-oauth-reasoning-output-tokens")
	const usage = {
		prompt_tokens: Number(input),
		completion_tokens: Number(output),
		total_tokens: Number(total),
		prompt_tokens_details: isCount(cached)
			? { cached_tokens: Number(cached) }
			: undefined,
		completion_tokens_details: isCount(reasoning)
			? { reasoning_tokens: Number(reasoning) }
			: undefined,
	}
	const publicHeaders = new Headers()
	for (const key of [
		"x-oauth-measurement-contract",
		"x-oauth-upstream-base-url",
		"x-oauth-upstream-request-id",
		"x-oauth-upstream-request-count",
		"x-oauth-response-id",
		"x-oauth-response-model",
		"x-oauth-input-tokens",
		"x-oauth-output-tokens",
		"x-oauth-total-tokens",
		"x-oauth-cached-input-tokens",
		"x-oauth-reasoning-output-tokens",
	]) {
		const value = headers.get(key)
		if (value) publicHeaders.set(key, value)
	}
	return {
		responseId,
		responseModel,
		upstreamRequestId,
		usage,
		headers: publicHeaders,
	}
}

const toChatCompletionResponse = (
	result: ChatCompletionResultShape,
	request: ChatRequest,
	headers?: HeadersInit,
	evidence?: MeasurementEvidence,
): Response => {
	const toolCalls = result.toolCalls.map((toolCall) => ({
		id: toolCall.toolCallId,
		type: "function",
		function: {
			name: toolCall.toolName,
			arguments: JSON.stringify(toolCall.input),
		},
	}))

	return toJsonResponse(
		{
			id: evidence?.responseId ?? `chatcmpl_${crypto.randomUUID()}`,
			object: "chat.completion",
			created: Math.floor(Date.now() / 1000),
			model: evidence?.responseModel ?? request.model,
			choices: [
				{
					index: 0,
					message: {
						role: "assistant",
						content: result.text.length > 0 ? result.text : null,
						tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
					},
					finish_reason: mapFinishReason(result.finishReason),
				},
			],
			usage: evidence?.usage ?? toUsage(result.usage),
		},
		200,
		evidence
			? new Headers([...new Headers(headers), ...evidence.headers])
			: headers,
	)
}

export const handleChatCompletionsRequest = async (
	request: Request,
	provider: OpenAIOAuthProvider,
	logger: ((event: OpenAIOAuthServerLogEvent) => void) | undefined,
	headers?: HeadersInit,
	measurementMode = false,
): Promise<Response> => {
	const requestId = crypto.randomUUID()
	const startedAt = Date.now()
	const body = await request.json()

	if (!isChatRequest(body) || !Array.isArray(body.messages)) {
		emitRequestLog(logger, {
			type: "chat_error",
			requestId,
			path: "/v1/chat/completions",
			durationMs: Date.now() - startedAt,
			message: "`messages` must be an array.",
		})
		return toErrorResponse(
			"`messages` must be an array.",
			400,
			"invalid_request_error",
			headers,
		)
	}
	if (measurementMode) {
		if (
			!MEASUREMENT_MODELS.includes(
				body.model as (typeof MEASUREMENT_MODELS)[number],
			)
		) {
			return toErrorResponse(
				"Measurement model must be gpt-5.6-sol or gpt-5.6-luna.",
				400,
				"invalid_request_error",
				headers,
			)
		}
		if (
			body.max_tokens !== undefined &&
			body.max_tokens !== MEASUREMENT_MAX_OUTPUT_TOKENS
		) {
			return toErrorResponse(
				"Measurement max_tokens must be 4096.",
				400,
				"invalid_request_error",
				headers,
			)
		}
		if (body.stream === true) {
			return toErrorResponse(
				"Measurement chat completions require stream=false.",
				400,
				"invalid_request_error",
				headers,
			)
		}
	}

	emitRequestLog(logger, {
		type: "chat_request",
		requestId,
		path: "/v1/chat/completions",
		...summarizeChatRequest(body),
	})

	if (body.stream === true) {
		return streamChatCompletions(body, provider, {
			logger,
			requestId,
			startedAt,
			headers,
		})
	}

	try {
		const result = await generateText({
			model: provider(body.model ?? "gpt-5.2"),
			messages: toModelMessages(body.messages),
			tools: createToolSet(body.tools),
			toolChoice: toToolChoice(body.tool_choice),
			temperature: body.temperature,
			topP: body.top_p,
			stopSequences:
				typeof body.stop === "string"
					? [body.stop]
					: Array.isArray(body.stop)
						? body.stop
						: undefined,
			maxOutputTokens: measurementMode
				? MEASUREMENT_MAX_OUTPUT_TOKENS
				: body.max_tokens,
			maxRetries: measurementMode ? 0 : undefined,
			providerOptions: {
				openai: {
					parallelToolCalls: body.parallel_tool_calls,
					reasoningEffort: body.reasoning_effort,
				},
			},
		})
		const evidence = measurementMode
			? readMeasurementEvidence(result.response?.headers, body.model ?? "")
			: undefined
		if (typeof evidence === "string") {
			emitRequestLog(logger, {
				type: "chat_error",
				requestId,
				path: "/v1/chat/completions",
				durationMs: Date.now() - startedAt,
				message: evidence,
			})
			return toErrorResponse(
				evidence,
				502,
				"measurement_evidence_error",
				headers,
			)
		}

		emitRequestLog(logger, {
			type: "chat_response",
			requestId,
			path: "/v1/chat/completions",
			status: 200,
			stream: false,
			durationMs: Date.now() - startedAt,
			finishReason: result.finishReason,
			usage: evidence
				? {
						inputTokens: evidence.usage.prompt_tokens,
						outputTokens: evidence.usage.completion_tokens,
						totalTokens: evidence.usage.total_tokens,
						cachedInputTokens:
							evidence.usage.prompt_tokens_details?.cached_tokens,
						reasoningTokens:
							evidence.usage.completion_tokens_details?.reasoning_tokens,
					}
				: result.usage,
			...(evidence && {
				upstreamRequestId: evidence.upstreamRequestId,
				responseId: evidence.responseId,
				responseModel: evidence.responseModel,
			}),
		})

		return toChatCompletionResponse(result, body, headers, evidence)
	} catch (error) {
		emitRequestLog(logger, {
			type: "chat_error",
			requestId,
			path: "/v1/chat/completions",
			durationMs: Date.now() - startedAt,
			message:
				error instanceof Error ? error.message : "Unexpected server error.",
		})
		throw error
	}
}
