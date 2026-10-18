# ADR-0012: Semantic search — vector recall to cover FTS5 blind spots, stay zero-CGO (M3)

- Status: Accepted-in-principle (vector storage zero-CGO verified; hybrid RRF core landed; C shipped default-on; A backend landed but default-off — **the labelled A/B gate passed on 2026-10-15, and the 2026-10-18 decision keeps the default OFF**, for the authorization reasons and forward constraint recorded in the closing "Gate passed, default value, and amendment" section; B dropped)
- Date: 2026-10-03
- Relates to: ADR-0003 (FTS5), ADR-0013, TODO M3. (Chinese original: `docs/adr/0012-*.md`.)

## Background

FTS5 trigram + bm25 handles literal/substring well but has no semantic recall ("heap keeps growing" won't match "memory leak"). Constraint: the DB driver is `modernc.org/sqlite` (pure Go, **zero CGO**); a desktop cross-platform app must not reintroduce CGO.

## Decisions

1. **Vector storage/search is feasible at zero-CGO — verified.** `modernc.org/sqlite/vec` bundles sqlite-vec v0.1.9 as pure Go; live-verified under `CGO_ENABLED=0` (`internal/vecprobe` regression: vec0 build + KNN + `vec_distance_l2`). Only **local embedding generation** was the hard part.
2. **Embedding provider (axis A) = OpenAI-compatible `/v1/embeddings`**, not vendor-locked (OpenAI / Voyage / Jina / self-hosted Ollama all speak it). Pointing at **local Ollama** keeps data on-device **and** zero-CGO (model runs out-of-process) — resolving the local-vs-cloud dilemma. `hybrid.RemoteEmbedder` implements it. B dropped (no quality pure-Go inference runtime exists).
3. **Ship as hybrid + RRF, default OFF**: `hybrid.FuseRRF` merges FTS5 and vector recall; `service.fuseSemantic`/`RebuildEmbeddings` wire it, **off unless `semantic_search=1`** + endpoint configured; any failure degrades to lexical (never fewer results). `App.RebuildEmbeddings` binding.
4. **A/B eval gate before exposing to users**: `internal/search/abeval` (recall@k / NDCG@k + `Compare`) + `cmd/abeval` run lexical-vs-hybrid on a labeled query set and PASS/FAIL a `-min-recall` margin.
5. **Embeddings are a derived cache**: SQLite stays the source of truth; rebuild anytime.

## Landed + live-verified

`internal/search/hybrid` (+`RemoteEmbedder`), `internal/db/vecindex.go`, `internal/search/vectordb` (Local/Qdrant/Weaviate, ADR-0013), C (FTS OR-relaxation) default-on. Live smoke tests (`ollamalive`/`qdrantlive`/`aelive`/`weavialive`) ran against **real local Ollama + Qdrant/Weaviate**, incl. full "Ollama→Qdrant→fused recall". Remaining: A/B harness on real labeled queries and cloud-vendor verification. The settings UI now exposes the opt-in switch and rebuild action; incremental per-note embedding has landed.

## Gate passed, default value, and amendment (measured 2026-10-15 / decided 2026-10-18 / written back 2026-10-19)

- **Both Phase 0 gates PASSED (2026-10-15, shipped with v2.2.0).** M3 gate: `.annotation-prep/notes.labeled.tsv` (51 human-written queries covering 51 note ids), PASS across k=3/5/10/20/50, and at k=10 lexical 0.608 / hybrid 0.735 / delta **+0.127**, clearing the default-on bar "hybrid minus lexical recall@10 >= 0.05" (gate definition in the labelled-retrieval workflow section of `docs/features/ai-integration.md`).
- **Strength limits (not optional):** the delta is real but small; of the +0.338 measured before the CJK lexical fix, roughly sixty percent was a false signal caused by "a whole Chinese sentence matching nothing", so +0.127 is the true semantic gain. **Passing the gate is not the same as a large benefit.**
- **Default-value decision (user, 2026-10-18): stay OFF.** The reason is not technical but about authorization — default-on would send note text to whatever embedding endpoint is configured, and that is a privacy consent a user must give explicitly; off-by-default is the zero-risk floor. The settings page already offers the switch and a full rebuild, and neither the code nor the gate blocks anything now, so this was a **zero-code, zero-CHANGELOG, zero-doc-sync** decision.
- **Forward constraint (if default-on is ever adopted):** flip only fresh/unconfigured databases, never silently change existing users' settings; follow the migration wording in `docs/features/ai-integration.md` and disclose the outbound surface prominently in the settings page and docs.
- **Amendment (2026-10-19):** this ADR's status line used to read "the labelled A/B gate has not passed". That wording predates Phase 0; both gates passed on 2026-10-15, so it is corrected to match fact. **The decision itself is unchanged (route A stays off by default); what changed is the statement about gate status.** Written back in the same pass: the 2026-10-18 decision above lived only as one line in `TODO.md`, and that line is removed with this change.
