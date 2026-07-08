# openai-oauth

[GitHub](https://github.com/EvanZhouDev/openai-oauth) | [Legal](#legal)

OpenAI-compatible local endpoint backed by your ChatGPT account.

## Usage

```bash
npx openai-oauth
```

When startup succeeds, the CLI prints:

```text
OpenAI-compatible endpoint ready at http://127.0.0.1:10531/v1
Use this as your OpenAI base URL.
Use this as your OpenAI API key: <local-token>
Available Models: gpt-5.4, gpt-5.3-codex, ...
```

If no auth file is available, it fails early and tells you to run:

```bash
npx @openai/codex login
```

## Configuration

| Config            | CLI                 | Default                                                                                                                                                 | Description                                                                                                                        |
| ----------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Host binding      | `--host`            | `127.0.0.1`                                                                                                                                             | Host interface the local proxy binds to.                                                                                           |
| Port              | `--port`            | `10531`                                                                                                                                                 | Port the local proxy binds to.                                                                                                     |
| Model allowlist   | `--models`          | Account-specific Codex models discovered from ChatGPT                                                                                                   | Comma-separated list of model ids exposed by `/v1/models`. When omitted, the CLI mirrors the models your account can actually use. |
| Codex API version | `--codex-version`   | Local `codex --version`, then `@openai/codex` latest from npm, then `0.111.0`                                                                          | Override the Codex API client version used for model discovery.                                                                    |
| Upstream base URL | `--base-url`        | `https://chatgpt.com/backend-api/codex`                                                                                                                 | Override the upstream Codex base URL. Custom hosts require the explicit unsafe override.                                            |
| OAuth client id   | `--oauth-client-id` | `app_EMoamEEZ73f0CkXaXp7hrann`                                                                                                                          | Override the OAuth client id used for refresh.                                                                                     |
| OAuth token URL   | `--oauth-token-url` | `https://auth.openai.com/oauth/token`                                                                                                                   | Override the OAuth token URL used for refresh. Custom hosts require the explicit unsafe override.                                   |
| Auth file path    | `--oauth-file`      | `--oauth-file` path if provided, otherwise `$CHATGPT_LOCAL_HOME/auth.json`, `$CODEX_HOME/auth.json`, `~/.chatgpt-local/auth.json`, `~/.codex/auth.json` | Override where the local OAuth auth file is discovered.                                                                            |
| Local API token   | `--local-token` / `OPENAI_OAUTH_LOCAL_TOKEN` | Random per process | Bearer token required for local `/v1/*` requests. Use `--no-local-auth` only in trusted tests. |
| CORS allowlist    | `--allow-origin`    | No browser origins allowed | Repeatable exact browser Origin allowlist. `--allow-any-origin` restores wildcard CORS and is unsafe. |
| Request body limit | `--max-body-bytes` | `10485760` | Maximum HTTP request body accepted by the Node server. |
| Remote bind       | `--allow-unsafe-remote-bind` | `false` | Required before binding to non-loopback interfaces such as `0.0.0.0`. |
| Unsafe URL overrides | `--allow-unsafe-base-url`, `--allow-unsafe-oauth-token-url` | `false` | Required before access or refresh tokens are sent to non-default hosts. |
| Update check      | `--no-update-check` / `OPENAI_OAUTH_NO_UPDATE_CHECK=1` | Enabled | Disables the npm registry latest-version check. |

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

## Known Limitations

What is intentionally not there yet:

- Only LLMs supported by Codex are available. This lists updates over time and is dependent on your Codex plan.
- Login flow is intentionally not bundled. Simply run `npx @openai/codex login` to create the auth file.
- There is no stateful replay support on the CLI `/v1/responses` endpoint. The proxy is stateless and expects callers to send the full conversation history.

## How it Works

OpenAI's Codex CLI uses a special endpoint at `chatgpt.com/backend-api/codex/responses` to let you use special OpenAI rate limits tied to your ChatGPT account.

By using the same Oauth tokens as Codex, we can effectively use OpenAI's API through Oauth instead of buying API credits.

## Legal

This is an unofficial, community-maintained project and is not affiliated with, endorsed by, or sponsored by OpenAI, Inc.

It uses your local Codex/ChatGPT authentication cache (auth.json, e.g. `~/.codex/auth.json`) and should be treated like password-equivalent credentials.

Use only for personal, local experimentation on trusted machines; do not run as a hosted service, do not share access, and do not pool or redistribute tokens.

You are solely responsible for complying with OpenAI’s Terms, policies, and any applicable agreements; misuse may result in rate limits, suspension, or termination.

Provided “as is” with no warranties; you assume all risk for data exposure, costs, and account actions.
