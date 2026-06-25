# STOA-718 — free-tier-claim CI gate (CI-admin promotion required)

The lint script + tests + pre-push hook ship in this PR. The matching
two-step wiring into `.github/workflows/pr.yml` could **not** be pushed
from this branch because the active OAuth token lacks the `workflow`
scope (`refusing to allow an OAuth App to create or update workflow
.github/workflows/pr.yml without workflow scope`).

CI-admin: please append these two steps to the existing `policy` job in
`.github/workflows/pr.yml`, immediately after
`Test no-git-push check`:

```yaml
      - name: Free-tier-claim gate (STOA-718)
        run: node ./scripts/check-free-tier-claims.mjs

      - name: Test free-tier-claim gate
        run: node --test ./scripts/check-free-tier-claims.test.mjs
```

Once wired, the gate runs on every PR. Until then, the
`.githooks/pre-push` hook (opt-in via `git config core.hooksPath
.githooks`) is the load-bearing local check, and `node
scripts/check-free-tier-claims.mjs` can be run manually.

Related: STOA-689 Q7 (Reitti €141 post-mortem), STOA-714 (cost-SKU
disclosure on hire).
