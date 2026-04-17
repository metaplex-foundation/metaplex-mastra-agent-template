# Metaplex Agent Template — Milestones

**Date:** 2026-04-17
**Status:** Approved direction
**Owner:** TBD

---

## Context

The Metaplex Agent Template is an open-source monorepo starter kit for building AI agents on Solana. Two tracks drive the near-term roadmap:

1. Make the repo a credible public template that external developers can fork.
2. Run the template as a live showcase on metaplex.com so devs can try before forking.

A third track — moving the showcase to mainnet — is deliberately deferred until the public devnet version is proven and hardened.

---

## Guiding decisions

- **Showcase identity:** the deployed agent is the generic template as-is — no Metaplex-specific branding, no custom tools, no bespoke persona. Its purpose is to demonstrate what devs get when they fork.
- **Release bar:** "proper dev release" — CI on PRs, template scaffolding, community files, tagged `v0.1.0`. Not a marketing launch with videos and example forks; that's deferred.
- **Network sequencing:** devnet first for the public showcase, mainnet later as its own milestone with a dedicated security-review gate.
- **Quality gate:** internal dogfood before public release — if the Metaplex team can't run it smoothly, external devs won't either.

---

## Milestones

### M1 — Audit Remediation Landed (`v0.1.0-rc`)

Prerequisite work to get `main` ready for public release.

**Scope**
- All Critical + High findings from `docs/REVIEW_REPORT_V2.md` merged into `main`, tracked against `docs/plans/2026-04-17-v2-remediation-plan.md`
- Uncommitted working-tree changes grouped into coherent commits and landed
- `pnpm build && pnpm typecheck` green on `main`
- GitHub Actions CI configured (typecheck + build on every PR) even while repo is still private

**Exit criteria**
- `main` is clean (no uncommitted files)
- Fresh-clone smoke test passes: clone → `pnpm install` → copy `.env.example` → `pnpm dev:all` → agent responds and signs a devnet transfer

---

### M2 — Internal Staging Deploy / Dogfood

Deploy `main` to internal Metaplex infrastructure so the team can use it before external exposure.

**Scope**
- Containerize the server (Dockerfile + compose for local parity)
- Deploy to internal devnet-targeted staging (team-only URL behind SSO or basic auth)
- Establish the secrets story (`WEB_CHANNEL_TOKEN`, `ANTHROPIC_API_KEY`, `AGENT_KEYPAIR`) in whatever secrets store Metaplex services already use
- Wire up baseline monitoring: uptime, LLM spend, per-session error rate, RPC error rate
- Team uses it for 1–2 weeks as part of normal devnet workflows
- Triage issues with a `dogfood/` label; fix all P0/P1 before proceeding

**Exit criteria**
- 1 continuous week of internal use with no P0/P1 open
- Runbook draft exists (restart, rotate token, drain connections)

---

### M3 — Public Template Release (`v0.1.0`)

Flip the repo public and position it as a fork-ready template.

**Scope**
- Repository visibility set to public
- `LICENSE` selected and added (Apache-2.0 or MIT — decision owed)
- `CONTRIBUTING.md` with development workflow + PR expectations
- `CODE_OF_CONDUCT.md` (Contributor Covenant or equivalent)
- Issue templates (bug report + feature request) and PR template
- "Use this template" enabled on the GitHub repo settings
- README additions: badges (CI status, license, node version), `degit` / `gh repo create --template` instructions, quick-start verified from a clean machine
- Tagged `v0.1.0` release with human-written release notes

**Exit criteria**
- External developer with no prior context can click "Use this template," clone, configure three env vars, run `pnpm dev:all`, and have a working agent in under 10 minutes

---

### M4 — Public Devnet Showcase on metaplex.com

Run the template as a live, public-facing agent integrated into metaplex.com.

**Scope**
- Deploy the containerized server (built in M2) to production-grade infra
- TLS termination + `wss://` reverse proxy; `WS_ALLOWED_ORIGINS` locked to metaplex.com
- Paid devnet RPC endpoint (e.g., Helius devnet) rather than the public endpoint
- Gateway rate limits in front of the server (Cloudflare rules or nginx `limit_req`) capping per-IP handshakes and messages
- Secrets managed via production secrets store (not `.env` on disk)
- Monitoring and alerts routed to Metaplex ops channels
- Frontend integration: "Try the agent" section on metaplex.com/agents pointing at the deployed endpoint (either embedded or subdomain like `agent-demo.metaplex.com`)
- Runbook finalized and linked from the ops channel

**Exit criteria**
- Public URL on metaplex.com reachable from the open internet
- Anyone with a devnet Phantom/Solflare wallet can connect, chat, and sign an end-to-end transfer
- Metaplex ops can restart, rotate `WEB_CHANNEL_TOKEN`, and drain connections without the original author

---

### M5 — Mainnet Hardening (future)

Upgrade the showcase to run on mainnet once trust and ops are established.

**Scope**
- External security audit of the full stack (server, protocol, tools, agent auth model) + remediation
- `AGENT_KEYPAIR` stored in KMS or Vault — never in env files or container images
- Paid mainnet RPC with enforced spend cap
- ToS and disclaimers on the metaplex.com frontend; legal sign-off on user-facing copy
- Funded PDA treasury with spending caps, balance alerts, and an emergency-pause mechanism
- Incident response plan + on-call rotation with defined severity ladder

**Exit criteria**
- Stable mainnet showcase for 2 continuous weeks
- No known Critical or High issues open
- On-call rotation live

---

## Suggested extras (non-sequential)

These are high-value when adoption signals justify them, but shouldn't block M1–M4.

### M6 — Test coverage
Unit tests for every tool, integration tests for the PlexChat protocol, one end-to-end happy-path test. Right-sized before external contributors start sending PRs — reviewer leverage matters more than the tests themselves.

### M7 — Worked example gallery
2–3 forks in their own repos (faucet agent, token-launch concierge, portfolio advisor) linked from the README. Proves the template is forkable for real use cases and gives external devs concrete starting points beyond the generic template.

### M8 — SDK extraction
If external adoption materializes, extract `@metaplex-agent/sdk` as a library so devs can depend on it instead of forking. The template becomes one reference implementation rather than the only path.

### M9 — Observability pack
OpenTelemetry hooks + pre-built Grafana dashboards shipped with the template. High-leverage once third parties run the template in production and need the same visibility Metaplex ops has.

---

## Sequencing

Recommended order:

```
M1 → M2 → M3 → M4 → M5
              │
              └─► M6 in parallel with M4 if bandwidth allows
                  M7/M8/M9 only when adoption signals justify them
```

M1 and M2 are internal and can move fast. M3 is a point-in-time release event. M4 is the largest single milestone by effort (new production infra). M5 is gated on real-world signal from M4, not a timeline.
