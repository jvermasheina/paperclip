import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.unmock("http");
vi.unmock("node:http");

const agentId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";

const mockIssueService = vi.hoisted(() => ({
  list: vi.fn(),
  listDependencyReadiness: vi.fn(async () => new Map()),
}));

const mockIssueRecoveryActionService = vi.hoisted(() => ({
  listActiveForIssues: vi.fn(async () => new Map()),
}));

const mockNoopService = vi.hoisted(() => () => ({}));

vi.mock("../routes/authz.js", async () => {
  const { unauthorized } = await vi.importActual<typeof import("../errors.js")>("../errors.js");
  function assertAuthenticated(req: Express.Request) {
    if (req.actor.type === "none") throw unauthorized();
  }
  return {
    assertAuthenticated,
    assertBoard: () => undefined,
    assertCompanyAccess: () => undefined,
    assertInstanceAdmin: () => undefined,
    getActorInfo: (req: Express.Request) => ({
      actorType: req.actor.type,
      actorId: req.actor.agentId ?? req.actor.userId ?? "unknown",
      agentId: req.actor.agentId ?? null,
      runId: req.actor.runId ?? null,
    }),
  };
});

vi.mock("../services/index.js", () => ({
  agentService: mockNoopService,
  agentInstructionsService: mockNoopService,
  accessService: mockNoopService,
  approvalService: mockNoopService,
  companySkillService: mockNoopService,
  budgetService: mockNoopService,
  heartbeatService: mockNoopService,
  issueApprovalService: mockNoopService,
  issueRecoveryActionService: () => mockIssueRecoveryActionService,
  issueService: () => mockIssueService,
  ISSUE_LIST_DEFAULT_LIMIT: 100,
  logActivity: vi.fn(),
  secretService: mockNoopService,
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent: unknown, config: unknown) => config),
  workspaceOperationService: mockNoopService,
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({
    getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })),
  }),
}));

vi.mock("../services/environments.js", () => ({ environmentService: mockNoopService }));
vi.mock("../services/environment-runtime.js", () => ({ environmentRuntimeService: mockNoopService }));
vi.mock("../services/environment-execution-target.js", () => ({
  resolveEnvironmentExecutionTarget: vi.fn(),
}));
vi.mock("../services/secrets.js", () => ({ secretService: mockNoopService }));

let routeModules:
  | Promise<[
    typeof import("../middleware/index.js"),
    typeof import("../routes/agents.js"),
  ]>
  | null = null;

async function loadRouteModules() {
  routeModules ??= Promise.all([
    import("../middleware/index.js"),
    import("../routes/agents.js"),
  ]);
  return routeModules;
}

async function createApp() {
  const [{ errorHandler }, { agentRoutes }] = await loadRouteModules();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId,
      companyId,
      runId: "run-1",
    };
    next();
  });
  app.use("/api", agentRoutes({} as any));
  app.use(errorHandler);
  return app;
}

function makeIssue(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "issue-1",
    identifier: "STOA-999",
    title: "In-review issue assigned to self",
    status: "in_review",
    priority: "high",
    projectId: null,
    goalId: null,
    parentId: null,
    updatedAt: new Date("2026-06-25T00:00:00.000Z"),
    activeRun: null,
    ...overrides,
  };
}

describe("GET /api/agents/me/inbox-lite (STOA-726)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.listDependencyReadiness.mockResolvedValue(new Map());
    mockIssueRecoveryActionService.listActiveForIssues.mockResolvedValue(new Map());
  });

  it("passes status filter that includes in_review to the issue service", async () => {
    mockIssueService.list.mockResolvedValue([]);
    const app = await createApp();
    const res = await request(app).get("/api/agents/me/inbox-lite");
    expect(res.status).toBe(200);

    expect(mockIssueService.list).toHaveBeenCalledTimes(1);
    const [calledCompanyId, calledFilters] = mockIssueService.list.mock.calls[0]!;
    expect(calledCompanyId).toBe(companyId);
    expect(calledFilters).toMatchObject({
      assigneeAgentId: agentId,
      status: "todo,in_progress,in_review,blocked",
    });
    // Defensive: explicit string check so a future refactor that splits the
    // string into an array still trips this test if `in_review` is dropped.
    expect(calledFilters.status).toContain("in_review");
  });

  it("returns in_review issues that are assigned to the requesting agent", async () => {
    const inReviewIssue = makeIssue({
      id: "in-review-issue",
      identifier: "STOA-1001",
      status: "in_review",
    });
    const inProgressIssue = makeIssue({
      id: "in-progress-issue",
      identifier: "STOA-1002",
      status: "in_progress",
      title: "Active work",
    });
    mockIssueService.list.mockResolvedValue([inReviewIssue, inProgressIssue]);

    const app = await createApp();
    const res = await request(app).get("/api/agents/me/inbox-lite");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);

    const ids = res.body.map((row: { id: string }) => row.id);
    expect(ids).toContain("in-review-issue");
    expect(ids).toContain("in-progress-issue");

    const inReviewRow = res.body.find((row: { id: string }) => row.id === "in-review-issue");
    expect(inReviewRow).toMatchObject({
      identifier: "STOA-1001",
      status: "in_review",
    });
  });
});
