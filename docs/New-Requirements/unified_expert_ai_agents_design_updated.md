**Unified Expert AI Agents Platform  
Technical Design Document**

*Knowledge base, retrieval, memory, collaboration, tool use, governance,
and TypeScript/Node implementation blueprint*

Prepared from five source inputs and consolidated into a single coherent
target design.

Design intent: resolve overlap and contradictions across the source
documents and supplementary implementation guides, preserve the
strongest ideas, and deliver one practical architecture that can be
implemented incrementally.

# 1. Executive summary

This document defines the target architecture for an expert AI agents
platform in which each agent is more than a prompt. An agent is a
governed runtime composed of identity, soul, policy, project state,
knowledge, memory, tools, evaluation, and optional collaboration.

The unified recommendation is a hybrid architecture. Current project
truth is maintained as a directly injected project state bundle. Broad
knowledge is stored in canonical files and retrieved through hybrid
search combining metadata filters, lexical search, dense vectors, and
reranking. Session memory is separated from published knowledge.
Multi-agent collaboration is supported, but only through structured
artifacts and explicit governance.

The canonical production architecture uses TypeScript/Node services,
PostgreSQL plus pgvector for metadata and vector retrieval, object
storage for canonical files, Redis plus a queue for coordination, and a
pluggable model and embeddings adapter. A local-first developer profile
may optionally substitute ChromaDB and a file-based bus, but these are
treated as development accelerators rather than the long-term production
default.

Final architectural choices made to remove contradictions across
sources:

-   Production source of truth is canonical files plus relational
    metadata, not a vector store alone.

-   The default retrieval model is hybrid retrieval with reranking;
    direct context is reserved for small, high-authority artifacts.

-   Project state is always injected directly through a curated state
    bundle and never inferred only from vector similarity.

-   Memory is three-tiered: turn, session, and published knowledge.
    Session notes cannot become durable knowledge without explicit
    promotion and review.

-   Multi-agent collaboration is allowed, but agent-to-agent exchange
    must be structured, bounded, auditable, and never a channel for
    policy override.

-   Tool use is governed by tool manifests, ACL scope, approval rules,
    and runtime limits.

# 2. Goals and non-goals

## 2.1 Goals

-   Host multiple expert agents with distinct identities, souls,
    policies, tools, and knowledge visibility.

-   Answer current-state questions and historical questions with
    traceable provenance.

-   Support project documents, ADRs, code summaries, runbooks,
    standards, decision logs, and operational state.

-   Provide deterministic context assembly and reproducible grounded
    responses.

-   Support both single-agent and coordinator-specialist workflows.

-   Operate in both enterprise and local-first development profiles.

## 2.2 Non-goals for the first release

-   No unrestricted autonomous background agents.

-   No durable storage of raw chain-of-thought or private model
    reasoning.

-   No direct promotion of chat transcripts into the long-term knowledge
    base.

-   No assumption that one vector database or one prompting pattern fits
    all deployment environments.

# 3. Unified capability model

| **Layer**               | **Purpose**                                                  | **Persistence**                        | **Final design choice**                |
|-------------------------|--------------------------------------------------------------|----------------------------------------|----------------------------------------|
| Policy                  | Defines authority, safety, ACL, approvals, publication rules | Versioned configuration                | Highest precedence at runtime          |
| Identity                | Defines who the agent is                                     | Versioned markdown or config           | Stable, curated, human-governed        |
| Soul                    | Defines how the agent works                                  | Versioned markdown or config           | Workflow and behavior rules            |
| Always-on project state | Defines what is true now for a project                       | Generated bundle                       | Injected on every run                  |
| Knowledge base          | Defines broad, long-lived evidence                           | Canonical files plus indexes           | Hybrid retrieval over approved sources |
| Session memory          | Captures active task context                                 | Ephemeral or session store             | Scoped and summarised                  |
| Published knowledge     | Approved durable summaries and decisions                     | Reviewed artifact store                | Created via promotion workflow         |
| Tools                   | Defines how the agent acts                                   | Manifest plus runtime executor         | Bounded and audited                    |
| Collaboration           | Delegation and shared artifacts                              | Message and artifact store             | Optional, structured, policy-bound     |
| Evaluation              | Defines how quality is measured                              | Versioned rubrics plus runtime metrics | Mandatory for release gating           |

# 4. Governing design principles

1.  Policy beats retrieved content. Retrieved documents are evidence,
    not runtime authority.

2.  Current truth beats historical similarity. The current project state
    bundle is authoritative for 'what is true now' questions.

