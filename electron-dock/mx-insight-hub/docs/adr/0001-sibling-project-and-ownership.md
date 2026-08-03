# ADR-0001: sibling project and ownership

Status: accepted.

MX Insight Hub lives at `electron-dock/mx-insight-hub`, beside `mx-launcher`.

Embedding it in Launcher would mix customer billing/data contracts with platform deployment and a lightweight JSONB registry. Embedding it in Night-All would couple stable customer semantics to provider/crawler churn and upstream author updates. A sibling gives independent data, release and rollback boundaries while allowing Launcher to delegate lifecycle commands.

