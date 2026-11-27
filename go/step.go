package verify

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

type liveStep struct {
	Success *bool `json:"success"`
	Output  struct {
		Status     string `json:"status"`
		Reason     string `json:"status_reason"`
		Reasoning  string `json:"reasoning"`
		Validation *bool  `json:"validation_result"`
		Extracted  *struct {
			Information *string `json:"information"`
		} `json:"extracted_data"`
		Engine string `json:"engine"`
	} `json:"step_output"`
}

func (s *Session) Instruction(ctx context.Context, text string, options ...StepOption) (StepResult, error) {
	if s.platform.computer() {
		return StepResult{}, failure(ErrNotAvailableOnPlatform, "Instruction is not available on computers. To click one thing by its description, use Tap(ctx, verify.Element(\"the Save button\")); to type into a field, use Type(ctx, verify.Element(\"the search field\"), text). Validation and Extract do work on a Mac opened with Inference set to true. See "+s.viewer)
	}
	settings, agent, err := splitOptions[StepOptions](options, "Instruction")
	if err != nil {
		return StepResult{}, err
	}
	if len(settings) > 1 {
		return StepResult{}, failure(ErrInvalidArgument, "Instruction accepts at most one options value.")
	}
	var timeout time.Duration
	if len(settings) == 1 {
		timeout = settings[0].Timeout
	}
	result, err := s.step(ctx, "instruction", text, timeout, agent)
	if err == nil && !result.Passed {
		err = failure(ErrInstructionFailed, "Instruction failed: \""+result.Text+"\". "+stepReason(result)+" See "+s.viewer)
	}
	return result, err
}

// Validation asks whether something holds on screen, and returns ErrValidationFailed when it does not, unless Soft is
// set. On a Mac computer it runs on the Mac's own vision model and needs one opened with Inference set to true.
func (s *Session) Validation(ctx context.Context, text string, options ...ValidationOption) (StepResult, error) {
	settings, agent, err := splitOptions[ValidationOptions](options, "Validation")
	if err != nil {
		return StepResult{}, err
	}
	if len(settings) > 1 {
		return StepResult{}, failure(ErrInvalidArgument, "Validation accepts at most one options value.")
	}
	var opt ValidationOptions
	if len(settings) == 1 {
		opt = settings[0]
	}
	if s.platform.computer() {
		result, err := s.computerStep(ctx, "validation", text, opt.Timeout, agent != nil)
		if err == nil && !result.Passed && !opt.Soft {
			err = failure(ErrValidationFailed, "Validation failed: \""+result.Text+"\". "+reasonPrefix(result.Reason)+"See "+s.viewer)
		}
		return result, err
	}
	result, err := s.step(ctx, "validation", text, opt.Timeout, agent)
	if err == nil && !result.Passed && !opt.Soft {
		err = failure(ErrValidationFailed, "Validation failed: \""+result.Text+"\". "+stepReason(result)+" See "+s.viewer)
	}
	return result, err
}

// Extract reads a value off the screen, such as "the order number", and returns the step with it in Value. It returns
// ErrStepFailed when nothing could be read. On browsers and devices it runs on Revyl's agent, so a session opened with
// your own model returns ErrInvalidArgument; on a Mac computer it runs on the Mac's own vision model and needs one
// opened with Inference set to true.
func (s *Session) Extract(ctx context.Context, text string, options ...ExtractOptions) (StepResult, error) {
	if len(options) > 1 {
		return StepResult{}, failure(ErrInvalidArgument, "Extract accepts at most one options value.")
	}
	var timeout time.Duration
	if len(options) == 1 {
		timeout = options[0].Timeout
	}
	if s.platform.computer() {
		return s.computerStep(ctx, "extract", text, timeout, false)
	}
	return s.step(ctx, "extract", text, timeout, nil)
}

func reasonPrefix(reason string) string {
	reason = strings.TrimRight(reason, ". \t\r\n")
	if reason == "" {
		return ""
	}
	return reason + ". "
}

func stepReason(result StepResult) string {
	return sentence(result.Reason)
}

func sentence(text string) string {
	reason := strings.TrimSpace(text)
	if reason == "" {
		return "Revyl gave no reason."
	}
	if !strings.ContainsAny(reason[len(reason)-1:], ".!?") {
		reason += "."
	}
	return reason
}

