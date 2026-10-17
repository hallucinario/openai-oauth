import {
	type CodexOAuthClient,
	collectCompletedResponseFromSse,
	normalizeCodexResponsesBody,
} from "../../openai-oauth-core/src/index.js"
import { prepareMeasurementBody } from "../../openai-oauth-core/src/measurement.js"
import {
	copyUpstreamResponse,
	isRecord,
	mergeHeaders,
	sseHeaders,
	toErrorResponse,
	toJsonResponse,
	usesServerReplayState,
} from "./shared.js"
import type { OpenAIOAuthServerOptions } from "./types.js"

export const handleResponsesRequest = async (
	request: Request,
	settings: OpenAIOAuthServerOptions,
	client: CodexOAuthClient,
	headers?: HeadersInit,
): Promise<Response> => {
	const body = await request.json()
	if (!isRecord(body)) {
		return toErrorResponse(
			"Request body must be a JSON object.",
			400,
			"invalid_request_error",
			headers,
		)
	}

	if (usesServerReplayState(body)) {
		return toErrorResponse(
			"Stateless Codex responses endpoint does not support `previous_response_id` or `item_reference`. Replay the full conversation history in `input` on each request.",
			400,
			"invalid_request_error",
			headers,
		)
	}
	let upstreamBody = body
	if (settings.measurementMode) {
		try {
			upstreamBody = prepareMeasurementBody(body)
		} catch (error) {
			return toErrorResponse(
				error instanceof Error ? error.message : "Invalid measurement request.",
				400,
				"invalid_request_error",
				headers,
			)
		}
	}

	const wantsStream = body.stream === true
	const upstream = await client.request("/responses", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: JSON.stringify(
			normalizeCodexResponsesBody(upstreamBody, {
				forceStream: true,
				instructions: settings.instructions,
				store: settings.store,
				preserveMaxOutputTokens: settings.measurementMode,
			}),
		),
	})

	if (!upstream.ok) {
		return copyUpstreamResponse(upstream, headers)
	}
	const responseHeaders = mergeHeaders(headers)
	if (settings.measurementMode) {
		for (const key of [
			"x-oauth-measurement-contract",
			"x-oauth-upstream-base-url",
			"x-oauth-upstream-request-id",
			"x-oauth-upstream-request-id-header",
			"x-oauth-upstream-request-count",
			"x-oauth-response-id",
			"x-oauth-response-model",
			"x-oauth-input-tokens",
			"x-oauth-output-tokens",
			"x-oauth-total-tokens",
			"x-oauth-cached-input-tokens",
			"x-oauth-reasoning-output-tokens",
		]) {
			const value = upstream.headers.get(key)
			if (value) responseHeaders.set(key, value)
		}
	}

	if (wantsStream) {
		return new Response(upstream.body, {
			status: upstream.status,
			headers: mergeHeaders(sseHeaders, responseHeaders),
		})
	}

	const completed = await collectCompletedResponseFromSse(
		upstream.body ?? new ReadableStream(),
	)
	return toJsonResponse(completed, 200, responseHeaders)
}
