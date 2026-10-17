import { iterateServerSentEvents } from "./sse.js"

export const MEASUREMENT_MODELS = ["gpt-5.6-sol", "gpt-5.6-luna"] as const
export const MEASUREMENT_MAX_OUTPUT_TOKENS = 4096
export const MEASUREMENT_CONTRACT = "subscription-single-attempt-v1"

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

const isTokenCount = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0

export const prepareMeasurementBody = (
	body: Record<string, unknown>,
): Record<string, unknown> => {
	if (
		!MEASUREMENT_MODELS.includes(
			body.model as (typeof MEASUREMENT_MODELS)[number],
		)
	) {
		throw new Error("Measurement model must be gpt-5.6-sol or gpt-5.6-luna.")
	}
	if (
		body.max_output_tokens !== undefined &&
		body.max_output_tokens !== MEASUREMENT_MAX_OUTPUT_TOKENS
	) {
		throw new Error("Measurement max_output_tokens must be 4096.")
	}
	return { ...body, max_output_tokens: MEASUREMENT_MAX_OUTPUT_TOKENS }
}

const invalidResponse = (reason: string, headers: Headers): Response => {
	headers.set("content-type", "application/json; charset=utf-8")
	return new Response(
		JSON.stringify({
			error: { type: "measurement_evidence_error", message: reason },
		}),
		{ status: 502, headers },
	)
}

/**
 * Buffer one upstream SSE response so the measurement lane can reject missing
 * evidence before it reports a successful HTTP response. This does not claim
 * that Codex enforced the requested output limit; the observed usage is checked.
 */
export const inspectMeasurementResponse = async (
	upstream: Response,
	requestedModel: string,
): Promise<Response> => {
	const headers = new Headers(upstream.headers)
	headers.delete("content-length")
	headers.delete("content-encoding")
	headers.set("x-oauth-measurement-contract", MEASUREMENT_CONTRACT)
	headers.set(
		"x-oauth-upstream-base-url",
		"https://chatgpt.com/backend-api/codex",
	)
	headers.set("x-oauth-upstream-request-count", "1")
	const upstreamRequestId = headers.get("x-request-id")
	if (upstreamRequestId) {
		headers.set("x-oauth-upstream-request-id", upstreamRequestId)
	}

	if (!upstream.ok) {
		return new Response(upstream.body, {
			status: upstream.status,
			statusText: upstream.statusText,
			headers,
		})
	}

	const raw = await upstream.text()
	let created: Record<string, unknown> | undefined
	let completed: Record<string, unknown> | undefined
	const stream = new Response(raw).body
	if (!stream)
		return invalidResponse("Completed response body is missing.", headers)
	for await (const event of iterateServerSentEvents(stream)) {
		if (
			(event.event !== "response.created" &&
				event.event !== "response.completed") ||
			!event.data
		)
			continue
		try {
			const parsed: unknown = JSON.parse(event.data)
			if (isRecord(parsed) && isRecord(parsed.response)) {
				if (parsed.type !== undefined && parsed.type !== event.event) {
					return invalidResponse(
						"Conflicting response event identity.",
						headers,
					)
				}
				if (event.event === "response.created") created = parsed.response
				else completed = parsed.response
			}
		} catch {
			return invalidResponse("Invalid response.completed event.", headers)
		}
	}

	if (!upstreamRequestId) {
		return invalidResponse("Upstream request ID is missing.", headers)
	}
	if (!completed) {
		return invalidResponse("Completed response evidence is missing.", headers)
	}
	if (
		!created ||
		created.id !== completed.id ||
		created.model !== completed.model
	) {
		return invalidResponse(
			"Response creation and completion identities differ.",
			headers,
		)
	}
	if (completed.model !== requestedModel) {
		return invalidResponse(
			"Observed model does not match the requested model.",
			headers,
		)
	}
	if (typeof completed.id !== "string" || completed.id.length === 0) {
		return invalidResponse("Observed response ID is missing.", headers)
	}
	if (!isRecord(completed.usage)) {
		return invalidResponse("Observed token usage is missing.", headers)
	}
	const { input_tokens, output_tokens, total_tokens } = completed.usage
	if (
		!isTokenCount(input_tokens) ||
		!isTokenCount(output_tokens) ||
		!isTokenCount(total_tokens)
	) {
		return invalidResponse("Observed token usage is incomplete.", headers)
	}
	if (output_tokens > MEASUREMENT_MAX_OUTPUT_TOKENS) {
		return invalidResponse("Observed output exceeded 4096 tokens.", headers)
	}

	headers.set("x-oauth-response-id", completed.id)
	headers.set("x-oauth-response-model", completed.model)
	headers.set("x-oauth-input-tokens", String(input_tokens))
	headers.set("x-oauth-output-tokens", String(output_tokens))
	headers.set("x-oauth-total-tokens", String(total_tokens))
	const inputDetails = completed.usage.input_tokens_details
	if (isRecord(inputDetails) && isTokenCount(inputDetails.cached_tokens)) {
		headers.set(
			"x-oauth-cached-input-tokens",
			String(inputDetails.cached_tokens),
		)
	}
	const outputDetails = completed.usage.output_tokens_details
	if (isRecord(outputDetails) && isTokenCount(outputDetails.reasoning_tokens)) {
		headers.set(
			"x-oauth-reasoning-output-tokens",
			String(outputDetails.reasoning_tokens),
		)
	}

	return new Response(raw, {
		status: upstream.status,
		statusText: upstream.statusText,
		headers,
	})
}
