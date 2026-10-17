import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test, vi } from "vitest"
import {
	collectCompletedResponseFromSse,
	createCodexOAuthFetch,
	normalizeCodexResponsesBody,
} from "../src/index.js"

const createAuthFile = async (): Promise<string> => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-oauth-core-"))
	const authPath = path.join(root, "auth.json")
	await fs.writeFile(
		authPath,
		JSON.stringify(
			{
				tokens: {
					access_token: "access-token",
					account_id: "acct-1",
				},
			},
			null,
			2,
		),
		"utf-8",
	)
	return authPath
}

afterEach(() => {
	vi.restoreAllMocks()
})

describe("normalizeCodexResponsesBody", () => {
	test("adds an empty-string fallback, disables store, and strips max_output_tokens", () => {
		const normalized = normalizeCodexResponsesBody({
			model: "gpt-5.2",
			max_output_tokens: 128,
		})

		expect(normalized.instructions).toBe("")
		expect(normalized.store).toBe(false)
		expect("max_output_tokens" in normalized).toBe(false)
	})

	test("preserves caller-provided instructions and explicit store", () => {
		const normalized = normalizeCodexResponsesBody(
			{
				instructions: "caller-instructions",
				store: true,
			},
			{
				instructions: "default-instructions",
			},
		)

		expect(normalized.instructions).toBe("caller-instructions")
		expect(normalized.store).toBe(true)
	})

	test("preserves a requested output limit for the measurement lane", () => {
		const normalized = normalizeCodexResponsesBody(
			{ model: "gpt-5.6-sol", max_output_tokens: 4096 },
			{ preserveMaxOutputTokens: true },
		)
		expect(normalized.max_output_tokens).toBe(4096)
	})

	test("preserves explicit empty and whitespace instructions", () => {
		expect(
			normalizeCodexResponsesBody(
				{
					instructions: "",
				},
				{
					instructions: "default-instructions",
				},
			).instructions,
		).toBe("")

		expect(
			normalizeCodexResponsesBody(
				{
					instructions: " ",
				},
				{
					instructions: "default-instructions",
				},
			).instructions,
		).toBe(" ")
	})

	test("allows callers to override the store default", () => {
		const normalized = normalizeCodexResponsesBody(
			{
				model: "gpt-5.2",
			},
			{
				store: false,
			},
		)

		expect(normalized.store).toBe(false)
	})
})

const measurementSse = (response: Record<string, unknown>): string =>
	[
		"event: response.created",
		`data: ${JSON.stringify({ response: { id: "resp_measured", model: response.model } })}`,
		"",
		"event: response.completed",
		`data: ${JSON.stringify({ response: { id: "resp_measured", ...response } })}`,
		"",
	].join("\n")

