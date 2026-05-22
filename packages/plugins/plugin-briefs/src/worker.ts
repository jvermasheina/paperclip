import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import {
  briefPreferencesSchema,
  listBriefCardsInputSchema,
  pinBriefCardInputSchema,
  updateBriefPreferencesInputSchema,
} from "./contracts.js";
import {
  buildDeterministicBriefCard,
  type BriefsSourceBundle,
  type DeterministicBriefOptions,
} from "./deterministic-card-service.js";
import { createBriefsStore } from "./store.js";

function objectParam(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

const plugin = definePlugin({
  async setup(ctx) {
    const store = createBriefsStore(ctx.db);

    ctx.data.register("cards", async (params) => {
      const input = listBriefCardsInputSchema.parse(params);
      return {
        cards: await store.listCards(input),
      };
    });

    ctx.actions.register("save-deterministic-card", async (params) => {
      const input = objectParam(params, "params");
      const bundle = objectParam(input.bundle, "bundle") as BriefsSourceBundle;
      const options = (input.options && typeof input.options === "object" ? input.options : {}) as DeterministicBriefOptions;
      const card = await store.saveCard(buildDeterministicBriefCard(bundle, options));
      await ctx.activity.log({
        companyId: card.companyId,
        message: `Updated briefing card "${card.title}"`,
        entityType: "plugin:briefs:card",
        entityId: card.id,
        metadata: {
          userId: card.userId,
          state: card.state,
          rootIssueId: card.rootIssueId,
          summaryStatus: card.summaryStatus,
        },
      });
      return { card };
    });

    ctx.actions.register("pin-card", async (params) => {
      const input = pinBriefCardInputSchema.parse(params);
      await store.setPinned(input);
      await ctx.activity.log({
        companyId: input.companyId,
        message: `${input.pinned ? "Pinned" : "Unpinned"} briefing card`,
        entityType: "plugin:briefs:card",
        entityId: input.cardId,
        metadata: { userId: input.userId, pinned: input.pinned },
      });
      return { ok: true };
    });

    ctx.actions.register("update-preferences", async (params) => {
      const input = updateBriefPreferencesInputSchema.parse(params);
      const preferences = briefPreferencesSchema.parse(input);
      await store.upsertPreferences(preferences);
      await ctx.activity.log({
        companyId: preferences.companyId,
        message: "Updated briefing preferences",
        entityType: "plugin:briefs:preferences",
        entityId: preferences.userId,
        metadata: preferences,
      });
      return { preferences };
    });
  },

  async onHealth() {
    return { status: "ok", message: "Briefs deterministic card service ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
