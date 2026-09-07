# ADR-0014: Hub-owned static media data plane on shared object-storage infrastructure

- Status: Accepted target architecture; persistence implementation pending
- Date: 2026-09-07
- Scope: MX Insight Hub public media ingestion, durable storage, delivery and migration

## Context

MX Insight Hub now has provider-backed data products whose normalized records can contain images. The current
ecommerce and Xiaohongshu paths can return normalized metadata immediately and relay a committed response's
bounded media through the Hub. That relay uses an in-process cache and duplicate-request coalescing; it is not a
durable asset store and does not survive a process restart or provide a shared cache across replicas.

The expected commercial volume is at least 1,000,000 API requests per 30-day month. That is only about
`0.386 requests/second` when evenly distributed; one customer at 70,000 requests/month averages about
`0.027 requests/second`. A design target of 1,000 sustained requests/second is a peak-throughput and burst
requirement, not a consequence of the monthly total: sustained for a month it would be 2,592,000,000 requests,
or 2,592 times the stated monthly volume. Capacity tests and autoscaling therefore use separate average,
concurrency, burst and sustained-peak assumptions.

The system must accept media supplied as a bounded base64 payload or an HTTPS URL, default to local storage for
development, support an S3-compatible or OSS backend without changing the public contract, isolate secrets, and
allow a future move from a block-volume deployment to NAS or object storage without breaking asset identifiers.
It must not add a dependency to MX Launcher login, SessionGate, MX-H2I networking, WireGuard or DNS.

## Decision

### 1. Hub owns the asset product; shared projects own only infrastructure

- **MX Insight Hub** owns the public asset API, tenant and API-key authorization, quotas, metadata, lineage,
  retention, transforms and delivery policy.
- **mx-base** may deploy generic MinIO/S3-compatible storage, NGINX or an ingress, PVCs, certificates, metrics
  and backup jobs. It does not own Hub tenant rules, public asset identifiers or provider normalization.
- **mx-common** remains the shared PostgreSQL/Redis infrastructure plane. Hub uses a dedicated database/schema,
  role and cache namespace; mx-common does not expose a media business API.
- **MX Launcher** remains the identity, application and control plane. It must not proxy blob bytes, hold object
  storage credentials or become a media-service availability dependency. External users may later authenticate
  through a separate Launcher client/audience, but Hub-local tenant, project, role and API-key authorization
  remain independent from MX-H2I memberships.

The Kubernetes workloads are separately deployable Hub API, ingestion worker, object service and read-delivery
components. A media incident can be scaled, disabled or rolled back without restarting Launcher or changing
MX-H2I login/network configuration.

### 2. Publish opaque assets, never physical paths

The future API accepts one of two explicitly bounded inputs:

- a base64 body with declared media type and strict decoded-size limit; or
- a public HTTPS URL fetched asynchronously through the existing SSRF defenses, with pinned DNS and
  redirect-by-redirect validation.

URL ingestion returns an operation/job identifier and does not hold an HTTP worker while a remote origin is
slow. The worker verifies size, media signature and allowlisted type, strips unsafe metadata, optionally
re-encodes to a canonical variant, computes SHA-256, and writes an immutable object. The caller receives an
opaque `assetId`; neither public nor tenant APIs expose a host path, PVC path, bucket credential or raw provider
URL.

Content-addressing permits byte-level deduplication, while tenant ACLs and references remain separate. Two
tenants can reference the same immutable bytes without gaining access to each other's record, provenance or
usage. Transform variants have their own digest and parent relationship. Deletion first removes a reference;
garbage collection only tombstones and removes bytes after retention, legal-hold and reference-count checks.

### 3. Use a storage port with filesystem and S3-compatible adapters

Hub code depends on a narrow storage port: put-if-absent, stat, ranged read, delete/tombstone and health. Initial
adapters are:

- filesystem for local development and deliberately small single-node installations;
- S3-compatible storage, with MinIO as the default production deployment supplied by mx-base;
- cloud OSS as an interchangeable production adapter after provider-specific conformance tests.

The default developer setting may write to disk. Production must not write durable bytes to a Pod root
filesystem. MinIO data uses dedicated persistent volumes and a reviewed storage class; a multi-replica reader
must not assume a `ReadWriteOnce` filesystem is shared. Object keys are derived from digest and media class, not
database IDs or tenant-controlled filenames.

Storage credentials are encrypted at rest, scoped to the minimum bucket/prefix and never returned by ordinary
Admin responses. The Admin Token may authorize an audited, short-lived reveal flow consistent with other Hub
external credentials; browser fields are never prefilled and clear on close.

