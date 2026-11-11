import { permissionModeSchema } from '@joymind/core';
import { providerIdSchema } from '@joymind/providers';
import { z } from 'zod';

export const channels = {
  startRun: 'joymind:run:start',
  getRun: 'joymind:run:get',
  listRuns: 'joymind:run:list',
  command: 'joymind:run:command',
  subscribe: 'joymind:run:subscribe',
  unsubscribe: 'joymind:run:unsubscribe',
  event: 'joymind:run:event',
  subscriptionError: 'joymind:run:subscription-error',
  catalog: 'joymind:providers:catalog',
  secretSettings: 'joymind:secrets:settings',
  secretSave: 'joymind:secrets:save',
  secretDelete: 'joymind:secrets:delete',
  connectionTest: 'joymind:providers:test',
  modelList: 'joymind:providers:models',
  preferencesGet: 'joymind:preferences:get',
  preferencesSave: 'joymind:preferences:save',
  workspaceSelect: 'joymind:workspace:select',
  externalOpen: 'joymind:external:open',
  menuAction: 'joymind:menu:action',
} as const;

const runIdSchema = z.string().min(1).max(200);
const commandIdSchema = z.string().min(1).max(200);
const approvalIdSchema = z.string().min(1).max(200);

export const providerSchema = providerIdSchema;
export const secretProviderSchema = providerIdSchema.exclude(['scripted']);
export const localeSchema = z.enum(['zh-CN', 'en-US']);

export const startRunSchema = z.object({
  workspacePath: z.string().trim().min(1).max(4096),
  goal: z.string().trim().min(1).max(20_000),
  provider: providerSchema,
  model: z.string().trim().min(1).max(200),
  permissionMode: permissionModeSchema,
}).strict();

export const preferencesInputSchema = z.object({
  locale: localeSchema,
  workspacePath: z.string().trim().max(4096),
  provider: providerSchema,
  models: z.partialRecord(providerSchema, z.string().trim().min(1).max(200)),
  baseUrls: z.partialRecord(secretProviderSchema, z.url()),
  modelListBaseUrls: z.partialRecord(secretProviderSchema, z.url()),
  permissionMode: permissionModeSchema,
  runDetail: z.enum(['detailed', 'compact']),
  showToolTimeline: z.boolean(),
}).strict();

export const preferencesFileSchema = z.object({
  version: z.literal(1),
  locale: localeSchema.default('zh-CN'),
  workspacePath: z.string().trim().max(4096).default(''),
  provider: providerSchema.default('scripted'),
  models: z.partialRecord(providerSchema, z.string().trim().min(1).max(200)).default({}),
  baseUrls: z.partialRecord(secretProviderSchema, z.url()).default({}),
  modelListBaseUrls: z.partialRecord(secretProviderSchema, z.url()).default({}),
  permissionMode: permissionModeSchema.default('ask'),
  runDetail: z.enum(['detailed', 'compact']).default('detailed'),
  showToolTimeline: z.boolean().default(true),
}).strict();

export const modelListSchema = z.object({
  provider: secretProviderSchema,
  baseUrl: z.url().optional(),
  modelListBaseUrl: z.url().optional(),
  apiKey: z.string().trim().min(1).max(16_384).optional(),
}).strict();

export const connectionTestSchema = modelListSchema.extend({
  model: z.string().trim().min(1).max(200),
}).strict();

export const externalOpenSchema = z.object({
  url: z.url().refine((value) => ['http:', 'https:'].includes(new URL(value).protocol)),
}).strict();

export const getRunSchema = z.object({ runId: runIdSchema }).strict();
export const listRunsSchema = z.object({
  limit: z.number().int().min(1).max(50),
  offset: z.number().int().min(0).max(100_000),
}).strict();

export const runCommandSchema = z.discriminatedUnion('type', [
  z.object({ commandId: commandIdSchema, type: z.literal('pause') }).strict(),
  z.object({ commandId: commandIdSchema, type: z.literal('resume') }).strict(),
  z.object({ commandId: commandIdSchema, type: z.literal('cancel'), reason: z.string().max(2000).optional() }).strict(),
  z.object({ commandId: commandIdSchema, type: z.literal('approve'), approvalId: approvalIdSchema }).strict(),
  z.object({ commandId: commandIdSchema, type: z.literal('reject'), approvalId: approvalIdSchema, reason: z.string().max(2000).optional() }).strict(),
  z.object({ commandId: commandIdSchema, type: z.literal('answer'), requestId: z.string().min(1).max(200), answer: z.string().max(20_000) }).strict(),
]);

export const commandSchema = z.object({ runId: runIdSchema, command: runCommandSchema }).strict();
export const subscribeSchema = z.object({
  subscriptionId: z.string().min(1).max(200),
  runId: runIdSchema,
  afterSeq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict();
export const unsubscribeSchema = z.object({
  subscriptionId: z.string().min(1).max(200),
}).strict();
export const secretSaveSchema = z.object({
  provider: secretProviderSchema,
  apiKey: z.string().trim().min(1).max(16_384),
}).strict();
export const secretDeleteSchema = z.object({ provider: secretProviderSchema }).strict();
