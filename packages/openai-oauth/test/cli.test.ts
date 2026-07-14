import { describe, expect, test, vi } from "vitest"
import {
	parseCliArgs,
	toMissingAuthFileMessage,
	toServerOptions,
} from "../src/cli-app.js"
import { toStartupMessage } from "../src/cli-logging.js"

describe("openai oauth cli", () => {
	test("parses kebab-case flags into server options", () => {
		const parsed = parseCliArgs([
			"--host",
			"0.0.0.0",
			"--port",
			"9999",
			"--models",
			"gpt-5.4,gpt-5.3-codex",
			"--codex-version",
			"0.114.0",
			"--base-url",
			"https://example.com/codex",
			"--oauth-client-id",
			"client-123",
			"--oauth-token-url",
			"https://auth.example.com/oauth/token",
			"--oauth-file",
			"/tmp/auth.json",
			"--local-token",
			"test-local-token-123",
			"--allow-origin",
			"http://127.0.0.1:3000",
			"--max-body-bytes",
			"1234",
			"--allow-unsafe-remote-bind",
			"--allow-unsafe-base-url",
			"--allow-unsafe-oauth-token-url",
			"--no-update-check",
		])

		expect(toServerOptions(parsed)).toMatchObject({
			host: "0.0.0.0",
			port: 9999,
			models: ["gpt-5.4", "gpt-5.3-codex"],
			codexVersion: "0.114.0",
			baseURL: "https://example.com/codex",
			clientId: "client-123",
			tokenUrl: "https://auth.example.com/oauth/token",
			authFilePath: "/tmp/auth.json",
			localToken: "test-local-token-123",
			allowedOrigins: ["http://127.0.0.1:3000"],
			maxBodyBytes: 1234,
			allowUnsafeRemoteBind: true,
			allowUnsafeBaseURL: true,
			allowUnsafeTokenUrl: true,
		})
		expect(parsed.disableUpdateCheck).toBe(true)
	})

	test("drops empty model entries", () => {
		const parsed = parseCliArgs(["--models", "gpt-5.4, ,gpt-5.2,,"])
		expect(parsed.models).toEqual(["gpt-5.4", "gpt-5.2"])
	})

	test("formats the startup message with a local token", () => {
		expect(
			toStartupMessage(
				"http://127.0.0.1:10531/v1",
				["gpt-5.4", "gpt-5.3-codex"],
				{ localToken: "test-local-token-123" },
			),
		).toBe(
			[
				"OpenAI-compatible endpoint ready at http://127.0.0.1:10531/v1",
				"Use this as your OpenAI base URL.",
				"Use this as your OpenAI API key: test-local-token-123",
				"",
				"Available Models: gpt-5.4, gpt-5.3-codex",
			].join("\n"),
		)
	})

	test("formats a missing explicit auth file message", () => {
		expect(toMissingAuthFileMessage("/tmp/missing-auth.json")).toContain(
			"Run `npx @openai/codex login` and try again.",
		)
		expect(toMissingAuthFileMessage("/tmp/missing-auth.json")).toContain(
			"/tmp/missing-auth.json",
		)
	})

	test("parses retry and concurrency flags", () => {
		const parsed = parseCliArgs([
			"--max-concurrent-requests",
			"10",
			"--max-retries",
			"5",
			"--retry-base-delay",
			"2000",
			"--retry-max-delay",
			"60000",
		])

		const opts = toServerOptions(parsed)
		expect(opts.maxConcurrentRequests).toBe(10)
		expect(opts.maxRetries).toBe(5)
		expect(opts.retryBaseDelayMs).toBe(2000)
		expect(opts.retryMaxDelayMs).toBe(60000)
	})

	test("retry and concurrency flags default to undefined", () => {
		const opts = toServerOptions(parseCliArgs([]))
		expect(opts.maxConcurrentRequests).toBeUndefined()
		expect(opts.maxRetries).toBeUndefined()
		expect(opts.retryBaseDelayMs).toBeUndefined()
		expect(opts.retryMaxDelayMs).toBeUndefined()
	})

	test("does not use hidden environment variable overrides", () => {
		vi.stubEnv("HOST", "0.0.0.0")
		vi.stubEnv("PORT", "3333")

		expect(toServerOptions({})).toMatchObject({
			host: undefined,
			port: 10531,
			codexVersion: undefined,
		})

		vi.unstubAllEnvs()
	})
})
