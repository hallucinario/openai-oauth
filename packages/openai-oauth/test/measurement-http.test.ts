import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { startOpenAIOAuthServer } from "../src/index.js"
import type { RunningOpenAIOAuthServer } from "../src/types.js"

const models = ["gpt-5.6-sol", "gpt-5.6-luna"] as const
const endpoints = ["chat/completions", "responses"] as const
const contract = "subscription-single-attempt-v1"
const upstreamBase = "https://chatgpt.com/backend-api/codex"
const uuidV4 =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const usage = {
	input_tokens: 12,
	output_tokens: 23,
	total_tokens: 35,
	input_tokens_details: { cached_tokens: 4 },
	output_tokens_details: { reasoning_tokens: 5 },
}

const measuredSse = (model: string) => {
	const response = {
		id: "resp_measured_http",
		object: "response",
		created_at: 1_700_000_000,
		model,
	}
	const item = {
		type: "message",
		id: "msg_measured_http",
		role: "assistant",
		status: "completed",
		content: [{ type: "output_text", text: "measured", annotations: [] }],
	}
	return [
		{
			type: "response.created",
			response: { ...response, status: "in_progress", output: [] },
		},
		{ type: "response.output_item.added", output_index: 0, item },
		{
			type: "response.output_text.delta",
			item_id: item.id,
			output_index: 0,
			content_index: 0,
			delta: "measured",
		},
		{ type: "response.output_item.done", output_index: 0, item },
		{
			type: "response.completed",
			response: { ...response, status: "completed", output: [item], usage },
		},
	]
		.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
		.join("")
}