describe("subscription measurement transport", () => {
	test("sends one fixed-model request with a 4096-token request and returns raw evidence", async () => {
		const authFilePath = await createAuthFile()
		const fetch = vi.fn(
			async () =>
				new Response(
					measurementSse({
						model: "gpt-5.6-sol",
						usage: { input_tokens: 12, output_tokens: 23, total_tokens: 35 },
					}),
					{ status: 200, headers: { "x-request-id": "upstream-123" } },
				),
		)
		const oauthFetch = createCodexOAuthFetch({
			authFilePath,
			ensureFresh: false,
			fetch,
			measurementMode: true,
		})
		const response = await oauthFetch("responses", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model: "gpt-5.6-sol" }),
		})
		expect(fetch).toHaveBeenCalledTimes(1)
		expect(fetch.mock.calls[0]?.[0]).toBe(
			"https://chatgpt.com/backend-api/codex/responses",
		)
		expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
			model: "gpt-5.6-sol",
			max_output_tokens: 4096,
		})
		expect(response.status).toBe(200)
		expect(response.headers.get("x-oauth-upstream-request-id")).toBe(
			"upstream-123",
		)
		expect(response.headers.get("x-oauth-response-id")).toBe("resp_measured")
		expect(response.headers.get("x-oauth-response-model")).toBe("gpt-5.6-sol")
		expect(response.headers.get("x-oauth-input-tokens")).toBe("12")
		expect(response.headers.get("x-oauth-output-tokens")).toBe("23")
		expect(response.headers.get("x-oauth-upstream-request-count")).toBe("1")
		expect(await response.text()).toContain("response.completed")
	})

	test("does not retry a 429 in measurement mode", async () => {
		const authFilePath = await createAuthFile()
		const fetch = vi.fn(
			async () => new Response("rate limited", { status: 429 }),
		)
		const oauthFetch = createCodexOAuthFetch({
			authFilePath,
			ensureFresh: false,
			fetch,
			measurementMode: true,
		})
		const response = await oauthFetch("responses", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model: "gpt-5.6-luna", max_output_tokens: 4096 }),
		})
		expect(response.status).toBe(429)
		expect(fetch).toHaveBeenCalledTimes(1)
	})

	test.each([
		["unapproved model", { model: "gpt-5.4" }],
		[
			"conflicting output limit",
			{ model: "gpt-5.6-sol", max_output_tokens: 512 },
		],
	])("rejects %s before any upstream request", async (_case, body) => {
		const authFilePath = await createAuthFile()
		const fetch = vi.fn()
		const oauthFetch = createCodexOAuthFetch({
			authFilePath,
			ensureFresh: false,
			fetch,
			measurementMode: true,
		})
		await expect(
			oauthFetch("responses", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			}),
		).rejects.toThrow()
		expect(fetch).not.toHaveBeenCalled()
	})

	test.each([
		["missing usage", { model: "gpt-5.6-sol" }],
		[
			"wrong model",
			{
				model: "gpt-5.6-luna",
				usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
			},
		],
		[
			"output over 4096",
			{
				model: "gpt-5.6-sol",
				usage: { input_tokens: 1, output_tokens: 4097, total_tokens: 4098 },
			},
		],
	])("does not accept %s as measured success", async (_case, completed) => {
		const authFilePath = await createAuthFile()
		const fetch = vi.fn(
			async () =>
				new Response(measurementSse(completed), {
					status: 200,
					headers: { "x-request-id": "upstream-123" },
				}),
		)
		const oauthFetch = createCodexOAuthFetch({
			authFilePath,
			ensureFresh: false,
			fetch,
			measurementMode: true,
		})
		const response = await oauthFetch("responses", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model: "gpt-5.6-sol", max_output_tokens: 4096 }),
		})
		expect(response.status).toBe(502)
		expect(fetch).toHaveBeenCalledTimes(1)
		expect(response.headers.get("x-oauth-upstream-request-count")).toBe("1")
	})

	test("requires an upstream request ID for accepted evidence", async () => {
		const authFilePath = await createAuthFile()
		const fetch = vi.fn(
			async () =>
				new Response(
					measurementSse({
						model: "gpt-5.6-sol",
						usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
					}),
					{ status: 200 },
				),
		)
		const oauthFetch = createCodexOAuthFetch({
			authFilePath,
			ensureFresh: false,
			fetch,
			measurementMode: true,
		})
		const response = await oauthFetch("responses", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model: "gpt-5.6-sol" }),
		})
		expect(response.status).toBe(502)
		expect(fetch).toHaveBeenCalledTimes(1)
	})

	test("rejects conflicting model identities within upstream SSE", async () => {
		const authFilePath = await createAuthFile()
		const sse = [
			"event: response.created",
			'data: {"response":{"id":"resp_measured","model":"gpt-5.6-luna"}}',
			"",
			"event: response.completed",
			'data: {"response":{"id":"resp_measured","model":"gpt-5.6-sol","usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}}',
			"",
		].join("\n")
		const fetch = vi.fn(
			async () =>
				new Response(sse, {
					status: 200,
					headers: { "x-request-id": "upstream-123" },
				}),
		)
		const oauthFetch = createCodexOAuthFetch({
			authFilePath,
			ensureFresh: false,
			fetch,
			measurementMode: true,
		})
		const response = await oauthFetch("responses", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model: "gpt-5.6-sol" }),
		})
		expect(response.status).toBe(502)
		expect(fetch).toHaveBeenCalledTimes(1)
	})

	test("refuses custom upstream and retry configuration", () => {
		expect(() =>
			createCodexOAuthFetch({
				measurementMode: true,
				baseURL: "https://example.com/codex",
				allowUnsafeBaseURL: true,
			}),
		).toThrow()
		expect(() =>
			createCodexOAuthFetch({ measurementMode: true, maxRetries: 1 }),
		).toThrow()
	})
})

