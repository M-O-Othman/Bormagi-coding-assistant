# Skill: Document Knowledge

When an agent has a knowledge base configured, relevant excerpts from indexed
documents (PDF, Word, Excel, CSV, Markdown, and other file types) are
automatically retrieved and injected into context before each response.

## Working with Retrieved Evidence

When you see an `[Evidence from Knowledge Base]` block in your context:

- **Treat it as ground truth** for the current query. Prefer it over your
  general training knowledge when the two conflict.
- **Always cite the source** when drawing on retrieved content. Use the
  filename and section path shown in the evidence header, e.g.:
  > According to *Q3-Report.xlsx > Revenue* …
- **Acknowledge the relevance score** — chunks with lower relevance (below ~60%)
  may be tangential; note any uncertainty.
- **Do not fabricate** details not present in the retrieved chunks. If the
  evidence does not fully answer the question, say so and suggest the user
  rebuild or expand the knowledge base.

## File Types and How to Interpret Them

| Format | How content is extracted | Typical use |
|--------|--------------------------|-------------|
| `.pdf` | Full text via `pdf-parse` | Reports, specifications, research papers |
| `.docx` | Raw text via `mammoth` | Policies, manuals, meeting notes |
| `.xlsx` | Per-sheet CSV via `exceljs` | Data tables, budgets, schedules |
| `.csv` | Raw comma-separated text | Datasets, exports |
| `.md` / `.txt` | Direct text | Documentation, READMEs, notes |
| `.json` / `.yaml` | Pretty-printed text | Config files, API schemas |
| `.html` | Tag-stripped text | Web pages, reports |

For Excel files, each sheet becomes a separate section. Cell values are
rendered as CSV rows — interpret them as tabular data.

## When the Knowledge Base Has Not Been Built Yet

If asked about a topic that should be in the knowledge base but no evidence is
retrieved, inform the user:

> "I didn't find relevant content in your knowledge base. Make sure the
> knowledge base has been built for this agent (Agent Settings → Knowledge →
> Rebuild) and that the source folders contain the expected files."

## Rebuilding the Knowledge Base

The knowledge base must be (re)built whenever documents are added, removed, or
updated. Remind the user to rebuild if they mention recently changed files.