3.  Hybrid retrieval beats single-mode retrieval for enterprise corpora.

4.  Canonical storage beats vector-store-only thinking. Vector indexes
    are retrieval accelerators, not the system of record.

5.  Memory must be useful, compact, and governable. Session notes are
    not durable knowledge until reviewed.

6.  Security filtering happens before model exposure, not after answer
    generation.

7.  Every grounded answer must be explainable through document versions,
    retrieval traces, and cited evidence.

8.  Collaboration must exchange artifacts and contracts, not private
    reasoning.

9.  The platform must support a dev profile and a production profile
    without changing the logical model.

# 5. Resolved source variances and final decisions

| **Topic**              | **Source variance**                                                                          | **Unified decision**                                                                                                                                        |
|------------------------|----------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Vector store           | One source centers on PostgreSQL plus pgvector; another centers on ChromaDB.                 | Use a repository abstraction. Production default is PostgreSQL plus pgvector; ChromaDB remains optional for local-first or prototyping use.                 |
| Current state handling | One source formalizes a project state bundle; another relies on injected YAML and manifests. | Keep the state bundle as the authoritative runtime artifact and allow manifests to declare the inputs that feed it.                                         |
| Prompt order           | One source starts from SOUL and IDENTITY; the other places platform policy first.            | Prompt order begins with platform policy, then identity and soul, followed by tool permissions, project state, task, memory, evidence, and output contract. |
| Collaboration          | One source is detailed on delegation and message bus; the other is more abstract.            | Adopt the concrete delegation model, but implement it on top of governed APIs and persisted structured artifacts.                                           |
| Deployment posture     | One source is local-first and self-hosted; the other is enterprise production-oriented.      | Support both profiles. The production architecture is canonical; the local-first profile is a compatible developer mode.                                    |

# 6. Reference architecture

Logical runtime architecture:

Client UI / API consumers

-\> API Gateway

-\> Orchestrator

-\> Policy Engine

-\> Planner

-\> Context Builder

-\> Retrieval Service

-\> Metadata Filters

-\> Lexical Search

-\> Vector Search

-\> Fusion and Reranking

-\> Memory Service

-\> Tool Router and Executor

-\> Collaboration Router

-\> Model Provider Adapter

-\> Knowledge Ingestion Service

-\> Parsers

-\> Normalizers

-\> State Bundle Builder

-\> Summary Builder

-\> Chunker

-\> Embeddings Worker

-\> Index Writer

-\> Canonical Storage

-\> PostgreSQL plus pgvector

-\> Redis plus queue

-\> Observability and Evaluation Store

Canonical runtime flow:

10. Receive a task with tenant, project, agent, session, user, optional
    selected files, and acceptance criteria.

11. Load policy, identity, soul, tool manifest, and retrieval profile.

12. Load the current project state bundle.

13. Classify the task and choose a retrieval mode.

14. Retrieve relevant session memory.

15. If retrieval is needed, run metadata-filtered lexical search and
    vector search in parallel, then fuse and rerank results.

16. Assemble a bounded evidence pack with provenance.

17. Execute the model directly or with tool use; invoke specialist
    agents only if policy allows.

18. Persist retrieval traces, tool logs, citations, memory updates, and
    evaluation signals.

# 7. Knowledge architecture

## 7.1 Knowledge classes

| **Class**      | **Examples**                                          | **Storage**                                      | **Retrieval behavior**                      |
|----------------|-------------------------------------------------------|--------------------------------------------------|---------------------------------------------|
| Normative      | Policies, standards, approved ADRs, runbooks          | Canonical files plus metadata                    | Preferred in high-authority answers         |
| Project state  | Current deliverables, blockers, milestones, ownership | Generated project state bundle plus source files | Directly injected and freshness-biased      |
| Historical     | Old decisions, prior release notes, archived plans    | Versioned canonical files                        | Used in history or compare mode             |
| Code knowledge | Code summaries, interfaces, symbols, configs          | Repo mirror plus chunk index                     | Metadata filtered by path, language, module |
| Reference      | API specs, glossaries, domain rules                   | Canonical files plus summary index               | Summary-first, then detailed evidence       |

## 7.2 Canonical storage and lineage

Every knowledge item must have an immutable document identity, revision
lineage, source URI, approval state, and visibility scope.

Canonical storage is the source of truth. Retrieval indexes may be
rebuilt from it at any time.

Superseded content remains traceable unless retention policy requires
hard deletion.

## 7.3 Agent-scoped knowledge manifests

