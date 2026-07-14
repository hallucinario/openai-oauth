import { describe, expect, it } from "vitest"
import { ConcurrencyLimiter } from "../src/concurrency.js"

const defer = () => {
	let resolve!: () => void
	const promise = new Promise<void>((r) => {
		resolve = r
	})
	return { promise, resolve }
}

describe("ConcurrencyLimiter", () => {
	it("throws on non-positive maxConcurrentRequests", () => {
		expect(() => new ConcurrencyLimiter(0)).toThrow(RangeError)
		expect(() => new ConcurrencyLimiter(-1)).toThrow(RangeError)
		expect(() => new ConcurrencyLimiter(1.5)).toThrow(RangeError)
	})

	it("allows up to maxConcurrentRequests and queues the rest", async () => {
		const limiter = new ConcurrencyLimiter(2)
		const running: number[] = []
		const order: number[] = []

		const task = (id: number) =>
			limiter.run(async () => {
				running.push(id)
				order.push(id)
				await new Promise((r) => setTimeout(r, 50))
				running.pop()
				return id
			})

		const results = await Promise.all([task(1), task(2), task(3)])
		expect(results).toEqual([1, 2, 3])
		expect(order[0]).toBe(1)
		expect(order[1]).toBe(2)
		expect(order[2]).toBe(3)
	})

	it("releases slot after completion and runs queued tasks FIFO", async () => {
		const limiter = new ConcurrencyLimiter(1)
		const completionOrder: number[] = []

		const task = (id: number) =>
			limiter.run(async () => {
				await new Promise((r) => setTimeout(r, 10))
				completionOrder.push(id)
				return id
			})

		await Promise.all([task(1), task(2), task(3)])
		expect(completionOrder).toEqual([1, 2, 3])
	})

	it("removes aborted queued requests without consuming a slot", async () => {
		const limiter = new ConcurrencyLimiter(1)
		const blocker = defer()

		const blockingTask = limiter.run(() => blocker.promise)

		const controller = new AbortController()
		const abortedTask = limiter.run(async () => "should not run", controller.signal)

		const normalTask = limiter.run(async () => "normal")

		await new Promise((r) => setTimeout(r, 10))
		controller.abort(new Error("cancelled"))

		await expect(abortedTask).rejects.toThrow("cancelled")

		blocker.resolve()
		await blockingTask

		const result = await normalTask
		expect(result).toBe("normal")
	})

	it("releases slot even when fn throws", async () => {
		const limiter = new ConcurrencyLimiter(1)

		await expect(
			limiter.run(() => Promise.reject(new Error("boom"))),
		).rejects.toThrow("boom")

		const result = await limiter.run(async () => "recovered")
		expect(result).toBe("recovered")
	})

	it("serializes all requests when maxConcurrentRequests is 1", async () => {
		const limiter = new ConcurrencyLimiter(1)
		let maxConcurrent = 0
		let current = 0

		const task = () =>
			limiter.run(async () => {
				current++
				maxConcurrent = Math.max(maxConcurrent, current)
				await new Promise((r) => setTimeout(r, 10))
				current--
			})

		await Promise.all([task(), task(), task()])
		expect(maxConcurrent).toBe(1)
	})
})
