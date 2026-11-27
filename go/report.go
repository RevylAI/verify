package verify

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"time"
)

// ReportOptions configure Report. Leave them empty for Revyl's defaults. Credentials work as for Open: REVYL_API_KEY
// or a "verify login"; BackendURL and AppURL select another Revyl environment.
type ReportOptions struct {
	BackendURL string
	AppURL     string
	HTTPClient *http.Client
}

// SessionReport is what Revyl recorded for one session, as Report reads it after the process that ran it has exited.
type SessionReport struct {
	ID string `json:"id"`
	// ViewerURL opens the session in Revyl, with its recording and steps.
	ViewerURL string `json:"viewerUrl"`
	// Platform is "web", "ios", "android", "macos" or "linux"; empty when Revyl reports none.
	Platform string `json:"platform,omitempty"`
	// Status is Revyl's session status, such as "running", "completed", "failed", "cancelled" or "timeout".
	Status string `json:"status"`
	// Finished is whether Status is final: "completed", "failed", "cancelled" or "timeout".
	Finished bool `json:"finished"`
	// Error is the session's error message; empty when it has none.
	Error string `json:"error,omitempty"`
	// StartedAt and EndedAt are the timestamps Revyl reports, as it formats them; empty when it reports none.
	StartedAt string `json:"startedAt,omitempty"`
	EndedAt   string `json:"endedAt,omitempty"`
	// Steps are the steps in Revyl's report, in the order they ran. Empty for computers and for a session Revyl has
	// no report for yet.
	Steps []SessionReportStep `json:"steps"`
}

// SessionReportStep is one step in a SessionReport.
type SessionReportStep struct {
	// Type is the kind of step, such as "instruction" or "validation".
	Type        string `json:"type"`
	Description string `json:"description,omitempty"`
	// Status is "passed", "failed", "warning", "pending" or "running".
	Status string `json:"status"`
	// Passed is the step's verdict; nil when Revyl recorded none.
	Passed *bool `json:"passed"`
	// Reasoning is why a validation passed or failed; empty when Revyl recorded none.
	Reasoning string `json:"reasoning,omitempty"`
	Error     string `json:"error,omitempty"`
}

// Report reads a session from Revyl by its ID: its status, error, link and the steps in Revyl's report. Use it after
// the process that ran the session has exited, for example to see why a CI run failed. It works for web, iOS, Android
// and computer sessions; computers have no steps. An ID Revyl doesn't know in this API key's organization returns
// ErrNotFound.
func Report(ctx context.Context, sessionID string, options ReportOptions) (*SessionReport, error) {
	if !uuidPattern.MatchString(sessionID) {
		return nil, failure(ErrInvalidArgument, "Report takes a Revyl session ID, a UUID such as the one at the end of the session's link.")
	}
	c, viewer, err := newClient(OpenOptions{BackendURL: options.BackendURL, AppURL: options.AppURL, HTTPClient: options.HTTPClient})
	if err != nil {
		return nil, err
	}
	r, err := c.send(ctx, http.MethodGet, "/api/v1/execution/device-sessions/"+url.PathEscape(sessionID), nil, true, 30*time.Second, false)
	if err != nil {
		return nil, err
	}
	if r.status == http.StatusNotFound {
		return nil, &Error{Code: ErrNotFound, HTTPStatus: r.status, Message: fmt.Sprintf("Revyl has no session %s in this API key's organization at %s. Check the id and the API key.", sessionID, c.base)}
	}
	if r.status < 200 || r.status >= 300 {
		return nil, httpError(r)
	}
	var session struct {
		Platform     string `json:"platform"`
		Status       string `json:"status"`
		ErrorMessage string `json:"error_message"`
		StartedAt    string `json:"started_at"`
		EndedAt      string `json:"ended_at"`
	}
	if err := decode(r, &session); err != nil {
		return nil, err
	}
	report := &SessionReport{ID: sessionID, ViewerURL: viewer + "/sessions/" + url.PathEscape(sessionID), Platform: session.Platform, Status: session.Status, Finished: finalStatuses[session.Status],
		Error: session.ErrorMessage, StartedAt: session.StartedAt, EndedAt: session.EndedAt, Steps: []SessionReportStep{}}
	if report.Platform == "macos" || report.Platform == "linux" {
		report.ViewerURL += "?kind=computer"
	}
	r, err = c.send(ctx, http.MethodGet, "/api/v1/reports-v3/reports/by-session/"+url.PathEscape(sessionID)+"/context?include_steps=true&include_actions=false&include_llm_calls=false", nil, true, 30*time.Second, false)
	if err != nil {
		return nil, err
	}
	if r.status == http.StatusNotFound {
		return report, nil
	}
	if r.status < 200 || r.status >= 300 {
		return nil, httpError(r)
	}
	var stored struct {
		Steps []struct {
			StepType            string `json:"step_type"`
			StepDescription     string `json:"step_description"`
			Status              string `json:"status"`
			EffectiveStatus     string `json:"effective_status"`
			Success             *bool  `json:"success"`
			ValidationResult    *bool  `json:"validation_result"`
			ValidationReasoning string `json:"validation_reasoning"`
			ErrorMessage        string `json:"error_message"`
			ExecutionOrder      int    `json:"execution_order"`
		} `json:"steps"`
	}
	if err := decode(r, &stored); err != nil {
		return nil, err
	}
	sort.SliceStable(stored.Steps, func(i, j int) bool { return stored.Steps[i].ExecutionOrder < stored.Steps[j].ExecutionOrder })
	for _, step := range stored.Steps {
		status := step.EffectiveStatus
		if status == "" {
			status = step.Status
		}
		passed := step.ValidationResult
		if passed == nil {
			passed = step.Success
		}
		report.Steps = append(report.Steps, SessionReportStep{Type: step.StepType, Description: step.StepDescription, Status: status, Passed: passed, Reasoning: step.ValidationReasoning, Error: step.ErrorMessage})
	}
	return report, nil
}