Adopt the useful manifest concept from the local-first design, but treat
it as a declaration layer rather than the primary store. A manifest
declares direct context items, retrievable collections, shared
collections, chunking hints, and visibility scope.

## 7.4 Current project state bundle

-   Maintain one small always-on state bundle per project.

-   Include current workstreams, deliverables and status, accepted
    decisions, blockers, risks, active open questions, key technologies,
    and canonical names.

-   Rebuild the bundle when high-value source documents change or on an
    explicit publish event.

-   Attach source document IDs and revision references to the bundle for
    auditability.

## 7.5 Summary indexing

-   Create document summaries, section summaries, and fine-grained
    chunks.

-   Use document and section summaries to narrow candidate sets before
    chunk retrieval.

-   Preserve section path, heading hierarchy, source revision, and
    approval metadata at chunk level.

# 8. Retrieval and context assembly

## 8.1 Retrieval modes

| **Mode**            | **Use case**                         | **Primary sources**                                 | **Typical output**                     |
|---------------------|--------------------------------------|-----------------------------------------------------|----------------------------------------|
| Current-only        | What is true now                     | Project state bundle plus latest approved documents | Short grounded answer                  |
| Direct file package | User-selected or must-read files     | Selected files plus current bundle                  | Deep bounded synthesis                 |
| Retrieve-and-answer | Open-ended knowledge questions       | Hybrid retrieval plus memory                        | Grounded answer with citations         |
| Retrieve-then-read  | Need discovery then detailed reading | Hybrid retrieval then canonical section fetch       | Longer synthesis                       |
| History/compare     | Evolution, trade-offs, timeline      | Current and historic versions                       | Explicit comparison                    |
| No-KB               | Pure reasoning task                  | Policy, identity, soul, task only                   | Non-grounded reasoning with disclosure |

## 8.2 Retrieval pipeline

19. Understand the query: detect project scope, time scope, exact
    identifiers, file type hints, and whether current or historical
    truth is needed.

20. Apply tenant, project, ACL, approval state, sensitivity class, and
    freshness filters before retrieval.

21. Run lexical search and vector search in parallel.

22. Fuse results using reciprocal rank fusion or weighted rank fusion.

23. Rerank the top candidate set with a stronger reranker.

24. Apply diversity controls to avoid overconcentration from one
    document.

25. Assemble a bounded evidence pack with summary chunks and evidence
    chunks.

## 8.3 Chunking and contextualization

| **Content type**     | **Recommended strategy**                                 | **Notes**                                    |
|----------------------|----------------------------------------------------------|----------------------------------------------|
| Markdown or text     | Split on heading hierarchy, then paragraphs or sentences | Preserve section path metadata               |
| Source code          | Split on symbol boundaries using parser-aware logic      | Include file path, signature, module         |
| YAML or JSON         | Keep complete objects or top-level keys together         | Avoid splitting semantically related config  |
| Decisions            | One decision record per chunk or small set               | Carry status and supersession metadata       |
| PDF or exported docs | Extract text, preserve page numbers and heading hints    | Store page references for citation rendering |

## 8.4 Prompt assembly order

26. Platform policy

27. Agent identity

28. Agent soul

29. Allowed tools and action limits

30. Current project state bundle

31. User task and acceptance criteria

32. Session memory summary

33. Retrieved evidence pack

34. Collaboration artifacts if relevant

35. Output contract and citation rules

# 9. Memory and knowledge publication

| **Memory tier**     | **Lifetime**    | **Examples**                                                                 | **Publication rule**                        |
|---------------------|-----------------|------------------------------------------------------------------------------|---------------------------------------------|
| Turn memory         | One request     | Selected sources, temporary plan, tool outputs                               | Discard unless promoted into session memory |
| Session memory      | Session or task | Assumptions, open questions, pending tasks, validated intermediate decisions | Can be proposed for publication             |
| Published knowledge | Long-lived      | Approved summary, finalized decision, stable fact, released design           | Only after explicit promotion and review    |

Session memory should support both episodic summaries and semantic
facts, but all semantic facts must carry confidence, origin, validation
date, and contradiction links. A promotion workflow must convert
candidate knowledge into approved durable knowledge only after
validation.

## 9.1 Decision log

-   Represent significant decisions as first-class ADR-like records.

-   Track title, status, date, context, options considered, chosen
    option, rationale, consequences, supersedes, and review date.

-   Prefer machine-readable decision artifacts plus a readable markdown
    rendering.

# 10. Multi-agent collaboration

The platform should support a coordinator-specialist model. Examples
include Solution Architect, Data Architect, Business Analyst, Cloud
Architect, QA, Frontend Designer, and Advanced Coder.

