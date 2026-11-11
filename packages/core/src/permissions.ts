import { z } from 'zod';
import type { ModelToolCall } from './types.js';

export const permissionAssessmentKey = '__joymind_permission';

export const permissionAssessmentSchema = z.object({
  decision: z.enum(['execute', 'ask']),
  reason: z.string().trim().min(1).max(2000).optional(),
}).strict();

export type PermissionAssessment = z.infer<typeof permissionAssessmentSchema>;

export function extractPermissionAssessment(call: ModelToolCall): {
  call: ModelToolCall;
  assessment?: PermissionAssessment;
} {
  if (typeof call.arguments !== 'object' || call.arguments === null || Array.isArray(call.arguments)) return { call };
  const argumentsRecord = { ...call.arguments as Record<string, unknown> };
  if (!(permissionAssessmentKey in argumentsRecord)) return { call };
  const assessment = permissionAssessmentSchema.safeParse(argumentsRecord[permissionAssessmentKey]);
  delete argumentsRecord[permissionAssessmentKey];
  return {
    call: { ...call, arguments: argumentsRecord },
    ...(assessment.success ? { assessment: assessment.data } : {}),
  };
}
