package verify

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"time"
)

// Revyl's Proof API, as declared in revyl-cli/docs/proof-api.md. This file is the only place that knows its paths, wire
// shapes, and refusal codes.

const (
	proofRunsPath         = "/api/v1/proof-runs"
	proofRunCreateTimeout = 60 * time.Second
	proofRunGetTimeout    = 30 * time.Second
	proofRunCancelTimeout = 15 * time.Second
)

var proofRunCreateRetryDelays = []time.Duration{500 * time.Millisecond, time.Second, 2 * time.Second}

type proofRefusal struct {
	code Code
	hint string
}

var proofRunRefusals = map[string]proofRefusal{
	"principal_not_allowed":                    {ErrAuthRejected, "The Proof API takes a Revyl member API key or a Revyl CI runner job key."},
	"access_denied":                            {ErrAuthRejected, "Starting proofs needs the Member role or higher; a Viewer's key is refused."},
	"environment_secret_ref_not_allowed":       {ErrSecretRefNotAllowed, "Only a member API key can reference a secret launch variable; a CI runner job key cannot. Use a member key, or pass the variable as a plain non-secret value."},
	"repository_not_accessible":                {ErrGitHubAppNotConnected, "Grant the repository to the Revyl GitHub App, then run `revyl github status`."},
	"github_app_not_connected":                 {ErrGitHubAppNotConnected, "Run `revyl github connect`, or grant the repository to the Revyl GitHub App."},
	"pull_request_not_found":                   {ErrNotFound, ""},
	"app_not_found":                            {ErrNotFound, ""},
	"build_not_found":                          {ErrNotFound, ""},
	"proof_run_not_found":                      {ErrNotFound, ""},
	"pull_request_not_open":                    {ErrPRClosed, ""},
	"head_sha_mismatch":                        {ErrHeadNotCurrent, "The pull request moved on; prove its current head."},
	"base_sha_mismatch":                        {ErrHeadNotCurrent, "The pull request's base moved on; prove it again from a fresh run of the job."},
	"config_managed_review":                    {ErrConfigManagedReview, "The repository's own Revyl config already proves this head."},
	"proof_settings_conflict":                  {ErrProofRunConflict, "Proofs with other apps, settings, or environment already cover this head; upload a new build or push a new commit to prove again."},
	"untrusted_pull_request_head":              {ErrUntrustedPRHead, "Pull requests from forks are not proved."},
	"build_not_supported":                      {ErrBuildRejected, ""},
	"build_scm_mismatch":                       {ErrBuildRejected, "The build was uploaded for another repository, pull request, or commit."},
	"unsupported_platform":                     {ErrBuildRejected, ""},
	"duplicate_target_platform":                {ErrInvalidArgument, ""},
	"web_build_unreachable":                    {ErrPreviewUnreachable, "The Web URL must be reachable from the request until its run settles."},
	"environment_not_supported_on_web":         {ErrInvalidArgument, ""},
	"environment_secret_ref_not_found":         {ErrInvalidArgument, "Create the organization launch variable first."},
	"environment_secret_ref_alias_unsupported": {ErrInvalidArgument, ""},
	"environment_secret_value_refused":         {ErrInvalidArgument, "Reference the secret launch variable by name instead of sending its value."},
	"harness_not_supported":                    {ErrInvalidArgument, ""},
	"invalid_request":                          {ErrInvalidArgument, ""},
	"proof_run_limit_reached":                  {ErrProofRunLimit, "Too many Proof API runs are queued or running for the organization; try again once some settle."},
	"provider_unavailable":                     {ErrProviderUnavailable, "Revyl could not reach GitHub."},
}

// proofRunState is one run as Revyl reports it. appID and platform come from the create response; a GET may not repeat them.
type proofRunState struct {
	id, appID, platform, status, verdict, label, reportURL, reviewURL, createdAt, settledAt string
}

type proofRunTarget struct {
	appID, buildID string
	environment    map[string]EnvValue
}

type createProofRunsRequest struct {
	pullRequest PullRequestContext
	targets     []proofRunTarget
	harness     ProofHarness
	guidance    string
}

// createProofRuns starts one run per target, retrying 5xx and network errors like an upload does: a repeat of the
// same request returns the existing runs, so it is safe to send again.
func createProofRuns(ctx context.Context, c *client, request createProofRunsRequest) ([]proofRunState, error) {
	targets := make([]map[string]any, 0, len(request.targets))
	for _, target := range request.targets {
		wire := map[string]any{"app_id": target.appID, "build_id": target.buildID}
		if len(target.environment) > 0 {
			environment := make(map[string]map[string]string, len(target.environment))
			for name, value := range target.environment {
				if value.secret {
					environment[name] = map[string]string{"secret_ref": value.secretRef}
				} else {
					environment[name] = map[string]string{"value": value.value}
				}
			}
			wire["environment"] = environment
		}
		targets = append(targets, wire)
	}
	scm := map[string]any{
		"provider":  request.pullRequest.Provider,
		"repo":      request.pullRequest.Repository,
		"pr_number": request.pullRequest.Number,
		"head_sha":  request.pullRequest.HeadSHA,
	}
	if request.pullRequest.BaseSHA != "" {
		scm["base_sha"] = request.pullRequest.BaseSHA
	}
	settings := map[string]any{"harness": request.harness}
	if request.guidance != "" {
		settings["guidance"] = request.guidance
	}
	r, err := sendProofRunsCreate(ctx, c, map[string]any{"targets": targets, "scm": scm, "settings": settings})
	if err != nil {
		return nil, err
	}
	if r.status < 200 || r.status >= 300 {
		return nil, proofRunError(r, http.MethodPost, proofRunsPath)
	}
	var wire struct {
		Runs []json.RawMessage `json:"runs"`
	}
	if err := decode(r, &wire); err != nil {
		return nil, err
	}
	if len(wire.Runs) != len(request.targets) {
		return nil, &Error{Code: ErrAPI, HTTPStatus: r.status, Message: "Revyl answered POST " + proofRunsPath + " without one run per target."}
	}
	states := make([]proofRunState, 0, len(wire.Runs))
	for _, raw := range wire.Runs {
		state, err := wireProofRun(raw, r.status, "POST "+proofRunsPath, "")
		if err != nil {
			return nil, err
		}
		states = append(states, state)
	}
	return states, nil
}