## 10.1 Agent registry

-   Maintain a registry of agents with capabilities, delegation
    permissions, acceptance constraints, and concurrency limits.

-   Allow per-agent knowledge visibility and tool scope.

-   Share platform policy and project state across agents, while keeping
    distinct souls and scoped knowledge views.

## 10.2 Handoff protocol

36. The invoking agent identifies a specialist that matches the required
    capability.

37. It submits a structured handoff: task, required context, acceptance
    criteria, deadline or priority, and artifact contract.

38. The receiving agent accepts, rejects with reason, or
    counter-proposes.

39. The result is returned as a structured artifact, not free-form
    chain-of-thought.

40. Failures or disagreements follow bounded retry and escalation rules.

## 10.3 Collaboration transport

In development, a file-based message bus may be used. In production,
replace it with a durable messaging layer such as Redis Streams, NATS,
or another internal eventing standard. Transport is an implementation
detail; the collaboration contract is the stable part of the design.

# 11. Tool use and runtime safety

Every tool must have a manifest describing inputs, outputs, ACL scope,
idempotency, approval requirements, and per-run limits.

| **Field**           | **Purpose**                                 |
|---------------------|---------------------------------------------|
| key and description | Stable identity and human meaning           |
| input schema        | Validation before execution                 |
| output schema       | Normalization before model re-entry         |
| acl scope           | Tenant, project, session, or narrower scope |
| requires approval   | Human review for high-risk actions          |
| max calls per run   | Prevents tool loops and runaway behavior    |
| audit rules         | Defines logging and redaction expectations  |

-   Restrict file tools to approved working directories.

-   Default database tools to read-only.

-   Route external API calls through allowlisted connectors or MCP
    servers.

-   Normalize tool outputs before placing them into the model context.

# 12. Storage and data model

Use a relational core for governance, lineage, and auditability. The
vector index should live beside relational metadata, not replace it.

-   Core entities: tenants, projects, agents, documents, document
    sections, chunks, document summaries, project state bundles, session
    memories, retrieval logs, decisions, tool manifests, collaboration
    runs.

-   Required metadata: title, doc type, approval state, status, revision
    ID, version label, sensitivity class, source URI, owner, created and
    updated timestamps, is_current, and visibility scope.

-   Required chunk metadata: chunk type, section path, heading, token
    count, content type, source revision, symbol name if code, and
    freshness or importance score if computed.

## 12.1 Repository abstraction

Implement a storage abstraction so the same logical services can run on
PostgreSQL plus pgvector in production and optionally ChromaDB in
local-first mode. The abstraction boundary should sit in the retrieval
service rather than across the whole platform.

# 13. TypeScript/Node service architecture

| **Service**           | **Responsibility**                                                                                      |
|-----------------------|---------------------------------------------------------------------------------------------------------|
| API Gateway           | Auth, tenant resolution, request validation, rate limiting, request tracing                             |
| Orchestrator          | Load runtime config, choose retrieval mode, assemble context, invoke model, persist run logs            |
| Retrieval Service     | Metadata filters, lexical search, vector search, fusion, reranking, evidence assembly                   |
| Ingestion Worker      | Parsing, normalization, summary generation, chunking, embeddings, index writes, bundle rebuild triggers |
| Memory Service        | Session memory CRUD, summarization, fact extraction, promotion workflow                                 |
| Collaboration Service | Agent registry, delegation protocol, handoff persistence, status tracking                               |
| Tool Router           | Manifest loading, validation, execution control, approval checks, audit logs                            |
| Evaluation Worker     | Benchmarks, groundedness checks, citation correctness, regression reports                               |
| Admin Console         | Documents, versions, bundles, retrieval traces, policy versions, evaluations, approvals                 |

## 13.1 Recommended implementation baseline

-   Runtime: Node.js LTS with strict TypeScript.

-   API and validation: Fastify or a comparable typed framework, plus
    Zod.

-   Data: PostgreSQL plus pgvector and native full-text search.

-   Canonical files: object storage or a Git-backed mirror.

-   Coordination: Redis plus a queue such as BullMQ or equivalent.

-   Telemetry: OpenTelemetry-compatible traces, metrics, and logs.

-   Testing: unit, integration, retrieval benchmark, and end-to-end
    workflow tests.

# 14. Deployment profiles

## 14.1 Canonical production profile

-   Managed PostgreSQL plus pgvector.

-   Object storage for canonical documents and generated artifacts.

