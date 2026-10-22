package service

import (
	"sync"
	"time"
)

// Query-vector cache (P1-1a / P1-1b of the retrieval-latency work).
//
// The problem it solves is measured, not hypothetical: on the 2026-10-22
// baseline a single evidence retrieval spent ~11.5ms p50 on the embedding
// round trip, and the EVIDENCE path paid it TWICE — once in the note path
// (fuseSemantic) and once in the page path (pageVectorRecall). With a local
// endpoint that is invisible; with a remote one (OpenAI / Voyage / Jina) the
// same query costs 150-500ms twice, inside a 3s EvidenceBudget.
//
// A query embedding is a pure function of (endpoint, model, query): the same
// model turns the same string into the same vector. So caching it is not an
// approximation — it is memoisation of a deterministic function.
//
// Two things it is deliberately NOT:
//
//   - It is never written to disk. The vector is derived from the user's own
//     question text, and a question may contain secrets from their notes.
//   - It is not shared between processes. It lives on the Service, so it dies
//     with the app.
//
// The cache is dropped whenever the embedding configuration changes (endpoint,
// model, key or dimension): the whole point of the key is that a different
// model produces a different vector, and a stale vector would silently score
// against the wrong space.

const (
	// queryVectorTTL bounds how long a cached vector may be served. The
	// function is deterministic, so the TTL is not a correctness requirement —
	// it bounds memory and keeps a reconfigured remote endpoint from being
	// shadowed by an old entry for longer than the user expects.
	queryVectorTTL = 5 * time.Minute

	// queryVectorMaxEntries bounds the cache size. 128 queries is far more
	// than one interactive session re-asks, and each entry is one embedding
	// (a few KB), so the ceiling is a few hundred KB at most.
	queryVectorMaxEntries = 128
)

// queryVectorEntry is one cached embedding.
type queryVectorEntry struct {
	vec     []float32
	stored  time.Time
	expires time.Time
}

// queryVectorCache memoises query embeddings.
type queryVectorCache struct {
	mu      sync.Mutex
	entries map[string]queryVectorEntry
	// order is the insertion order, used for eviction. Keeping a separate
	// order list avoids scanning the map for the oldest entry.
	order []string
}

// queryVectorCacheStore is the process-wide instance carried by Service.
// It is a value (not a pointer) so the zero value is ready to use.
type queryVectorCacheStore struct {
	queryVec queryVectorCache
}

// queryVectorKey identifies an embedding: the model that produced it, its
// dimension, and the query text. The endpoint is included so a switch to a
// different server cannot serve a vector from the old one.
func queryVectorKey(endpoint, model, dim, query string) string {
	return endpoint + "\x00" + model + "\x00" + dim + "\x00" + query
}

// get returns a cached vector for the key, if one is present and unexpired.
func (c *queryVectorCache) get(key string) ([]float32, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[key]
	if !ok {
		return nil, false
	}
	if time.Now().After(e.expires) {
		c.removeLocked(key)
		return nil, false
	}
	return e.vec, true
}

// put stores a vector, evicting the oldest entry when the cache is full.
func (c *queryVectorCache) put(key string, vec []float32) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.entries == nil {
		c.entries = make(map[string]queryVectorEntry, queryVectorMaxEntries)
	}
	if _, exists := c.entries[key]; !exists {
		c.order = append(c.order, key)
	}
	c.entries[key] = queryVectorEntry{
		vec:     vec,
		stored:  time.Now(),
		expires: time.Now().Add(queryVectorTTL),
	}
	// Evict from the front of the insertion order until the cache fits.
	for len(c.order) > queryVectorMaxEntries {
		oldest := c.order[0]
		c.order = c.order[1:]
		delete(c.entries, oldest)
	}
}

// removeLocked drops one entry. The caller holds c.mu.
func (c *queryVectorCache) removeLocked(key string) {
	delete(c.entries, key)
	for i, k := range c.order {
		if k == key {
			c.order = append(c.order[:i], c.order[i+1:]...)
			break
		}
	}
}

// clear drops every entry. Called when the embedding configuration changes.
func (c *queryVectorCache) clear() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries = nil
	c.order = nil
}
