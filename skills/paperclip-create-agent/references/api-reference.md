# Paperclip Create Agent API Reference

## Core Endpoints

- `GET /llms/agent-configuration.txt`
- `GET /llms/agent-configuration/:adapterType.txt`
- `GET /llms/agent-icons.txt`
- `GET /api/companies/:companyId/agent-configurations`
- `GET /api/companies/:companyId/skills`
- `POST /api/companies/:companyId/skills/import`
- `GET /api/agents/:agentId/configuration`
- `POST /api/agents/:agentId/skills/sync`
- `POST /api/companies/:companyId/agent-hires`
- `POST /api/companies/:companyId/agents`
- `GET /api/agents/:agentId/config-revisions`
- `POST /api/agents/:agentId/config-revisions/:revisionId/rollback`
- `POST /api/issues/:issueId/approvals`
- `GET /api/approvals/:approvalId/issues`

Approval collaboration:

- `GET /api/approvals/:approvalId`
- `POST /api/approvals/:approvalId/request-revision` (board)
- `POST /api/approvals/:approvalId/resubmit`
- `GET /api/approvals/:approvalId/comments`
- `POST /api/approvals/:approvalId/comments`
- `GET /api/approvals/:approvalId/issues`

## `POST /api/companies/:companyId/agent-hires`

Request body matches agent create shape:

```json
{
  "name": "CTO",
  "role": "cto",
  "title": "Chief Technology Officer",
  "icon": "crown",
  "reportsTo": "uuid-or-null",
  "capabilities": "Owns architecture and engineering execution",
  "desiredSkills": ["vercel-labs/agent-browser/agent-browser"],
  "adapterType": "claude_local",
  "adapterConfig": {
    "cwd": "/absolute/path",
    "model": "claude-sonnet-4-5-20250929"
  },
  "instructionsBundle": {
    "entryFile": "AGENTS.md",
    "files": {
      "AGENTS.md": "You are CTO..."
    }
  },
  "runtimeConfig": {
    "heartbeat": {
      "enabled": false,
      "wakeOnDemand": true
    }
  },
  "budgetMonthlyCents": 0,
  "sourceIssueId": "uuid-or-null",
  "sourceIssueIds": ["uuid-1", "uuid-2"]
}
```

Response:

```json
{
  "agent": {
    "id": "uuid",
    "status": "pending_approval"
  },
  "approval": {
    "id": "uuid",
    "type": "hire_agent",
    "status": "pending",
    "payload": {
      "desiredSkills": ["vercel-labs/agent-browser/agent-browser"]
    }
  }
}
```

If company setting disables required approval, `approval` is `null` and the agent is created as `idle`.

`desiredSkills` accepts company skill ids, canonical keys, or a unique slug. The server resolves and stores canonical company skill keys.
Leave timer heartbeats disabled by default. Only set `runtimeConfig.heartbeat.enabled=true` and include an `intervalSec` when the role truly needs scheduled recurring work or the user explicitly requested it.

The hire-request COMMENT (the one you post on the source issue and approval thread) must include the `## Cost-SKU disclosure` table. The request body itself does not have a `costSku` field — the disclosure lives in the human-reviewable comment so the board can audit it before approving. See the Cost-SKU disclosure section below.

## Approval Lifecycle

Statuses:

- `pending`
- `revision_requested`
- `approved`
- `rejected`
- `cancelled`

For hire approvals:

- approved: linked agent transitions `pending_approval -> idle`
- rejected: linked agent is terminated

## Safety Notes

- Config read APIs redact obvious secrets.
- `pending_approval` agents cannot run heartbeats, receive assignments, or create keys.
- All actions are logged in activity for auditability.
- Use markdown in issue/approval comments and include links to approval, agent, and source issue.
- After approval resolution, requester may be woken with `PAPERCLIP_APPROVAL_ID` and should reconcile linked issues.

## Cost-SKU disclosure (required in every hire comment)

Every `agent-hires` request comment MUST include a `## Cost-SKU disclosure` section listing every third-party SKU the candidate agent will hit. This is the audit record the board uses to authorize cost-bearing defaults. See SKILL.md step 7 for the full rule and the `H2` block in `references/draft-review-checklist.md` for the gating checklist.

Worked example for a `claude_local` builder agent with a single image-generation skill:

```md
## Cost-SKU disclosure

| SKU | Provider | Auth path | Cost tier | Expected monthly volume | Budget cap |
| --- | --- | --- | --- | --- | --- |
| Claude Messages API (Sonnet 4.6) | Anthropic | host Claude subscription | subscription | ~8 M tokens | covered by host plan |
| Imagen 4.0 generate | Google AI Studio (NOT Vertex) | `GEMINI_API_KEY` env, free-tier project | free | ~30 images | board alert pending — escalate if usage > 50/mo |
| Shopify Admin GraphQL | Shopify | per-customer Theme Access token | n/a (customer cost) | ~200 calls | n/a |
```

Negative example — what the Reitti incident looked like and what to reject:

```md
## Cost-SKU disclosure

| SKU | Provider | Auth path | Cost tier | Expected monthly volume | Budget cap |
| --- | --- | --- | --- | --- | --- |
| Gemini text-generation | (free Gemini Flash via CLI) | `GEMINI_API_KEY` env | free-tier-ish | unknown | none |
```

Reject and request a resubmission:

- `Provider` does not distinguish `Google AI Studio` (free) from `Vertex AI` / paid GCP project.
- `Cost tier` is not one of `free | subscription | paid | paid-with-cap`.
- `Expected monthly volume = unknown` without a board-approved investigation budget.
- `Budget cap = none` on a non-free SKU.

These four omissions are exactly how the four Verifier agents accumulated €141 of Gemini Pro Long charges over 50 days. Treat the disclosure as the authorization gate.
