# Open Questions for Accounting System Implementation

## Q-001: Technology Stack Clarification
**Agent:** Advanced Coder  
**Date:** 2026-03-14  
**Status:** Open  
**Task:** Phase 1 Implementation - Foundation, Core Accounting, and Technical Components  
**Context:** The design document mentions TypeScript, Node.js, PostgreSQL, Redis, React, but the plan mentions NestJS/Fastify, Prisma/TypeORM. Need specific decisions before starting.
**Question:** What exact technology stack should we use? Specifically:
1. Backend framework: NestJS or Fastify?
2. ORM: Prisma or TypeORM/Knex?
3. Frontend: React with which state management (TanStack Query, Zustand, Redux Toolkit)?
4. UI library: Material UI, Ant Design, or custom?
**Options considered:**
- NestJS provides structure but adds complexity
- Fastify is faster but requires more manual setup
- Prisma has better DX but less SQL control
- TypeORM is mature but has performance concerns
**Blocking:** Yes  
**Assumption:** Will use NestJS + Prisma + React + Material UI unless otherwise specified
**Answer:** We'll proceed with **NestJS** as the backend framework for its out-of-the-box architecture, dependency injection, and module system which will help maintain consistency as the codebase grows. For ORM, we'll use **Prisma** due to its excellent TypeScript support, migration tools, and developer experience - we can always drop down to raw SQL for complex queries when needed. Frontend will use **React with TanStack Query** for server state and **Zustand** for client state management - this combination gives us the best of both worlds without Redux boilerplate. For UI, we'll use **Material UI** as it provides comprehensive components that speed up development while maintaining a professional appearance.
**Answered-by:** Tech Lead

---

## Q-002: Multi-Tenancy Implementation Strategy
**Agent:** Advanced Coder  
**Date:** 2026-03-14  
**Status:** Open  
**Task:** Phase 1 - Identity, Security, and Multi-Tenancy  
**Context:** Design mentions "shared database, shared schema, tenant_id on all tenant-owned tables" with row-level security or repository-level scoping. Need to decide implementation approach.
**Question:** How should we implement multi-tenancy?
1. Row-level security (RLS) at database level vs repository-level scoping?
2. Should we use a global middleware to inject tenant context?
3. How to handle tenant isolation for background jobs?
**Options considered:**
- RLS provides security at DB level but adds complexity
- Repository scoping is simpler but relies on code correctness
- Hybrid approach: RLS for sensitive tables, repository for others
**Blocking:** Yes  
**Assumption:** Will implement repository-level scoping with tenant_id on all tables, plus middleware for request context
**Answer:** We'll implement a **hybrid approach** with repository-level scoping as the primary mechanism, complemented by database-level RLS as a defense-in-depth layer for critical financial tables. We'll create a global middleware that extracts tenant context from the JWT and attaches it to the request, making it available via a context service. For background jobs, we'll require explicit tenant context to be passed when jobs are enqueued and validate it when jobs are processed. All repository methods will automatically filter by tenant_id from context, with an escape hatch for system-level operations. This gives us the simplicity of code-level scoping with the security of database enforcement where it matters most.
**Answered-by:** Tech Lead

---

## Q-003: Authentication and Authorization Approach
**Agent:** Advanced Coder  
**Date:** 2026-03-14  
**Status:** Open  
**Task:** Phase 1 - Identity, Security, and Multi-Tenancy  
**Context:** Need to implement OIDC/OAuth2 for SSO and local authentication with JWT.
**Question:** 
1. Should we implement our own auth or use a service (Auth0, Cognito, Supabase)?
2. What RBAC structure? Basic roles (Admin, Owner, Accountant) or more granular?
3. How to handle permission inheritance and role hierarchies?
**Options considered:**
- Custom auth gives full control but is complex
- Third-party service reduces dev time but adds dependency
- Flat roles vs hierarchical roles
**Blocking:** Yes  
**Assumption:** Will implement custom JWT-based auth with basic RBAC for Phase 1
**Answer:** We'll implement **custom JWT-based authentication** for Phase 1 to maintain full control and avoid external dependencies, while designing the auth system to easily integrate with OIDC/OAuth2 providers in the future. For RBAC, we'll start with a **granular permission-based system** rather than just roles - we'll define specific permissions (e.g., journal.create, report.view) and assign them to roles. This gives us flexibility to create custom role combinations later. Roles will have hierarchical inheritance (e.g., Admin inherits all permissions from Accountant) implemented through a permission aggregation service. We'll use a roles table, permissions table, and role_permissions junction table to keep it flexible.
**Answered-by:** Tech Lead

---