func (s *Session) step(ctx context.Context, kind, text string, timeout time.Duration, agent *agent) (StepResult, error) {
	if err := s.sessionEndError(); err != nil {
		return StepResult{}, err
	}
	if strings.TrimSpace(text) == "" || textLength(text) > 4000 {
		return StepResult{}, failure(ErrInvalidArgument, "Step description must contain 1–4000 characters.")
	}
	if kind == "extract" && s.agent != nil {
		return StepResult{}, failure(ErrInvalidArgument, "Extract runs on Revyl's agent, and this session runs steps on your model because Open was passed WithModel, WithCustomModel or WithAgent. Read the value from Screenshot with your model, or open a session without them to use Extract.")
	}
	if timeout == 0 {
		timeout = s.stepTimeout
	}
	if timeout < time.Second {
		return StepResult{}, failure(ErrInvalidArgument, "Step timeout must be at least one second.")
	}
	s.mu.Lock()
	if s.stepRunning {
		s.mu.Unlock()
		return StepResult{}, failure(ErrInvalidArgument, "Run one instruction, validation or extract at a time on a session.")
	}
	s.stepRunning = true
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.stepRunning = false
		s.mu.Unlock()
	}()
	started := time.Now()
	text = strings.TrimSpace(text)
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	if expiresAt := s.ExpiresAt(); !expiresAt.IsZero() {
		var expireCancel context.CancelFunc
		ctx, expireCancel = context.WithDeadline(ctx, expiresAt)
		defer expireCancel()
	}
	if s.lifetime != nil {
		stop := context.AfterFunc(s.lifetime, cancel)
		defer stop()
		if s.lifetime.Err() != nil {
			cancel()
		}
	}
	if agent == nil {
		agent = s.agent
	}
	if agent != nil {
		return s.runLocal(ctx, kind, text, timeout, agent, started)
	}
	outcome, err := s.runStep(ctx, kind, text, timeout)
	if err != nil {
		if ended := s.sessionEndError(); ended != nil {
			return StepResult{}, ended
		}
		return StepResult{}, err
	}
	reason := outcome.Output.Reason
	if reason == "" {
		reason = outcome.Output.Reasoning
	}
	success := outcome.Success != nil && *outcome.Success
	if kind == "validation" && (!success || outcome.Output.Validation == nil) {
		return StepResult{}, failure(ErrStepFailed, "Validation did not reach a verdict. See "+s.viewer)
	}
	var value *string
	if outcome.Output.Extracted != nil {
		value = outcome.Output.Extracted.Information
	}
	if kind == "extract" && (!success || outcome.Output.Status == "failed" || value == nil) {
		why := sentence(reason)
		if success && outcome.Output.Status != "failed" {
			why = "Revyl returned no value."
		}
		return StepResult{}, failure(ErrStepFailed, "Extract read nothing: \""+text+"\". "+why+" Describe one value that is on the screen now, such as \"the order number on the confirmation\". See "+s.viewer)
	}
	passed := success && outcome.Output.Status != "failed"
	if kind == "validation" {
		passed = *outcome.Output.Validation
	}
	result := StepResult{Type: kind, Text: text, Passed: passed, Reason: reason, Duration: time.Since(started)}
	if kind == "extract" {
		result.Value = *value
	}
	if outcome.Output.Engine == "local" || outcome.Output.Engine == "hosted" {
		result.Engine = outcome.Output.Engine
	}
	return result, nil
}