-   Redis plus workers for ingestion, evaluation, and bundle rebuilds.

-   Containerized services behind an ingress or gateway.

-   Secrets manager for provider keys and infrastructure credentials.

## 14.2 Local-first developer profile

-   Optional ChromaDB backend for rapid local experimentation.

-   Optional Ollama-based local embeddings.

-   Optional file-based collaboration bus for single-machine
    development.

-   Same logical manifests, APIs, and policies as production, so local
    work remains compatible.

# 15. Security, tenancy, and governance

41. Enforce tenant, project, and sensitivity ACLs before retrieval
    returns any content to the model.

42. Separate runtime APIs from administrative and governance APIs.

43. Version policy, identity, soul, retrieval profile, and tool
    manifests; persist the versions used on each run.

44. Redact secrets and sensitive tokens during ingestion where possible
    and sanitize logs before persistence.

45. Treat retrieved documents as hostile input. Strip executable
    instructions, block prompt-injection attempts, and preserve source
    text only as evidence.

46. Require approval workflows for durable publication and high-risk
    tools.

47. Encrypt data at rest and in transit according to enterprise
    standards.

# 16. Evaluation, observability, and testing

## 16.1 Retrieval metrics

-   Recall at K, precision at K, nDCG, duplicate chunk rate, source
    diversity, stale-source rate, and retrieval latency.

## 16.2 Generation metrics

-   Groundedness, citation correctness, task completion, schema
    compliance, hallucination rate, and policy breach rate.

## 16.3 Test strategy

-   Separate retrieval-stage tests from generation-stage tests.

-   Maintain benchmark question sets per project and agent type.

-   Run regressions when chunking, embeddings, reranking, prompts, or
    tool manifests change.

-   Use LLM-as-judge only as one signal, not the only release criterion.

## 16.4 Observability

-   Trace each run end-to-end across retrieval, tool use, model
    invocation, and collaboration handoffs.

-   Persist prompt token counts, evidence composition, used sources, and
    tool execution statistics.

-   Provide an admin view that explains why a specific answer used
    specific sources and decisions.

# 17. Implementation roadmap

| **Phase**                 | **Scope**                            | **Key deliverables**                                                                         |
|---------------------------|--------------------------------------|----------------------------------------------------------------------------------------------|
| 0 - Foundations           | Schemas, policies, platform skeleton | Monorepo, CI/CD, config schemas, auth, tracing, storage baseline                             |
| 1 - Ingestion MVP         | Knowledge onboarding                 | Parsers, canonical storage, summaries, chunking, embeddings, index writes                    |
| 2 - Runtime MVP           | Grounded answering                   | Run-agent API, project state bundle, hybrid retrieval, citations, retrieval logs             |
| 3 - Quality upgrade       | Better relevance                     | Reranking, summary-first retrieval, contextual chunks, benchmarks                            |
| 4 - Memory and governance | Continuity and publication control   | Session memory, semantic facts, promotion workflow, approvals                                |
| 5 - Collaboration         | Coordinator and specialists          | Agent registry, handoff protocol, structured artifacts, replay and evaluation                |
| 6 - Hardening             | Operational readiness                | Scale testing, security hardening, cost controls, failure recovery, admin console maturation |

# 18. Additional implementation refinements adopted from the two supplementary HTML inputs

The two HTML inputs add useful implementation detail around
orchestration, operational tooling, observability, memory layering, and
delivery sequencing. They do not overturn the core architectural
decisions already made in this unified design; instead, they are treated
as supplementary implementation guides.

| **Source**                                 | **Assessment**                                                                                                                                                    | **Adopted**                                                                                                                           | **Not carried forward**                                                                                    |
|--------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------|
| expert_ai_agents_platform_design_v1-3.docx | Best source for governance, layered runtime model, project state bundle, hybrid retrieval, service boundaries, and implementation sequencing.                     | Production architecture, state bundle, hybrid retrieval, candidate knowledge promotion, retrieval logs, evaluation model.             | Reduced emphasis on exact component versions to avoid overfitting the design to one moment in time.        |
| expert_ai_agents_platform_design_v1.docx   | Text-identical duplicate of v1-3 in the uploaded material. Useful as confirmation, not as an independent perspective.                                             | Used as corroboration of the same architectural stance.                                                                               | Not treated as a separate source of requirements or contradictions.                                        |
| agent-knowledge-base-design.docx           | Best source for concrete local-first implementation patterns, manifests, decision structures, memory structures, delegation protocol, and tool manifest patterns. | Knowledge manifest concept, collaboration protocol, decision record shape, semantic and episodic memory structure, local dev profile. | Did not keep ChromaDB as the canonical production backend or the file-based bus as a production transport. |

