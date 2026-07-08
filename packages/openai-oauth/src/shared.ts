import { Buffer } from "node:buffer"
import { randomBytes, timingSafeEqual } from "node:crypto"
import type {
	IncomingHttpHeaders,
	IncomingMessage,
	ServerResponse,
} from "node:http"
import { isIP, type AddressInfo } from "node:net"
import type { ChatRequest, JsonValue, UsageLike } from "./types.js"

export const DEFAULT_HOST = "127.0.0.1"
export const DEFAULT_PORT = 10531
export const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024
export const LOCAL_TOKEN_ENV = "OPENAI_OAUTH_LOCAL_TOKEN"
const MIN_LOCAL_TOKEN_LENGTH = 16

const jsonHeaders = {
	"content-type": "application/json; charset=utf-8",
}

const baseCorsHeaders = {
	"access-control-allow-methods": "GET,POST,OPTIONS",
	"access-control-allow-headers": "authorization,content-type,x-api-key",
}

export const sseHeaders = {
	"content-type": "text/event-stream; charset=utf-8",
	"cache-control": "no-cache, no-transform",
	connection: "keep-alive",
	"x-accel-buffering": "no",
}

/**
 * Deliberately excludes access-control-allow-origin. Browser access must be
 * explicitly allowlisted with --allow-origin or restored with --allow-any-origin.
 */
export const corsHeaders = baseCorsHeaders

export class RequestBodyTooLargeError extends Error {
	readonly status = 413
	readonly type = "request_too_large"

	constructor(maxBodyBytes: number) {
		super(`Request body exceeds the configured ${maxBodyBytes} byte limit.`)
	}
}

export const createLocalToken = (): string => randomBytes(32).toString("hex")

const validateLocalToken = (token: string): string => {
	if (token.length < MIN_LOCAL_TOKEN_LENGTH) {
		throw new Error(
			`Local API token must be at least ${MIN_LOCAL_TOKEN_LENGTH} characters long.`,
		)
	}
	return token
}

export const resolveLocalToken = (
	localToken: string | false | undefined,
): string | false => {
	if (localToken === false) {
		return false
	}

	if (typeof localToken === "string" && localToken.length > 0) {
		return validateLocalToken(localToken)
	}

	const envToken = process.env[LOCAL_TOKEN_ENV]
	if (typeof envToken === "string" && envToken.length > 0) {
		return validateLocalToken(envToken)
	}

	return createLocalToken()
}

export const resolveMaxBodyBytes = (value: number | undefined): number => {
	if (value === undefined) {
		return DEFAULT_MAX_BODY_BYTES
	}

	if (!Number.isFinite(value) || value <= 0) {
		throw new Error("maxBodyBytes must be a positive finite number.")
	}

	return Math.floor(value)
}

export const mergeHeaders = (
	...entries: Array<HeadersInit | undefined>
): Headers => {
	const headers = new Headers()
	for (const entry of entries) {
		if (entry == null) {
			continue
		}

		new Headers(entry).forEach((value, key) => {
			headers.set(key, value)
		})
	}
	return headers
}

const getOrigin = (request: Request): string | undefined => {
	const origin = request.headers.get("origin")
	return typeof origin === "string" && origin.length > 0 ? origin : undefined
}

const isCorsOriginAllowed = (
	origin: string | undefined,
	allowedOrigins: string[] | false | undefined,
): boolean => {
	if (allowedOrigins === false) {
		return true
	}

	if (origin === undefined) {
		return true
	}

	return Array.isArray(allowedOrigins) && allowedOrigins.includes(origin)
}

export const resolveCorsHeaders = (
	request: Request,
	allowedOrigins: string[] | false | undefined,
): HeadersInit => {
	const origin = getOrigin(request)
	if (allowedOrigins === false) {
		return {
			...baseCorsHeaders,
			"access-control-allow-origin": "*",
		}
	}

	if (origin !== undefined && allowedOrigins?.includes(origin)) {
		return {
			...baseCorsHeaders,
			"access-control-allow-origin": origin,
			vary: "origin",
		}
	}

	return {}
}

