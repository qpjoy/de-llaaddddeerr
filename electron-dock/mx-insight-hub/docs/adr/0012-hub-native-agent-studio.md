# ADR-0012: Hub-native Agent Studio owns authoring, runtime evidence, evaluation and release

Status: **Accepted**

Date: 2026-09-01

Scope: MX Insight Hub Internal Agent Studio, Agent Runtime, evaluation and release

Supersedes the active adoption roadmap in
[`agent-studio-platform-boundaries-and-build-vs-buy.md`](../architecture/agent-studio-platform-boundaries-and-build-vs-buy.md)

## Context

Agent Studio is not only a visual DAG editor. It is the product control plane that turns Hub-governed
sources, datasets, schemas, mappings, retrieval, models and policies into reviewable Data Agents. A useful
product must keep authoring, execution evidence, evaluation, release and operation connected to the same
`agentKey`, immutable Artifact and Hub data contracts.

LangSmith, Promptfoo and Langfuse demonstrate useful concepts: typed graph debugging, trace exploration,
versioned prompts, datasets, experiments, evaluators and release evidence. Introducing their management
planes would also create a second Agent identity, Prompt truth, Run model, evaluation database and operator
journey. The team has chosen to learn from those concepts without adding those platforms.

The current implementation truth remains P1/P1.5:

- Agent Project, CAS Draft, Prompt editing, typed DAG and code-owned node registry are available;
- the Hub compiler creates an immutable, non-runnable Artifact;
- static assurance covers the Draft contract, node registry/config, typed ports, DAG topology, budgets and
  read-only effect policy;
- Sandbox, Run/Event Ledger, Eval, Release and Deployment are not implemented and remain unavailable;
- the existing fixed `advanced-search-dry-run` adapter is not a generic runtime.

## Decision

1. **MX Insight Hub owns the whole Agent product lifecycle.** Hub PostgreSQL remains authoritative for
   Project, Draft, Artifact, Prompt, Run/Event Ledger, Eval Suite, Dataset snapshot, gate decision, Release,
   Deployment and Market binding.
2. **No Promptfoo, Langfuse or LangSmith management/runtime dependency is introduced.** Their capabilities
   are design references only. No Hub page deep-links to them, no adapter is placed on the request path, and
   no external platform state is required to explain or release an Agent.
3. **mx-test-framework stays a sibling black-box quality product.** It may later invoke an approved Hub
   Deployment as an external system test, but it does not own internal Agent cases, traces, gates or releases.
4. **LangGraph is a Hub-owned runtime library candidate, not a control plane.** When delivered, it runs in a
   dedicated Hub worker behind the Artifact contract, checkpointer and Run/Event Ledger. React Flow remains
   the editor. Long-running deterministic ETL remains in governed workers; the DAG coordinates references
   and decisions instead of moving bulk rows through an LLM loop.
5. **JustOne direct ingestion is deferred.** This ADR adds no JustOne adapter, credential, node or route.
   Existing source-catalog labels and Night-All compatibility contracts are unchanged; “deferred” does not
   silently disable an existing upstream compatibility path.

## Hub-native product chain

```text
Idea / Template
  -> CAS Draft (DAG + Prompt + policies)
  -> Static Compile + Hub Assurance
  -> Immutable Artifact + dependency snapshot
  -> Sandbox Run + ordered Event Ledger
  -> Eval Suite + immutable Dataset snapshot
  -> Gate decision + human review
  -> Release + Deployment pointer
  -> Agent Market discovery + governed invocation
  -> Operate / replay / compare / rollback
```

Each stage owns a different immutable or append-only object. A later stage may reference an earlier object,
but must not mutate it. In particular:

- Draft is editable; Artifact is immutable.
- Trace events describe an actual Run; compile diagnostics are not fake Run events.
- Eval results bind exact `artifactHash + suiteVersion + datasetSnapshotHash`.
- Gate is a Hub policy conclusion, not a UI color or an evaluator exit code.
- Market visibility binds an approved active Deployment; a catalog entry grants no execution permission.

## Native capability model

### Build and static assurance

The compiler emits deterministic `mx-insight.agent-static-assurance.v1` evidence with six checks:

1. Draft contract;
2. code-owned registry and node config;
3. typed ports and edge contracts;
4. DAG reachability and terminal paths;
5. static budget envelope;
6. read-only effect policy.

This evidence is included in the immutable normalized plan and therefore in `artifactHash`. It explicitly
states that runtime events, evaluation results, release decisions and runnable execution are unavailable.
The UI must never translate static success into “Agent healthy”, “Eval passed” or “published”.

### Runtime and trace

The future Hub runtime uses the compiled Artifact only. It appends ordered, idempotent events before exposing
status to the UI. The minimum native vocabulary includes run lifecycle, node attempt, model/tool request,
checkpoint, approval wait/resume and terminal outcome. Node/edge highlighting is derived only from committed
events; an empty ledger keeps all edges neutral.