The concrete patterns adopted from the HTML inputs are consolidated
later in Section 20 so the final implementation guidance stays grouped
in one place.

| **Source**                  | **Conceptual quality** | **Implementation specificity** | **Enterprise readiness** | **Uniqueness**  |
|-----------------------------|------------------------|--------------------------------|--------------------------|-----------------|
| v1-3                        | High                   | Medium                         | High                     | Medium          |
| v1                          | High                   | Medium                         | High                     | Low - duplicate |
| agent-knowledge-base-design | Medium-High            | High                           | Medium                   | High            |

# 19. Requirements ranked by implementation priority

Use the following priority model for delivery: P0 requirements are
mandatory for the first usable release; P1 requirements materially
improve operability, governance, and scale; P2 requirements are optional
optimizations or advanced capabilities.

## 19.1 P0 - mandatory for first release

-   Versioned identity, soul, policy, and tool manifests for each agent.

-   Curated project state bundle injected directly for current-truth
    questions.

-   Canonical document store with revision lineage, approval state, and
    source provenance.

-   Hybrid retrieval with ACL filtering, lexical search, vector search,
    fusion, and reranking.

-   Bounded evidence-pack assembly with citations and retrieval traces
    persisted per run.

-   Separation of transient session memory from durable published
    knowledge, with explicit promotion workflow.

-   Typed tool contracts, approval gates for high-risk tools, and
    runtime limits.

-   Stateful orchestrator with resumable execution and checkpoint
    persistence.

-   Core observability, audit logging, and security controls before
    model exposure.

-   Multi-tenant and project isolation in storage, retrieval, and tool
    execution.

## 19.2 P1 - strongly recommended after the first release

-   Structured multi-agent collaboration using handoff contracts, shared
    artifacts, and bounded specialist delegation.

-   Document, section, and bundle summaries to improve retrieval quality
    and reduce context cost.

-   Admin and human-in-the-loop dashboard for approvals, run inspection,
    and replay.

-   Evaluation suite with benchmark corpora, retrieval metrics,
    groundedness checks, and regression gates.

-   Model routing, prompt caching, and response caching to reduce cost
    and latency.

-   Reference implementation in LangGraph.js with provider-agnostic
    model adapters.

-   OpenTelemetry-compatible tracing with LangSmith or equivalent run
    analytics.

-   Local-first developer profile that preserves the same logical
    contracts as production.

## 19.3 P2 - optional optimizations and advanced capabilities

-   Procedural memory built from successful tool sequences and reusable
    execution patterns.

-   Sandboxed code execution for coding and analysis tasks.

-   Agentic query rewriting, HyDE-style expansion, or iterative
    retrieval loops when baseline retrieval is insufficient.

-   Automated bundle rebuild triggers from Git/webhook/file-change
    events.

-   Advanced rerankers, semantic chunkers, and specialized document
    parsers for domain-specific corpora.

-   File-based message bus and ChromaDB-only mode for single-machine
    prototyping.

# 20. Supplementary implementation patterns synthesized from the two HTML inputs

The two HTML inputs were valuable mainly because they translated
platform concepts into concrete implementation patterns. The following
patterns are adopted, with qualification where needed to avoid
contradiction:

## 20.1 Patterns adopted into the unified design

-   Use LangGraph.js as the reference orchestration framework for the
    planner, executor, reflector, and checkpointed workflow graph. The
    logical architecture remains framework-agnostic, but LangGraph.js is
    the preferred implementation path for the TypeScript stack.

-   Represent memory in two compatible views: an operational four-layer
    view (short-term, semantic retrieval, episodic, procedural) and a
    governance view (transient turn/session knowledge versus explicitly
    published durable knowledge).

-   Implement agentic RAG as a bounded control loop: task
    classification, optional query rewrite, hybrid retrieval, reranking,
    evidence-pack assembly, and retry only when the first evidence pack
    is insufficient.

-   Use Zod-validated tool schemas, approval classes, idempotency
    expectations, timeouts, and audit metadata for all externally
    visible tools.

-   Adopt LangSmith-compatible tracing on top of OpenTelemetry so model
    reasoning steps, retrieval traces, and tool usage can be debugged
    without storing private raw chain-of-thought.

-   Use model routing: cheaper models for classification, extraction,
    and summarization; stronger models for planning, synthesis, and
    high-risk reasoning tasks.

-   Provide an admin and human-review dashboard, preferably a Next.js
    application, for approvals, run inspection, source tracing, and
    evaluation reporting.

