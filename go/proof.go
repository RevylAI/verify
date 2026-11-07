package verify

import (
	"context"
	"math"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// ProofHarness is the agent that runs a Proof of Changes run. HarnessRevyl is the only one.
type ProofHarness string

const HarnessRevyl ProofHarness = "revyl"

// EnvValue is one launch variable for a Proof of Changes run: a plain value from EnvPlain, or a reference to an
// organization launch variable from EnvSecretRef. Formatting it never prints a plain value.
type EnvValue struct {
	value     string
	secretRef string
	secret    bool
}

// EnvPlain is a plain launch value. Revyl stores it with the run and it may appear in reports, so it must not be a secret.
func EnvPlain(value string) EnvValue { return EnvValue{value: value} }

// EnvSecretRef uses the organization launch variable of the same name, which holds a secret: its value stays in Revyl,
// and only a member API key can reference it. Put it under the key name: Environment["TOKEN"] = EnvSecretRef("TOKEN").
func EnvSecretRef(name string) EnvValue { return EnvValue{secretRef: name, secret: true} }

func (v EnvValue) String() string {
	if v.secret {
		return "EnvSecretRef(" + v.secretRef + ")"
	}
	return "EnvPlain(<redacted>)"
}

func (v EnvValue) GoString() string { return v.String() }

// AuthBypass is a deep link Revyl opens after the app launches, like session.auth_bypass.deep_link in a Revyl config,
// for example "myapp://revyl-auth?token=${REVYL_AUTH_BYPASS_TOKEN}". Each ${NAME} placeholder resolves from the
// target's Environment only, on Revyl's side, so a secret's value never reaches the agent, the report, or the logs.
// Formatting it never prints the link.
type AuthBypass struct {
	DeepLink string
}

func (AuthBypass) String() string { return "AuthBypass(<redacted>)" }

func (a AuthBypass) GoString() string { return a.String() }

// ProofTarget is one target of a Proof of Changes run. Set exactly one of Build and URL.
type ProofTarget struct {
	// AppID is the Revyl app (UUID): a mobile app for Build, a Web app for URL.
	AppID string
	// Build is a mobile build: a debug .apk, a simulator .app bundle, or a .zip holding one.
	Build string
	// URL is a Web deployment to prove in a cloud browser. It must be public HTTPS on port 443, and any HTTP status of
	// 400 or above fails the page. URL builds take no headers or basic auth, so the page must load signed in or without
	// sign-in. It must stay up from the call until the run settles, which can take minutes; with NoWait, keeping it up
	// is the caller's job.
	URL string
	// Environment holds launch variables for a Build target's run, by name. An EnvPlain value may appear in reports; an
	// EnvSecretRef uses the organization launch variable of the same name and needs a member API key.
	Environment map[string]EnvValue
	// AuthBypass is a deep link for a Build target that Revyl opens after the app launches; its ${NAME} placeholders
	// resolve from Environment only.
	AuthBypass *AuthBypass
	// Version is a Build target's label, unique within the app; empty uses the short head commit plus a UTC timestamp.
	Version string
}

// ProofOptions describes what to prove: up to three Targets, one per platform, or a single target given inline with
// Build or URL, AppID, Environment, and Version. Starting the same targets (the same builds and settings) again at the
// same head returns the earlier runs in whatever state they are in; to prove again, upload a new build or push a new
// commit.
type ProofOptions struct {
	Targets []ProofTarget
	// Build, URL, AppID, Environment, AuthBypass, and Version give a single target inline, as in ProofTarget.
	Build       string
	URL         string
	AppID       string
	Environment map[string]EnvValue
	AuthBypass  *AuthBypass
	Version     string
	// Guidance is what the agent should focus on.
	Guidance string
	// Harness is the agent that runs the proof; HarnessRevyl, the default, is the only one.
	Harness ProofHarness
	// NoWait returns as soon as the runs start instead of waiting for them to settle.
	NoWait bool
	// Timeout bounds the wait and defaults to 30 minutes. The runs keep going on Revyl after it.
	Timeout time.Duration
	// Token defaults to REVYL_API_KEY or the Revyl CLI login.
	Token      string
	BackendURL string
	HTTPClient *http.Client
}

// PullRequestContext is the pull request a Proof of Changes run covers.
type PullRequestContext struct {
	Provider   string `json:"provider"`
	Repository string `json:"repository"`
	Number     int    `json:"number"`
	HeadSHA    string `json:"headSha"`
	BaseSHA    string `json:"baseSha,omitempty"`
}

// ProofTargetRun is the Proof of Changes run of one target.
type ProofTargetRun struct {
	ID    string `json:"id"`
	AppID string `json:"appId"`
	// Platform is ios, android, or web, as Revyl reports it.
	Platform string `json:"platform,omitempty"`
	// Status is Revyl's run status, as reported.
	Status string `json:"status"`
	// Verdict is passed, failed, or inconclusive once the run settles with a verdict.
	Verdict string `json:"verdict,omitempty"`
	// Label is Revyl's display label, such as "Ready", "Ready with issues", or "Partial coverage".
	Label string `json:"label,omitempty"`
	// ReportURL is the pull request comment with the report.
	ReportURL string `json:"reportUrl,omitempty"`
	ReviewURL string `json:"reviewUrl,omitempty"`
	CreatedAt string `json:"createdAt,omitempty"`
	// SettledAt is set once the run is over.
	SettledAt string `json:"settledAt,omitempty"`
	// Build is the uploaded mobile build; nil for a URL target.
	Build *UploadResult `json:"build,omitempty"`
	// URLBuild is the registered Web URL build; nil for a mobile target.
	URLBuild *URLBuildResult `json:"urlBuild,omitempty"`
}

// ProofRun is a Proof of Changes run on a pull request: one run per target.
type ProofRun struct {
	Runs []ProofTargetRun `json:"runs"`
	// Verdict is set once every run has a verdict: failed if any run failed, otherwise inconclusive if any run is
	// inconclusive (a verdict Verify doesn't recognize counts as inconclusive), otherwise passed.
	Verdict string `json:"verdict,omitempty"`
	// Label is the label of the first run whose verdict decided Verdict.
	Label string `json:"label,omitempty"`
	// ReportURL is the pull request comment with the report, from the first run that has one.
	ReportURL   string             `json:"reportUrl,omitempty"`
	PullRequest PullRequestContext `json:"pullRequest"`
}

var (
	environmentNamePattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
	deepLinkPlaceholder    = regexp.MustCompile(`\$\{([A-Za-z_][A-Za-z0-9_]*)\}`)
)

const (
	maxProofTargets     = 3
	defaultProofTimeout = 30 * time.Minute
)

var proofPollIntervals = []time.Duration{5 * time.Second, 10 * time.Second, 15 * time.Second}

// Proof uploads each target's mobile build or registers its Web deployment URL, then starts one Revyl Proof of Changes
// run per target on the pull request. Unless NoWait is set it polls until every run settles, and cancels the runs
// still going if ctx is cancelled while waiting. It needs a pull request on GitHub Actions.
//
// Revyl reports on the pull request in a comment but adds no check run, so the result is the CI gate: fail the job
// unless Verdict is "passed".
func Proof(ctx context.Context, options ProofOptions) (*ProofRun, error) {
	targets, err := proofTargets(options)
	if err != nil {
		return nil, err
	}
	harness := options.Harness
	if harness == "" {
		harness = HarnessRevyl
	}
	if harness != HarnessRevyl {
		return nil, failure(ErrInvalidArgument, "harness must be 'revyl'.")
	}
	timeout := options.Timeout
	if timeout < 0 {
		return nil, failure(ErrInvalidArgument, "Timeout must be positive.")
	}
	if timeout == 0 {
		timeout = defaultProofTimeout
	}
	pullRequest, err := detectPullRequest()
	if err != nil {
		return nil, err
	}
	c, _, err := newTokenClient(OpenOptions{BackendURL: options.BackendURL, HTTPClient: options.HTTPClient}, options.Token)
	if err != nil {
		return nil, err
	}

	runs := make([]ProofTargetRun, len(targets))
	request := createProofRunsRequest{pullRequest: pullRequest, harness: harness, guidance: strings.TrimSpace(options.Guidance)}
	platforms := map[string]bool{}
	var seen []string
	for i, target := range targets {
		var buildID, platform string
		if target.URL != "" {
			if runs[i].URLBuild, err = registerURLBuild(ctx, c, target.URL, target.AppID); err != nil {
				return nil, err
			}
			buildID, platform = runs[i].URLBuild.BuildID, runs[i].URLBuild.Platform
		} else {
			if runs[i].Build, err = UploadBuild(ctx, UploadOptions{File: target.Build, AppID: target.AppID, Version: target.Version, Token: c.token, BackendURL: options.BackendURL, HTTPClient: options.HTTPClient}); err != nil {
				return nil, err
			}
			buildID, platform = runs[i].Build.BuildID, runs[i].Build.Platform
		}
		seen = append(seen, platform)
		platforms[platform] = true
		request.targets = append(request.targets, proofRunTarget{appID: target.AppID, buildID: buildID, environment: target.Environment, authBypass: target.AuthBypass})
	}
	if len(platforms) != len(seen) {
		return nil, failure(ErrInvalidArgument, "Targets must be one per platform; got "+strings.Join(seen, ", ")+".")
	}

	started, err := createProofRuns(ctx, c, request)
	if err != nil {
		return nil, err
	}
	states := started
	for i, state := range states {
		if state.isSettled() {
			fresh, err := getProofRun(ctx, c, state.id)
			if err != nil {
				return nil, err
			}
			states[i] = fresh.withIdentity(state)
		}
	}
	if !options.NoWait {
		if states, err = waitForAll(ctx, c, states, timeout); err != nil {
			return nil, err
		}
	}
	result := &ProofRun{Runs: runs, PullRequest: pullRequest}
	for i, state := range states {
		run := &result.Runs[i]
		run.ID, run.AppID, run.Platform, run.Status = state.id, firstNonEmpty(state.appID, targets[i].AppID), state.platform, state.status
		run.Verdict, run.Label, run.ReportURL, run.ReviewURL = state.verdict, state.label, state.reportURL, state.reviewURL
		run.CreatedAt, run.SettledAt = state.createdAt, state.settledAt
		if result.ReportURL == "" {
			result.ReportURL = state.reportURL
		}
	}
	result.Verdict, result.Label = overallVerdict(result.Runs)
	return result, nil
}

func proofTargets(options ProofOptions) ([]ProofTarget, error) {
	inline := options.Build != "" || options.URL != "" || options.AppID != "" || options.Environment != nil || options.AuthBypass != nil || options.Version != ""
	if options.Targets != nil && inline {
		return nil, failure(ErrInvalidArgument, "Set Targets, or a single Build or URL with AppID, not both.")
	}
	targets := options.Targets
	if options.Targets == nil && (options.Build != "" || options.URL != "") {
		targets = []ProofTarget{{AppID: options.AppID, Build: options.Build, URL: options.URL, Environment: options.Environment, AuthBypass: options.AuthBypass, Version: options.Version}}
	}
	if len(targets) == 0 || len(targets) > maxProofTargets {
		return nil, failure(ErrInvalidArgument, "Proof needs 1 to 3 targets, one per platform.")
	}
	appIDs := map[string]bool{}
	urls := 0
	for _, target := range targets {
		web := target.URL != ""
		switch {
		case web == (target.Build != ""):
			return nil, failure(ErrInvalidArgument, "Each target takes either Build (a mobile artifact) or URL (a Web deployment), not both.")
		case web && target.Environment != nil:
			return nil, failure(ErrInvalidArgument, "Environment applies only to mobile builds; a URL target takes no launch variables.")
		case web && target.Version != "":
			return nil, failure(ErrInvalidArgument, "Version applies only to mobile builds.")
		case web && target.AuthBypass != nil:
			return nil, failure(ErrInvalidArgument, "AuthBypass applies only to mobile builds; a URL target takes no deep link.")
		case !uuidPattern.MatchString(target.AppID):
			return nil, failure(ErrInvalidArgument, "AppID must be a Revyl app id (a UUID).")
		}
		if web {
			if err := validateWebURL(target.URL); err != nil {
				return nil, err
			}
			urls++
		}
		for name, value := range target.Environment {
			if !environmentNamePattern.MatchString(name) {
				return nil, failure(ErrInvalidArgument, "Environment has an invalid variable name: use letters, digits, and underscores, not starting with a digit.")
			}
			if value.secret && value.secretRef != name {
				return nil, failure(ErrInvalidArgument, "environment variable "+name+" must reference the launch variable of the same name: EnvSecretRef(\""+name+"\").")
			}
		}
		if err := validAuthBypass(target.AuthBypass, target.Environment); err != nil {
			return nil, err
		}
		appIDs[target.AppID] = true
	}
	if len(appIDs) != len(targets) {
		return nil, failure(ErrInvalidArgument, "Each target needs its own AppID, one per platform.")
	}
	if urls > 1 {
		return nil, failure(ErrInvalidArgument, "Targets take at most one URL: one target per platform.")
	}
	return targets, nil
}

func validAuthBypass(authBypass *AuthBypass, environment map[string]EnvValue) error {
	if authBypass == nil {
		return nil
	}
	if strings.TrimSpace(authBypass.DeepLink) == "" {
		return failure(ErrInvalidArgument, "AuthBypass needs a non-empty DeepLink.")
	}
	var missing []string
	seen := map[string]bool{}
	for _, match := range deepLinkPlaceholder.FindAllStringSubmatch(authBypass.DeepLink, -1) {
		if _, ok := environment[match[1]]; !ok && !seen[match[1]] {
			seen[match[1]] = true
			missing = append(missing, "${"+match[1]+"}")
		}
	}
	if len(missing) > 0 {
		return failure(ErrInvalidArgument, "AuthBypass.DeepLink uses "+strings.Join(missing, ", ")+", which the target's Environment doesn't set. Placeholders resolve only from the target's Environment.")
	}
	return nil
}

func overallVerdict(runs []ProofTargetRun) (string, string) {
	decide := func(verdict string) string {
		if verdict == "passed" || verdict == "failed" {
			return verdict
		}
		return "inconclusive"
	}
	verdict := "passed"
	for _, run := range runs {
		switch {
		case run.Verdict == "":
			return "", ""
		case decide(run.Verdict) == "failed":
			verdict = "failed"
		case decide(run.Verdict) == "inconclusive" && verdict == "passed":
			verdict = "inconclusive"
		}
	}
	for _, run := range runs {
		if decide(run.Verdict) == verdict {
			return verdict, run.Label
		}
	}
	return verdict, ""
}

func waitForAll(ctx context.Context, c *client, states []proofRunState, timeout time.Duration) ([]proofRunState, error) {
	deadline := time.Now().Add(timeout)
	unsettled := func() []string {
		var ids []string
		for _, state := range states {
			if !state.isSettled() {
				ids = append(ids, state.id)
			}
		}
		return ids
	}
	for poll := 0; len(unsettled()) > 0; poll++ {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return states, failure(ErrTimeout, "Proof of Changes had no verdict for "+strings.Join(unsettled(), ", ")+" after "+strconv.Itoa(int(math.Round(timeout.Seconds())))+" s. The runs keep going on Revyl."+proofRunLink(states))
		}
		err := pause(ctx, min(proofPollIntervals[min(poll, len(proofPollIntervals)-1)], remaining))
		for i := 0; err == nil && i < len(states); i++ {
			if states[i].isSettled() {
				continue
			}
			var fresh proofRunState
			if fresh, err = getProofRun(ctx, c, states[i].id); err == nil {
				states[i] = fresh.withIdentity(states[i])
			}
		}
		if ctx.Err() != nil {
			return states, cancelUnsettledProofRuns(ctx, c, unsettled())
		}
		if err != nil {
			return states, err
		}
	}
	var ended []string
	for _, state := range states {
		if state.verdict == "" {
			ended = append(ended, state.id+" ("+firstNonEmpty(state.label, state.status)+")")
		}
	}
	if len(ended) > 0 {
		return states, failure(ErrProofRunEnded, "Proof of Changes run "+strings.Join(ended, ", ")+" ended without a verdict."+proofRunLink(states))
	}
	return states, nil
}