export const toCorsRejection = (
	request: Request,
	allowedOrigins: string[] | false | undefined,
): Response | undefined => {
	const origin = getOrigin(request)
	if (isCorsOriginAllowed(origin, allowedOrigins)) {
		return undefined
	}

	return toErrorResponse(
		`CORS origin is not allowed: ${origin}`,
		403,
		"forbidden_error",
	)
}

export const toPreflightResponse = (
	request: Request,
	allowedOrigins: string[] | false | undefined,
): Response => {
	const corsRejection = toCorsRejection(request, allowedOrigins)
	if (corsRejection) {
		return corsRejection
	}

	return new Response(null, {
		status: 204,
		headers: resolveCorsHeaders(request, allowedOrigins),
	})
}

export const withCorsHeaders = (
	response: Response,
	request: Request,
	allowedOrigins: string[] | false | undefined,
): Response => {
	const cors = resolveCorsHeaders(request, allowedOrigins)
	const headers = mergeHeaders(response.headers, cors)
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	})
}

const constantTimeEquals = (left: string, right: string): boolean => {
	const leftBuffer = Buffer.from(left)
	const rightBuffer = Buffer.from(right)
	return (
		leftBuffer.byteLength === rightBuffer.byteLength &&
		timingSafeEqual(leftBuffer, rightBuffer)
	)
}

export const requireLocalAuthorization = (
	request: Request,
	localToken: string | false,
): Response | undefined => {
	if (localToken === false) {
		return undefined
	}

	const authorization = request.headers.get("authorization") ?? ""
	const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1]
	const apiKey = request.headers.get("x-api-key")
	const candidate = bearer ?? apiKey
	if (typeof candidate === "string" && constantTimeEquals(candidate, localToken)) {
		return undefined
	}

	return toErrorResponse(
		"Unauthorized. Set the OpenAI API key to the local token printed by openai-oauth.",
		401,
		"authentication_error",
	)
}

export const normalizeHostForSecurityCheck = (host: string): string =>
	host.toLowerCase().replace(/^\[|\]$/g, "")

export const isLoopbackHost = (host: string): boolean => {
	const normalized = normalizeHostForSecurityCheck(host)
	if (normalized === "localhost" || normalized === "::1") {
		return true
	}

	return isIP(normalized) === 4 && normalized.startsWith("127.")
}

export const toUrlHost = (host: string): string => {
	const normalized = host.replace(/^\[|\]$/g, "")
	return normalized.includes(":") ? `[${normalized}]` : normalized
}

export const toSafeRemoteImageUrl = (value: string): URL | undefined => {
	try {
		const url = new URL(value)
		const hostname = url.hostname.toLowerCase()

		if (url.protocol !== "https:") {
			return undefined
		}

		if (
			hostname.length === 0 ||
			hostname === "localhost" ||
			hostname.endsWith(".localhost") ||
			hostname.endsWith(".local") ||
			hostname.endsWith(".internal") ||
			!hostname.includes(".") ||
			isIP(hostname) !== 0
		) {
			return undefined
		}

		return url
	} catch {
		return undefined
	}
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

export const isJsonValue = (value: unknown): value is JsonValue => {
	if (
		value == null ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	) {
		return true
	}

	if (Array.isArray(value)) {
		return value.every((item) => isJsonValue(item))
	}

	if (isRecord(value)) {
		return Object.values(value).every((item) => isJsonValue(item))
	}

	return false
}

export const toJsonResponse = (
	body: unknown,
	status = 200,
	headers?: HeadersInit,
): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: mergeHeaders(jsonHeaders, headers),
	})

export const toErrorResponse = (
	message: string,
	status = 400,
	type = "invalid_request_error",
	headers?: HeadersInit,
): Response =>
	toJsonResponse(
		{
			error: {
				message,
				type,
			},
		},
		status,
		headers,
	)

export const mapFinishReason = (
	finishReason: string | undefined,
): "stop" | "length" | "tool_calls" | "content_filter" | null => {
	switch (finishReason) {
		case "stop":
			return "stop"
		case "length":
			return "length"
		case "tool-calls":
			return "tool_calls"
		case "content-filter":
			return "content_filter"
		default:
			return null
	}
}