## Q-004: Database Schema Design Details
**Agent:** Advanced Coder  
**Date:** 2026-03-14  
**Status:** Open  
**Task:** Phase 1 - Core Domain and General Ledger  
**Context:** Need to design tables for tenants, companies, accounts, journals, journal_entries, journal_lines.
**Question:** 
1. Should we use UUIDs or sequential IDs for primary keys?
2. How to handle soft deletion vs hard deletion for different entities?
3. What indexes are critical for performance?
4. Should we use ENUM types or lookup tables for account types, journal statuses?
**Options considered:**
- UUIDs better for distributed systems but larger
- Sequential IDs faster for joins but expose business metrics
- ENUMs simpler but less flexible than lookup tables
**Blocking:** Yes  
**Assumption:** Will use UUID v4 for all primary keys, soft deletion for master data, ENUMs for simple types
**Answer:** We'll use **UUID v7** (timestamp-based) for primary keys - they're sortable and more efficient for indexing than UUID v4 while still providing distribution benefits. For deletion: soft delete for all master data (accounts, companies, users) with deleted_at timestamp; hard delete for transient data (sessions, temporary records) and for compliance-related deletions after retention periods. Critical indexes: composite indexes on (tenant_id, created_at) for all tenant tables, (account_id, date) for journal lines, (journal_id, status) for journals, and (company_id, fiscal_year) for periods. We'll use **lookup tables** for account types, journal statuses, and other taxonomies - this allows for easier updates and additional metadata per type without schema changes.
**Answered-by:** Tech Lead

---

## Q-005: Posting Engine Design
**Agent:** Advanced Coder  
**Date:** 2026-03-14  
**Status:** Open  
**Task:** Phase 1 - The Accounting Core & General Ledger  
**Context:** Need to implement immutable posting with double-entry validation, period checks, and outbox pattern.
**Question:** 
1. Should posting be synchronous or async with job queue?
2. How to handle transaction rollback on validation failure?
3. What validation rules beyond debits=credits? (open periods, valid accounts, etc.)
4. How to implement the outbox pattern for downstream projections?
**Options considered:**
- Synchronous posting simpler but blocks user
- Async posting better UX but requires eventual consistency
- Database transactions vs application-level compensation
**Blocking:** Yes  
**Assumption:** Will implement synchronous posting within database transaction, with outbox table for async events
**Answer:** We'll implement **synchronous posting within database transactions** for Phase 1 to maintain data integrity and provide immediate feedback - accounting systems require strong consistency. For validation: (1) debits = credits, (2) period is open, (3) all accounts exist and are active, (4) account types match expected debit/credit behavior, (5) sufficient permissions for the user/tenant, (6) date is within allowed posting range, (7) no duplicate journal references. All validations occur within the transaction before writing. For the outbox pattern, we'll use a separate journal_outbox table - after successful posting, we insert events into this table within the same transaction. A background worker processes these events and updates projections. On validation failure, the entire transaction rolls back, returning clear error messages to the client.
**Answered-by:** Tech Lead

---

## Q-006: Deployment and Infrastructure
**Agent:** Advanced Coder  
**Date:** 2026-03-14  
**Status:** Open  
**Task:** Phase 1 - Technical Infrastructure & CI/CD  
**Context:** Need to set up environments, IaC, CI/CD pipelines.
**Question:** 
1. Which cloud provider? (AWS, GCP, Azure, or local Docker only?)
2. Should we use managed services (RDS, ElastiCache) or self-hosted?
3. What CI/CD platform? (GitHub Actions, GitLab CI, etc.)
4. How to structure environment configuration?
**Options considered:**
- AWS most comprehensive but complex
- Local Docker simplest for development
- GitHub Actions most common for open source
**Blocking:** Yes  
**Assumption:** Will use Docker Compose for local dev, with structure ready for cloud deployment later
**Answer:** For Phase 1, we'll use **Docker Compose for local development** with configurations ready for cloud deployment. We'll target **AWS** as our primary cloud provider for production, using managed services (RDS for PostgreSQL, ElastiCache for Redis) to reduce operational burden. For CI/CD, we'll use **GitHub Actions** since the code will be hosted on GitHub - it provides seamless integration and sufficient capabilities. Environment configuration will follow a hierarchical approach: default values in code, overridden by environment-specific .env files (never committed), with sensitive values injected via GitHub Secrets or AWS Secrets Manager. We'll create docker-compose.yml for local dev and docker-compose.prod.yml as a template for production deployment.
**Answered-by:** Tech Lead

---

## Q-007: Observability and Monitoring
**Agent:** Advanced Coder  
**Date:** 2026-03-14  
**Status:** Open  
**Task:** Phase 1 - Technical Infrastructure & CI/CD  
**Context:** Need structured logging, metrics, tracing.
**Question:** 
1. What logging format? (JSON structured logs)
2. Which metrics collection? (Prometheus vs cloud-native)
3. How much tracing is needed for Phase 1?
4. Should we implement health checks and readiness probes?
**Options considered:**
- JSON logs for machine readability
- Prometheus for self-hosted metrics
- Basic tracing vs full OpenTelemetry
**Blocking:** No  
**Assumption:** Will implement JSON structured logging, basic Prometheus metrics, health endpoints
**Answer:** We'll implement **JSON structured logging** with consistent fields (timestamp, level, tenant_id, request_id, module, message, metadata) for machine parsing and log aggregation. For metrics, we'll expose a **Prometheus endpoint** with custom metrics for business events (journals posted, validation failures) and technical metrics (request duration, DB connection pool usage). For Phase 1, tracing will be **basic request IDs** passed through the system to correlate logs - we'll design with OpenTelemetry in mind but not implement full tracing yet. Health checks: /health/liveness for basic process health, /health/readiness for dependency checks (DB, Redis connectivity), and /health/startup for initial warm-up. All endpoints will return appropriate HTTP status codes and detailed status information.
**Answered-by:** Tech Lead

