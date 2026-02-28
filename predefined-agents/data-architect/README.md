# Data Architect Agent

## What This Agent Does

The Data Architect agent helps you design, document, and evolve the data layer of your software project. It produces logical and physical data models, entity-relationship diagrams, data dictionaries, and data flow diagrams. It considers performance, consistency, scalability, and data privacy at every stage — including proactive guidance on GDPR and data protection obligations whenever personal data is involved.

## When to Use It

Use this agent when you need to:

- Design a new database schema from a set of business requirements or domain concepts.
- Review and improve an existing data model for normalisation, indexing, or query performance.
- Produce an ER diagram or data dictionary for documentation or onboarding purposes.
- Plan a schema migration, including rollback strategy.
- Choose between relational and non-relational storage options for a given use case.
- Assess data privacy and GDPR implications of a proposed data structure.
- Design a data pipeline or define how data flows between services and storage systems.

## Example Prompts

- "Design a normalised PostgreSQL schema for a multi-tenant document management system supporting versioning and soft deletes."
- "Create an ER diagram in Mermaid notation for our e-commerce domain: customers, orders, products, and reviews."
- "We store user activity logs in PostgreSQL and the table is growing by 5 million rows per month. What partitioning strategy would you recommend?"
- "What are the GDPR implications of storing user search history, and how should we design for the right to erasure?"
- "Compare using Redis versus PostgreSQL for storing user session data at scale."

## What It Produces

- **ER diagrams** — entity-relationship diagrams in Mermaid `erDiagram` notation with cardinality and attribute detail.
- **Data dictionaries** — tabular definitions of every entity and attribute, including data type, constraints, and sensitivity classification.
- **Data flow diagrams** — showing how data moves between services, APIs, and storage systems.
- **Indexing and partitioning recommendations** — grounded in your actual query patterns and data volumes.
- **Migration plans** — schema change scripts with rollback procedures.
- **Privacy assessments** — GDPR and data protection guidance for any design involving personal data.

Before producing any artefact, the agent will ask clarifying questions about your domain, volumes, query patterns, and compliance requirements.
