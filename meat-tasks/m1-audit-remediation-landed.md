# M1 — Audit Remediation Landed (`v0.1.0-rc`)

Human-only action items for M1. See `docs/plans/2026-04-17-milestones-design.md` for full milestone scope.

Most of M1 landed in commits `857cb16` ("Addressing audits") and `851388b` (plans tracked). What remains is the human work around validating the fixes and GitHub configuration.

## Remaining before M1 exit

### End-to-end smoke test on a live agent

Automated build + typecheck passes in CI, but nobody has actually run the agent end-to-end against the post-remediation code. Do one pass with a real wallet before calling M1 done.

- [x] Clone `main` to a scratch directory
- [x] `cp .env.example .env` and fill in a throwaway devnet `AGENT_KEYPAIR`, a real `ANTHROPIC_API_KEY`, a fresh `WEB_CHANNEL_TOKEN` (≥32 chars), and `BOOTSTRAP_WALLET=<your-wallet>` (required in autonomous mode; optional in public mode)
- [x] `cp packages/ui/.env.local.example packages/ui/.env.local` and set `NEXT_PUBLIC_WS_TOKEN` to match
- [x] `pnpm install && pnpm dev:all`
- [x] Open <http://localhost:3001>, connect Phantom/Solflare on devnet
- [x] Send "What is my SOL balance?" — confirm the agent responds
- [x] Send "Transfer 0.001 SOL to <some-devnet-wallet>" — confirm the approval modal appears, fee line renders, signing completes, signature lands on devnet
- [ ] Optional: switch `AGENT_MODE=autonomous` and verify non-owner WS connections are rejected
- [ ] Report any regressions as GitHub issues labeled `dogfood/`

### CI first run

The `.github/workflows/ci.yml` file is checked in, but it hasn't run yet (repo is still private and the file is new).

- [ ] Open a trivial PR (e.g., a README typo) to trigger CI on a PR context
- [ ] Verify the `Build & Typecheck` job runs to green on the PR
- [ ] Merge the PR and verify CI also runs green on the push-to-main trigger

### Branch protection

CI is only a quality gate if it's enforced.

- [ ] In GitHub repo settings → Branches → add a rule for `main`
- [ ] Require `Build & Typecheck` status check before merge
- [ ] Require PRs before merging to `main` (1+ approval recommended, but optional for solo work)
- [ ] Enable "Require branches to be up to date before merging" (catches stale PRs)
- [ ] Optionally: require linear history (keeps `main` clean)

### Tag the RC

- [ ] Once the smoke test passes and CI is green on `main`, tag the release candidate:
      `git tag -a v0.1.0-rc1 -m "M1: audit remediation landed" && git push origin v0.1.0-rc1`
- [ ] GitHub Release is **not** required yet — that comes with M3 when the repo goes public.

## Decisions owed (parkable until M3 but worth noting)

- [ ] **pnpm version:** CI pins pnpm 9, local dev is using pnpm 10 (lockfile is v9, works with both). Consider adding `"packageManager": "pnpm@9.15.0"` (or whichever version) to `package.json` to freeze this explicitly. Not blocking M1.
- [ ] **Node version:** CI uses Node 20, `engines.node` is `>=20`. Consider adding `.nvmrc` with `20` for contributor convenience. Not blocking M1.

## Reference

- Milestone design: `docs/plans/2026-04-17-milestones-design.md`
- Remediation plan: `docs/plans/2026-04-17-v2-remediation-plan.md`
- Remediation design: `docs/plans/2026-04-17-v2-remediation-design.md`
- Review report: `docs/REVIEW_REPORT_V2.md`
