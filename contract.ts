import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const goalStatusSchema = z.enum([
  "active",
  "paused",
  "blocked",
  "complete",
  "budget_limited",
  "usage_limited",
]);

export const goalItemStatusSchema = z.enum(["pending", "in_progress", "completed"]);

export const goalItemSchema = z.object({
  id: z.string(),
  step: z.string(),
  status: goalItemStatusSchema,
});

export const goalAgentStatusSchema = z.enum([
  "starting",
  "running",
  "idle",
  "completed",
  "error",
  "stopped",
  "unknown",
]);

export const goalAgentRoleSchema = z.enum(["worker", "verifier"]);

export const goalAgentSchema = z.object({
  threadId: z.string(),
  taskName: z.string(),
  nickname: z.string(),
  title: z.string().nullable(),
  itemId: z.string().nullable(),
  role: goalAgentRoleSchema,
  status: goalAgentStatusSchema,
  summary: z.string().nullable(),
});

// One rendered row in Now: a genuinely live subagent and its slice. Computed
// server-side in lib/projection.ts; the UI renders it verbatim.
export const nowRowSchema = z.object({
  key: z.string(),
  title: z.string(),
  nickname: z.string(),
  threadId: z.string().nullable(),
  itemId: z.string().nullable(),
});

export const goalSettingsSchema = z.object({
  verifyEnabled: z.boolean(),
  verifyProvider: z.string(),
  verifyModel: z.string(),
  autoContinue: z.boolean(),
  progressUpdateMinutes: z.number().int(),
});

export const goalSnapshotSchema = z.object({
  threadId: z.string(),
  objective: z.string(),
  status: goalStatusSchema,
  reason: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  startedAt: z.number().int(),
  tokenBudget: z.number().int().nullable(),
  tokensUsed: z.number().int(),
  timeUsedSeconds: z.number().int(),
  lastContinueAt: z.number().int().nullable(),
  lastProgressAt: z.number().int().nullable(),
  lastAccountedAt: z.number().int().nullable(),
  agentRunning: z.boolean(),
  items: z.array(goalItemSchema),
  agents: z.array(goalAgentSchema),
  now: z.array(nowRowSchema),
  next: z.array(goalItemSchema),
  settings: goalSettingsSchema,
});

export type GoalStatus = z.infer<typeof goalStatusSchema>;
export type GoalItemStatus = z.infer<typeof goalItemStatusSchema>;
export type GoalItem = z.infer<typeof goalItemSchema>;
export type GoalAgentStatus = z.infer<typeof goalAgentStatusSchema>;
export type GoalAgent = z.infer<typeof goalAgentSchema>;
export type GoalAgentRole = z.infer<typeof goalAgentRoleSchema>;
export type NowRow = z.infer<typeof nowRowSchema>;
export type GoalSettings = z.infer<typeof goalSettingsSchema>;
export type GoalSnapshot = z.infer<typeof goalSnapshotSchema>;

export const rpcContract = defineRpcContract({
  getGoal: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({
      goal: goalSnapshotSchema.nullable(),
    }),
  },
  pause: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({ goal: goalSnapshotSchema.nullable() }),
  },
  resume: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({ goal: goalSnapshotSchema.nullable() }),
  },
  clear: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({ cleared: z.boolean() }),
  },
  edit: {
    input: z
      .object({
        threadId: z.string().min(1),
        objective: z.string().min(1),
      })
      .strict(),
    output: z.object({ goal: goalSnapshotSchema.nullable() }),
  },
  setItemStatus: {
    input: z
      .object({
        threadId: z.string().min(1),
        itemId: z.string().min(1),
        status: goalItemStatusSchema,
      })
      .strict(),
    output: z.object({ goal: goalSnapshotSchema.nullable() }),
  },
  addItem: {
    input: z
      .object({
        threadId: z.string().min(1),
        step: z.string().min(1),
      })
      .strict(),
    output: z.object({ goal: goalSnapshotSchema.nullable() }),
  },
  removeItem: {
    input: z
      .object({
        threadId: z.string().min(1),
        itemId: z.string().min(1),
      })
      .strict(),
    output: z.object({ goal: goalSnapshotSchema.nullable() }),
  },
  updateSettings: {
    input: z
      .object({
        threadId: z.string().min(1),
        verifyEnabled: z.boolean().optional(),
        verifyProvider: z.string().min(1).optional(),
        verifyModel: z.string().min(1).optional(),
        autoContinue: z.boolean().optional(),
        progressUpdateMinutes: z.number().int().min(0).max(240).optional(),
        tokenBudget: z.number().int().positive().nullable().optional(),
      })
      .strict(),
    output: z.object({ goal: goalSnapshotSchema.nullable() }),
  },
  listModels: {
    input: z.object({ threadId: z.string().min(1).optional() }).strict(),
    output: z.object({
      providers: z.array(
        z.object({
          id: z.string(),
          displayName: z.string(),
          available: z.boolean(),
          models: z.array(
            z.object({
              id: z.string(),
              displayName: z.string(),
              description: z.string().optional(),
            }),
          ),
        }),
      ),
    }),
  },
  listCrews: {
    input: z.object({}).strict(),
    output: z.object({
      crews: z.array(
        z.object({
          threadId: z.string(),
          items: z.array(goalItemSchema),
          agents: z.array(goalAgentSchema),
          workerIds: z.array(z.string()),
        }),
      ),
    }),
  },
});
