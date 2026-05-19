import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  agentRuntimeState,
  companies,
  costEvents,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
const mockTrackAgentFirstHeartbeat = vi.hoisted(() => vi.fn());
const mockAdapterExecute = vi.hoisted(() => vi.fn());

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => mockTelemetryClient,
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentFirstHeartbeat: mockTrackAgentFirstHeartbeat,
  };
});

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat cost provenance tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat cost provenance", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-cost-provenance-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    mockAdapterExecute.mockReset();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
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
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    return { companyId, agentId };
  }

  async function runHeartbeatAndReadCostEvent(agentId: string) {
    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual", {
      actorType: "system",
      actorId: "test",
    });
    expect(run).toBeTruthy();

    let event: typeof costEvents.$inferSelect | null = null;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const rows = await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, run!.id));
      event = rows[0] ?? event;
      const [finishedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
      if (event && finishedRun?.status === "succeeded") return event;
      if (finishedRun?.status === "failed" || finishedRun?.status === "timed_out" || finishedRun?.status === "cancelled") {
        throw new Error(`Heartbeat run ended before writing a cost event: ${finishedRun.status}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    throw new Error("Timed out waiting for cost event");
  }

  it("stores provider-reported Codex cost provenance", async () => {
    const { agentId } = await seedAgent();
    mockAdapterExecute.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      provider: "openai",
      biller: "openai",
      model: "gpt-5.5",
      billingType: "metered_api",
      usage: { inputTokens: 1_000, cachedInputTokens: 200, outputTokens: 300 },
      costUsd: 0.42,
      costSource: "reported",
      costMetadata: { providerCostField: "total_cost_usd", source: "codex_jsonl" },
    });

    const event = await runHeartbeatAndReadCostEvent(agentId);

    expect(event.costCents).toBe(42);
    expect(event.costSource).toBe("reported");
    expect(event.costMetadata).toMatchObject({
      providerCostField: "total_cost_usd",
      source: "codex_jsonl",
      costUsd: 0.42,
    });
  });

  it("estimates direct OpenAI metered API cost when no provider cost is reported", async () => {
    const { agentId } = await seedAgent();
    mockAdapterExecute.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      provider: "openai",
      biller: "openai",
      model: "gpt-5.5",
      billingType: "metered_api",
      usage: {
        inputTokens: 1_000_000,
        cachedInputTokens: 100_000,
        outputTokens: 10_000,
        reasoningOutputTokens: 5_000,
      },
      costUsd: null,
    });

    const event = await runHeartbeatAndReadCostEvent(agentId);

    expect(event.costCents).toBe(500);
    expect(event.costSource).toBe("estimated");
    expect(event.costMetadata).toMatchObject({
      estimator: "openai_model_rate_table",
      inputUsdPerMillion: 5,
      cachedInputUsdPerMillion: 0.5,
      outputUsdPerMillion: 30,
      reasoningOutputTokens: 5_000,
    });

    const [state] = await db.select().from(agentRuntimeState).where(eq(agentRuntimeState.agentId, agentId));
    expect(state?.totalCostCents).toBe(500);
  });

  it("keeps unpriced token usage visible as unavailable provenance", async () => {
    const { agentId } = await seedAgent();
    mockAdapterExecute.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      provider: "openai",
      biller: "openai",
      model: "gpt-unknown-future",
      billingType: "metered_api",
      usage: { inputTokens: 10_000, cachedInputTokens: 0, outputTokens: 1_000 },
      costUsd: null,
    });

    const event = await runHeartbeatAndReadCostEvent(agentId);

    expect(event.costCents).toBe(0);
    expect(event.costSource).toBe("unavailable");
    expect(event.costMetadata).toMatchObject({
      reason: "no_reported_cost_or_configured_rate",
    });
  });
});