describe("createCodexOAuthFetch", () => {
	test("injects oauth headers and normalizes responses requests", async () => {
		const authFilePath = await createAuthFile()
		const fetch = vi.fn(async () => new Response(null, { status: 200 }))

		const oauthFetch = createCodexOAuthFetch({
			authFilePath,
			ensureFresh: false,
			fetch,
			instructions: "core-instructions",
		})

		await oauthFetch("https://example.test/v1/responses", {
			method: "POST",
			headers: {
				Authorization: "Bearer ignored",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: "gpt-5.2",
				max_output_tokens: 5,
			}),
		})

		expect(fetch).toHaveBeenCalledTimes(1)
		expect(fetch).toHaveBeenCalledWith(
			"https://chatgpt.com/backend-api/codex/responses",
			expect.objectContaining({
				headers: expect.any(Headers),
				body: expect.any(String),
			}),
		)

		const [, init] = fetch.mock.calls[0] ?? []
		const headers = new Headers(init?.headers)
		const body = JSON.parse(String(init?.body))

		expect(headers.get("authorization")).toMatch(/^Bearer /)
		expect(headers.get("chatgpt-account-id")).toBeTruthy()
		expect(body.instructions).toBe("core-instructions")
		expect(body.store).toBe(false)
		expect(body.max_output_tokens).toBeUndefined()

		await fs.rm(path.dirname(authFilePath), {
			recursive: true,
			force: true,
		})
	})

	test("preserves absolute codex urls without duplicating the upstream path", async () => {
		const authFilePath = await createAuthFile()
		const fetch = vi.fn(async () => new Response(null, { status: 200 }))

		const oauthFetch = createCodexOAuthFetch({
			authFilePath,
			ensureFresh: false,
			fetch,
		})

		await oauthFetch(
			"https://chatgpt.com/backend-api/codex/responses?foo=bar",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model: "gpt-5.2",
				}),
			},
		)

		expect(fetch).toHaveBeenCalledTimes(1)
		expect(fetch).toHaveBeenCalledWith(
			"https://chatgpt.com/backend-api/codex/responses?foo=bar",
			expect.any(Object),
		)

		await fs.rm(path.dirname(authFilePath), {
			recursive: true,
			force: true,
		})
	})

	test("supports relative response paths", async () => {
		const authFilePath = await createAuthFile()
		const fetch = vi.fn(async () => new Response(null, { status: 200 }))

		const oauthFetch = createCodexOAuthFetch({
			authFilePath,
			ensureFresh: false,
			fetch,
		})

		await oauthFetch("responses", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: "gpt-5.2",
			}),
		})

		expect(fetch).toHaveBeenCalledTimes(1)
		expect(fetch).toHaveBeenCalledWith(
			"https://chatgpt.com/backend-api/codex/responses",
			expect.any(Object),
		)

		await fs.rm(path.dirname(authFilePath), {
			recursive: true,
			force: true,
		})
	})

	test("rejects custom upstream base urls unless explicitly allowed", () => {
		const fetch = vi.fn(async () => new Response(null, { status: 200 }))

		expect(() =>
			createCodexOAuthFetch({
				baseURL: "https://example.com/codex",
				fetch,
			}),
		).toThrow("untrusted Codex base URL")

		expect(() =>
			createCodexOAuthFetch({
				allowUnsafeBaseURL: true,
				baseURL: "https://example.com/codex",
				fetch,
			}),
		).not.toThrow()
	})

	test("can disable local replay state entirely", async () => {
		const authFilePath = await createAuthFile()
		const fetch = vi.fn(async () => new Response(null, { status: 200 }))

		const oauthFetch = createCodexOAuthFetch({
			authFilePath,
			ensureFresh: false,
			fetch,
			responsesState: false,
		})

		await oauthFetch("https://example.test/v1/responses", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: "gpt-5.2",
				previous_response_id: "resp_1",
				input: [],
			}),
		})

		const [, init] = fetch.mock.calls[0] ?? []
		expect(JSON.parse(String(init?.body))).toMatchObject({
			model: "gpt-5.2",
			previous_response_id: "resp_1",
			input: [],
			store: false,
			instructions: "",
		})

		await fs.rm(path.dirname(authFilePath), {
			recursive: true,
			force: true,
		})
	})

	test("passes token url overrides through auth refresh", async () => {
		const root = await fs.mkdtemp(
			path.join(os.tmpdir(), "codex-oauth-refresh-"),
		)
		const authFilePath = path.join(root, "auth.json")
		const now = new Date("2025-01-01T00:00:00Z")
		const expiredToken = [
			Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString(
				"base64url",
			),
			Buffer.from(
				JSON.stringify({
					exp: Math.floor(now.getTime() / 1000) - 10,
				}),
			).toString("base64url"),
			"signature",
		].join(".")
		const fetch = vi.fn(async (input: RequestInfo | URL) => {
			if (String(input) === "https://auth.example.com/custom/token") {
				return new Response(
					JSON.stringify({
						access_token: "new-access",
						refresh_token: "new-refresh",
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				)
			}

			return new Response(null, { status: 200 })
		})

		try {
			await fs.writeFile(
				authFilePath,
				JSON.stringify(
					{
						tokens: {
							access_token: expiredToken,
							refresh_token: "refresh",
							account_id: "acct-1",
						},
						last_refresh: "2020-01-01T00:00:00Z",
					},
					null,
					2,
				),
				"utf-8",
			)

			const oauthFetch = createCodexOAuthFetch({
				authFilePath,
				fetch,
				now: () => now,
				tokenUrl: "https://auth.example.com/custom/token",
				allowUnsafeTokenUrl: true,
			})

			await oauthFetch("responses", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model: "gpt-5.2",
				}),
			})

			expect(fetch).toHaveBeenCalledWith(
				"https://auth.example.com/custom/token",
				expect.objectContaining({
					method: "POST",
				}),
			)
		} finally {
			await fs.rm(root, {
				recursive: true,
				force: true,
			})
		}
	})

	test("refreshes cached token when JWT exp is within margin", async () => {
		const root = await fs.mkdtemp(
			path.join(os.tmpdir(), "codex-oauth-refresh-cache-"),
		)
		const authFilePath = path.join(root, "auth.json")
		let currentTime = new Date("2025-01-01T00:00:00Z")
		const farFutureExp = Math.floor(currentTime.getTime() / 1000) + 7200

		const makeJwt = (exp: number) =>
			[
				Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString(
					"base64url",
				),
				Buffer.from(JSON.stringify({ exp })).toString("base64url"),
				"signature",
			].join(".")

		const tokenEndpointCalls: string[] = []
		const fetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input)
			if (url.includes("/oauth/token")) {
				tokenEndpointCalls.push(url)
				return new Response(
					JSON.stringify({
						access_token: makeJwt(farFutureExp + 7200),
						refresh_token: "new-refresh",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				)
			}
			return new Response(null, { status: 200 })
		})

		try {
			await fs.writeFile(
				authFilePath,
				JSON.stringify({
					tokens: {
						access_token: makeJwt(farFutureExp),
						refresh_token: "refresh-token",
						account_id: "acct-1",
					},
					last_refresh: currentTime.toISOString(),
				}),
				"utf-8",
			)

			const oauthFetch = createCodexOAuthFetch({
				authFilePath,
				fetch,
				now: () => currentTime,
				ensureFresh: true,
			})

			await oauthFetch("responses", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: "gpt-5.2", input: [] }),
			})

			expect(tokenEndpointCalls).toHaveLength(0)

			currentTime = new Date(farFutureExp * 1000 - 60_000)

			await oauthFetch("responses", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: "gpt-5.2", input: [] }),
			})

			expect(tokenEndpointCalls.length).toBeGreaterThanOrEqual(1)
		} finally {
			await fs.rm(root, { recursive: true, force: true })
		}
	})

	test("refreshes cached opaque token after REFRESH_INTERVAL_MS", async () => {
		const root = await fs.mkdtemp(
			path.join(os.tmpdir(), "codex-oauth-opaque-refresh-"),
		)
		const authFilePath = path.join(root, "auth.json")
		let currentTime = new Date("2025-01-01T00:00:00Z")

		const tokenEndpointCalls: string[] = []
		const fetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input)
			if (url.includes("/oauth/token")) {
				tokenEndpointCalls.push(url)
				return new Response(
					JSON.stringify({
						access_token: "refreshed-opaque-key",
						refresh_token: "new-refresh",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				)
			}
			return new Response(null, { status: 200 })
		})

		try {
			await fs.writeFile(
				authFilePath,
				JSON.stringify({
					tokens: {
						access_token: "opaque-api-key-no-jwt",
						refresh_token: "refresh-token",
						account_id: "acct-1",
					},
					last_refresh: currentTime.toISOString(),
				}),
				"utf-8",
			)

			const oauthFetch = createCodexOAuthFetch({
				authFilePath,
				fetch,
				now: () => currentTime,
				ensureFresh: true,
			})

			await oauthFetch("responses", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: "gpt-5.2", input: [] }),
			})

			expect(tokenEndpointCalls).toHaveLength(0)

			currentTime = new Date(currentTime.getTime() + 56 * 60 * 1000)

			await oauthFetch("responses", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: "gpt-5.2", input: [] }),
			})

			expect(tokenEndpointCalls.length).toBeGreaterThanOrEqual(1)
		} finally {
			await fs.rm(root, { recursive: true, force: true })
		}
	})
})