describe("measurement HTTP boot attestation", () => {
	let root: string
	let authFilePath: string
	const servers = new Set<RunningOpenAIOAuthServer>()

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "oauth-measurement-http-"))
		authFilePath = path.join(root, "auth.json")
		await fs.writeFile(
			authFilePath,
			JSON.stringify({
				tokens: {
					access_token: "synthetic-measurement-access",
					account_id: "synthetic-measurement-account",
				},
			}),
		)
	})

	afterEach(async () => {
		try {
			await Promise.all([...servers].map((server) => server.close()))
		} finally {
			servers.clear()
			await fs.rm(root, { recursive: true, force: true })
		}
	})

	const start = async (upstreamFetch: typeof fetch, measurementMode = true) => {
		const server = await startOpenAIOAuthServer({
			host: "127.0.0.1",
			port: 0,
			authFilePath,
			ensureFresh: false,
			fetch: upstreamFetch,
			measurementMode,
		})
		servers.add(server)
		return server
	}

	const health = async (server: RunningOpenAIOAuthServer) => {
		const response = await fetch(new URL("/health", server.url), {
			headers: { "x-oauth-instance-id": "spoofed-client-instance" },
		})
		expect(response.status).toBe(200)
		expect(response.headers.get("x-oauth-measurement-contract")).toBe(contract)
		const body = await response.json()
		expect(body).toEqual({
			ok: true,
			replay_state: "stateless",
			instance_id: expect.stringMatching(uuidV4),
			measurement: {
				contract,
				models: [...models],
				upstream: upstreamBase,
				max_output_tokens: 4096,
				max_retries: 0,
				chat_completions_stream: false,
			},
		})
		expect(response.headers.get("x-oauth-instance-id")).toBe(body.instance_id)
		return body.instance_id as string
	}

	test("keeps one UUID per boot and rotates it for new servers and restarts", async () => {
		const upstreamFetch = vi.fn<typeof fetch>(async () => {
			throw new Error("Health must not dispatch upstream or refresh auth")
		})
		const first = await start(upstreamFetch)
		const firstId = await health(first)
		expect(await health(first)).toBe(firstId)
		const second = await start(upstreamFetch)
		const secondId = await health(second)
		expect(secondId).not.toBe(firstId)
		await first.close()
		servers.delete(first)
		const restarted = await start(upstreamFetch)
		const restartedId = await health(restarted)
		expect(restartedId).not.toBe(firstId)
		expect(restartedId).not.toBe(secondId)
		expect(await health(second)).toBe(secondId)
		expect(upstreamFetch).not.toHaveBeenCalled()
	})

	for (const model of models) {
		for (const endpoint of endpoints) {
			test.each([
				200, 429,
			])(`${model} ${endpoint} status %s binds a single attempt to its boot`, async (status) => {
				const upstreamFetch = vi.fn<typeof fetch>(async (input, init) => {
					expect(String(input)).toBe(`${upstreamBase}/responses`)
					expect(init?.method).toBe("POST")
					expect(JSON.parse(String(init?.body))).toMatchObject({
						model,
						stream: true,
						max_output_tokens: 4096,
					})
					expect(new Headers(init?.headers).get("authorization")).toBe(
						"Bearer synthetic-measurement-access",
					)
					return new Response(
						status === 200
							? measuredSse(model)
							: JSON.stringify({
									error: { type: "rate_limit", message: "synthetic limit" },
								}),
						{
							status,
							headers: {
								"content-type":
									status === 200 ? "text/event-stream" : "application/json",
								"x-request-id": "upstream-measured-http",
								"x-oauth-instance-id": "spoofed-upstream-instance",
							},
						},
					)
				})
				const server = await start(upstreamFetch)
				const instanceId = await health(server)
				const response = await fetch(`${server.url}/${endpoint}`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						authorization: `Bearer ${server.localToken}`,
						"x-oauth-instance-id": "spoofed-client-instance",
					},
					body: JSON.stringify({
						model,
						stream: false,
						...(endpoint === "chat/completions"
							? { messages: [{ role: "user", content: "hi" }] }
							: { input: "hi" }),
					}),
				})
				expect(response.status).toBe(status)
				expect(upstreamFetch).toHaveBeenCalledTimes(1)
				for (const [header, value] of Object.entries({
					"x-oauth-instance-id": instanceId,
					"x-oauth-measurement-contract": contract,
					"x-oauth-upstream-base-url": upstreamBase,
					"x-oauth-upstream-request-count": "1",
					"x-oauth-upstream-request-id": "upstream-measured-http",
					"x-oauth-upstream-request-id-header": "x-request-id",
				})) {
					expect(response.headers.get(header), header).toBe(value)
				}
				const body = await response.json()
				if (status === 429) {
					expect(body).toMatchObject({ error: { type: "rate_limit" } })
				} else {
					for (const [header, value] of Object.entries({
						"x-oauth-response-id": "resp_measured_http",
						"x-oauth-response-model": model,
						"x-oauth-input-tokens": "12",
						"x-oauth-output-tokens": "23",
						"x-oauth-total-tokens": "35",
						"x-oauth-cached-input-tokens": "4",
						"x-oauth-reasoning-output-tokens": "5",
					})) {
						expect(response.headers.get(header), header).toBe(value)
					}
					expect(body).toMatchObject({
						id: "resp_measured_http",
						model,
						usage:
							endpoint === "chat/completions"
								? { prompt_tokens: 12, completion_tokens: 23, total_tokens: 35 }
								: usage,
					})
					if (endpoint === "chat/completions") {
						expect(body.choices[0].message.content).toBe("measured")
					} else {
						expect(body.output[0].content[0].text).toBe("measured")
					}
				}
				expect(await health(server)).toBe(instanceId)
				expect(upstreamFetch).toHaveBeenCalledTimes(1)
			})
		}
	}

	test.each(
		endpoints,
	)("propagates alternate upstream request-ID provenance through %s", async (endpoint) => {
		const upstreamFetch = vi.fn<typeof fetch>(
			async () =>
				new Response(measuredSse("gpt-5.6-sol"), {
					status: 200,
					headers: {
						"x-oai-request-id": "alternate-http-id",
						"content-type": "text/event-stream",
					},
				}),
		)
		const server = await start(upstreamFetch)
		const response = await fetch(`${server.url}/${endpoint}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${server.localToken}`,
			},
			body: JSON.stringify({
				model: "gpt-5.6-sol",
				stream: false,
				...(endpoint === "chat/completions"
					? { messages: [{ role: "user", content: "hi" }] }
					: { input: "hi" }),
			}),
		})
		expect(response.status).toBe(200)
		expect(response.headers.get("x-oauth-upstream-request-id")).toBe(
			"alternate-http-id",
		)
		expect(response.headers.get("x-oauth-upstream-request-id-header")).toBe(
			"x-oai-request-id",
		)
		expect(upstreamFetch).toHaveBeenCalledTimes(1)
	})

	test("leaves ordinary health unchanged and does not dispatch upstream", async () => {
		const upstreamFetch = vi.fn<typeof fetch>(async () => {
			throw new Error("Ordinary health must not dispatch upstream")
		})
		const server = await start(upstreamFetch, false)
		const response = await fetch(new URL("/health", server.url))
		expect(response.status).toBe(200)
		await expect(response.json()).resolves.toEqual({
			ok: true,
			replay_state: "stateless",
		})
		expect(response.headers.has("x-oauth-measurement-contract")).toBe(false)
		expect(response.headers.has("x-oauth-instance-id")).toBe(false)
		expect(upstreamFetch).not.toHaveBeenCalled()
	})
})
