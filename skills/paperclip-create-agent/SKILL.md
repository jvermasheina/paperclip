---
name: paperclip-create-agent
description: >
  Create new agents in Paperclip with governance-aware hiring. Use when you need
  to inspect adapter configuration options, compare existing agent configs,
  draft a new agent prompt/config, and submit a hire request.
---

# Paperclip Create Agent Skill

Use this skill when you are asked to hire/create an agent.

## Preconditions

You need either:

- board access, or
- agent permission `can_create_agents=true` in your company

If you do not have this permission, escalate to your CEO or board.

## Workflow

### 1. Confirm identity and company context

```sh
curl -sS "$PAPERCLIP_API_URL/api/agents/me" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"
```

### 2. Discover adapter configuration for this Paperclip instance

```sh
curl -sS "$PAPERCLIP_API_URL/llms/agent-configuration.txt" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"

# Then the specific adapter you plan to use, e.g. claude_local:
curl -sS "$PAPERCLIP_API_URL/llms/agent-configuration/claude_local.txt" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"
```

### 3. Compare existing agent configurations

```sh
curl -sS "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/agent-configurations" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"
```

Note naming, icon, reporting-line, and adapter conventions the company already follows.

### 4. Choose the instruction source (required)

This is the single most important decision for hire quality. Pick exactly one path:

- **Exact template** — the role matches an entry in the template index. Use the matching file under `references/agents/` as the starting point.
- **Adjacent template** — no exact match, but an existing template is close (for example, a "Backend Engineer" hire adapted from `coder.md`, or a "Content Designer" adapted from `uxdesigner.md`). Copy the closest template and adapt deliberately: rename the role, rewrite the role charter, swap domain lenses, and remove sections that do not fit.
- **Generic fallback** — no template is close. Use the baseline role guide to construct a new `AGENTS.md` from scratch, filling in each recommended section for the specific role.

Template index and when-to-use guidance:
`skills/paperclip-create-agent/references/agent-instruction-templates.md`

Generic fallback for no-template hires:
`skills/paperclip-create-agent/references/baseline-role-guide.md`

State which path you took in your hire-request comment so the board can see the reasoning.

### 5. Discover allowed agent icons

```sh
curl -sS "$PAPERCLIP_API_URL/llms/agent-icons.txt" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"
```

### 6. Draft the new hire config

- role / title / name
- icon (required in practice; pick from `/llms/agent-icons.txt`)
- reporting line (`reportsTo`)
- adapter type
- `desiredSkills` from the company skill library when this role needs installed skills on day one
- if any `desiredSkills` or adapter settings expand browser access, external-system reach, filesystem scope, or secret-handling capability, justify each one in the hire comment
- adapter and runtime config aligned to this environment
- leave timer heartbeats off by default; only set `runtimeConfig.heartbeat.enabled=true` with an `intervalSec` when the role genuinely needs scheduled recurring work or the user explicitly asked for it
- if the role may handle private advisories or sensitive disclosures, confirm a confidential workflow exists first (dedicated skill or documented manual process)
- capabilities
- managed instructions bundle (`AGENTS.md`) for adapters that support it; avoid durable `promptTemplate` config
- for coding or execution agents, include the Paperclip execution contract: start actionable work in the same heartbeat; do not stop at a plan unless planning was requested; leave durable progress with a clear next action; use child issues for long or parallel delegated work instead of polling; mark blocked work with owner/action; respect budget, pause/cancel, approval gates, and company boundaries
- instruction text such as `AGENTS.md` built from step 4; for local managed-bundle adapters, send this as top-level `instructionsBundle.files["AGENTS.md"]`. Do not set `adapterConfig.promptTemplate` or `bootstrapPromptTemplate` for new agents.
- source issue linkage (`sourceIssueId` or `sourceIssueIds`) when this hire came from an issue

### 7. Cost-SKU disclosure (REQUIRED — every hire request)

Every hire comment MUST include a `## Cost-SKU disclosure` section. This is non-negotiable, even when you believe the role is "free-tier only". A textual "free-tier" claim without an itemized SKU table is exactly how the 2026-05 → 2026-06 Reitti incident accumulated €141 of unauthorized Gemini Pro Long spend across four Verifier agents over 50 days ([STOA-689](/STOA/issues/STOA-689) Stream 3 findings).

List **every** third-party API/service the candidate agent will hit at runtime. Include the agent's LLM provider, image/audio/vector services, scheduling APIs, telemetry sinks, vendor SDKs surfaced via skills, and anything reached through `adapterConfig.env` keys. One row per SKU:

| SKU | Provider | Auth path | Cost tier | Expected monthly volume | Budget cap |
| --- | --- | --- | --- | --- | --- |
| Claude API (Sonnet 4.6) | Anthropic | host subscription | subscription | ~5 M tokens | n/a (covered by host plan) |
| Gemini 2.5 Pro | Google AI Studio | `GEMINI_API_KEY` env | paid-with-cap | ~2 M tokens | €20/mo board-approved |
| Imagen 4.0 | Vertex AI | `GOOGLE_CLOUD_PROJECT` env | paid | ~50 images | board approval pending |

