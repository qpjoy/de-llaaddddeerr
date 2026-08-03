# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

## MX Insight Hub product context

- Treat `/Users/qpjoy/workspace/qpjoy/de/de-llaaddddeerr/electron-dock/mx-launcher/demos/ui-design-neon-void` and `mx-launcher/ui-design` as the visual source of truth.
- Use the supplied Sub2API dashboard screenshot only as the information-architecture reference for accounts, API keys, plans, quotas, usage, channels, and operational metrics. Do not copy its branding.
- The primary workflow is: create a consumer, issue a one-time API key, grant explicit platform capabilities and limits, call Night-All through the Hub, and inspect usage/latency/error evidence.
- Night-All remains an internal data source. Never expose its provider credentials, provider names, endpoint IDs, `businessId`, or `availabilityMode` to public clients.
- MX Launcher owns deployment and human-operator access. MX Insight Hub owns tenants, consumers, API keys, grants, plans, credits, usage, request idempotency, and billing evidence.
