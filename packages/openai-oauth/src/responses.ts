import {
	type CodexOAuthClient,
	collectCompletedResponseFromSse,
	normalizeCodexResponsesBody,
} from "../../openai-oauth-core/src/index.js"
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

	const wantsStream = body.stream === true
	const upstream = await client.request("/responses", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: JSON.stringify(
			normalizeCodexResponsesBody(body, {
				forceStream: true,
				instructions: settings.instructions,
				store: settings.store,
			}),
		),
	})

	if (!upstream.ok) {
		return copyUpstreamResponse(upstream, headers)
	}

	if (wantsStream) {
		return new Response(upstream.body, {
			status: upstream.status,
			headers: mergeHeaders(sseHeaders, headers),
		})
	}

	const completed = await collectCompletedResponseFromSse(
		upstream.body ?? new ReadableStream(),
	)
	return toJsonResponse(completed, 200, headers)
}
