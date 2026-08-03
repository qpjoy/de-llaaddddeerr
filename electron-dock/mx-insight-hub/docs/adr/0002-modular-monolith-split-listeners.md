# ADR-0002: modular monolith with split listeners

Status: accepted.

The first production shape is one codebase/image with cohesive modules and one PostgreSQL, not premature microservices. Kubernetes runs the image in separate `public` and `admin` listener modes, so the public Service cannot expose management routes.

Workers, semantic BI and Agent execution become separate processes only when workload isolation or scaling evidence requires it. Their contracts stay inside this repository.

