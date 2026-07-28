import { loadConfig } from '../src/config.js';
import { ConfigCenterController } from '../src/modules/config-center/config-center.controller.js';
import { MemoryStore } from '../src/store/memory.js';

const config = loadConfig();
const store = new MemoryStore(config);
const controller = new ConfigCenterController(store, config);

const builtinProviders = await store.listSecretProviderConfigs();
const builtinReferences = await store.listConfigSecretReferences();
assert(builtinProviders.some((provider) => provider.providerId === 'secretprov_kubernetes_runtime'), 'missing builtin Kubernetes provider');
assert(builtinReferences.some((reference) => reference.secretRefId === 'secretref_release_oss'), 'missing builtin release OSS reference');
assert(
  builtinReferences.some((reference) => reference.secretRefId === 'secretref_sdk_service_account_credentials'),
  'missing builtin SDK service-account credential reference'
);

await controller.upsertSecretProvider({
  providerId: 'secretprov_alibaba_kms',
  name: 'Alibaba KMS Secrets Manager',
  kind: 'alibaba-kms',
  region: 'cn-hangzhou',
  authMode: 'ecs-ram-role'
});
const saved = await controller.upsertSecretReference({
  secretRefId: 'secretref_release_oss',
  name: 'Release Center OSS',
  providerId: 'secretprov_alibaba_kms',
  remoteRef: 'mx-launcher/prod/release/oss',
  consumerIds: ['release-center'],
  exposure: 'signed-url',
  versionStage: 'ACSCurrent',
  rotationMode: 'provider-managed',
  targetNamespace: 'mx-internal-shadow',
  targetSecretName: 'mx-release-oss'
});
assert(saved.reference.containsSecretMaterial === false, 'secret reference must never contain material');
assert(saved.reference.providerId === 'secretprov_alibaba_kms', 'secret reference provider was not updated');

let rejectedSecretMaterial = false;
try {
  await controller.upsertSecretProvider({
    providerId: 'invalid',
    kind: 'alibaba-kms',
    accessKeySecret: 'must-not-be-stored'
  });
} catch (error) {
  rejectedSecretMaterial = error instanceof Error && error.message.includes('stores secret references only');
}
assert(rejectedSecretMaterial, 'Config Center accepted raw secret material');

console.log(JSON.stringify({
  ok: true,
  providers: (await store.listSecretProviderConfigs()).map((provider) => provider.providerId),
  reference: saved.reference,
  rejectedSecretMaterial
}, null, 2));

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
