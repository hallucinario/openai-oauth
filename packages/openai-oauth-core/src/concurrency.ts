type Waiter = {
	resolve: () => void
	reject: (err: unknown) => void
	cleanup?: () => void
}

export class ConcurrencyLimiter {
	private active = 0
	private readonly queue: Waiter[] = []
	private readonly max: number

	constructor(maxConcurrentRequests: number) {
		this.max = maxConcurrentRequests
	}

	async run<T>(
		fn: () => Promise<T>,
		signal?: AbortSignal | null,
	): Promise<T> {
		await this.acquire(signal)
		try {
			return await fn()
		} finally {
			this.release()
		}
	}

	private acquire(signal?: AbortSignal | null): Promise<void> {
		if (this.active < this.max) {
			this.active++
			return Promise.resolve()
		}

		return new Promise<void>((resolve, reject) => {
			const waiter: Waiter = { resolve, reject }

			if (signal?.aborted) {
				reject(signal.reason)
				return
			}

			const onAbort = () => {
				const index = this.queue.indexOf(waiter)
				if (index !== -1) {
					this.queue.splice(index, 1)
				}
				reject(signal!.reason)
			}

			signal?.addEventListener("abort", onAbort, { once: true })
			waiter.cleanup = () =>
				signal?.removeEventListener("abort", onAbort)

			this.queue.push(waiter)
		})
	}

	private release(): void {
		const next = this.queue.shift()
		if (next) {
			next.cleanup?.()
			next.resolve()
			return
		}

		this.active--
	}
}
