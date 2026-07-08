import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import {
	type CodexOAuthSettings,
	createCodexOAuthClient,
} from "../../openai-oauth-core/src/index.js"
import {
	createOpenAIOAuth,
	type OpenAIOAuthProvider,
} from "../../openai-oauth-provider/src/index.js"
import { handleChatCompletionsRequest } from "./chat-completions.js"
import { createRequestLogger } from "./logging.js"
import { createModelResolver } from "./models.js"
import { handleResponsesRequest } from "./responses.js"
import {
	DEFAULT_HOST,
	DEFAULT_PORT,
	RequestBodyTooLargeError,
	isLoopbackHost,
	requireLocalAuthorization,
	resolveAddress,
	resolveCorsHeaders,
	resolveLocalToken,
	resolveMaxBodyBytes,
	toCorsRejection,
	toErrorResponse,
	toJsonResponse,
	toPreflightResponse,
	toUrlHost,
	toWebRequest,
	withCorsHeaders,
	writeWebResponse,
} from "./shared.js"
import type {
	OpenAIOAuthFetchHandler,
	OpenAIOAuthServerOptions,
	RunningOpenAIOAuthServer,
} from "./types.js"

const shouldRequireLocalAuth = (pathname: string): boolean =>
	pathname === "/v1" || pathname.startsWith("/v1/")

const handleRoutes = async (
	request: Request,
	settings: OpenAIOAuthServerOptions,
	provider: OpenAIOAuthProvider,
	client: ReturnType<typeof createCodexOAuthClient>,
	resolveModels: () => Promise<string[]>,
	requestLogger: ReturnType<typeof createRequestLogger>,
	localToken: string | false,
): Promise<Response> => {
	if (request.method === "OPTIONS") {
		return toPreflightResponse(request, settings.allowedOrigins)
	}

	const corsRejection = toCorsRejection(request, settings.allowedOrigins)
	if (corsRejection) {
		return corsRejection
	}

	const url = new URL(request.url)
	const cors = resolveCorsHeaders(request, settings.allowedOrigins)

	if (request.method === "GET" && url.pathname === "/health") {
		return toJsonResponse(
			{
				ok: true,
				replay_state: "stateless",
			},
			200,
			cors,
		)
	}

	if (shouldRequireLocalAuth(url.pathname)) {
		const authRejection = requireLocalAuthorization(request, localToken)
		if (authRejection) {
			return authRejection
		}
	}

	if (request.method === "GET" && url.pathname === "/v1/models") {
		try {
			const models = await resolveModels()
			return toJsonResponse(
				{
					object: "list",
					data: models.map((id) => ({
						id,
						object: "model",
						created: 0,
						owned_by: "codex-oauth",
					})),
				},
				200,
				cors,
			)
		} catch (error) {
			return toErrorResponse(
				error instanceof Error ? error.message : "Failed to load models.",
				502,
				"upstream_error",
				cors,
			)
		}
	}

	if (request.method === "POST" && url.pathname === "/v1/responses") {
		return handleResponsesRequest(request, settings, client, cors)
	}

	if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
		return handleChatCompletionsRequest(
			request,
			provider,
			requestLogger,
			cors,
		)
	}

	return toErrorResponse("Route not found.", 404, "not_found_error", cors)
}

export const createOpenAIOAuthFetchHandler = (
	settings: OpenAIOAuthServerOptions = {},
): OpenAIOAuthFetchHandler => {
	const localToken = resolveLocalToken(settings.localToken)
	const effectiveSettings: OpenAIOAuthServerOptions = {
		...settings,
		localToken,
		maxBodyBytes: resolveMaxBodyBytes(settings.maxBodyBytes),
	}
	const sharedSettings: CodexOAuthSettings = {
		...effectiveSettings,
		responsesState: false,
	}
	const client = createCodexOAuthClient(sharedSettings)
	const provider = createOpenAIOAuth(sharedSettings)
	const resolveModels = createModelResolver(client, effectiveSettings.models, {
		codexVersion: effectiveSettings.codexVersion,
	})
	const requestLogger = createRequestLogger(effectiveSettings)

	const handler = async (request: Request) => {
		try {
			const response = await handleRoutes(
				request,
				effectiveSettings,
				provider,
				client,
				resolveModels,
				requestLogger,
				localToken,
			)
			return withCorsHeaders(
				response,
				request,
				effectiveSettings.allowedOrigins,
			)
		} catch (error) {
			const response = toErrorResponse(
				error instanceof Error ? error.message : "Unexpected server error.",
				500,
				"server_error",
			)
			return withCorsHeaders(
				response,
				request,
				effectiveSettings.allowedOrigins,
			)
		}
	}

	return Object.assign(handler, {
		localToken: localToken === false ? undefined : localToken,
	})
}

export const startOpenAIOAuthServer = async (
	settings: OpenAIOAuthServerOptions = {},
): Promise<RunningOpenAIOAuthServer> => {
	const host = settings.host ?? DEFAULT_HOST
	const port = settings.port ?? DEFAULT_PORT
	if (!settings.allowUnsafeRemoteBind && !isLoopbackHost(host)) {
		throw new Error(
			`Refusing to listen on non-loopback host ${host}. Set allowUnsafeRemoteBind only for trusted, firewalled environments.`,
		)
	}

	const handler = createOpenAIOAuthFetchHandler(settings)
	const maxBodyBytes = resolveMaxBodyBytes(settings.maxBodyBytes)
	const server = createServer(async (req, res) => {
		try {
			const request = await toWebRequest(req, {
				host,
				port,
				maxBodyBytes,
			})
			const response = await handler(request)
			await writeWebResponse(res, response)
		} catch (error) {
			if (res.headersSent || res.writableEnded) {
				res.destroy(error instanceof Error ? error : undefined)
				return
			}

			const message =
				error instanceof Error ? error.message : "Unexpected server error."
			const status =
				error instanceof RequestBodyTooLargeError ? error.status : 500
			const type =
				error instanceof RequestBodyTooLargeError
					? error.type
					: "server_error"
			await writeWebResponse(res, toErrorResponse(message, status, type))
		}
	})

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject)
		server.listen(port, host, () => {
			server.off("error", reject)
			resolve()
		})
	})

	const address = resolveAddress(server.address() as AddressInfo, host)
	return {
		server,
		host: address.host,
		port: address.port,
		url: `http://${toUrlHost(address.host)}:${address.port}/v1`,
		localToken: handler.localToken,
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error) {
						reject(error)
						return
					}

					resolve()
				})
			}),
	}
}
