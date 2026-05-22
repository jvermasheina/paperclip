import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "paperclipai.plugin-briefs";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Briefs",
  description: "Company-scoped briefing cards backed by deterministic Paperclip work-state analysis.",
  author: "Paperclip",
  categories: ["automation", "ui"],
  capabilities: [
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "companies.read",
    "projects.read",
    "goals.read",
    "agents.read",
    "issues.read",
    "issue.subtree.read",
    "issue.relations.read",
    "issue.comments.read",
    "issue.documents.read",
    "issues.orchestration.read",
    "activity.log.write",
    "plugin.state.read",
    "plugin.state.write"
  ],
  entrypoints: {
    worker: "./dist/worker.js"
  },
  database: {
    namespaceSlug: "briefs",
    migrationsDir: "migrations",
    coreReadTables: ["companies", "issues"]
  }
};

export default manifest;
