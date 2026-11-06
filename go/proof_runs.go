package verify

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"time"
)

// Built against Revyl's provisional proof-runs contract (REVL-18697), which is not declared yet. This file is the
// only place that knows the paths and wire shapes, so aligning to the declared contract changes nothing outside it.

const (
	proofRunsPath         = "/api/v1/proof-runs"
	proofRunCreateTimeout = 60 * time.Second
	proofRunGetTimeout    = 30 * time.Second
	proofRunCancelTimeout = 15 * time.Second
	proofRunGitHubAppFix  = "Proof of Changes needs the Revyl GitHub App on the repository: run `revyl github connect`, or grant the repository to the Revyl GitHub App."
)

var proofRunRefusals = map[string]Code{
	"config_managed_review":         ErrConfigManagedReview,
	"github_app_not_connected":      ErrGitHubAppNotConnected,
	"github_app_not_installed":      ErrGitHubAppNotConnected,
	"github_repository_not_granted": ErrGitHubAppNotConnected,
	"pull_request_closed":           ErrPRClosed,
	"head_sha_not_current":          ErrHeadNotCurrent,
	"app_not_found":                 ErrNotFound,
	"build_not_found":               ErrNotFound,
	"platform_mismatch":             ErrPlatformMismatch,
	"preview_unreachable":           ErrPreviewUnreachable,
	"url_unreachable":               ErrPreviewUnreachable,
}

type proofRunState struct {
	id, status, verdict, label, reportURL, reviewURL, createdAt, settledAt string
}

type createProofRunRequest struct {
	appID, buildID string
	pullRequest    PullRequestContext
	harness        ProofHarness
	guidance       string
	environment    map[string]EnvValue
}

func createProofRun(ctx context.Context, c *client, request createProofRunRequest) (proofRunState, error) {
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
	if len(request.environment) > 0 {
		environment := make(map[string]map[string]string, len(request.environment))
		for name, value := range request.environment {
			if value.secret {
				environment[name] = map[string]string{"secret_ref": value.secretRef}
			} else {
				environment[name] = map[string]string{"value": value.value}
			}
		}
		settings["environment"] = environment
	}
	body := map[string]any{"app_id": request.appID, "build_id": request.buildID, "scm": scm, "settings": settings}
	r, err := c.send(ctx, http.MethodPost, proofRunsPath, body, false, proofRunCreateTimeout, false)
	if err != nil {
		return proofRunState{}, err
	}
	return decodeProofRun(r, http.MethodPost, proofRunsPath, "")
}

func getProofRun(ctx context.Context, c *client, id string) (proofRunState, error) {
	path := proofRunsPath + "/" + url.PathEscape(id)
	r, err := c.send(ctx, http.MethodGet, path, nil, true, proofRunGetTimeout, false)
	if err != nil {
		return proofRunState{}, err
	}
	return decodeProofRun(r, http.MethodGet, path, id)
}

func cancelProofRun(ctx context.Context, c *client, id string) error {
	r, err := c.send(ctx, http.MethodPost, proofRunsPath+"/"+url.PathEscape(id)+"/cancel", nil, true, proofRunCancelTimeout, false)
	if err != nil {
		return err
	}
	if r.status == 409 || (r.status >= 200 && r.status < 300) {
		return nil
	}
	return httpError(r)
}

func decodeProofRun(r response, method, path, knownID string) (proofRunState, error) {
	if r.status < 200 || r.status >= 300 {
		return proofRunState{}, proofRunError(r, method, path)
	}
	var wire map[string]json.RawMessage
	if err := decode(r, &wire); err != nil {
		return proofRunState{}, err
	}
	text := func(key string) string {
		var value string
		_ = json.Unmarshal(wire[key], &value)
		return value
	}
	state := proofRunState{
		id:        firstNonEmpty(text("proof_run_id"), knownID),
		verdict:   text("verdict"),
		label:     text("display_status_label"),
		reportURL: text("report_url"),
		reviewURL: text("review_url"),
		createdAt: text("created_at"),
		settledAt: text("settled_at"),
	}
	if state.id == "" || json.Unmarshal(wire["status"], &state.status) != nil {
		return proofRunState{}, &Error{Code: ErrAPI, HTTPStatus: r.status, Message: "Revyl returned a proof run to " + method + " " + path + " without an id and status."}
	}
	return state, nil
}

func proofRunError(r response, method, path string) error {
	failed := httpError(r).(*Error)
	if failed.Code == ErrEdgeBlocked {
		return failed
	}
	refusal, said, runID := proofRunRefusal(r)
	code, mapped := proofRunRefusals[refusal]
	message := fmt.Sprintf("Revyl refused the proof run (HTTP %d", r.status)
	if refusal != "" {
		message += ", " + refusal
	}
	message += ")"
	if said != "" {
		message += ": " + said
	}
	message += "."
	switch {
	case code == ErrGitHubAppNotConnected:
		message += " " + proofRunGitHubAppFix
	case code == ErrConfigManagedReview:
		message += " The repository's .revyl/config.yaml already runs Proof of Changes for this head, so Proof can't start another run."
	case code == ErrPreviewUnreachable:
		message += " Revyl couldn't load the URL: it must be public HTTPS on port 443 and answer below HTTP 400 without headers or basic auth."
	case mapped:
	case r.status == 409 && runID != "":
		code = ErrProofRunConflict
		message += " Proof run " + runID + " already covers this head with different settings."
	case r.status == 404 && method == http.MethodGet:
		code = ErrNotFound
		message = fmt.Sprintf("Revyl request %s %s failed (HTTP 404).", method, path)
	default:
		return failed
	}
	return &Error{Code: code, Reason: failed.Reason, HTTPStatus: r.status, Message: message, ProofRunID: runID}
}

func proofRunRefusal(r response) (string, string, string) {
	var body map[string]any
	if json.Unmarshal(r.body, &body) != nil {
		return "", "", ""
	}
	detail, _ := body["detail"].(map[string]any)
	first := func(values ...any) string {
		for _, value := range values {
			if text, ok := value.(string); ok && text != "" {
				return text
			}
		}
		return ""
	}
	code := first(body["error"], body["code"], detail["error"], detail["code"], body["detail"])
	said := first(detail["message"], body["message"], body["detail"])
	if said == code {
		said = ""
	}
	if len(said) > 500 {
		said = said[:500]
	}
	return code, said, first(body["proof_run_id"], detail["proof_run_id"])
}
