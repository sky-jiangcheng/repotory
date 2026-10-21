package service

import (
	"log"

	"repotory/internal/db"
	"repotory/internal/search/graph"
)

// Graph-aware page evidence (ADR-0018 lane 2, schema v23). The consumer half: when
// wiki_graph_search is on, page evidence retrieval is STAGED — the FTS hits (if
// any) are the seeds and keep their exact bm25 order as the page prefix; only
// when the trigram lexicon finds nothing does page-vector recall seed instead
// (the "向量粗筛" fallback below); the whitelist-edge expansion then APPENDS
// neighbours behind the prefix, PPR-ordered ("图精排"), so a page that is
// structurally adjacent to a hit — or that the query only reaches semantically
// — can still be cited. When the switch is OFF (the default), evidencePages
// returns the exact FTS ordering it always has: zero behavior regression, which
// is the acceptance bar ADR-0018 lane 2 sets for the off state.
//
// The seeding is staged rather than fused on purpose, and the reason is
// measured, not aesthetic: fusing FTS and vector seeds into one PPR reset —
// uniform or RRF-weighted — lets the seed flood REORDER direct hits, and
// condition 10② demands "k=2..20 all positive, no case regression". On the
// 2026-10-21 dense corpus (27 pages / 55 edges) the fused variants measured
// -0.182 (uniform) and +0.136 @k=10 with negative deltas below k=7 plus one
// regressed case (RRF), so both were rejected; the staged shape keeps the
// recall prefix byte-identical and adds strictly after it. See the promotion
// record in the ADR.
//
// The design keeps the two index spaces apart: page ids are ordered with
// page-vector recall and PPR inside the page id space only, and the result is
// handed back as an ordered []EvidenceItem that GatherEvidence interleaves with
// notes by position — never fused into one RRF with note ids (the collision
// trap). See wiki_evidence.go.

// wikiGraphSearchKey gates graph-aware evidence. Default OFF.
const wikiGraphSearchKey = "wiki_graph_search"

// graphSearchEnabled reports whether graph-aware page evidence is on. Anything
// other than "1" (including unset) keeps it OFF, so the safe state is the default.
func (s *Service) graphSearchEnabled() bool {
	v, err := db.GetConfig(s.db, wikiGraphSearchKey)
	return err == nil && v == "1"
}

// graphExpandHops is how far expansion walks. 1 hop by default (ADR-0018 待决 5:
// "default 1 hop, 2 only after abeval shows a gain"), with 2 available as a tuned
// value. Kept a const so the abeval gate can widen it in one place.
const graphExpandHops = 1

// graphMaxNeighbors bounds the expansion so a hub page with hundreds of approved
// neighbours cannot flood the evidence budget. The triple budget in GatherEvidence
// is the real backstop; this is the per-query input cap.
const graphMaxNeighbors = 50

// graphAdjacencyEdgeLimit bounds the subgraph loaded for PPR, so a pathological hub
// cannot pull an unbounded graph into memory inside the 3s deadline.
const graphAdjacencyEdgeLimit = 2000

// pageVecRecallK bounds how many page-vector ids seed when the lexicon found
// nothing. Deliberately small (not the 20 the note path recalls): on a
// personal-knowledge corpus the compiled pages are stylistically alike, so a
// deep KNN list is mostly noise — the first abeval run with 20 uniform fused
// seeds collapsed every query to the same hub ordering (delta -0.182). Eight
// seeds are a coarse-filter nudge, not a second corpus scan.
const pageVecRecallK = 8