describe("retry and concurrency in createCodexOAuthFetch", () => {
	test("retries on 429 and returns success", async () => {
		const authFilePath = await createAuthFile()
		let callCount = 0
		const fetch = vi.fn(async () => {
			callCount++
			if (callCount <= 2) {
				return new Response("rate limited", { status: 429 })
			}
			return new Response(null, { status: 200 })
		})

		const oauthFetch = createCodexOAuthFetch({
			authFilePath,
			ensureFresh: false,
			fetch,
			responsesState: false,
			maxRetries: 3,
			retryBaseDelayMs: 0,
			retryMaxDelayMs: 1,
		})

		const response = await oauthFetch("responses", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model: "gpt-5.2" }),
		})

		expect(response.status).toBe(200)
		expect(fetch).toHaveBeenCalledTimes(3)

		await fs.rm(path.dirname(authFilePath), {
			recursive: true,
			force: true,
		})
	})

	test("concurrency limiter gates parallel requests", async () => {
		const authFilePath = await createAuthFile()
		let maxConcurrent = 0
		let current = 0
		const fetch = vi.fn(async () => {
			current++
			maxConcurrent = Math.max(maxConcurrent, current)
			await new Promise((r) => setTimeout(r, 30))
			current--
			return new Response(null, { status: 200 })
		})

		const oauthFetch = createCodexOAuthFetch({
			authFilePath,
			ensureFresh: false,
			fetch,
			responsesState: false,
			maxConcurrentRequests: 1,
		})

		const makeRequest = () =>
			oauthFetch("responses", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: "gpt-5.2" }),
			})

		await Promise.all([makeRequest(), makeRequest()])
		expect(maxConcurrent).toBe(1)

		await fs.rm(path.dirname(authFilePath), {
			recursive: true,
			force: true,
		})
	})
})

describe("collectCompletedResponseFromSse", () => {
	test("returns the completed response object", async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					new TextEncoder().encode(
						[
							"event: response.created",
							'data: {"response":{"id":"resp_1","status":"in_progress"}}',
							"",
							"event: response.completed",
							'data: {"response":{"id":"resp_1","status":"completed","output":[{"type":"message"}]}}',
							"",
						].join("\n"),
					),
				)
				controller.close()
			},
		})

		await expect(collectCompletedResponseFromSse(stream)).resolves.toEqual({
			id: "resp_1",
			status: "completed",
			output: [{ type: "message" }],
		})
	})
})
