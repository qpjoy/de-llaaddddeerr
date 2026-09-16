import { z } from 'zod'

const reference = z.string().min(1).max(200)
const jsonSchema = z.record(z.string(), z.unknown())
export const integrationSlotManifest = z.object({
  contractVersion: z.literal('mx-hub.integration-slot.v1'),
  slotId: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
  displayName: reference,
  ownership: z.enum(['external_service', 'self_hosted', 'contributed_package']),
  adapter: z.object({
    kind: z.enum(['http_service', 'process_job', 'database_pull', 'file_import', 'event_push']),
    version: reference,
    implementationRef: reference,
    deploymentRef: reference.nullable(),
    activation: z.enum(['implemented_optional', 'candidate']),
  }).strict(),
  capabilities: z.array(z.object({
    key: reference,
    mode: z.enum(['sync', 'async', 'pull', 'push']),
    inputSchema: jsonSchema,
    resultSchema: jsonSchema,
    idempotency: z.enum(['hub_journal', 'provider_verified', 'none']),
    observation: z.array(z.enum(['status', 'logs', 'steps', 'artifacts', 'records'])),
  }).strict()).min(1),
  dataContract: z.object({
    nativePayload: z.literal('preserved'),
    mappingRef: reference.nullable(),
    mappingStatus: z.enum(['existing_contract_recheck_binding', 'pending']),
    identity: reference,
    watermark: reference.nullable(),
    deletion: reference,
    ingestion: z.enum(['separate_plan', 'not_connected']),
  }).strict(),
  limits: z.object({ maxConcurrent: z.number().int().positive(), timeoutSeconds: z.number().positive(),
    maxResponseBytes: z.number().int().positive(), autoRetryAmbiguous: z.literal(false) }).strict(),
  evidence: z.array(z.object({ kind: z.enum(['source_review', 'offline_adapter', 'live', 'mapping', 'capacity']),
    status: z.enum(['reviewed', 'reported', 'pending']), ref: reference }).strict()).min(1),
}).strict().superRefine((manifest, context) => {
  if (new Set(manifest.capabilities.map(cap => cap.key)).size !== manifest.capabilities.length) context.addIssue({ code: 'custom', message: 'Capability keys must be unique' })
  if (manifest.adapter.activation === 'candidate' && manifest.adapter.deploymentRef !== null) context.addIssue({ code: 'custom', message: 'A candidate cannot claim a deployed binding' })
  if (manifest.dataContract.mappingStatus === 'pending' && manifest.dataContract.ingestion !== 'not_connected') context.addIssue({ code: 'custom', message: 'Unreviewed mapping cannot claim ingestion' })
})