The Ledger is the business truth. Trace search, flame/waterfall views, token/cost aggregates and comparison
views are Hub projections that can be rebuilt from the Ledger and its telemetry outbox.

### Evaluation and testing

Hub owns:

- versioned Eval Suites and cases;
- immutable fixture/dataset/evidence-set snapshots;
- deterministic schema, policy, citation, trajectory and regression evaluators;
- optional model-judge evaluators with pinned Sequence revision and rubric;
- `failed` versus `blocked/infrastructure` semantics;
- repeated, pairwise and baseline comparison;
- the immutable gate-policy snapshot and final gate decision.

Evaluation is executed by a Hub-owned `EvaluationRunner` worker with bounded concurrency, deadline, budget,
network allowlist and a short-lived eval-scoped identity. It receives no Hub Admin Token, Launcher session or
provider credential. LLM calls continue through a pinned Hub LLM Sequence; Provider and Proxy remain
control-plane execution settings, not business DAG nodes.

### Data Agent, Text2SQL and Agentic AI

Data capabilities are installed, versioned Hub nodes/tools, not arbitrary SQL or network configuration in a
Draft. A Data Agent works with references such as `sourceRef`, `schemaRef`, `datasetVersionRef`,
`mappingProposalRef` and `queryPlanRef`.

Text2SQL follows a governed subgraph:

```text
business question
  -> authorized semantic/catalog context
  -> query-plan proposal
  -> deterministic SQL validation and policy rewrite
  -> read-only bounded execution
  -> result contract + lineage + evidence
  -> explanation / BI output
```

The model never receives a database credential or executes free-form SQL directly. Dataset/column/tenant
authorization, statement class, row limit, timeout and cost policy are deterministic gates. Agentic AI can
branch, retry and request approval, but bulk ingestion, cleaning and publication remain deterministic jobs
referenced by the graph.

## Information architecture

The P1.5 UI exposes only real objects:

- Portfolio tabs: Agent Projects, Templates, Artifacts and Archived;
- filters use real tags, owner, project kind and compile status, not inferred business/source/dataset fields;
- Draft detail exposes Build, Prompt, model route, compile diagnostics, static assurance and actual governed
  references;
- Run Trace, Eval Dataset, Gate and Release are visible as locked future stages, not empty active work queues;
- source/dataset/schema/Sequence counts are derived from Draft config or Artifact dependency manifest;
- every template CTA carries the exact selected `templateKey`.

## Security and availability invariants

- All Studio APIs remain under `/internal/v1/admin/agent-studio/*`; the public listener returns `404`.
- Platform Admin may read; only Hub Admin Token may mutate/compile until a finer Hub-local role is delivered.
- No Studio worker receives the MX-H2I renderer session, Launcher token, WireGuard key, DNS ownership or
  network lease.
- Agent runtime/evaluation degradation never changes Hub or MX-H2I login/network readiness.
- Run and eval queues use separate quotas from ingestion, API and login traffic.
- Provider/Proxy secrets and endpoints never enter Draft, Artifact, evidence, events or datasets.

## Delivery sequence

1. **P1.5 — static evidence:** truthful Portfolio, exact template selection, actual governed references,
   immutable Artifact provenance and Hub static assurance.
2. **P2 — sandbox kernel:** pinned Artifact execution, LangGraph worker candidate, checkpointer, ordered Event
   Ledger, node/edge state and replay.
3. **P3 — data/eval contracts:** immutable dataset snapshots, native deterministic evaluators, comparison and
   evidence retention.
4. **P4 — governance:** gate snapshots, approval, Release, Deployment, canary/rollback and Market binding.
5. **P5 — Data Agent expansion:** governed Text2SQL, BI/report nodes, long-running job references and online
   monitoring, all behind the same Artifact and capability contracts.

## Consequences

Positive:

- one product identity, Prompt truth, Run truth and release journey;
- no second platform to operate, secure, reconcile or teach;
- Data Agent semantics stay aligned with Hub source/schema/dataset/lineage permissions;
- concepts can evolve without coupling domain objects to a vendor schema.

Costs:

- Hub must build and operate trace exploration, evaluation datasets, experiment comparison and gate UX;
- native workers, retention, projections and query performance require explicit capacity planning;
- delivery must remain phased so visual completeness never outruns runtime truth.

## Acceptance gates

- Compiler assurance is deterministic and part of the Artifact hash.
- Existing artifacts without the assurance contract are shown as legacy/unknown, never retroactively passed.
- No `promptfoo`, `langfuse`, `langsmith` or `jenkins` runtime/package/deploy dependency is added to Hub.
- `/runs`, `/evals`, `/releases` and `/deployments` remain unavailable until their own schemas, ledgers and
  authorization tests exist.
- MX-H2I login/network, Hub SessionGate/identity and Launcher/HDO/WireGuard protected paths have no diff.
- No JustOne direct connector, credential, node or request is added by Agent Studio work.