func cancelUnsettledProofRuns(ctx context.Context, c *client, ids []string) error {
	cancelCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), proofRunCancelTimeout)
	defer cancel()
	var failed error
	for _, id := range ids {
		if err := cancelProofRun(cancelCtx, c, id); err != nil && failed == nil {
			failed = err
		}
	}
	if failed != nil {
		return &Error{Code: ErrAPI, Message: "Proof of Changes was interrupted, but cancelling its runs failed: " + failed.Error(), Cause: failed}
	}
	return ctx.Err()
}

func detectPullRequest() (PullRequestContext, error) {
	identity, err := detectScmIdentity(UploadOptions{}, os.Getenv)
	if err != nil {
		return PullRequestContext{}, err
	}
	if identity == nil || identity.CISystem != "github-actions" || identity.PR <= 0 {
		return PullRequestContext{}, failure(ErrPRContextMissing, "Proof needs a pull_request event on GitHub Actions to know the repository, pull request, and head commit.")
	}
	return PullRequestContext{Provider: "github", Repository: identity.Repository, Number: identity.PR, HeadSHA: identity.Commit, BaseSHA: identity.BaseCommit}, nil
}

func proofRunLink(states []proofRunState) string {
	for _, state := range states {
		if link := firstNonEmpty(state.reportURL, state.reviewURL); link != "" {
			return " See " + link
		}
	}
	return ""
}
