export type RetrySettings = {
	maxRetries?: number
	baseDelayMs?: number
	maxDelayMs?: number
	now?: () => number
	sleep?: (ms: number, signal?: AbortSignal | null) => Promise<void>
}

const DEFAULT_MAX_RETRIES = 3
const DEFAULT_BASE_DELAY_MS = 1000
const DEFAULT_MAX_DELAY_MS = 30000

const defaultSleep = (ms: number, signal?: AbortSignal | null): Promise<void> =>
	new Promise<void>((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason)
			return
		}

		const timer = setTimeout(resolve, ms)
		const onAbort = () => {
			clearTimeout(timer)
			reject(signal!.reason)
		}

		signal?.addEventListener("abort", onAbort, { once: true })
	})

const parseRetryAfterSeconds = (value: string): number | undefined => {
	const seconds = Number(value)
	return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined
}

const parseRetryAfterDate = (
	value: string,
	now: number,
): number | undefined => {
	const date = new Date(value)
	const ms = date.getTime()
	if (!Number.isFinite(ms)) {
		return undefined
	}

	const delta = (ms - now) / 1000
	return delta > 0 ? delta : undefined
}

const computeDelay = (
	retryAfter: string | null,
	attempt: number,
	baseDelayMs: number,
	maxDelayMs: number,
	now: number,
): number => {
	if (typeof retryAfter === "string" && retryAfter.length > 0) {
		const asSeconds = parseRetryAfterSeconds(retryAfter)
		if (asSeconds !== undefined) {
			return Math.min(asSeconds * 1000, maxDelayMs)
		}

		const asDate = parseRetryAfterDate(retryAfter, now)
		if (asDate !== undefined) {
			return Math.min(asDate * 1000, maxDelayMs)
		}
	}

	return Math.random() * Math.min(maxDelayMs, baseDelayMs * 2 ** attempt)
}

export const withRetry = async (
	fn: () => Promise<Response>,
	settings: RetrySettings = {},
	signal?: AbortSignal | null,
): Promise<Response> => {
	const maxRetries = settings.maxRetries ?? DEFAULT_MAX_RETRIES
	const baseDelayMs = settings.baseDelayMs ?? DEFAULT_BASE_DELAY_MS
	const maxDelayMs = settings.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
	const now = settings.now ?? (() => Date.now())
	const sleep = settings.sleep ?? defaultSleep

	let attempt = 0

	while (true) {
		const response = await fn()

		if (response.status !== 429 || attempt >= maxRetries) {
			return response
		}

		if (signal?.aborted) {
			throw signal.reason
		}

		const delay = computeDelay(
			response.headers.get("retry-after"),
			attempt,
			baseDelayMs,
			maxDelayMs,
			now(),
		)

		await sleep(delay, signal)
		attempt++
	}
}
