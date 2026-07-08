import { access } from "node:fs/promises"
import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import {
	createCodexOAuthClient,
	resolveAuthFileCandidates,
} from "../../openai-oauth-core/src/index.js"
import packageJson from "../package.json" with { type: "json" }
import { installCliWarningLogger, toStartupMessage } from "./cli-logging.js"
import { startOpenAIOAuthServer } from "./index.js"
import { resolveOpenAIOAuthModels } from "./models.js"
import { DEFAULT_MAX_BODY_BYTES, DEFAULT_PORT } from "./shared.js"
import { checkForOpenAIOAuthUpdates } from "./update-check.js"

export type CliArgs = {
	host?: string
	port?: number
	models?: string[]
	codexVersion?: string
	baseURL?: string
	clientId?: string
	tokenUrl?: string
	authFilePath?: string
	localToken?: string | false
	allowedOrigins?: string[] | false
	maxBodyBytes?: number
	allowUnsafeRemoteBind?: boolean
	allowUnsafeBaseURL?: boolean
	allowUnsafeTokenUrl?: boolean
	disableUpdateCheck?: boolean
}

const parseModels = (value: string | undefined): string[] | undefined => {
	if (typeof value !== "string") {
		return undefined
	}

	const models = value
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0)

	return models.length > 0 ? models : undefined
}

const parseAllowedOrigins = (value: unknown): string[] | undefined => {
	if (typeof value === "string") {
		const entries = value
			.split(",")
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0)
		return entries.length > 0 ? entries : undefined
	}

	if (Array.isArray(value)) {
		const entries = value
			.flatMap((entry) =>
				typeof entry === "string" ? entry.split(",") : [],
			)
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0)
		return entries.length > 0 ? entries : undefined
	}

	return undefined
}

const helpLines = [
	"Free OpenAI API access with your ChatGPT account.",
	"",
	"Usage",
	"  npx openai-oauth@latest [options]",
	"",
	"Options",
	"  --host <host>                  Host interface to bind to. Default: 127.0.0.1",
	"  --port <port>                  Port to listen on. Default: 10531",
	"  --models <ids>                 Comma-separated model ids to expose from /v1/models.",
	"  --codex-version <version>      Codex API version to use for model discovery.",
	"  --local-token <token>          Bearer token required for local /v1 requests. Default: generated per process.",
	"  --allow-origin <origin>        Browser Origin allowed by CORS. Repeatable. Default: none.",
	`  --max-body-bytes <bytes>       Maximum HTTP request body size. Default: ${DEFAULT_MAX_BODY_BYTES}`,
	"  --base-url <url>               Override the upstream Codex base URL. Requires --allow-unsafe-base-url unless it is chatgpt.com.",
	"  --oauth-client-id <id>         Override the OAuth client id used for refresh.",
	"  --oauth-token-url <url>        Override the OAuth token URL used for refresh. Requires --allow-unsafe-oauth-token-url unless it is auth.openai.com.",
	"  --oauth-file <path>            Path to the local auth.json file.",
	"",
	"Unsafe flags",
	"  --no-local-auth                Disable the local bearer-token check.",
	"  --allow-any-origin             Restore wildcard CORS.",
	"  --allow-unsafe-remote-bind     Allow binding to non-loopback hosts such as 0.0.0.0.",
	"  --allow-unsafe-base-url        Allow sending OAuth access tokens to a custom --base-url.",
	"  --allow-unsafe-oauth-token-url Allow sending refresh tokens to a custom --oauth-token-url.",
	"  --no-update-check              Disable the npm registry update check.",
	"",
	"Flags",
	"  --help                         Show help",
	`  --version                      Show version (${packageJson.version})`,
	"",
	"Notes",
	"  If no auth file is found, run: npx @openai/codex login",
	"  By default, available models are discovered from your account.",
]

const createCliParser = (argv: string[]) =>
	yargs(argv)
		.scriptName("openai-oauth")
		.strict()
		.help(false)
		.version(false)
		.option("host", {
			type: "string",
			describe: "Host interface to bind to.",
		})
		.option("port", {
			type: "number",
			describe: "Port to listen on. Default: 10531",
		})
		.option("models", {
			type: "string",
			describe: "Comma-separated model ids to expose from /v1/models.",
			coerce: parseModels,
		})
		.option("codex-version", {
			type: "string",
			describe: "Codex API version to use for model discovery.",
		})
		.option("base-url", {
			type: "string",
			describe: "Override the upstream Codex base URL.",
		})
		.option("oauth-client-id", {
			type: "string",
			describe: "Override the OAuth client id used for refresh.",
		})
		.option("oauth-token-url", {
			type: "string",
			describe: "Override the OAuth token URL used for refresh.",
		})
		.option("oauth-file", {
			type: "string",
			describe: "Path to the local auth.json file.",
		})
		.option("local-token", {
			type: "string",
			describe: "Bearer token required for local /v1 requests.",
		})
		.option("local-auth", {
			type: "boolean",
			describe: "Enable local bearer-token checks.",
		})
		.option("allow-origin", {
			type: "string",
			array: true,
			describe: "Browser Origin allowed by CORS. Repeatable.",
		})
		.option("allow-any-origin", {
			type: "boolean",
			describe: "Restore wildcard CORS. Unsafe.",
		})
		.option("max-body-bytes", {
			type: "number",
			describe: "Maximum HTTP request body size.",
		})
		.option("allow-unsafe-remote-bind", {
			type: "boolean",
			describe: "Allow binding to non-loopback hosts. Unsafe.",
		})
		.option("allow-unsafe-base-url", {
			type: "boolean",
			describe: "Allow non-chatgpt.com upstream base URL. Unsafe.",
		})
		.option("allow-unsafe-oauth-token-url", {
			type: "boolean",
			describe: "Allow custom OAuth token URL. Unsafe.",
		})
		.option("update-check", {
			type: "boolean",
			describe: "Enable npm registry update checks.",
		})

