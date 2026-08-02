# Module 11 — Answer Key: RAG

## Exercise 1: Upload a document

Navigate to `/knowledge`, click **Add Source**, and paste the content of this README or a product spec:

```markdown
# My Product
AgentPrimer is a full-stack AI agent platform for learning and production.
Key features include: 21 built-in tools, MCP protocol support, RAG index
with vector search, streaming agent responses, and multimodal attachments.
```

Click **Ingest**. Wait for the status to show "ready".

Then ask the agent (in a chat): *"What are the key features of AgentPrimer?"*

**Expected:**

1. Agent calls `search_rag({ query: "key features of AgentPrimer", top_k: 5 })`
2. The RAG pipeline searches the vector index or FTS5 fallback
3. Returns relevant chunks from the ingested document
4. Agent reads the chunks and produces an answer citing the features

**Verify in DB:**
```sql
SELECT ks.name, ks.chunk_count, kc.chunk_index, substr(kc.chunk_text, 1, 60)
FROM knowledge_chunks kc
JOIN knowledge_sources ks ON kc.source_id = ks.id;
```

---

## Exercise 2: Inspect chunks via SQL

Run after ingesting the document from Exercise 1:

```sql
SELECT kc.chunk_index, substr(kc.chunk_text, 1, 100) AS preview
FROM knowledge_chunks kc
JOIN knowledge_sources ks ON kc.source_id = ks.id
WHERE ks.name = 'My Product'
ORDER BY kc.chunk_index;
```

**Expected output (example for a short document that fits in one chunk):**
```
0|# My Product
AgentPrimer is a full-stack AI agent platform for learning and production.
Key features include: 21 built-in tools, MCP protocol support, RAG index
with vector search, streaming agent responses, and multimodal attachments.
```

For longer documents, you'll see multiple rows split by the chunking strategy (default: ~1600-character chunks with 200-character overlap).

The `embedding` column stores the 384-dimensional vector as a JSON array of floats (null if the local embedder was unavailable):
```sql
SELECT chunk_index, embedding IS NOT NULL AS has_embedding
FROM knowledge_chunks;
```

---

## Exercise 3: Force FTS5 fallback

Local embeddings now run in-process via `@huggingface/transformers`, so there
is no separate process to kill. To force the degraded path, make the model fail
to load by pointing `EMBED_MODEL` at a non-existent model and restarting:

```bash
EMBED_MODEL="does-not-exist/nope" npm run dev
```

Then:
1. Reload the `/knowledge` page — the badge should show "degraded" (the sidebar shows "FTS5 (keyword)" instead of "Vector")
2. Ask the agent: *"What are the key features of AgentPrimer?"*

**Expected:** The agent still returns results. The search is now keyword-based (FTS5) instead of semantic (vector). Exact keyword matches work, but synonyms and paraphrased queries will be less accurate.

**How the fallback works (`lib/rag.ts`):**
- When the agent calls `search_rag`, `retrieveChunks` first tries the vector search via the in-process embedder (`embedLocal()` in `lib/embeddings.ts`)
- If the embedding model is unavailable or returns an error, it falls back to FTS5:
  ```sql
  SELECT chunk_text FROM knowledge_fts WHERE chunk_text MATCH ?
  ```
- FTS5 uses SQLite's built-in full-text search with the BM25 ranking algorithm
- This fallback is transparent to the agent — it just receives text chunks either way

Restore vector search by restarting without the override:
```bash
npm run dev
```

---

## Exercise 4: Compare embedding vs. keyword search

Ingest a document with the phrase "automotive vehicle". Then search for "car".

**Vector search:** May find a match because the embedding model understands that "car" and "automotive vehicle" are semantically similar (high cosine similarity).

**FTS5 keyword search:** Will NOT find the match because "car" does not appear verbatim in any chunk — FTS5 matches exact keywords only.

**Why embeddings matter:**
- Semantic search captures meaning, not just word overlap
- "automotive vehicle" and "car" have different tokens but similar embeddings (they appear in similar contexts in the training data)
- Cosine similarity in JS (`lib/rag.ts`) compares the query embedding against all stored chunk embeddings and returns the top_k nearest

**The trade-off:**
| Feature | Vector (all-MiniLM-L6-v2) | FTS5 (keyword) |
|---------|---------------------------|----------------|
| Synonyms | ✅ Understands | ❌ Exact match only |
| Speed | Slower (cosine against all chunks) | Faster (indexed) |
| Setup | In-process model (~90 MB) | Built into SQLite |

---

## Exercise 5: Add auto-retrieval

In `lib/agent/prompt.ts`, modify `buildSystemPrompt()` to auto-retrieve context from the RAG index:

```typescript
import { retrieveChunks } from './rag';

export function buildSystemPrompt(
  agentSystemPrompt: string,
  memory: string,
  pendingNotifications?: AgentNotification[],
): string {
  const systemPromptBase = readSystemPrompt();
  // ... existing code ...

  return `${systemPromptBase}
---
${agentSystemPrompt}
---
...
${memory}
${notifSection}`;
}
```

The modified version with auto-retrieval:

```typescript
export async function buildSystemPromptWithAutoRag(
  agentSystemPrompt: string,
  memory: string,
  userMessage?: string,
  pendingNotifications?: AgentNotification[],
): Promise<string> {
  const systemPromptBase = readSystemPrompt();
  let ragSection = '';
  if (userMessage) {
    try {
      const chunks = await retrieveChunks(userMessage, 3);
      if (chunks.length > 0) {
        ragSection = `\n\n---\n\n## Retrieved RAG Context\nThe following information was retrieved from RAG:\n${chunks.map((c, i) => `[${i+1}] ${c}`).join('\n')}`;
      }
    } catch { /* graceful degradation */ }
  }

  // ... rest of prompt assembly ...
}
```

**Trade-offs of auto-retrieval:**

| Pro | Con |
|-----|-----|
| Always up-to-date context without explicit search tools | Every user message triggers a RAG call — adds latency |
| Works even for agents whose tools are restricted | Wastes tokens on irrelevant retrievals |
| Simpler agent (no need to call search_rag) | Agent cannot decide when to search vs. not search |

**Current approach (tool-based) is generally better because:**
1. The agent can decide relevance — it only searches when the query is actually knowledge-related
2. No wasted latency or tokens on trivial messages like "hello" or "what time is it"
3. The agent can refine its search ("search more broadly", "search for something different")
4. Auto-retrieval adds async complexity to a synchronous prompt builder
