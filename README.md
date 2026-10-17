# openai-oauth

[NPM](https://www.npmjs.com/package/openai-oauth) | [Legal](#legal)

Free OpenAI API access with your ChatGPT account.

Just run `npx openai-oauth`.

## How to Use

You can currently use `openai-oauth` in two different ways:

### `openai-oauth` CLI

This package lets you create a localhost proxy to `chatgpt.com/backend-api/codex/responses` pre-authenticated with your Oauth tokens.

Use directly:

```bash
npx openai-oauth

OpenAI-compatible endpoint ready at http://127.0.0.1:10531/v1
Use this as your OpenAI base URL.
Use this as your OpenAI API key: <local-token>
Available Models: gpt-5.4, gpt-5.3-codex, ...
```

### `openai-oauth-provider`

This is a Vercel AI SDK Provider.

```ts
import { generateText } from "ai";
import { createOpenAIOAuth } from "openai-oauth-provider";

const openai = createOpenAIOAuth();

const result = await generateText({
	model: openai("gpt-5.4"),
	prompt: "write an essay about dogs",
});

console.log(result.text);
```

## Configuration

The CLI and the provider share the same core OAuth transport settings.

| Config              | CLI                 | Provider       | Default                                                                                                                                                 | Description                                                                                                                        |
| ------------------- | ------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Host binding        | `--host`            | N/A            | `127.0.0.1`                                                                                                                                             | Host interface the local proxy binds to.                                                                                           |
| Port                | `--port`            | N/A            | `10531`                                                                                                                                                 | Port the local proxy binds to.                                                                                                     |
| Model allowlist     | `--models`          | N/A            | Account-specific Codex models discovered from ChatGPT                                                                                                   | Comma-separated list of model ids exposed by `/v1/models`. When omitted, the CLI discovers the models your account has access to. |
| Codex API version   | `--codex-version`   | `codexVersion` | Local `codex --version`, then `@openai/codex` latest from npm, then `0.111.0`                                                                          | Override the Codex API client version used for model discovery.                                                                    |
| Upstream base URL   | `--base-url`        | `baseURL`      | `https://chatgpt.com/backend-api/codex`                                                                                                                 | Override the upstream Codex base URL. Custom hosts require the explicit unsafe override.                                            |
| OAuth client id     | `--oauth-client-id` | `clientId`     | `app_EMoamEEZ73f0CkXaXp7hrann`                                                                                                                          | Override the OAuth client id used for refresh.                                                                                     |
| OAuth token URL     | `--oauth-token-url` | `tokenUrl`     | `https://auth.openai.com/oauth/token`                                                                                                                   | Override the OAuth token URL used for refresh. Custom hosts require the explicit unsafe override.                                   |
| Auth file path      | `--oauth-file`      | `authFilePath` | `--oauth-file` path if provided, otherwise `$CHATGPT_LOCAL_HOME/auth.json`, `$CODEX_HOME/auth.json`, `~/.chatgpt-local/auth.json`, `~/.codex/auth.json` | Override where the local OAuth auth file is discovered.                                                                            |
| Ensure fresh tokens | N/A                 | `ensureFresh`  | `true`                                                                                                                                                  | Control whether access tokens are refreshed automatically.                                                                         |
| Provider name       | N/A                 | `name`         | `openai`                                                                                                                                                | Override the provider name exposed to Vercel AI SDK internals.                                                                     |
| Local API token     | `--local-token` / `OPENAI_OAUTH_LOCAL_TOKEN` | N/A | Random per process | Bearer token required for local `/v1/*` requests. Use `--no-local-auth` only in trusted tests. |
| CORS allowlist      | `--allow-origin`    | N/A            | No browser origins allowed                                                                                                                              | Repeatable exact browser Origin allowlist. `--allow-any-origin` restores wildcard CORS and is unsafe.                              |
| Request body limit  | `--max-body-bytes`  | N/A            | `10485760`                                                                                                                                              | Maximum HTTP request body accepted by the Node server.                                                                             |
| Unsafe URL overrides | `--allow-unsafe-base-url`, `--allow-unsafe-oauth-token-url` | `allowUnsafeBaseURL`, `allowUnsafeTokenUrl` | `false` | Required before access or refresh tokens are sent to non-default hosts. |
| Subscription measurement | `--measurement-mode` | `measurementMode` | `false` | Enables a fixed-model, single-attempt lane with response evidence validation. |
| Remote bind         | `--allow-unsafe-remote-bind` | N/A | `false` | Required before binding to non-loopback interfaces such as `0.0.0.0`. |
| Update check        | `--no-update-check` / `OPENAI_OAUTH_NO_UPDATE_CHECK=1` | N/A | Enabled | Disables the npm registry latest-version check. |

## Security Defaults

The CLI now requires a local bearer token for `/v1/*` requests by default. The token is generated per process unless `--local-token` or `OPENAI_OAUTH_LOCAL_TOKEN` is set. Browser CORS access is denied unless an exact Origin is allowlisted with `--allow-origin`. Non-loopback binding, wildcard CORS, custom Codex upstream hosts, and custom OAuth token hosts require explicit unsafe flags.

## Features

What currently works:

- Working Endpoints:
  - `/v1/responses`
  - `/v1/chat/completions`
  - `/v1/models` (account-aware by default, or overridden with `--models`)
- Streaming Responses
- Toolcalls
- Reasoning Traces

## Subscription Measurement Mode

Run a separate measurement lane from a built checkout:

```bash
pnpm --filter openai-oauth exec node dist/cli.js --host 127.0.0.1 --port 10532 --measurement-mode --models gpt-5.6-sol,gpt-5.6-luna --no-update-check
curl -i http://127.0.0.1:10532/health
```

General mode and the default port `10531` remain unchanged.

`--measurement-mode` enables a strict local measurement lane. It accepts only
`gpt-5.6-sol` and `gpt-5.6-luna` at the default
`https://chatgpt.com/backend-api/codex` upstream. The mode rejects a configured
retry count above zero, disables the transport's 429 retries and the AI SDK's
retries for non-streaming `/v1/chat/completions`, and sends
`max_output_tokens: 4096` to Codex. The 4096 value is a **request**, not proof
that the upstream enforced a cap. A supplied `max_tokens` or
`max_output_tokens` must equal 4096; an omitted value is set to 4096.

The measured Chat Completions endpoint requires `stream: false`. Direct
`/v1/responses` requests may ask for a stream, but the proxy buffers the
upstream SSE response first to validate the completed event. The measurement
lane requires the upstream `x-request-id`, completed response ID and model, and
input, output and total token usage. It returns HTTP 502 when evidence is
missing, the observed model differs from the request, or observed output exceeds
4096 tokens. An upstream 429 is returned after one request. Missing usage is
never reported as zero in this lane.

`GET /health` attests the configured mode with
`x-oauth-measurement-contract: subscription-single-attempt-v1` and a
`measurement` object containing the contract, models, upstream URL, output
request, retry count and Chat Completions stream setting. Successful measured
responses carry that contract header plus `x-oauth-upstream-base-url`,
`x-oauth-upstream-request-count`, `x-oauth-upstream-request-id`,
`x-oauth-response-id`, `x-oauth-response-model`, `x-oauth-input-tokens`,
`x-oauth-output-tokens`, and `x-oauth-total-tokens`. Cached input and reasoning
output tokens appear as `x-oauth-cached-input-tokens` and
`x-oauth-reasoning-output-tokens` when provided upstream. The non-streaming Chat
Completions JSON uses the observed response ID, model and usage. The request
count attests OAuth-to-Codex calls only; a calling LiteLLM proxy must separately
disable and verify its own retries and fallback routes.
Callers using `createOpenAIOAuth({ measurementMode: true })` directly must also
set `maxRetries: 0` on their own AI SDK calls; the server sets this automatically
for its non-streaming Chat Completions route.

Every measurement-mode handler instance generates one server-owned UUID.
Measured `GET /health` returns it as top-level `instance_id` and as the
`x-oauth-instance-id` response header. All measurement handler responses,
including successful receipts and upstream 429 responses on both endpoints,
carry that same header, overriding client or upstream values. The UUID stays
stable across requests and changes for a new server or restart. Reacquire
health after restarting and require health `instance_id`, the health header,
and each receipt header to match before accepting measurements. Model IDs are
the actual `gpt-5.6-sol` and `gpt-5.6-luna`; LiteLLM handles any alias translation.

The fake-upstream HTTP smoke exercises the real local HTTP server, transport,
and SDK using synthetic auth and injected upstream responses, with no provider
requests or real credentials:

```bash
LIVE_CODEX_E2E=0 pnpm --filter openai-oauth exec vitest run test/measurement-http.test.ts
```

Run the CI checks locally with:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
LIVE_CODEX_E2E=0 pnpm test
pnpm format-and-lint
LIVE_CODEX_E2E=0 pnpm --filter openai-oauth exec vitest run test/measurement-http.test.ts
```

CI runs on pull requests and pushes to `main`, verifies and prints the exact
checked-out PR head or push SHA, and keeps live provider tests disabled.

## Known Limitations

What is intentionally not there yet:

- Only LLMs supported by Codex are available. This lists updates over time and is dependent on your Codex plan.
- Login flow is intentionally not bundled. Simply run `npx @openai/codex login` to create the auth file.
- There is no stateful replay support on the CLI `/v1/responses` endpoint. The proxy is stateless and expects callers to send the full conversation history.

## How it Works

OpenAI's Codex CLI uses a special endpoint at `chatgpt.com/backend-api/codex/responses` to let you use special OpenAI rate limits tied to your ChatGPT account.

By using the same Oauth tokens as Codex, we can effectively use OpenAI's API through Oauth instead of buying API credits.

## Monorepo

- `packages/openai-oauth-core`
  Private shared transport, auth refresh, SSE helpers, and replay state.
- `packages/openai-oauth-provider`
  Public Vercel AI SDK provider that talks directly to Codex using local auth files.
- `packages/openai-oauth`
  Public CLI and localhost proxy package intended for `npx openai-oauth`.

## Legal

This is an unofficial, community-maintained project and is not affiliated with, endorsed by, or sponsored by OpenAI, Inc.

It uses your local Codex/ChatGPT authentication cache (auth.json, e.g. ~/.codex/auth.json) and should be treated like password-equivalent credentials.

Use only for personal, local experimentation on trusted machines; do not run as a hosted service, do not share access, and do not pool or redistribute tokens.

You are solely responsible for complying with OpenAI’s Terms, policies, and any applicable agreements; misuse may result in rate limits, suspension, or termination.

Provided “as is” with no warranties; you assume all risk for data exposure, costs, and account actions.
