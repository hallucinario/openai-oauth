import { afterEach, describe, expect, test } from "vitest"
import { startOpenAIOAuthServer } from "../src/index.js"

describe("node server runtime", () => {
	let close: (() => Promise<void>) | undefined

	afterEach(async () => {
		await close?.()
		close = undefined
	})

	test("starts an http server and serves health", async () => {
		const running = await startOpenAIOAuthServer({
			host: "127.0.0.1",
			port: 0,
		})
		close = running.close
		expect(running.localToken).toEqual(expect.any(String))
		expect(running.localToken?.length).toBeGreaterThanOrEqual(16)

		const response = await fetch(
			`http://${running.host}:${running.port}/health`,
		)
		expect(response.ok).toBe(true)
		await expect(response.json()).resolves.toEqual({
			ok: true,
			replay_state: "stateless",
		})
	})

	test("rejects non-loopback hosts unless explicitly allowed", async () => {
		await expect(
			startOpenAIOAuthServer({
				host: "0.0.0.0",
				port: 0,
			}),
		).rejects.toThrow("Refusing to listen on non-loopback host")
	})
})
