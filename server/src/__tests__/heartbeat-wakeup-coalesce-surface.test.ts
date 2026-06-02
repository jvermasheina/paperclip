import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres wakeup-coalesce-surface tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat.wakeup surfaces coalesce state to caller (STOA-184)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wakeup-coalesce-surface-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await db?.$client?.end?.({ timeout: 0 });
    await tempDb?.cleanup();
  });

  async function seedAgentWithBlockingRun() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const blockingRunId = randomUUID();
    const blockingIssueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CEO",
      role: "ceo",
      status: "running",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    // Seed a different-scope running run so the agent's concurrency slot is
    // taken — this prevents our coalesce-test queued run from being claimed
    // and actually started (which would trigger environment-lease acquisition
    // outside the scope of this test).
    await db.insert(heartbeatRuns).values({
      id: blockingRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      contextSnapshot: {
        issueId: blockingIssueId,
        taskId: blockingIssueId,
        wakeReason: "issue_assigned",
      },
    });

    return { companyId, agentId };
  }

  it("first call returns coalesced=false; subsequent calls return coalesced=true with target run id and count", async () => {
    const { agentId } = await seedAgentWithBlockingRun();
    const heartbeat = heartbeatService(db);

    const first = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "stoa-184-first",
    });
    expect(first).not.toBeNull();
    expect(first?.coalesced).toBe(false);
    expect(first?.coalescedInto).toBeNull();
    expect(first?.coalescedCount).toBe(0);
    const firstRunId = first!.id;

    const second = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "stoa-184-second",
    });
    expect(second).not.toBeNull();
    expect(second?.coalesced).toBe(true);
    expect(second?.coalescedInto).not.toBeNull();
    expect(second?.coalescedInto?.runId).toBe(firstRunId);
    expect(typeof second?.coalescedInto?.status).toBe("string");
    expect(second?.id).toBe(firstRunId);
    expect(second?.coalescedCount ?? 0).toBeGreaterThanOrEqual(2);

    const third = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "stoa-184-third",
    });
    expect(third?.coalesced).toBe(true);
    expect(third?.coalescedInto?.runId).toBe(firstRunId);
    expect(third?.coalescedCount ?? 0).toBeGreaterThanOrEqual(3);
  });
});