// pageVectorRecall recalls approved pages by page-vector KNN for the query —
// the page twin of fuseSemantic's vector arm, and lane 2's "向量粗筛" stage: a
// query phrased differently from the page text still reaches the right seed,
// and the graph expansion then does the precision work ("图精排").
//
// Every gate is a degrade-to-nil, never an error: consent (semantic_search —
// the same key the note path inherits, so page embedding spends no endpoint
// without it), a configured endpoint, a built index, and a successful
// embed+KNN are ALL required; anything else returns nil and seeding falls back
// to FTS-only. KNN ids are re-filtered through PageHitsByIDs's approved check,
// so a stale vector for a since-unapproved page cannot enter evidence.
func (s *Service) pageVectorRecall(query string, k int) []db.WikiPage {
	if !s.semanticEnabled() {
		return nil
	}
	emb, ok := s.noteEmbedder()
	if !ok {
		return nil
	}
	if !db.PageVectorIndexReady(s.db) {
		return nil
	}
	vecs, err := emb.Embed([]string{query})
	if err != nil || len(vecs) == 0 || len(vecs[0]) == 0 {
		if err != nil {
			log.Printf("wiki graph evidence: query embed failed; FTS seeds only: %v", err)
		}
		return nil
	}
	if k <= 0 {
		k = pageVecRecallK
	}
	ids, err := db.KnnPageIDs(s.db, vecs[0], k)
	if err != nil {
		log.Printf("wiki graph evidence: page KNN failed; FTS seeds only: %v", err)
		return nil
	}
	if len(ids) == 0 {
		return nil
	}
	pages, err := db.PageHitsByIDs(s.db, ids)
	if err != nil {
		log.Printf("wiki graph evidence: vector-recall load failed; FTS seeds only: %v", err)
		return nil
	}
	// KNN order is the recall order; PageHitsByIDs makes no order promise.
	byID := make(map[int64]db.WikiPage, len(pages))
	for _, p := range pages {
		byID[p.ID] = p
	}
	out := make([]db.WikiPage, 0, len(ids))
	for _, id := range ids {
		if p, ok := byID[id]; ok {
			out = append(out, p)
		}
	}
	return out
}

// graphNeighborOrder orders the whitelist-edge neighbours of the seed set: PPR
// with the seeds as the reset vector, with the seeds themselves filtered out of
// the output (the caller owns the seed prefix — it is the recall order and must
// not be re-ranked here), and any neighbour PPR did not surface appended in
// expansion order. Returns nil when the switch is off, the seed set is empty,
// or expansion finds nothing — the caller then just keeps its prefix. Errors
// degrade to nil with a log: graph evidence is an enrichment, and a failure
// must never turn AskAI into an error (the same "never errors" contract
// GatherEvidence holds).
func (s *Service) graphNeighborOrder(seedIDs []int64) []int64 {
	if !s.graphSearchEnabled() || len(seedIDs) == 0 {
		return nil
	}
	nbrs, err := db.WikiGraphNeighbors(s.db, seedIDs, graphExpandHops)
	if err != nil {
		log.Printf("wiki graph evidence: expansion failed, keeping recall order: %v", err)
		return nil
	}
	if len(nbrs) == 0 {
		return nil // an isolated hit has no neighbours; the recall order stands
	}
	if len(nbrs) > graphMaxNeighbors {
		nbrs = nbrs[:graphMaxNeighbors]
	}

	// Uniform reset is enough here: the seeds' own order is the caller's prefix
	// and is not re-ranked, so the reset only shapes WHICH neighbours surface
	// first — the ones most reachable from the hit set. Neighbours are NOT in
	// the reset — they only accrue score by being reached from a seed, which is
	// what makes "adjacent to a hit" rank below "is a hit".
	reset := make(map[int64]float64, len(seedIDs))
	for _, id := range seedIDs {
		reset[id] = 1
	}
	adj, err := db.WikiAdjacency(s.db, seedIDs, graphExpandHops, graphAdjacencyEdgeLimit)
	if err != nil {
		log.Printf("wiki graph evidence: adjacency load failed, keeping recall order: %v", err)
		return nil
	}
	ranked := graph.PPR(adj, reset, 0.85, 20, len(seedIDs)+len(nbrs))

	isSeed := make(map[int64]bool, len(seedIDs))
	for _, id := range seedIDs {
		isSeed[id] = true
	}
	out := make([]int64, 0, len(nbrs))
	seen := make(map[int64]bool, len(nbrs))
	for _, id := range ranked {
		if !isSeed[id] && !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	for _, n := range nbrs {
		if !isSeed[n.PageID] && !seen[n.PageID] {
			seen[n.PageID] = true
			out = append(out, n.PageID)
		}
	}
	return out
}