const isHelpFlag = (argv: string[]): boolean =>
	argv.includes("--help") || argv.includes("-h")

const isVersionFlag = (argv: string[]): boolean => argv.includes("--version")

export const toHelpMessage = (): string => helpLines.join("\n")

export const parseCliArgs = (argv: string[]): CliArgs => {
	const parsed = createCliParser(argv).parseSync()

	return {
		host: parsed.host,
		port: parsed.port,
		models: parsed.models,
		codexVersion: parsed.codexVersion,
		baseURL: parsed.baseUrl,
		clientId: parsed.oauthClientId,
		tokenUrl: parsed.oauthTokenUrl,
		authFilePath: parsed.oauthFile,
		localToken: parsed.localAuth === false ? false : parsed.localToken,
		allowedOrigins:
			parsed.allowAnyOrigin === true
				? false
				: parseAllowedOrigins(parsed.allowOrigin),
		maxBodyBytes: parsed.maxBodyBytes,
		allowUnsafeRemoteBind: parsed.allowUnsafeRemoteBind,
		allowUnsafeBaseURL: parsed.allowUnsafeBaseUrl,
		allowUnsafeTokenUrl: parsed.allowUnsafeOauthTokenUrl,
		disableUpdateCheck: parsed.updateCheck === false,
	}
}

export const toServerOptions = (args: CliArgs) => ({
	host: args.host,
	port: args.port ?? DEFAULT_PORT,
	models: args.models,
	codexVersion: args.codexVersion,
	baseURL: args.baseURL,
	clientId: args.clientId,
	tokenUrl: args.tokenUrl,
	authFilePath: args.authFilePath,
	localToken: args.localToken,
	allowedOrigins: args.allowedOrigins,
	maxBodyBytes: args.maxBodyBytes,
	allowUnsafeRemoteBind: args.allowUnsafeRemoteBind,
	allowUnsafeBaseURL: args.allowUnsafeBaseURL,
	allowUnsafeTokenUrl: args.allowUnsafeTokenUrl,
})

const findExistingAuthFile = async (
	authFilePath: string | undefined,
): Promise<string | undefined> => {
	for (const candidate of resolveAuthFileCandidates(authFilePath)) {
		try {
			await access(candidate)
			return candidate
		} catch {}
	}

	return undefined
}

const toMissingAuthFileMessage = (authFilePath: string | undefined): string => {
	if (authFilePath) {
		return [
			`No auth file was found at ${authFilePath}.`,
			"Run `npx @openai/codex login` and try again.",
		].join("\n")
	}

	const candidates = resolveAuthFileCandidates(undefined)
	return [
		`No auth file was found in the default search paths: ${candidates.join(", ")}.`,
		"Run `npx @openai/codex login` and try again.",
	].join("\n")
}

export const runCli = async (argv: string[] = hideBin(process.argv)) => {
	if (isHelpFlag(argv)) {
		console.log(toHelpMessage())
		return
	}

	if (isVersionFlag(argv)) {
		console.log(packageJson.version)
		return
	}

	installCliWarningLogger()

	const args = parseCliArgs(argv)
	const options = toServerOptions(args)
	const existingAuthFile = await findExistingAuthFile(options.authFilePath)
	if (!existingAuthFile) {
		throw new Error(toMissingAuthFileMessage(options.authFilePath))
	}

	const client = createCodexOAuthClient({
		...options,
		responsesState: false,
	})
	const availableModels = await resolveOpenAIOAuthModels(
		client,
		options.models,
		{
			codexVersion: options.codexVersion,
			onWarning: (message) => {
				console.error(message)
			},
		},
	)
	const server = await startOpenAIOAuthServer(options)

	console.log(
		toStartupMessage(
			`http://${server.host}:${server.port}/v1`,
			availableModels,
			{
				useColor: process.stdout.isTTY,
				localToken: server.localToken,
			},
		),
	)

	const updateCheckDisabled =
		args.disableUpdateCheck || process.env.OPENAI_OAUTH_NO_UPDATE_CHECK === "1"
	if (!updateCheckDisabled) {
		void checkForOpenAIOAuthUpdates(packageJson.version, {
			onWarning: (message) => {
				console.error(message)
			},
		})
	}

	const shutdown = async () => {
		await server.close()
		process.exit(0)
	}

	process.on("SIGINT", () => {
		void shutdown()
	})

	process.on("SIGTERM", () => {
		void shutdown()
	})
}

export { createCliParser, toMissingAuthFileMessage }