Required fields per row:

- **SKU** — concrete API surface (e.g. `Claude Messages API`, `Gemini text-generation`, `Imagen 4.0`, `Resend send`, `Stripe Checkout`).
- **Provider** — the billing-bearing entity (Anthropic, Google AI Studio, Vertex AI / GCP project, etc.). Distinguish `Google AI Studio` (free-tier path) from `Vertex AI` / paid GCP projects — these LOOK identical and were the exact failure mode in Reitti.
- **Auth path** — `host subscription`, OAuth, env var name (e.g. `GEMINI_API_KEY`), or scoped skill.
- **Cost tier** — exactly one of `free`, `subscription` (covered by an existing host plan), `paid`, `paid-with-cap` (budget cap wired to billing alerts).
- **Expected monthly volume** — token/request count rough order-of-magnitude. "Unknown" is acceptable only with a board-approved investigation budget.
- **Budget cap** — explicit cap + alert wiring, or `n/a` for subscription/free, or "board approval pending" for paid SKUs without a cap.

Rules:

- If ANY row is `paid` or `paid-with-cap`, the hire comment MUST also propose a billing-alert wiring (cost-explorer alert, GCP budget alert, Anthropic usage alert) and the hire stays in `pending_approval` until the board confirms the alert exists.
- An `AGENTS.md` claim such as "this agent uses free Gemini Flash" is not evidence. Cite the exact env var the runtime resolves and the billing project it routes through.
- If the role's adapter is `claude_local` and the only LLM path is the host's Claude subscription, that single row is sufficient — but the section is still REQUIRED so the table exists for future audit.
- Skills that the agent will receive via `desiredSkills` count: enumerate their third-party SKUs too (e.g. `frontend-design` may invoke Imagen; `paperclip` does not invoke billed APIs).

The board uses this section as the authorization record for cost-bearing defaults. Omitting it is grounds for rejection.

### 8. Review the draft against the quality checklist

Before submitting, walk the draft-review checklist end-to-end and fix any item that does not pass:
`skills/paperclip-create-agent/references/draft-review-checklist.md`

### 9. Submit hire request

```sh
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/agent-hires" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "CTO",
    "role": "cto",
    "title": "Chief Technology Officer",
    "icon": "crown",
    "reportsTo": "<ceo-agent-id>",
    "capabilities": "Owns technical roadmap, architecture, staffing, execution",
    "desiredSkills": ["vercel-labs/agent-browser/agent-browser"],
    "adapterType": "codex_local",
    "adapterConfig": {"cwd": "/abs/path/to/repo", "model": "o4-mini"},
    "instructionsBundle": {"files": {"AGENTS.md": "You are the CTO..."}},
    "runtimeConfig": {"heartbeat": {"enabled": false, "wakeOnDemand": true}},
    "sourceIssueId": "<issue-id>"
  }'
```

### 10. Handle governance state

- if the response has `approval`, the hire is `pending_approval`
- monitor and discuss on the approval thread
- when the board approves, you will be woken with `PAPERCLIP_APPROVAL_ID`; read linked issues and close/comment follow-up

```sh
curl -sS "$PAPERCLIP_API_URL/api/approvals/<approval-id>" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"

curl -sS -X POST "$PAPERCLIP_API_URL/api/approvals/<approval-id>/comments" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"body":"## CTO hire request submitted\n\n- Approval: [<approval-id>](/approvals/<approval-id>)\n- Pending agent: [<agent-ref>](/agents/<agent-url-key-or-id>)\n- Source issue: [<issue-ref>](/issues/<issue-identifier-or-id>)\n\nUpdated prompt and adapter config per board feedback."}'
```

If the approval already exists and needs manual linking to the issue:

```sh
curl -sS -X POST "$PAPERCLIP_API_URL/api/issues/<issue-id>/approvals" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"approvalId":"<approval-id>"}'
```

After approval is granted, run this follow-up loop:

```sh
curl -sS "$PAPERCLIP_API_URL/api/approvals/$PAPERCLIP_APPROVAL_ID" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"

curl -sS "$PAPERCLIP_API_URL/api/approvals/$PAPERCLIP_APPROVAL_ID/issues" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY"
```

For each linked issue, either:
- close it if the approval resolved the request, or
- comment in markdown with links to the approval and next actions.

## References

- Template index and how to apply a template: `skills/paperclip-create-agent/references/agent-instruction-templates.md`
- Individual role templates: `skills/paperclip-create-agent/references/agents/`
- Generic baseline role guide (no-template fallback): `skills/paperclip-create-agent/references/baseline-role-guide.md`
- Pre-submit draft-review checklist: `skills/paperclip-create-agent/references/draft-review-checklist.md`
- Endpoint payload shapes and full examples: `skills/paperclip-create-agent/references/api-reference.md`
