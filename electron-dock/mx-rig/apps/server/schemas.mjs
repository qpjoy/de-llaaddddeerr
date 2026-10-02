import { z } from 'zod'
import { RigError, TOOL_NAMES } from '../../packages/contracts/index.mjs'
import { AGENT_CATEGORIES } from './agent-presets.mjs'

/**
 * Request shapes for the Rig API.
 *
 * Every object is strict: an unexpected field is a rejected request, not a
 * silently ignored one. The domain rules still live in Settings and the
 * runtime — this layer only guarantees that what reaches them has the shape
 * they were written against.
 */
const identifier = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, '标识只能使用小写字母、数字、- 和 _')

export const loginBody = z
  .object({
    account: z.string().min(1).max(120),
    password: z.string().min(1).max(200),
    // The desktop keeps the service address client-side; accepted and ignored
    // here so one shared client can post the same body to either surface.
    url: z.string().max(2000).optional()
  })
  .strict()

export const missionStartBody = z
  .object({
    goal: z.string().min(1).max(8000),
    mode: z.enum(['agent', 'workflow', 'orchestration']),
    taskId: z.string().max(200).optional(),
    agentKey: identifier.optional(),
    orchestrationKey: identifier.optional(),
    // A drafted flight plan, run once without being saved. Its shape is
    // checked by the orchestration schema in the runtime; here it is only
    // bounded in size.
    spec: z.looseObject({ key: identifier, nodes: z.array(z.unknown()).min(1).max(24) }).optional(),
    // A member's own grant for this mission only; honoured only when the
    // admin allowed it, and never beyond the allowed test origins.
    grants: z.object({ browserWrites: z.boolean() }).strict().optional(),
    inputs: z.record(z.string().max(40), z.string().max(400)).optional()
  })
  .strict()
  .refine((body) => body.mode !== 'workflow' || Boolean(body.taskId), {
    message: '测试工作流必须选择一个测试计划',
    path: ['taskId']
  })
  .refine((body) => body.mode !== 'orchestration' || Boolean(body.orchestrationKey || body.spec), {
    message: '运行编排必须选择一条编排，或提供一份飞行计划',
    path: ['orchestrationKey']
  })

export const missionFollowupBody = z.object({ goal: z.string().min(1).max(8000) }).strict()

export const missionApproveBody = z.object({ approvalId: z.uuid(), approved: z.boolean() }).strict()

export const missionCancelBody = z.object({}).strict()

// A desktop mission as its Runtime last saved it. Loose on purpose: the record
// grows with the Runtime, and the server stores it for reading, never executes
// it. What matters is bounded here — identity, status and size — and the
// owner is always the caller, whatever the record says.
const syncedMission = z.looseObject({
  id: z.uuid(),
  goal: z.string().max(8000),
  mode: z.enum(['agent', 'workflow', 'orchestration']),
  status: z.enum([
    'queued',
    'running',
    'awaiting_approval',
    'completed',
    'failed',
    'blocked',
    'cancelled'
  ]),
  createdAt: z.iso.datetime(),
  events: z.array(z.unknown()).max(200)
})

export const missionSyncBody = z
  .object({ missions: z.array(syncedMission).min(1).max(20) })
  .strict()

/** The largest single desktop record the service stores; the desktop trims to fit. */
export const SYNCED_MISSION_BYTES = 512 * 1024

const toolCall = z
  .object({
    id: z.string().min(1).max(200),
    type: z.literal('function'),
    function: z.object({ name: z.string().max(64), arguments: z.string().max(8000) }).strict()
  })
  .strict()

// A screenshot for a vision-capable model: one JPEG or PNG, inline, bounded.
const contentPart = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().max(24_000) }).strict(),
  z
    .object({
      type: z.literal('image_url'),
      image_url: z
        .object({
          url: z
            .string()
            .max(1_400_000)
            .regex(/^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/)
        })
        .strict()
    })
    .strict()
])

const chatMessage = z.discriminatedUnion('role', [
  z
    .object({
      role: z.literal('user'),
      content: z.union([z.string().max(24_000), z.array(contentPart).min(1).max(2)])
    })
    .strict(),
  z
    .object({
      role: z.literal('assistant'),
      content: z.string().max(24_000).nullable().optional(),
      tool_calls: z.array(toolCall).max(1).optional()
    })
    .strict(),
  z
    .object({
      role: z.literal('tool'),
      tool_call_id: z.string().max(200),
      content: z.string().max(24_000)
    })
    .strict()
])

export const modelTurnBody = z
  .object({
    agentKey: identifier.optional(),
    messages: z
      .array(chatMessage)
      .max(90)
      // The Runtime keeps only the latest screenshot; more is a client bug.
      .refine(
        (messages) =>
          messages.filter(
            (message) =>
              Array.isArray(message.content) &&
              message.content.some((part) => part.type === 'image_url')
          ).length <= 1,
        { message: '一次模型调用最多附带一张截图' }
      ),
    // Only the name is read; the schema itself always comes from our registry.
    tools: z
      .array(
        z
          .object({
            type: z.literal('function'),
            function: z.looseObject({ name: z.string().max(64) })
          })
          .loose()
      )
      .max(40)
  })
  .strict()

