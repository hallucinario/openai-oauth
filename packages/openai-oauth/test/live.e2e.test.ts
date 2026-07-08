import { createOpenAI } from "@ai-sdk/openai"
import {
	generateText,
	streamText,
	Experimental_Agent as ToolLoopAgent,
	tool,
} from "ai"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import * as z from "zod"
import { startOpenAIOAuthServer } from "../src/index.js"

const liveTest = process.env.LIVE_CODEX_E2E === "1" ? test : test.skip

describe("openai oauth server live e2e", () => {
	let stop: (() => Promise<void>) | undefined
	let baseURL = ""
	let localToken = ""

	beforeAll(async () => {
		const running = await startOpenAIOAuthServer({
			host: "127.0.0.1",
			port: 0,
		})
		stop = running.close
		baseURL = running.url
		localToken = running.localToken ?? ""
	})

	afterAll(async () => {
		await stop?.()
	})

	liveTest(
		"supports responses and chat clients through the local server",
		async () => {
			const modelsResponse = await fetch(`${baseURL}/models`, {
				headers: { authorization: `Bearer ${localToken}` },
			})
			expect(modelsResponse.ok).toBe(true)
			const modelsPayload = await modelsResponse.json()
			expect(Array.isArray(modelsPayload.data)).toBe(true)
			expect(modelsPayload.data.length).toBeGreaterThan(0)
			expect(
				modelsPayload.data.every(
					(model: { id?: unknown }) =>
						typeof model.id === "string" && model.id.length > 0,
				),
			).toBe(true)

			const directResponse = await fetch(`${baseURL}/responses`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					authorization: `Bearer ${localToken}`,
				},
				body: JSON.stringify({
					model: "gpt-5.2",
					stream: false,
					input: [
						{
							role: "user",
							content: [
								{
									type: "input_text",
									text: "Reply with exactly: endpoint-json-ok",
								},
							],
						},
					],
				}),
			})

			expect(directResponse.ok).toBe(true)

			const openai = createOpenAI({
				baseURL,
				apiKey: localToken,
			})

			const smoke = await generateText({
				model: openai.responses("gpt-5.2"),
				prompt: "Reply with exactly: server-smoke-ok",
			})
			expect(smoke.text.trim()).toBe("server-smoke-ok")

			const weather = tool({
				description: "Get weather",
				inputSchema: z.object({
					city: z.string(),
				}),
			})

			const streamedToolEvents: string[] = []
			const toolStream = streamText({
				model: openai.chat("gpt-5.2"),
				messages: [
					{
						role: "user",
						content: "Use the weather tool for San Francisco.",
					},
				],
				tools: { weather },
			})

			for await (const part of toolStream.fullStream) {
				if (
					part.type === "tool-input-start" ||
					part.type === "tool-input-delta" ||
					part.type === "tool-call"
				) {
					streamedToolEvents.push(part.type)
				}
			}

			expect(streamedToolEvents).toContain("tool-input-start")
			expect(streamedToolEvents).toContain("tool-call")

			const agent = new ToolLoopAgent({
				model: openai.chat("gpt-5.2"),
				tools: {
					weather: tool({
						description: "Get weather",
						inputSchema: z.object({
							city: z.string(),
						}),
						execute: async ({ city }) => ({
							city,
							tempC: 21,
						}),
					}),
				},
			})

			const agentResult = await agent.generate({
				prompt:
					"Use the weather tool for San Francisco and answer with the temperature only.",
			})

			expect(agentResult.text).toContain("21")
		},
		120_000,
	)
})