### 4. Separate the write path from the read path

The write path is:

```text
public/admin ingest request
  -> auth + capability + quota + idempotency
  -> bounded staging record/job
  -> fetch/decode + validate + canonicalize + hash
  -> immutable object write
  -> PostgreSQL metadata + reference + transactional outbox commit
```

The read path resolves `assetId` and tenant authorization from PostgreSQL/cache, then serves immutable bytes
from object storage through a dedicated delivery service or private bucket-backed ingress. It supports `ETag`,
conditional requests, byte ranges and safe immutable cache headers. CDN use is optional and cannot bypass Hub
authorization for private assets. PostgreSQL stores authoritative metadata and lifecycle state; Redis stores
only rebuildable hot metadata, locks and rate-limit counters.

Provider-backed requests continue to return normalized content as soon as the synchronous public contract is
committed. A transactional outbox schedules durable media capture independently. Until capture succeeds, the
existing authenticated relay may deliver bounded bytes; a failed capture does not rewrite the original
provider response. Once a durable asset is ready, subsequent Hub queries use its stable `assetId` and stored
variant instead of repeatedly reaching the provider.

Minimum metadata includes asset/version identifiers, digest, byte length, detected type, backend and opaque
object key, lifecycle state, tenant reference, source/request lineage, transform parent, timestamps and
retention policy. Jobs, outbox events, reference changes and tombstones are append-only evidence around the
current state.

### 5. Migrate storage without changing public identity

A filesystem/PVC-to-NAS, MinIO-to-NAS or MinIO-to-cloud migration uses the same sequence:

1. register the destination backend and verify write/read/hash conformance;
2. enable dual-write for new immutable objects while the old backend remains authoritative;
3. backfill existing objects by digest and record per-object verification evidence;
4. enable dual-read with destination first and bounded fallback to the old backend;
5. audit counts, bytes, hashes, ranges and sampled transforms;
6. cut the authoritative backend after an observation window;
7. retain the old backend through the rollback window, then retire it explicitly.

Database rows never contain a mount-dependent public URL. Backend and object-key mapping can change behind an
unchanged `assetId`. A failed destination write is visible in job/outbox state and cannot silently report a
durable asset. Backfill, garbage collection and transforms use separate worker pools so they cannot exhaust
interactive reads or provider acquisition.

### 6. Capacity is proven, not inferred

API, ingestion workers, media readers and object storage scale independently. Per-tenant quotas, bounded
payloads, global/per-tenant concurrency, duplicate coalescing and backpressure protect the system; limits are
observable and configurable rather than a single artificially low browser queue.

Before claiming 1,000 requests/second, a production-like test must prove the required request mix, object sizes,
cache-hit ratio, range requests, ingress bandwidth, PostgreSQL/Redis latency, object-store tail latency and
failure recovery. Monthly request volume alone does not justify that claim. Autoscaling uses queue depth,
in-flight work and latency/error SLOs in addition to CPU.

## Compatibility and rollout

This ADR defines the target persistent file service; it does not claim that filesystem, MinIO, OSS, PVC/NAS
migration, base64 upload or the public asset API is implemented today. The current delivered media component is
the bounded authenticated in-memory relay used by committed external-data responses.

Rollout is additive:

1. land schemas and a disabled storage adapter;
2. shadow-write and verify objects without changing responses;
3. expose Admin-only status and migration controls;
4. enable durable reads for one Hub data product;
5. run concurrency, restart, multi-Pod, backup/restore and failover gates;
6. publish the versioned external asset API and capability only after those gates pass.

No rollout step changes Launcher token validation, MX-H2I roles, WireGuard, DNS or user connectivity. A separate
deployment and kill switch must leave login and already-stored non-media Hub data available when media storage
is degraded.

## Consequences

Positive:

- public identities remain stable across disk, PVC, NAS, MinIO and cloud OSS;
- hot media reads no longer force repeated paid/provider-origin requests;
- write-heavy capture, read-heavy delivery and identity/control traffic have separate failure domains;
- tenant authorization, usage and provenance stay in the Hub rather than leaking into generic infrastructure.

Costs:

- object storage, PostgreSQL metadata, outbox workers, lifecycle cleanup and migration verification add
  operational components;
- private delivery requires an authorization/cache design instead of exposing bucket URLs;
- 1,000-request/second readiness requires measured load tests and capacity planning, not configuration alone.

