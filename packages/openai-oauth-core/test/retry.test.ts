import { describe, expect, it, vi } from "vitest"
import { withRetry } from "../src/retry.js"

const ok = () => Promise.resolve(new Response("ok", { status: 200 }))

const tooManyRequests = (headers?: HeadersInit) =>
	Promise.resolve(new Response("rate limited", { status: 429, headers }))

const noopSleep = () => Promise.resolve()

describe("withRetry", () => {
	it("passes through non-429 responses immediately", async () => {
		const fn = vi.fn(ok)
		const response = await withRetry(fn, { sleep: noopSleep })
		expect(fn).toHaveBeenCalledTimes(1)
		expect(response.status).toBe(200)
	})

	it("retries on 429 up to maxRetries and succeeds", async () => {
		let calls = 0
		const fn = vi.fn(() => {
			calls++
			return calls < 3 ? tooManyRequests() : ok()
		})
		const response = await withRetry(fn, { maxRetries: 3, sleep: noopSleep })
		expect(fn).toHaveBeenCalledTimes(3)
		expect(response.status).toBe(200)
	})

	it("returns 429 after maxRetries exhausted", async () => {
		const fn = vi.fn(() => tooManyRequests())
		const response = await withRetry(fn, { maxRetries: 2, sleep: noopSleep })
		expect(fn).toHaveBeenCalledTimes(3)
		expect(response.status).toBe(429)
	})

	it("respects Retry-After as seconds", async () => {
		let calls = 0
		const fn = vi.fn(() => {
			calls++
			return calls === 1
				? tooManyRequests({ "Retry-After": "5" })
				: ok()
		})
		const sleepSpy = vi.fn(() => Promise.resolve())
		await withRetry(fn, { maxRetries: 3, sleep: sleepSpy })
		expect(sleepSpy).toHaveBeenCalledTimes(1)
		expect(sleepSpy.mock.calls[0]![0]).toBe(5000)
	})

	it("respects Retry-After as HTTP-date", async () => {
		const fixedNow = new Date("2026-07-10T12:00:00Z").getTime()
		const futureDate = new Date("2026-07-10T12:00:10Z").toUTCString()
		let calls = 0
		const fn = vi.fn(() => {
			calls++
			return calls === 1
				? tooManyRequests({ "Retry-After": futureDate })
				: ok()
		})
		const sleepSpy = vi.fn(() => Promise.resolve())
		await withRetry(fn, {
			maxRetries: 3,
			sleep: sleepSpy,
			now: () => fixedNow,
		})
		expect(sleepSpy).toHaveBeenCalledTimes(1)
		expect(sleepSpy.mock.calls[0]![0]).toBe(10000)
	})

	it("falls back to exponential jitter when no Retry-After", async () => {
		vi.spyOn(Math, "random").mockReturnValue(0.5)
		let calls = 0
		const fn = vi.fn(() => {
			calls++
			return calls <= 2 ? tooManyRequests() : ok()
		})
		const sleepSpy = vi.fn(() => Promise.resolve())
		await withRetry(fn, {
			maxRetries: 3,
			baseDelayMs: 1000,
			maxDelayMs: 30000,
			sleep: sleepSpy,
		})
		expect(sleepSpy).toHaveBeenCalledTimes(2)
		expect(sleepSpy.mock.calls[0]![0]).toBe(500)
		expect(sleepSpy.mock.calls[1]![0]).toBe(1000)
		vi.restoreAllMocks()
	})

	it("aborts before sleep when signal is already aborted", async () => {
		const controller = new AbortController()
		controller.abort(new Error("cancelled"))
		let calls = 0
		const fn = vi.fn(() => {
			calls++
			return tooManyRequests()
		})
		await expect(
			withRetry(fn, { maxRetries: 3, sleep: noopSleep }, controller.signal),
		).rejects.toThrow("cancelled")
		expect(fn).toHaveBeenCalledTimes(1)
	})

	it("aborts during sleep", async () => {
		const controller = new AbortController()
		let calls = 0
		const fn = vi.fn(() => {
			calls++
			return tooManyRequests()
		})
		const blockingSleep = (_ms: number, signal?: AbortSignal | null) =>
			new Promise<void>((_resolve, reject) => {
				if (signal?.aborted) {
					reject(signal.reason)
					return
				}
				signal?.addEventListener("abort", () => reject(signal.reason))
			})

		const retryPromise = withRetry(
			fn,
			{ maxRetries: 3, sleep: blockingSleep },
			controller.signal,
		)
		await new Promise((r) => setTimeout(r, 10))
		controller.abort(new Error("cancelled mid-sleep"))
		await expect(retryPromise).rejects.toThrow("cancelled mid-sleep")
	})

	it("does not retry when fn() throws", async () => {
		const fn = vi.fn().mockRejectedValue(new Error("network error"))
		await expect(
			withRetry(fn, { maxRetries: 3, sleep: noopSleep }),
		).rejects.toThrow("network error")
		expect(fn).toHaveBeenCalledTimes(1)
	})

	it("falls back to jitter when Retry-After date is in the past", async () => {
		vi.spyOn(Math, "random").mockReturnValue(0.5)
		const fixedNow = new Date("2026-07-10T12:00:00Z").getTime()
		const pastDate = new Date("2026-07-10T11:00:00Z").toUTCString()
		let calls = 0
		const fn = vi.fn(() => {
			calls++
			return calls === 1
				? tooManyRequests({ "Retry-After": pastDate })
				: ok()
		})
		const sleepSpy = vi.fn(() => Promise.resolve())
		await withRetry(fn, {
			maxRetries: 3,
			baseDelayMs: 1000,
			maxDelayMs: 30000,
			sleep: sleepSpy,
			now: () => fixedNow,
		})
		expect(sleepSpy).toHaveBeenCalledTimes(1)
		expect(sleepSpy.mock.calls[0]![0]).toBe(500)
		vi.restoreAllMocks()
	})

	it("returns 429 immediately when maxRetries is 0", async () => {
		const fn = vi.fn(() => tooManyRequests())
		const response = await withRetry(fn, { maxRetries: 0, sleep: noopSleep })
		expect(fn).toHaveBeenCalledTimes(1)
		expect(response.status).toBe(429)
	})
})