const providerBody = z
  .object({
    id: identifier,
    displayName: z.string().min(1).max(60),
    baseUrl: z.string().max(2000),
    model: z.string().max(200),
    apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]{0,100}$/),
    timeoutMs: z.number().int().min(5_000).max(120_000),
    enabled: z.boolean(),
    stream: z.boolean().optional(),
    vision: z.boolean().optional()
  })
  .strict()

const egressProfileBody = z
  .object({
    id: identifier,
    displayName: z.string().min(1).max(60),
    proxyUrl: z.string().min(1).max(300),
    bypass: z.array(z.string().max(200)).max(30).optional(),
    // A variable name, never a secret — same rule as a Provider's apiKeyEnv.
    authEnv: z.string().max(101).optional(),
    appliesTo: z
      .array(z.enum(['model', 'browser']))
      .min(1)
      .max(2)
      .optional(),
    note: z.string().max(240).optional()
  })
  .strict()

export const egressBody = z
  .object({
    activeId: identifier.nullable().optional(),
    profiles: z.array(egressProfileBody).max(6)
  })
  .strict()

const agentBody = z
  .object({
    key: identifier,
    displayName: z.string().min(1).max(60),
    summary: z.string().min(1).max(240),
    category: z.enum(Object.keys(AGENT_CATEGORIES)),
    surface: z.enum(['any', 'desktop', 'terminal']),
    tools: z.array(z.enum(TOOL_NAMES)).max(TOOL_NAMES.length),
    persona: z.string().min(1).max(4000),
    starter: z.string().max(400).optional(),
    enabled: z.boolean(),
    // Accepted so a round-trip of the admin view validates; the value is
    // recomputed from the built-in registry and never trusted.
    builtin: z.boolean().optional()
  })
  .strict()

// The orchestration shape itself is owned by packages/graph/orchestration.mjs,
// which also runs the structural checks a schema cannot express. Here it is
// only loosely bounded so an oversized body is rejected before parsing.
const orchestrationBody = z.looseObject({
  key: identifier,
  nodes: z.array(z.unknown()).min(1).max(24)
})

export const orchestrationPreviewBody = z.object({ orchestration: orchestrationBody }).strict()

export const adminConfigBody = z
  .object({
    maxTurns: z.number().int().min(1).max(30),
    allowedTools: z.array(z.enum(TOOL_NAMES)).max(TOOL_NAMES.length),
    browserOrigins: z.array(z.string().max(2000)).max(30),
    browserSites: z.enum(['ask', 'list']).optional(),
    productionHosts: z.array(z.string().max(253)).max(30).optional(),
    browserPreauth: z.boolean().optional(),
    tokenBudget: z.number().int().min(0).max(50_000_000).optional(),
    providers: z.array(providerBody).min(1).max(8),
    sequence: z.array(identifier).max(8),
    agents: z.array(agentBody).max(24),
    orchestrations: z.array(orchestrationBody).max(24).optional(),
    egress: egressBody.optional(),
    // Tolerated so the admin view can post back what it read.
    revision: z.string().max(80).optional(),
    model: z.unknown().optional()
  })
  .strict()

export const probeBody = z.object({ providerId: identifier }).strict()

// -- system layer ---------------------------------------------------------------
// The names themselves are checked against the closed lists in `system.mjs`:
// this layer only keeps an oversized or malformed body from reaching them.
export const systemSignalBody = z.object({ signal: z.string().min(1).max(64) }).strict()

export const systemClaimBody = z.object({ questId: z.string().min(1).max(64) }).strict()

export const systemSeenBody = z.object({ version: z.string().min(1).max(20) }).strict()

export const dispatchPlanBody = z
  .object({
    text: z.string().min(1).max(2000),
    // Which workbench is asking. It only decides whether desktop-only Agents
    // are worth proposing; the actual surface requirement is still enforced by
    // the tool executor at execution time.
    surface: z.enum(['web', 'desktop']).optional()
  })
  .strict()

export const flightDraftBody = z
  .object({ text: z.string().min(1).max(2000), surface: z.enum(['web', 'desktop']).optional() })
  .strict()

export const egressActivateBody = z.object({ activeId: identifier.nullable().optional() }).strict()

/** Turn a zod failure into the product's own error shape, without a stack. */
export function parseBody(schema, value, code = 'invalid_input') {
  const result = schema.safeParse(value)
  if (result.success) return result.data
  const issue = result.error.issues[0]
  const where = issue?.path?.length ? `${issue.path.join('.')}: ` : ''
  throw new RigError(code, `请求参数无效（${where}${issue?.message ?? '格式不符'}）`)
}
