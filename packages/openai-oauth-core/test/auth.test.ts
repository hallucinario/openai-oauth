import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, test, vi } from "vitest"
import { deriveAccountId, loadAuthTokens, parseJwtClaims } from "../src/auth.js"

const encodeBase64Url = (value: Record<string, unknown>): string =>
	Buffer.from(JSON.stringify(value)).toString("base64url")

const createJwt = (payload: Record<string, unknown>): string => {
	const header = encodeBase64Url({ alg: "none", typ: "JWT" })
	const body = encodeBase64Url(payload)
	return `${header}.${body}.signature`
}

const writeAuthFile = async (filePath: string, data: unknown) => {
	await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8")
}

describe("auth helpers", () => {
	test("parseJwtClaims returns undefined for invalid tokens", () => {
		expect(parseJwtClaims(undefined)).toBeUndefined()
		expect(parseJwtClaims("not-a-jwt")).toBeUndefined()
	})

	test("parseJwtClaims returns payload for valid tokens", () => {
		expect(parseJwtClaims(createJwt({ sub: "user-1" }))).toEqual({
			sub: "user-1",
		})
	})

	test("deriveAccountId reads account id claim", () => {
		expect(
			deriveAccountId(
				createJwt({
					"https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
				}),
			),
		).toBe("acct-1")
	})
})

describe("loadAuthTokens", () => {
	test("throws when access token is missing", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "auth-missing-"))
		const authPath = path.join(root, "auth.json")
		const fetch =
			globalThis.fetch ??
			(async () => {
				throw new Error("unused")
			})

		try {
			await writeAuthFile(authPath, {
				tokens: {
					refresh_token: "refresh",
					account_id: "acct-1",
				},
			})

			await expect(
				loadAuthTokens({
					authFilePath: authPath,
					fetch,
					ensureFresh: false,
				}),
			).rejects.toThrow("ChatGPT access token not found")
		} finally {
			await fs.rm(root, { recursive: true, force: true })
		}
	})

	test("returns stored tokens when refresh is not required", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "auth-basic-"))
		const authPath = path.join(root, "auth.json")
		const fetch =
			globalThis.fetch ??
			(async () => {
				throw new Error("unused")
			})

		try {
			await writeAuthFile(authPath, {
				tokens: {
					access_token: "access",
					refresh_token: "refresh",
					account_id: "acct-1",
				},
			})

			const result = await loadAuthTokens({
				authFilePath: authPath,
				fetch,
				ensureFresh: false,
			})

			expect(result.accessToken).toBe("access")
			expect(result.accountId).toBe("acct-1")
			expect(result.sourcePath).toBe(authPath)
		} finally {
			await fs.rm(root, { recursive: true, force: true })
		}
	})

	test("refreshes tokens when access token is expired", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "auth-refresh-"))
		const authPath = path.join(root, "auth.json")
		const now = new Date("2025-01-01T00:00:00Z")
		const expiredToken = createJwt({
			exp: Math.floor(now.getTime() / 1000) - 10,
		})
		const refreshedIdToken = createJwt({
			"https://api.openai.com/auth": { chatgpt_account_id: "acct-2" },
		})

		const fetch = async () =>
			new Response(
				JSON.stringify({
					access_token: "new-access",
					id_token: refreshedIdToken,
					refresh_token: "new-refresh",
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			)

		try {
			await writeAuthFile(authPath, {
				tokens: {
					access_token: expiredToken,
					refresh_token: "refresh",
				},
				last_refresh: "2020-01-01T00:00:00Z",
			})

			const result = await loadAuthTokens({
				authFilePath: authPath,
				fetch,
				now: () => now,
			})

			expect(result.accessToken).toBe("new-access")
			expect(result.accountId).toBe("acct-2")
			expect(result.refreshToken).toBe("new-refresh")

			const updated = JSON.parse(await fs.readFile(authPath, "utf-8"))
			expect(updated.last_refresh).toBe(now.toISOString())
			expect(updated.tokens.access_token).toBe("new-access")
		} finally {
			await fs.rm(root, { recursive: true, force: true })
		}
	})

	test("rejects custom token urls unless explicitly allowed", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "auth-token-url-deny-"))
		const authPath = path.join(root, "auth.json")
		const fetch = vi.fn()

		try {
			await writeAuthFile(authPath, {
				tokens: {
					access_token: "access",
					account_id: "acct-1",
				},
			})

			await expect(
				loadAuthTokens({
					authFilePath: authPath,
					fetch,
					ensureFresh: false,
					tokenUrl: "https://auth.example.com/custom/token",
				}),
			).rejects.toThrow("untrusted token URL")
			expect(fetch).not.toHaveBeenCalled()
		} finally {
			await fs.rm(root, { recursive: true, force: true })
		}
	})

	test("uses an explicit token url override when refreshing", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "auth-token-url-"))
		const authPath = path.join(root, "auth.json")
		const now = new Date("2025-01-01T00:00:00Z")
		const expiredToken = createJwt({
			exp: Math.floor(now.getTime() / 1000) - 10,
		})
		const fetch = vi.fn(async () => {
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
		})

		try {
			await writeAuthFile(authPath, {
				tokens: {
					access_token: expiredToken,
					refresh_token: "refresh",
					account_id: "acct-1",
				},
				last_refresh: "2020-01-01T00:00:00Z",
			})

			await loadAuthTokens({
				authFilePath: authPath,
				fetch,
				now: () => now,
				tokenUrl: "https://auth.example.com/custom/token",
				allowUnsafeTokenUrl: true,
			})

			expect(fetch).toHaveBeenCalledWith(
				"https://auth.example.com/custom/token",
				expect.objectContaining({
					method: "POST",
				}),
			)
		} finally {
			await fs.rm(root, { recursive: true, force: true })
		}
	})
})