export const toUsage = (usage: UsageLike) => ({
	prompt_tokens: usage.inputTokens ?? 0,
	completion_tokens: usage.outputTokens ?? 0,
	total_tokens: usage.totalTokens ?? 0,
	prompt_tokens_details:
		usage.cachedInputTokens == null
			? undefined
			: {
					cached_tokens: usage.cachedInputTokens,
				},
	completion_tokens_details:
		usage.reasoningTokens == null
			? undefined
			: {
					reasoning_tokens: usage.reasoningTokens,
				},
})

export const summarizeChatRequest = (request: {
	model?: string
	messages?: Array<{ role?: string }>
	reasoning_effort?: ChatRequest["reasoning_effort"]
	stream?: boolean
	tools?: unknown[]
}) => ({
	bodyKeys: Object.keys(request).sort(),
	messageCount: request.messages?.length ?? 0,
	messageRoles: (request.messages ?? [])
		.map((message) => message.role)
		.filter((role): role is string => typeof role === "string"),
	model: request.model,
	reasoningEffort: request.reasoning_effort,
	stream: request.stream === true,
	toolCount: request.tools?.length ?? 0,
})

export const usesServerReplayState = (
	value: Record<string, unknown>,
): boolean => {
	if (typeof value.previous_response_id === "string") {
		return true
	}

	if (!Array.isArray(value.input)) {
		return false
	}

	return value.input.some(
		(item) =>
			isRecord(item) &&
			item.type === "item_reference" &&
			typeof item.id === "string",
	)
}

export const resolveModels = (
	models: string[] | undefined,
): string[] | undefined =>
	Array.isArray(models) && models.length > 0 ? [...models] : undefined

export const copyUpstreamResponse = (
	response: Response,
	headers?: HeadersInit,
): Response => {
	const responseHeaders = mergeHeaders(response.headers, headers)

	if (!responseHeaders.has("content-type")) {
		responseHeaders.set("content-type", "application/json; charset=utf-8")
	}

	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers: responseHeaders,
	})
}

export const readNodeBody = async (
	request: IncomingMessage,
	maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
): Promise<Uint8Array> => {
	const contentLength = request.headers["content-length"]
	if (typeof contentLength === "string") {
		const parsed = Number.parseInt(contentLength, 10)
		if (Number.isFinite(parsed) && parsed > maxBodyBytes) {
			throw new RequestBodyTooLargeError(maxBodyBytes)
		}
	}

	const chunks: Buffer[] = []
	let totalBytes = 0

	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
		totalBytes += buffer.byteLength
		if (totalBytes > maxBodyBytes) {
			throw new RequestBodyTooLargeError(maxBodyBytes)
		}
		chunks.push(buffer)
	}

	return Buffer.concat(chunks)
}

export const toHeaders = (headers: IncomingHttpHeaders): Headers => {
	const nextHeaders = new Headers()

	for (const [key, value] of Object.entries(headers)) {
		if (Array.isArray(value)) {
			for (const item of value) {
				nextHeaders.append(key, item)
			}
			continue
		}

		if (typeof value === "string") {
			nextHeaders.set(key, value)
		}
	}

	return nextHeaders
}

export const toWebRequest = async (
	request: IncomingMessage,
	options: { host: string; port: number; maxBodyBytes?: number },
): Promise<Request> => {
	const url = `http://${toUrlHost(options.host)}:${options.port}${request.url ?? "/"}`
	const body =
		request.method === "GET" || request.method === "HEAD"
			? undefined
			: await readNodeBody(request, options.maxBodyBytes)

	return new Request(url, {
		method: request.method,
		headers: toHeaders(request.headers),
		body:
			body == null || body.byteLength === 0
				? undefined
				: new Blob([Buffer.from(body)]),
		duplex: "half",
	} as RequestInit)
}

export const writeWebResponse = async (
	response: ServerResponse,
	webResponse: Response,
): Promise<void> => {
	response.statusCode = webResponse.status
	webResponse.headers.forEach((value, key) => {
		response.setHeader(key, value)
	})

	if (webResponse.body == null) {
		response.end()
		return
	}

	const reader = webResponse.body.getReader()
	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) {
				break
			}

			response.write(Buffer.from(value))
		}
	} finally {
		reader.releaseLock()
	}

	response.end()
}

export const resolveAddress = (
	address: AddressInfo,
	host: string,
): { host: string; port: number } => ({
	host:
		address.address === "::" || address.address === "0.0.0.0"
			? host
			: address.address,
	port: address.port,
})
