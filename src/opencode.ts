// Schemas of the opencode data we consume (server events and `run --format json` lines).
// Loose objects: unknown fields are kept (they are written as-is to the run logs).
import { z } from 'zod';

export const ToolState = z.looseObject({
  status: z.string(),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  error: z.unknown().optional(),
  title: z.string().optional(),
});

export const Part = z.looseObject({
  type: z.string(),
  id: z.string().optional(),
  messageID: z.string().optional(),
  sessionID: z.string().optional(),
  text: z.string().optional(),
  synthetic: z.boolean().optional(),
  time: z.looseObject({ start: z.number().optional(), end: z.number().optional() }).optional(),
  tool: z.string().optional(),
  callID: z.string().optional(),
  state: ToolState.optional(),
  cost: z.number().optional(),
  tokens: z
    .looseObject({ total: z.number().optional(), input: z.number().optional(), output: z.number().optional() })
    .optional(),
});
export type Part = z.output<typeof Part>;

export const ErrorInfo = z.looseObject({
  name: z.string().optional(),
  message: z.string().optional(),
  data: z.looseObject({ message: z.string().optional() }).optional(),
});
export type ErrorInfo = z.output<typeof ErrorInfo>;

export const errorText = (e: ErrorInfo): string => `${e.name ?? 'Error'}: ${e.data?.message ?? e.message ?? ''}`;

/** Server-sent events (`GET /event`) we react to. Others are ignored. */
export const ServerEvent = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('session.status'),
    properties: z.object({ sessionID: z.string(), status: z.looseObject({ type: z.string() }) }),
  }),
  z.object({ type: z.literal('session.idle'), properties: z.object({ sessionID: z.string() }) }),
  z.object({
    type: z.literal('message.updated'),
    properties: z.object({ info: z.looseObject({ id: z.string(), role: z.string(), sessionID: z.string() }) }),
  }),
  z.object({ type: z.literal('message.part.updated'), properties: z.object({ part: Part }) }),
  z.object({
    type: z.literal('session.error'),
    properties: z.object({ sessionID: z.string().optional(), error: ErrorInfo.optional() }),
  }),
  z.object({
    type: z.enum(['permission.asked', 'permission.v2.asked']),
    properties: z.looseObject({ id: z.string(), sessionID: z.string() }),
  }),
]);
export type ServerEvent = z.output<typeof ServerEvent>;

/** One line of a run log (`runs/<id>.jsonl`), same shape as `opencode run --format json`. */
export const LogLine = z.discriminatedUnion('type', [
  z.object({ type: z.enum(['text', 'reasoning', 'tool_use', 'step_finish', 'step_start']), sessionID: z.string().optional(), part: Part }),
  z.object({ type: z.literal('error'), sessionID: z.string().optional(), error: ErrorInfo }),
]);
export type LogLine = z.output<typeof LogLine>;

export const SessionCreated = z.looseObject({ id: z.string() });
export const Health = z.looseObject({ healthy: z.boolean() });