-   Treat BullMQ-style workers, Redis coordination, Drizzle ORM, and a
    typed Fastify-style API as the default implementation accelerators
    for the Node.js reference stack.

-   Support an optional sandbox such as E2B or isolated containers for
    code execution tasks that require controlled runtime environments.

## 20.2 Recommendations accepted only with qualification

-   The HTML inputs frame an 8-week path to a production-ready system.
    In this unified design, that timeline is treated as an aggressive
    MVP example, not a guaranteed delivery commitment.

-   Specific target metrics such as autonomous task success rates or
    exact latency promises are treated as illustrative goals, not
    architectural facts, because the sources do not provide validation
    data.

-   Specific providers and model names are examples only. The platform
    must remain provider-agnostic and capable of using OpenAI,
    Anthropic, Grok, local models, or future providers through adapters.

-   The HTML inputs present the four-layer memory model as if it were
    the only memory scheme. Here it is integrated without replacing the
    stricter publication and governance model already established in
    this document.

# 21. Assessment of each source input and SWOT analysis

**Assessment method:** sources were ranked by architectural quality,
implementation usefulness, governance maturity, and independence as
evidence. Duplicate sources were penalized for lack of independent
contribution.

| **Rank** | **Source**                                 | **Role in synthesis**                        | **Assessment summary**                                                                                                                           |
|----------|--------------------------------------------|----------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------|
| 1        | expert_ai_agents_platform_design_v1.docx   | Primary production architecture source       | Strongest production-grade architecture; best source of truth for layered capability model, governance, and hybrid retrieval.                    |
| 2        | agent-knowledge-base-design.docx           | Primary local-first and developer-MVP source | Best source for manifests, folder conventions, memory organization, and practical incremental adoption.                                          |
| 3        | answer2grok.html                           | Supplementary implementation guide           | Adds concrete implementation patterns, LangGraph.js details, tool contracts, observability, and roadmap structure.                               |
| 4        | answer-1grok.html                          | Supplementary implementation guide           | Useful but more presentation-oriented and somewhat less detailed than answer2grok.html; overlaps heavily with it.                                |
| 5        | expert_ai_agents_platform_design_v1-3.docx | Duplicate of source 1                        | Architecturally strong because it matches source 1, but weak as independent evidence because the uploaded content is text-identical to source 1. |

## 21.1 expert_ai_agents_platform_design_v1.docx

-   Strengths: strongest production architecture; clear separation of
    identity, policy, knowledge, memory, tools, and evaluation; strong
    governance stance.

-   Weaknesses: broader than an MVP and sometimes less concrete on
    immediate implementation steps.

-   Opportunities: ideal canonical target-state design for enterprise
    deployment and multi-project governance.

-   Threats: risk of overengineering if the team attempts to build the
    full target architecture in one phase.

## 21.2 expert_ai_agents_platform_design_v1-3.docx

-   Strengths: same architectural strengths as source 1.

-   Weaknesses: no independent value because the uploaded version is
    text-identical to source 1.

-   Opportunities: can be treated as a governed version marker if real
    deltas are introduced later.

-   Threats: creates false confidence if stakeholders mistake it for a
    second independent expert opinion.

## 21.3 agent-knowledge-base-design.docx

-   Strengths: strongest practical guide for manifests, knowledge
    folders, episodic and semantic memory separation, and local-first
    development.

-   Weaknesses: weaker production governance; ChromaDB and file-based
    coordination are not ideal long-term defaults for multi-user
    enterprise deployment.

-   Opportunities: excellent source for developer ergonomics and an
    optional local-first profile that accelerates early delivery.

-   Threats: can mislead teams into treating prototype-oriented storage
    and coordination patterns as sufficient for production.

## 21.4 answer2grok.html

-   Strengths: strong implementation concreteness; useful
    recommendations on LangGraph.js, Drizzle, BullMQ, LangSmith, Zod
    tools, and a phased roadmap.

-   Weaknesses: occasionally overconfident, mixes architecture with
    optimistic delivery claims, and treats some provider/model choices
    as if they were standard.

-   Opportunities: valuable companion for turning the target
    architecture into a delivery backlog and reference implementation.

-   Threats: unsupported schedule or metric claims could harden into
    false requirements if copied uncritically.

## 21.5 answer-1grok.html

-   Strengths: helpful operational summary of orchestration, memory,
    retrieval, tools, and production features; converges with the
    stronger sources.

-   Weaknesses: less comprehensive than answer2grok.html and heavily
    overlapping with it.

