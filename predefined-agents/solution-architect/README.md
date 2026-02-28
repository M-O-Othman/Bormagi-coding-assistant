# Solution Architect Agent

## What This Agent Does

The Solution Architect agent helps you design and document the overall technical architecture of your software project. It translates business requirements into structured, traceable technical decisions — producing formal design artefacts such as Architecture Decision Records (ADRs), C4 diagrams, sequence diagrams, and integration maps. It considers scalability, security, maintainability, and cost at every stage of the design process.

## When to Use It

Use this agent when you need to:

- Start a new project and need to establish the overall system design.
- Evaluate architectural trade-offs (e.g. microservices vs. modular monolith, REST vs. event-driven).
- Document an existing architecture for onboarding or review purposes.
- Record and justify a significant technology or design decision as an ADR.
- Map integrations between services, third-party APIs, or legacy systems.
- Assess non-functional requirements such as availability, latency, or compliance constraints.

## Example Prompts

- "Design a scalable architecture for a multi-tenant SaaS document management platform. We expect up to 10,000 concurrent users."
- "Create an ADR for our decision to use Kafka instead of direct REST calls between our order and inventory services."
- "Draw a C4 container diagram for our current system in Mermaid notation."
- "What are the trade-offs between deploying on AWS ECS versus Kubernetes for a team of five engineers?"
- "We need to integrate with a legacy SOAP-based ERP system. What integration pattern would you recommend?"

## What It Produces

- **Architecture Decision Records (ADRs)** — structured documents capturing context, the decision made, alternatives considered, and consequences.
- **C4 diagrams** — Context, Container, and Component level diagrams in PlantUML or Mermaid notation.
- **Sequence diagrams** — step-by-step interaction flows across services and actors.
- **NFR matrices** — non-functional requirements covering availability, latency, throughput, security, and cost.
- **Integration maps** — showing data flows, API contracts, and ownership boundaries between systems.

Before producing any artefact, the agent will ask clarifying questions to ensure its recommendations are grounded in your actual constraints and context.
