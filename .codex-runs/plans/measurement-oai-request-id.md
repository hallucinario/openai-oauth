# Measurement upstream request-ID repair

## Goal

Repair genuine upstream `x-oai-request-id` propagation in measurement mode and prepare one implementation commit for the parent agent's single PR. No live measurement, canary, retry, restart, deployment, push, PR, review-loop, merge, or worktree lifecycle operation is in this worker's scope.

## Current state

- Worktree branch `fix/measurement-oai-request-id-5c8150b15683` is at `1c4cbb4555c5eb28d5d6aa7a48d073c88601fc1c`; worktree is clean before this plan artifact.
- `packages/openai-oauth-core/src/measurement.ts` requires only `x-request-id`, causing alternate-header-only upstream responses to fail with HTTP 502.
- Existing measurement contract retains strict model, response identity, token usage, output-limit, and one-attempt checks.
- `README.md` describes only `x-request-id`.
- Existing tests include core transport, provider auth, and fake-upstream HTTP coverage.
- Parent reports immutable measurement 10532 at `1c4cbb4555c5eb28d5d6aa7a48d073c88601fc1c`; one failed request is retained. No live retest is authorized.

## Audience / User

The parent agent and operators relying on auditable, single-attempt measurement receipts need the actual upstream request ID and the header provenance without weakening evidence requirements.

## Scope

### In scope

- Test genuine alternate-header fallback and primary-header precedence.
- Keep empty `x-request-id` authoritative and reject it even if the alternate header is nonempty.
- Add `x-oauth-upstream-request-id-header` containing only the selected canonical header name.
- Propagate provenance through provider and HTTP success/error paths as specified.
- Reject missing/empty IDs and any substitute or forged metadata; preserve all current measurement checks.
- Document pinned official upstream semantics and provenance in `README.md`.
- Run fake-upstream tests with `LIVE_CODEX_E2E=0`, build, typecheck, test, and Biome checks.

### Out of scope

- Live provider requests, luna/capture/canary/retry, measurement ledger edits, service restart, deployment, runtime adoption, CI workflow edits, dependency changes, push/PR/review/merge, and branch/worktree cleanup.

## Constraints

- Work only in the existing linked worktree and branch; main checkout and its unrelated untracked `.claude/` and `.codex-reviews/` must remain untouched.
- Do not create/remove worktrees or branches. Parent owns push and GitHub lifecycle.
- Preserve request ID bytes; use Web Headers API; do not accept IDs from body, SDK response ID, client ID, `cf-ray`, or upstream-supplied attestation.
- No package changes. Use `pnpm`; disable live tests.
- Commit task files with `--no-gpg-sign`, Conventional Commits, HEREDOC, no coauthor.

## Risks and controls

- False evidence could incorrectly validate a request: select only actual upstream response headers and retain strict nonempty validation.
- Wrong precedence could misreport evidence: select `x-request-id` when present, otherwise `x-oai-request-id`; an empty present primary remains a rejection.
- Route/provider header loss could hide provenance: cover real provider and ephemeral fake-upstream HTTP paths.
- Live traffic or deployment could mutate external state: explicitly prohibited and all verification uses injected fake upstreams.

## Assumptions

- The parent-provided official Codex source inspection is authoritative for current intended precedence: source commit `bc9cad3473d4092d34d11a8d050c2dc199a74959`, `codex-rs/response-debug-context/src/lib.rs`, lines 5–7 and 26–36.
- The supplied failure and immutable measurement facts are parent-observed; this worker will not recreate them.
- The existing lockfile and package versions are sufficient; no new dependency is needed.

## Sources inspected

- User-provided task plan, sections 1–11, for immutable measurement facts, scope, authoritative source findings, responsibility map, commands, and parent/worker boundaries.
- `README.md` for current measurement contract documentation.
- `packages/openai-oauth-core/src/measurement.ts` for current header selection and evidence checks.
- Root `package.json` for scripts and package manager.
- Existing target test files: `packages/openai-oauth-core/test/transport.test.ts`, `packages/openai-oauth-provider/test/auth.test.ts`, `packages/openai-oauth/test/measurement-http.test.ts`, and `packages/openai-oauth/test/measurement.test.ts`.
- `docs/context/codex-plan-readiness.md` and repository `AGENTS.md` are absent in this checkout; the full applicable policy and plan were supplied in the conversation.

## External research

No additional research required: this domain-specific evidence extraction needs no generic utility or dependency. The official source commit and exact precedence were already inspected and pinned by the parent in the supplied plan. No live endpoint access is permitted.

## Verification and implementation sequence

1. Add focused regression tests only; run them against unchanged production code and preserve failing output outside the repository.
2. Implement the minimal extraction and provenance propagation without relaxing any check.
3. Run focused tests, then `pnpm build --force`, `pnpm typecheck`, `LIVE_CODEX_E2E=0 pnpm test`, `pnpm format-and-lint`, and the fake-upstream measurement HTTP smoke.
4. Perform a bounded independent lite-review on the final local branch/worktree if the review runner is available; parent separately owns fresh exact-head PR review evidence.

## Acceptance criteria

- Alternate-only genuine SSE response succeeds and reports the exact ID plus selected header name.
- When both headers exist, `x-request-id` wins.
- Missing, empty primary, cf-ray-only, client-ID-only, response-ID-only, and forged attestation do not satisfy request-ID evidence.
- Model mismatch, incomplete usage, output over 4096, and one-attempt behavior remain enforced.
- Provider response and both HTTP endpoints preserve provenance; non-2xx upstream response remains one attempt.
- All final build, typecheck, tests, formatting/lint, and `LIVE_CODEX_E2E=0` fake HTTP smoke checks pass.
- Only requested task files and this readiness artifact are committed; no live measurement or external runtime action occurs.

## Rollback / recovery

No deployment or rollback action is in scope. If the parent rejects the change, revert the task commit on the implementation branch. The immutable measurement record remains untouched.

## Evidence

- Target failure evidence: alternate-only SSE currently cannot pass because source checks `headers.get("x-request-id")` exclusively; the first tests-only run will record executable red evidence.
- Runtime-safety evidence: all HTTP verification injects fake upstream responses, uses loopback only, and runs with `LIVE_CODEX_E2E=0`.
