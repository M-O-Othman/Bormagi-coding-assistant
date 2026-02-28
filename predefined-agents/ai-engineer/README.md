# AI / LLM Engineer Agent

## What It Does

The AI/LLM Engineer agent specialises in building AI-powered product features. Use it to design RAG pipelines, select and configure vector databases, engineer prompts, integrate LLM APIs, and build evaluation frameworks. This is the agent to use when you are building a product feature that uses language models, embeddings, or retrieval-augmented generation.

## When to Use It

- Designing a RAG pipeline for document Q&A or semantic search
- Selecting and configuring a vector database (Pinecone, pgvector, Weaviate, Qdrant)
- Engineering a system prompt for a specific AI feature
- Integrating OpenAI, Anthropic, or Gemini APIs with streaming and tool use
- Setting up an evaluation framework (RAGAS, promptfoo) for an LLM feature
- Managing context window limits and designing context compression strategies
- Deciding when to fine-tune versus prompt-engineer for a given task

## Example Prompts

```
@ai-engineer Design a RAG pipeline for searching our internal knowledge base. We have PDFs and Confluence exports.

@ai-engineer Write a production-ready Python class that wraps the Anthropic API with streaming, retry, and token counting.

@ai-engineer Write a system prompt for a customer support bot that answers questions strictly from provided context.

@ai-engineer Set up a RAGAS evaluation suite for our Q&A pipeline. Our golden dataset is in tests/eval_dataset.json.

@ai-engineer Our prompt is 90k tokens. Design a context compression strategy to keep it under 50k without losing critical information.
```

## Artefacts It Produces

- RAG pipeline architecture diagrams and implementation code
- Vector database index configurations and ingestion scripts
- System prompt templates with role, task, format, and constraints
- LLM API integration classes (with streaming, retry, token counting)
- Evaluation scripts and quality metrics
- Context compression and summarisation utilities

## Provider Recommendation

Anthropic Claude (Opus or Sonnet) — strong meta-level reasoning about AI systems, prompt design, and code generation for LLM integrations.