func (s *Session) runStep(ctx context.Context, kind, text string, timeout time.Duration) (out liveStep, err error) {
	var stepID string
	defer func() {
		if err != nil && ctx.Err() != nil {
			if stepID != "" {
				cancelCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
				defer cancel()
				_, _ = s.client.send(cancelCtx, "POST", s.workerPath("step_cancel/"+url.PathEscape(stepID)), map[string]any{}, false, 5*time.Second, true)
			}
			err = contextError(ctx)
		}
	}()
	body := map[string]string{"step_type": kind, "step_description": text, "workflow_run_id": s.runID}
	if s.id != "" {
		body["session_id"] = s.id
	}
	r, err := s.worker(ctx, "POST", "execute_step", body, false, timeout)
	if err != nil {
		return out, err
	}
	if err := decode(r, &out); err != nil {
		return out, err
	}
	if out.Success != nil {
		return out, nil
	}
	var accepted struct {
		Status string `json:"status"`
		ID     string `json:"step_id"`
	}
	if err := decode(r, &accepted); err != nil {
		return out, err
	}
	if accepted.Status != "accepted" || accepted.ID == "" {
		return out, failure(ErrAPI, "Revyl returned neither a step result nor an accepted step ID.")
	}
	stepID = accepted.ID
	acceptedAt := time.Now()
	for wait := 500 * time.Millisecond; ; wait = min(wait*2, 5*time.Second) {
		if err := pause(ctx, wait); err != nil {
			return out, err
		}
		r, err := s.worker(ctx, "GET", "step_status/"+url.PathEscape(stepID), nil, true, 30*time.Second)
		if err != nil && liveStepNotFound(r) {
			if time.Since(acceptedAt) < liveStepGrace {
				continue
			}
			return out, responseFailure(r, ErrStepFailed, "Revyl accepted the step but could not find it for 10 s. The session is still open and the step may still be running, so wait for it to finish before sending another. See "+s.viewer)
		}
		if err != nil {
			return out, err
		}
		var status struct {
			Status string          `json:"status"`
			Result json.RawMessage `json:"result"`
		}
		if err := decode(r, &status); err != nil {
			return out, err
		}
		if status.Status == "running" {
			continue
		}
		if status.Status == "cancelled" {
			return out, failure(ErrStepFailed, "Step was cancelled before finishing. See "+s.viewer)
		}
		if status.Status != "completed" && status.Status != "failed" {
			return out, failure(ErrAPI, "Revyl returned an unknown step status.")
		}
		if len(status.Result) == 0 || string(status.Result) == "null" || json.Unmarshal(status.Result, &out) != nil || out.Success == nil {
			return out, failure(ErrAPI, "Terminal step status has no readable result.")
		}
		return out, nil
	}
}

func (s *Session) runLocal(ctx context.Context, kind, text string, timeout time.Duration, agent *agent, started time.Time) (StepResult, error) {
	name := agent.model.Name()
	attribution := strings.Map(func(r rune) rune {
		if r < 0x20 || r > 0x7e {
			return '?'
		}
		return r
	}, "Verify local: "+name)
	sessionID, err := newUUID()
	if err != nil {
		return StepResult{}, failure(ErrAPI, "Could not generate an agent session ID.")
	}
	ctx = context.WithValue(ctx, attributionKey{}, [2]string{clip(attribution, 100), sessionID})
	local, err := runLocalStep(ctx, kind, text, agent, s.platform, s, s.logLine)
	if err != nil {
		var sdkError *Error
		if ctx.Err() != nil && !(errors.As(err, &sdkError) && sdkError.Code != ErrTimeout) {
			err = &Error{Code: ErrTimeout, Message: fmt.Sprintf("The %s did not finish within %d ms on %s. See %s", kind, timeout.Milliseconds(), name, s.viewer), Cause: err}
		}
		if ended := s.sessionEndError(); ended != nil {
			err = ended
		}
		code := err.Error()
		if errors.As(err, &sdkError) {
			code = string(sdkError.Code)
		}
		s.logLine(fmt.Sprintf("✗ %s: %s", kind, code))
		return StepResult{}, err
	}
	result := StepResult{Type: kind, Text: text, Passed: local.passed, Reason: local.reason, Duration: time.Since(started), Model: local.run}
	mark, plural, why := "✓", "s", ""
	if !local.passed {
		mark = "✗"
		if local.reason != "" {
			why = ": " + local.reason
		}
	}
	if len(local.run.Turns) == 1 {
		plural = ""
	}
	s.logLine(fmt.Sprintf("%s %s (%s, %d turn%s on %s, %d tokens)%s", mark, kind, formatDuration(result.Duration), len(local.run.Turns), plural, local.run.ID, local.run.InputTokens+local.run.OutputTokens, why))
	return result, nil
}

func formatDuration(d time.Duration) string {
	ms := d.Milliseconds()
	if ms < 60_000 {
		return strconv.FormatFloat(float64(ms)/1000, 'f', 1, 64) + "s"
	}
	return fmt.Sprintf("%dm %ds", ms/60_000, int(math.Floor(float64(ms%60_000)/1000+0.5)))
}

// Revyl can briefly answer a just-accepted step's status with 404 "Live step not found" before its run is listed.
const liveStepGrace = 10 * time.Second

var liveStepNotFoundDetail = regexp.MustCompile(`(?i)^live step not found`)

func liveStepNotFound(r response) bool {
	if r.status != 404 {
		return false
	}
	var body struct {
		Detail string `json:"detail"`
	}
	return json.Unmarshal(r.body, &body) == nil && liveStepNotFoundDetail.MatchString(body.Detail)
}