func sendProofRunsCreate(ctx context.Context, c *client, body any) (response, error) {
	for attempt := 0; ; attempt++ {
		r, err := c.send(ctx, http.MethodPost, proofRunsPath, body, false, proofRunCreateTimeout, false)
		retryable := r.status >= 500
		if err != nil {
			retryable = errors.Is(err, ErrAPI) || errors.Is(err, ErrTimeout)
		}
		if !retryable || attempt >= len(proofRunCreateRetryDelays) || ctx.Err() != nil {
			return r, err
		}
		if err := pause(ctx, proofRunCreateRetryDelays[attempt]); err != nil {
			return response{}, err
		}
	}
}

func getProofRun(ctx context.Context, c *client, id string) (proofRunState, error) {
	path := proofRunsPath + "/" + url.PathEscape(id)
	r, err := c.send(ctx, http.MethodGet, path, nil, true, proofRunGetTimeout, false)
	if err != nil {
		return proofRunState{}, err
	}
	return decodeProofRun(r, http.MethodGet, path, id)
}

// cancelProofRun stops the run's agent and releases its device; cancelling a settled run changes nothing.
func cancelProofRun(ctx context.Context, c *client, id string) error {
	path := proofRunsPath + "/" + url.PathEscape(id) + "/cancel"
	r, err := c.send(ctx, http.MethodPost, path, nil, true, proofRunCancelTimeout, false)
	if err != nil {
		return err
	}
	if r.status < 200 || r.status >= 300 {
		return proofRunError(r, http.MethodPost, path)
	}
	return nil
}

// withIdentity keeps the app and platform the create response named for the run.
func (s proofRunState) withIdentity(known proofRunState) proofRunState {
	s.appID, s.platform = firstNonEmpty(known.appID, s.appID), firstNonEmpty(known.platform, s.platform)
	return s
}

// isSettled reports whether the run is over: it has settled, or its status is one Revyl never leaves.
func (s proofRunState) isSettled() bool {
	switch s.status {
	case "passed", "failed", "inconclusive", "cancelled", "superseded":
		return true
	}
	return s.settledAt != ""
}

func decodeProofRun(r response, method, path, knownID string) (proofRunState, error) {
	if r.status < 200 || r.status >= 300 {
		return proofRunState{}, proofRunError(r, method, path)
	}
	return wireProofRun(r.body, r.status, method+" "+path, knownID)
}

func wireProofRun(raw json.RawMessage, status int, what, knownID string) (proofRunState, error) {
	var wire map[string]json.RawMessage
	if json.Unmarshal(raw, &wire) != nil {
		wire = nil
	}
	text := func(key string) string {
		var value string
		_ = json.Unmarshal(wire[key], &value)
		return value
	}
	state := proofRunState{
		id:        firstNonEmpty(text("proof_run_id"), knownID),
		appID:     text("app_id"),
		platform:  text("platform"),
		verdict:   text("verdict"),
		label:     text("display_status_label"),
		reportURL: text("report_url"),
		reviewURL: text("review_url"),
		createdAt: text("created_at"),
		settledAt: text("settled_at"),
	}
	if state.id == "" || json.Unmarshal(wire["status"], &state.status) != nil {
		return proofRunState{}, &Error{Code: ErrAPI, HTTPStatus: status, Message: "Revyl returned a proof run to " + what + " without an id and status."}
	}
	if state.verdict == "" && (state.status == "passed" || state.status == "failed" || state.status == "inconclusive") {
		state.verdict = state.status
	}
	return state, nil
}

func proofRunError(r response, method, path string) error {
	failed := httpError(r).(*Error)
	if failed.Code == ErrEdgeBlocked {
		return failed
	}
	var body struct {
		Code                any `json:"code"`
		Detail              any `json:"detail"`
		ExistingProofRunIDs any `json:"existing_proof_run_ids"`
	}
	_ = json.Unmarshal(r.body, &body)
	code, _ := body.Code.(string)
	detail, _ := body.Detail.(string)
	if len(detail) > 500 {
		detail = detail[:500]
	}
	var runIDs []string
	ids, _ := body.ExistingProofRunIDs.([]any)
	for _, id := range ids {
		if text, ok := id.(string); ok && text != "" {
			runIDs = append(runIDs, text)
		}
	}
	if code == "" {
		return failed
	}
	known, ok := proofRunRefusals[code]
	if !ok {
		failed.Message += " (" + code + ")"
		failed.ProofRunIDs = runIDs
		return failed
	}
	message := fmt.Sprintf("Revyl refused the proof (HTTP %d, %s)", r.status, code)
	if detail != "" {
		message += ": " + detail
	}
	message += "."
	if known.hint != "" {
		message += " " + known.hint
	}
	return &Error{Code: known.code, HTTPStatus: r.status, Message: message, ProofRunIDs: runIDs}
}