---

## Q-008: Testing Strategy
**Agent:** Advanced Coder  
**Date:** 2026-03-14  
**Status:** Open  
**Task:** Phase 1 Implementation  
**Context:** Need testing approach for accounting system where correctness is critical.
**Question:** 
1. What testing pyramid? (unit, integration, e2e ratios)
2. How to test double-entry accounting logic?
3. Should we use test databases or in-memory SQLite?
4. How to handle multi-tenant testing?
**Options considered:**
- Heavy on integration tests for accounting logic
- Test containers for PostgreSQL
- Factory patterns for test data
**Blocking:** No  
**Assumption:** Will use Jest for unit tests, integration tests with test database, focus on accounting logic validation
**Answer:** Given the financial domain, we'll invert the traditional pyramid - **heavy on integration tests** (60%), moderate on unit tests (30%), lighter on e2e (10%). For accounting logic, we'll create a comprehensive test suite with known test cases: balanced journals, unbalanced journals (should fail), journals crossing period boundaries, journals with invalid accounts, and complex scenarios with multiple lines. We'll use **testcontainers** to spin up real PostgreSQL instances for integration tests to ensure database-specific behavior is tested. For multi-tenant testing, we'll create fixtures with multiple tenants and verify isolation - tests will assert that tenant A cannot see tenant B's data at any layer. We'll also implement property-based testing for the posting engine to generate random valid journal combinations and verify accounting invariants hold.
**Answered-by:** Tech Lead

---

## Q-009: Code Organization and Architecture
**Agent:** Advanced Coder  
**Date:** 2026-03-14  
**Status:** Open  
**Task:** Phase 1 - Base Framework  
**Context:** Need to structure the modular monolith with clear bounded contexts.
**Question:** 
1. How to organize modules? (by domain vs by layer)
2. Should we use DDD patterns (aggregates, value objects)?
3. How to handle shared types and utilities?
4. What folder structure for scalability?
**Options considered:**
- Domain-driven folder structure
- Feature-based organization
- Traditional layered architecture
**Blocking:** No  
**Assumption:** Will use domain-driven organization with modules per bounded context
**Answer:** We'll organize by **bounded contexts** (modules) following Domain-Driven Design principles. Each module (tenant, identity, accounting, reporting) will have its own folder with clear boundaries. Inside each module: domain/ (entities, value objects, domain services), application/ (use cases, DTOs, application services), infrastructure/ (repositories, external integrations), api/ (controllers, request/response validation). Shared kernel (common utilities, base classes, types) will live in a shared/ folder with strict rules about dependencies - shared code cannot depend on modules. This structure keeps related code together, enforces boundaries, and makes it easier to extract microservices later if needed.
**Answered-by:** Tech Lead

---

## Q-010: Phase 1 Scope Boundaries
**Agent:** Advanced Coder  
**Date:** 2026-03-14  
**Status:** Open  
**Task:** Phase 1 Implementation  
**Context:** Need to define exact deliverables for Phase 1 completion.
**Question:** 
1. What constitutes "complete" for Phase 1?
2. Should we include basic UI for manual journals in Phase 1?
3. How much of the reporting engine is needed for Phase 1?
4. What audit logging is required for Phase 1?
**Options considered:**
- API-only vs full UI
- Basic vs comprehensive audit
- Manual journal UI as MVP
**Blocking:** Yes  
**Assumption:** Phase 1 includes backend APIs, basic admin UI, manual journal posting, no advanced reporting
**Answer:** Phase 1 is complete when we have: (1) **Complete backend APIs** for tenant management, user authentication, account management, and journal posting with full validation, (2) **Basic admin UI** that allows super-admins to create tenants and manage users, and tenant admins to manage accounts and post manual journals, (3) **Audit logging** at the domain level - every create/update/delete operation on financial data is logged with before/after state, user, timestamp, and tenant context, (4) **Reporting API** that can generate trial balance and basic general ledger reports, (5) **Deployment ready** with Docker Compose configuration and documentation. We explicitly exclude advanced reporting (financial statements, dashboards), integrations with external systems, and scheduled jobs from Phase 1 scope.
**Answered-by:** Tech Lead

---

## Summary
These questions need answers before starting implementation to ensure we build the right foundation. The most critical blocking questions are about technology stack, multi-tenancy, authentication, database design, and posting engine design.