-   Opportunities: useful as a concise implementation handout for
    developers.

-   Threats: if used alone, it can understate governance nuances and the
    distinction between source-of-record storage and retrieval indexes.

# 22. Updated final recommendation

-   Proceed with a production architecture based on canonical files,
    PostgreSQL plus pgvector, hybrid retrieval, a mandatory project
    state bundle, separate transient memory, and structured multi-agent
    collaboration.

-   Adopt LangGraph.js as the reference orchestration framework,
    Zod-validated tool contracts, LangSmith-compatible tracing, and a
    Next.js admin workflow as implementation refinements rather than
    architectural replacements.

-   Retain ChromaDB, local embeddings, and file-based collaboration only
    as optional local-first development accelerators. Do not treat them
    as the long-term enterprise default.

-   Use the HTML inputs to tighten implementation detail, but keep the
    original production architecture document as the primary authority
    whenever a conflict appears.

# 23. Suggested technologies and coding stack

## 23.1 Recommended baseline stack

| **Layer**                            | **Recommended choice**                                                     | **Alternatives or notes**                                                                 |
|--------------------------------------|----------------------------------------------------------------------------|-------------------------------------------------------------------------------------------|
| Language and runtime                 | TypeScript 5.x on Node.js 22 LTS                                           | Keep strict typing and ESM-first conventions.                                             |
| Package manager                      | pnpm                                                                       | npm is acceptable if standard across the team.                                            |
| API layer                            | Fastify with OpenAPI generation and Zod validation                         | NestJS is acceptable if the team already uses it.                                         |
| Workflow orchestration               | LangGraph.js                                                               | Equivalent graph orchestration is acceptable if it preserves checkpoints and typed state. |
| LLM adapter layer                    | Thin provider abstraction with OpenAI, Anthropic, Grok, and local adapters | Do not bind core logic directly to one provider SDK.                                      |
| Relational data and vector retrieval | PostgreSQL 16 plus pgvector                                                | Primary source of record for metadata and retrieval indexes.                              |
| Lexical retrieval                    | PostgreSQL full-text search plus pg_trgm                                   | OpenSearch becomes optional only at larger corpus sizes or more demanding scale.          |
| ORM and migrations                   | Drizzle ORM                                                                | Prisma is acceptable if the team values its ecosystem over SQL-first control.             |
| Cache and coordination               | Redis                                                                      | Use for cache, distributed locks, and lightweight coordination.                           |
| Job and worker system                | BullMQ                                                                     | Equivalent queue system is acceptable if it supports retries, backoff, and observability. |
| Canonical file store                 | S3-compatible object storage or cloud object storage                       | A Git mirror may be added for code and text assets.                                       |
| Embeddings                           | Provider-abstracted embedding adapter                                      | Examples: OpenAI text-embedding-3-large or small, Voyage, or local bge models.            |
| Reranking                            | Cohere Rerank or bge-reranker family                                       | Keep reranker pluggable.                                                                  |
| Frontend and admin UI                | Next.js with React and TypeScript                                          | Use for admin console, approvals, run inspection, and evaluation views.                   |
| Observability                        | OpenTelemetry plus LangSmith-compatible tracing                            | Grafana, Loki, and Tempo can complement platform observability.                           |
| Authentication and authorization     | OIDC-based auth with project and tenant RBAC                               | Use Auth0, Keycloak, or cloud-native identity provider.                                   |
| Secrets management                   | Vault or cloud secrets manager                                             | Never store provider secrets in manifests or source code.                                 |
| Guardrails                           | Policy engine plus optional NeMo Guardrails or Llama Guard                 | Guardrails supplement but do not replace ACLs and tool approvals.                         |
| Sandbox execution                    | Isolated containers or E2B-style sandbox                                   | Required only for code and analysis tasks that need runtime execution.                    |
| Testing                              | Vitest, Playwright, Testcontainers, retrieval benchmark harness            | Keep retrieval and generation tests separate.                                             |
| Deployment                           | Docker plus managed Postgres, Redis, and object storage                    | Kubernetes is optional; use it only if operational scale justifies it.                    |

## 23.2 Local-first development profile

-   Optional ChromaDB backend for rapid local experimentation when the
    team wants a light developer setup.

-   Optional Ollama or other local embedding and inference providers for
    offline or low-cost development.

-   Optional file-based collaboration bus for a single-developer or
    single-machine prototype only.

-   The local-first profile must preserve the same logical manifests,
    APIs, retrieval contracts, and governance checks as the baseline
    stack.
