package service

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"repotory/internal/db"
)

// A gateway can answer HTTP 200 with an error envelope and no choices at all.
// OpenRouter does this when the upstream provider's worker pool is saturated:
// the body carries {"error":{"message":"...ResourceExhausted..."},"metadata":
// {"error_type":"provider_unavailable"}} and no choices array. The old code
// only looked at Choices, so the provider's own explanation was thrown away
// and the user saw "AI endpoint returned no choices" — which names neither the
// cause nor the remedy, and reads as a broken wiring.

func TestProviderErrorRendering(t *testing.T) {
	cases := []struct {
		name string
		body string
		want []string
		none bool
	}{
		{
			name: "no error envelope",
			body: `{"choices":[]}`,
			none: true,
		},
		{
			name: "message only",
			body: `{"error":{"message":"model not loaded"}}`,
			want: []string{"model not loaded"},
		},
		{
			name: "error type only",
			body: `{"error":{"metadata":{"error_type":"provider_unavailable"}}}`,
			want: []string{"provider_unavailable"},
		},
		{
			name: "message and error type",
			body: `{"error":{"message":"Worker local total request limit reached (16/16)","metadata":{"error_type":"provider_unavailable"}}}`,
			want: []string{"provider_unavailable", "Worker local total request limit reached"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var cr chatResponse
			if err := json.Unmarshal([]byte(tc.body), &cr); err != nil {
				t.Fatal(err)
			}
			err := cr.providerError()
			if tc.none {
				if err != nil {
					t.Fatalf("providerError = %v, want nil", err)
				}
				return
			}
			if err == nil {
				t.Fatal("providerError = nil, want the provider's own error")
			}
			for _, want := range tc.want {
				if !strings.Contains(err.Error(), want) {
					t.Errorf("error %q does not mention %q", err, want)
				}
			}
		})
	}
}

// End to end through the real HTTP path: a 200 body with an error envelope and
// no choices must surface the provider's words, not "no choices".
func TestAskAISurfacesProviderError(t *testing.T) {
	body := `{"id":"gen-1","error":{"message":"Upstream error from Nvidia: ResourceExhausted: Worker local total request limit reached (16/16)","code":502,"metadata":{"error_type":"provider_unavailable"}}}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()

	svc, _ := setupService(t)
	if err := db.SetConfig(svc.db, "ai_chat_base_url", srv.URL); err != nil {
		t.Fatal(err)
	}
	if err := db.SetConfig(svc.db, "ai_chat_model", "test-model"); err != nil {
		t.Fatal(err)
	}

	_, err := svc.AskAI(0, "问题")
	if err == nil {
		t.Fatal("expected an error for a 200 body carrying an error envelope")
	}
	msg := err.Error()
	if !strings.Contains(msg, "provider_unavailable") {
		t.Errorf("error %q does not carry the provider's error_type", msg)
	}
	if !strings.Contains(msg, "ResourceExhausted") {
		t.Errorf("error %q does not carry the provider's message", msg)
	}
	if strings.Contains(msg, "no choices") {
		t.Errorf("error %q still collapses to the unhelpful 'no choices' wording", msg)
	}
}

// A body with neither choices nor an error envelope is genuinely malformed, and
// the old wording is still the accurate one for it.
func TestAskAIKeepsNoChoicesWordingWhenThereIsNoErrorEnvelope(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[]}`))
	}))
	defer srv.Close()

	svc, _ := setupService(t)
	if err := db.SetConfig(svc.db, "ai_chat_base_url", srv.URL); err != nil {
		t.Fatal(err)
	}
	if err := db.SetConfig(svc.db, "ai_chat_model", "test-model"); err != nil {
		t.Fatal(err)
	}

	_, err := svc.AskAI(0, "问题")
	if err == nil {
		t.Fatal("expected an error for a body with no choices")
	}
	if !strings.Contains(err.Error(), "no choices") {
		t.Errorf("error %q should keep the 'no choices' wording for a truly empty body", err)
	}
}
