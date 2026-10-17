import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { generateText } from "ai"
import { describe, expect, test, vi } from "vitest"
import { createOpenAIOAuth } from "../src/index.js"

const measurementSse = (model: string) => {
	const response = {
		id: "resp_provider_measurement",
		object: "response",
		created_at: 1_700_000_000,
		model,
	}
	const item = {
		type: "message",
		id: "msg_provider_measurement",
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
			response: {
				...response,
				status: "completed",
				output: [item],
				usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
			},
		},
	]
		.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
		.join("")
}

describe("measurement provider response headers", () => {
	test("exposes upstream ID and selected-header provenance on generateText", async () => {
		const root = await fs.mkdtemp(
			path.join(os.tmpdir(), "oauth-provider-measurement-"),
		)
		const authFilePath = path.join(root, "auth.json")
		await fs.writeFile(
			authFilePath,
			JSON.stringify({
				tokens: {
					access_token: "synthetic-measurement-access",
					account_id: "synthetic-measurement-account",
				},
			}),
		)
		try {
			const provider = createOpenAIOAuth({
				authFilePath,
				ensureFresh: false,
				measurementMode: true,
				fetch: vi.fn<typeof fetch>(
					async () =>
						new Response(measurementSse("gpt-5.6-sol"), {
							status: 200,
							headers: { "x-oai-request-id": "provider-alternate-id" },
						}),
				),
			})
			const result = await generateText({
				model: provider("gpt-5.6-sol"),
				prompt: "synthetic",
				maxRetries: 0,
			})

			expect(result.response.headers).toMatchObject({
				"x-oauth-upstream-request-id": "provider-alternate-id",
				"x-oauth-upstream-request-id-header": "x-oai-request-id",
			})
		} finally {
			await fs.rm(root, { recursive: true, force: true })
		}
	})
})
