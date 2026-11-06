package verify

import (
	"archive/zip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// UploadOptions describes a finished CI build to upload for Proof of Changes.
type UploadOptions struct {
	// File is a debug .apk, a simulator .app bundle, or a .zip holding one.
	File string
	// AppID is the Revyl app (UUID) the build belongs to.
	AppID string
	// Platform is "ios" or "android"; empty infers it from File.
	Platform string
	// Version is a label unique within the app; empty uses the short head commit plus a UTC timestamp.
	Version string
	// Repo is the base repository receiving the pull request (owner/name). It requires Commit and overrides GitHub Actions detection.
	Repo string
	// Commit is the full pull request head SHA, never a merge commit. It requires Repo.
	Commit string
	// PR selects the pull request explicitly; zero matches by commit. It requires Repo and Commit.
	PR         int
	BackendURL string
	HTTPClient *http.Client
}

// ScmIdentity is the pull request identity sent with an upload, in the fields revyl build upload sends.
type ScmIdentity struct {
	CISystem   string `json:"ciSystem"`
	Repository string `json:"repository"`
	Commit     string `json:"commit"`
	PR         int    `json:"pr,omitempty"`
	PRURL      string `json:"prUrl,omitempty"`
	Branch     string `json:"branch,omitempty"`
	BaseCommit string `json:"baseCommit,omitempty"`
	RunID      string `json:"runId,omitempty"`
	RunURL     string `json:"runUrl,omitempty"`
	Actor      string `json:"actor,omitempty"`
	ActorURL   string `json:"actorUrl,omitempty"`
}

// ReviewCorrelation reports whether Revyl attached the build to a review, as Revyl reports it. Status is "unknown" when Revyl doesn't report it.
type ReviewCorrelation struct {
	Status             string `json:"status"`
	MatchedTargetCount *int   `json:"matchedTargetCount,omitempty"`
}

// UploadResult is the uploaded build. Identity is nil when no pull request identity was found, so no review can match it.
type UploadResult struct {
	BuildID           string            `json:"buildId"`
	Version           string            `json:"version"`
	AppID             string            `json:"appId"`
	Platform          string            `json:"platform"`
	PackageID         string            `json:"packageId,omitempty"`
	Identity          *ScmIdentity      `json:"identity,omitempty"`
	ReviewCorrelation ReviewCorrelation `json:"reviewCorrelation"`
	Warnings          []string          `json:"warnings"`
}

var (
	repositoryPattern = regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)
	commitPattern     = regexp.MustCompile(`^([0-9a-f]{40}|[0-9a-f]{64})$`)
)

const (
	uploadSource          = "verify_upload"
	uploadSessionTimeout  = 30 * time.Second
	uploadPutTimeout      = 10 * time.Minute
	uploadFinalizeTimeout = 90 * time.Second
)

var uploadPutRetryDelays = []time.Duration{time.Second, 3 * time.Second}

// UploadBuild uploads a finished CI build with the pull request identity Revyl matches to a review.
// The identity is detected on GitHub Actions; set Repo and Commit elsewhere.
func UploadBuild(ctx context.Context, options UploadOptions) (*UploadResult, error) {
	if !uuidPattern.MatchString(options.AppID) {
		return nil, failure(ErrInvalidArgument, "AppID must be a Revyl app id (a UUID).")
	}
	path, platform, bundle, err := inspectArtifact(options.File, options.Platform)
	if err != nil {
		return nil, err
	}
	identity, err := detectScmIdentity(options, os.Getenv)
	if err != nil {
		return nil, err
	}
	version := strings.TrimSpace(options.Version)
	if version == "" {
		version = defaultUploadVersion(identity)
	}
	c, _, err := newClient(OpenOptions{BackendURL: options.BackendURL, HTTPClient: options.HTTPClient})
	if err != nil {
		return nil, err
	}
	if bundle {
		dir, err := os.MkdirTemp("", "verify-upload-")
		if err != nil {
			return nil, failure(ErrInvalidArgument, "Could not create a folder to zip the .app bundle in.")
		}
		defer os.RemoveAll(dir)
		if path, err = zipAppBundle(path, filepath.Join(dir, filepath.Base(path)+".zip")); err != nil {
			return nil, err
		}
	}
	headers := identityHeaders(identity)
	appPath := "/api/v1/apps/" + url.PathEscape(options.AppID) + "/builds"
	var session struct {
		UploadID    string `json:"upload_id"`
		UploadURL   string `json:"upload_url"`
		ContentType string `json:"content_type"`
	}
	r, err := c.sendWithHeaders(ctx, http.MethodPost, appPath+"/upload-session?source="+uploadSource, map[string]string{"version": version, "file_name": filepath.Base(path)}, false, uploadSessionTimeout, false, headers)
	if err := uploadCall(r, err, options.AppID, &session); err != nil {
		return nil, err
	}
	if session.UploadID == "" || session.UploadURL == "" {
		return nil, failure(ErrAPI, "Revyl returned an invalid upload session.")
	}
	if err := putArtifact(ctx, c.http, session.UploadURL, session.ContentType, path); err != nil {
		return nil, err
	}
	metadata := identityMetadata(identity, platform)
	metadata["source"] = uploadSource
	metadata["platform"] = platform
	var build struct {
		ID          string         `json:"id"`
		Version     string         `json:"version"`
		PackageName string         `json:"package_name"`
		Metadata    map[string]any `json:"metadata"`
		Correlation *struct {
			Status             string `json:"status"`
			MatchedTargetCount *int   `json:"matched_target_count"`
		} `json:"review_correlation"`
	}
	r, err = c.sendWithHeaders(ctx, http.MethodPost, appPath, map[string]any{"upload_id": session.UploadID, "version": version, "metadata": metadata}, true, uploadFinalizeTimeout, false, headers)
	if err := uploadCall(r, err, options.AppID, &build); err != nil {
		return nil, err
	}
	if build.ID == "" {
		return nil, failure(ErrAPI, "Revyl returned a build without an id.")
	}
	if build.Version != "" {
		version = build.Version
	}
	correlation := ReviewCorrelation{Status: "unknown"}
	if build.Correlation != nil && build.Correlation.Status != "" {
		correlation.Status = build.Correlation.Status
		if count := build.Correlation.MatchedTargetCount; count != nil && *count >= 0 {
			correlation.MatchedTargetCount = count
		}
	}
	return &UploadResult{
		BuildID:           build.ID,
		Version:           version,
		AppID:             options.AppID,
		Platform:          platform,
		PackageID:         build.PackageName,
		Identity:          identity,
		ReviewCorrelation: correlation,
		Warnings:          validationWarnings(build.Metadata),
	}, nil
}

func detectScmIdentity(options UploadOptions, getenv func(string) string) (*ScmIdentity, error) {
	var detected *ScmIdentity
	if getenv("GITHUB_ACTIONS") == "true" {
		detected = githubActionsIdentity(getenv)
	}
	if options.Repo == "" && options.Commit == "" && options.PR == 0 {
		if detected != nil && detected.Repository != "" && detected.Commit != "" {
			return detected, nil
		}
		return nil, nil
	}
	repository := strings.TrimSpace(options.Repo)
	commit := strings.ToLower(strings.TrimSpace(options.Commit))
	switch {
	case repository == "" || commit == "":
		return nil, failure(ErrInvalidArgument, "An explicit pull request identity needs both Repo (owner/name) and Commit (the full PR head SHA).")
	case !repositoryPattern.MatchString(repository):
		return nil, failure(ErrInvalidArgument, "Repo must be the base repository receiving the pull request, as owner/name.")
	case !commitPattern.MatchString(commit):
		return nil, failure(ErrInvalidArgument, "Commit must be the full PR head commit SHA (40 or 64 hexadecimal characters).")
	case options.PR < 0:
		return nil, failure(ErrInvalidArgument, "PR must be a positive pull request number; leave it zero to match by commit.")
	}
	identity := &ScmIdentity{CISystem: "external", Repository: repository, Commit: commit}
	if detected != nil {
		identity.CISystem, identity.RunID, identity.RunURL, identity.Actor, identity.ActorURL = detected.CISystem, detected.RunID, detected.RunURL, detected.Actor, detected.ActorURL
	}
	if options.PR > 0 {
		identity.PR = options.PR
		identity.PRURL = "https://github.com/" + repository + "/pull/" + strconv.Itoa(options.PR)
	}
	return identity, nil
}

func githubActionsIdentity(getenv func(string) string) *ScmIdentity {
	var event struct {
		PullRequest struct {
			Number  int    `json:"number"`
			HTMLURL string `json:"html_url"`
			Head    struct {
				SHA string `json:"sha"`
			} `json:"head"`
			Base struct {
				SHA string `json:"sha"`
			} `json:"base"`
		} `json:"pull_request"`
	}
	if path := strings.TrimSpace(getenv("GITHUB_EVENT_PATH")); path != "" {
		if raw, err := os.ReadFile(path); err == nil {
			_ = json.Unmarshal(raw, &event)
		}
	}
	repository := strings.TrimSpace(getenv("GITHUB_REPOSITORY"))
	server := strings.TrimRight(strings.TrimSpace(getenv("GITHUB_SERVER_URL")), "/")
	runID := strings.TrimSpace(getenv("GITHUB_RUN_ID"))
	actor := strings.TrimSpace(getenv("GITHUB_ACTOR"))
	identity := &ScmIdentity{
		CISystem:   "github-actions",
		Repository: repository,
		Commit:     firstNonEmpty(event.PullRequest.Head.SHA, getenv("REVYL_PR_HEAD_SHA"), getenv("GITHUB_SHA")),
		PRURL:      strings.TrimSpace(event.PullRequest.HTMLURL),
		Branch:     firstNonEmpty(getenv("GITHUB_HEAD_REF"), getenv("GITHUB_REF_NAME")),
		BaseCommit: strings.TrimSpace(event.PullRequest.Base.SHA),
		RunID:      runID,
		Actor:      actor,
	}
	if event.PullRequest.Number > 0 {
		identity.PR = event.PullRequest.Number
	}
	if server != "" && repository != "" && runID != "" {
		identity.RunURL = server + "/" + repository + "/actions/runs/" + runID
	}
	if server != "" && actor != "" {
		identity.ActorURL = server + "/" + actor
	}
	return identity
}

func identityHeaders(identity *ScmIdentity) map[string]string {
	headers := map[string]string{}
	if identity == nil {
		return headers
	}
	for name, value := range map[string]string{
		"X-CI-System":     identity.CISystem,
		"X-CI-Commit-SHA": identity.Commit,
		"X-CI-Branch":     identity.Branch,
		"X-CI-Run-ID":     identity.RunID,
		"X-CI-Run-URL":    identity.RunURL,
		"X-CI-Repository": identity.Repository,
		"X-CI-Actor":      identity.Actor,
		"X-CI-Actor-URL":  identity.ActorURL,
		"X-CI-PR-URL":     identity.PRURL,
	} {
		if value != "" && headerSafe(value) {
			headers[name] = value
		}
	}
	if identity.PR > 0 {
		headers["X-CI-PR-Number"] = strconv.Itoa(identity.PR)
	}
	return headers
}

func headerSafe(value string) bool {
	for _, char := range value {
		if char < 32 || char > 126 {
			return false
		}
	}
	return true
}

func identityMetadata(identity *ScmIdentity, platform string) map[string]any {
	metadata := map[string]any{}
	if identity == nil {
		return metadata
	}
	for key, value := range map[string]string{
		"ci_system":         identity.CISystem,
		"ci_run_id":         identity.RunID,
		"ci_run_url":        identity.RunURL,
		"ci_actor":          identity.Actor,
		"github_repository": identity.Repository,
		"scm_repo":          identity.Repository,
		"scm_provider":      "github",
		"scm_branch":        identity.Branch,
		"scm_head_sha":      identity.Commit,
		"scm_base_sha":      identity.BaseCommit,
		"scm_platform":      platform,
	} {
		if value != "" {
			metadata[key] = value
		}
	}
	if separator := strings.LastIndex(identity.Repository, "/"); separator > 0 && separator < len(identity.Repository)-1 {
		metadata["scm_namespace"] = identity.Repository[:separator]
		metadata["scm_project"] = identity.Repository[separator+1:]
	}
	if identity.PR > 0 {
		metadata["scm_review_number"] = identity.PR
		metadata["pr_number"] = identity.PR
	}
	return metadata
}

func inspectArtifact(file, platform string) (string, string, bool, error) {
	if strings.TrimSpace(file) == "" {
		return "", "", false, failure(ErrInvalidArgument, "File must be the path to an .apk, an .app bundle, or a .zip holding one.")
	}
	if platform != "" && platform != "ios" && platform != "android" {
		return "", "", false, failure(ErrInvalidArgument, "Platform must be \"ios\" or \"android\".")
	}
	name := strings.ToLower(filepath.Base(file))
	switch {
	case strings.HasSuffix(name, ".aab"):
		return "", "", false, failure(ErrInvalidArgument, "Android App Bundles (.aab) are not supported. Upload a standalone .apk instead.")
	case strings.HasSuffix(name, ".apks"):
		return "", "", false, failure(ErrInvalidArgument, "Android split APKs and APK Set archives are not supported. Upload one standalone installable .apk instead.")
	case strings.HasSuffix(name, ".ipa"):
		return "", "", false, failure(ErrInvalidArgument, "IPA files are not supported. Upload a simulator-built .app bundle, or a .zip holding one.")
	}
	info, err := os.Lstat(file)
	if err != nil {
		return "", "", false, &Error{Code: ErrInvalidArgument, Message: "Cannot read the build artifact " + file + ".", Cause: err}
	}
	resolved := platform
	if resolved == "" {
		switch {
		case strings.HasSuffix(name, ".apk"):
			resolved = "android"
		case strings.HasSuffix(name, ".app"), strings.HasSuffix(name, ".zip"):
			resolved = "ios"
		default:
			return "", "", false, failure(ErrInvalidArgument, "Cannot tell the platform of "+filepath.Base(file)+". Upload an .apk, an .app bundle, or a .zip, or set Platform.")
		}
	}
	if info.IsDir() {
		if !strings.HasSuffix(name, ".app") {
			return "", "", false, failure(ErrInvalidArgument, file+" is a directory but not an .app bundle.")
		}
		if resolved != "ios" {
			return "", "", false, failure(ErrInvalidArgument, "An .app bundle is an iOS build; it cannot be uploaded as Android.")
		}
		return file, resolved, true, nil
	}
	if !info.Mode().IsRegular() {
		return "", "", false, failure(ErrInvalidArgument, file+" is not a regular file.")
	}
	if resolved == "ios" && strings.HasSuffix(name, ".apk") {
		return "", "", false, failure(ErrInvalidArgument, filepath.Base(file)+" is an Android build; upload a simulator-built .app bundle for iOS.")
	}
	return file, resolved, false, nil
}

// zipAppBundle zips an .app bundle the way revyl build upload does: entries under the bundle name, symlinks kept as links.
func zipAppBundle(bundle, destination string) (string, error) {
	out, err := os.Create(destination)
	if err != nil {
		return "", &Error{Code: ErrInvalidArgument, Message: "Could not create the .app bundle zip.", Cause: err}
	}
	defer out.Close()
	archive := zip.NewWriter(out)
	bundle = filepath.Clean(bundle)
	parent := filepath.Dir(bundle)
	walkErr := filepath.WalkDir(bundle, func(path string, entry fs.DirEntry, err error) error {
		if err != nil || path == bundle {
			return err
		}
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() && !info.IsDir() && info.Mode()&fs.ModeSymlink == 0 {
			return fmt.Errorf("%s in the .app bundle is not a file, directory, or symlink", path)
		}
		header, err := zip.FileInfoHeader(info)
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(parent, path)
		if err != nil {
			return err
		}
		header.Name = filepath.ToSlash(relative)
		header.Method = zip.Deflate
		if info.IsDir() {
			header.Name += "/"
			header.Method = zip.Store
		}
		writer, err := archive.CreateHeader(header)
		if err != nil || info.IsDir() {
			return err
		}
		if info.Mode()&fs.ModeSymlink != 0 {
			target, err := os.Readlink(path)
			if err != nil {
				return err
			}
			_, err = io.WriteString(writer, filepath.ToSlash(target))
			return err
		}
		file, err := os.Open(path)
		if err != nil {
			return err
		}
		_, copyErr := io.Copy(writer, file)
		return errors.Join(copyErr, file.Close())
	})
	if err := errors.Join(walkErr, archive.Close(), out.Close()); err != nil {
		return "", &Error{Code: ErrInvalidArgument, Message: "Could not zip the .app bundle.", Cause: err}
	}
	return destination, nil
}

func putArtifact(ctx context.Context, h *http.Client, uploadURL, contentType, path string) error {
	u, err := url.Parse(uploadURL)
	loopback := err == nil && (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1")
	if err != nil || u.Host == "" || (u.Scheme != "https" && !(u.Scheme == "http" && loopback)) {
		return failure(ErrAPI, "Revyl returned an upload URL that is not HTTPS.")
	}
	info, err := os.Stat(path)
	if err != nil {
		return &Error{Code: ErrInvalidArgument, Message: "Cannot read the build artifact.", Cause: err}
	}
	for attempt := 0; ; attempt++ {
		retryable, failed := putArtifactOnce(ctx, h, u.String(), contentType, path, info.Size())
		if failed == nil {
			return nil
		}
		if !retryable || attempt >= len(uploadPutRetryDelays) {
			return failed
		}
		if err := pause(ctx, uploadPutRetryDelays[attempt]); err != nil {
			return err
		}
	}
}

func putArtifactOnce(ctx context.Context, h *http.Client, target, contentType, path string, size int64) (bool, error) {
	file, err := os.Open(path)
	if err != nil {
		return false, &Error{Code: ErrInvalidArgument, Message: "Cannot read the build artifact.", Cause: err}
	}
	defer file.Close()
	requestCtx, cancel := context.WithTimeout(ctx, uploadPutTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(requestCtx, http.MethodPut, target, file)
	if err != nil {
		return false, failure(ErrAPI, "Could not construct the artifact upload request.")
	}
	req.ContentLength = size
	req.Header.Set("Content-Type", contentType)
	r, err := h.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return false, contextError(ctx)
		}
		if requestCtx.Err() != nil {
			return false, &Error{Code: ErrTimeout, Message: "The artifact upload got no response within 10 minutes.", Cause: requestCtx.Err()}
		}
		return true, &Error{Code: ErrUploadFailed, Message: "Could not upload the artifact to Revyl's storage.", Cause: err}
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(r.Body, 16*1024))
	r.Body.Close()
	if r.StatusCode >= 200 && r.StatusCode < 300 {
		return false, nil
	}
	retryable := r.StatusCode == 429 || r.StatusCode == 500 || r.StatusCode == 502 || r.StatusCode == 503 || r.StatusCode == 504
	return retryable, &Error{Code: ErrUploadFailed, HTTPStatus: r.StatusCode, Message: fmt.Sprintf("Revyl's storage rejected the artifact upload with HTTP %d.", r.StatusCode)}
}

func uploadCall(r response, err error, appID string, into any) error {
	if err != nil {
		return err
	}
	if r.status >= 200 && r.status < 300 {
		return decode(r, into)
	}
	if blocked := responseFailure(r, ErrAPI, ""); blocked.(*Error).Code == ErrEdgeBlocked {
		return blocked
	}
	suffix := ""
	if detail := responseDetailText(r); detail != "" {
		suffix = ": " + detail
	}
	switch r.status {
	case 401:
		return &Error{Code: ErrAuthRejected, HTTPStatus: 401, Message: "Revyl rejected the upload credentials (HTTP 401)" + suffix + ". Uploads need a Revyl member's API key or a CI runner key; an organization API key that isn't tied to a member can be rejected as an invalid API key."}
	case 403:
		return &Error{Code: ErrAuthRejected, HTTPStatus: 403, Message: "Revyl rejected the upload (HTTP 403)" + suffix + ". Uploading a build needs the Member role or higher in the app's organization."}
	case 404:
		return &Error{Code: ErrNotFound, HTTPStatus: 404, Message: "Revyl app " + appID + " was not found in this organization" + suffix + "."}
	case 409:
		return &Error{Code: ErrVersionExists, HTTPStatus: 409, Message: "Revyl already has this build version" + suffix + ". Pass a version that is unique within the app."}
	case 400, 413, 422:
		return &Error{Code: ErrArtifactRejected, HTTPStatus: r.status, Message: fmt.Sprintf("Revyl rejected the build (HTTP %d)%s.", r.status, suffix)}
	}
	return &Error{Code: ErrAPI, HTTPStatus: r.status, Message: fmt.Sprintf("Revyl upload request failed (HTTP %d)%s.", r.status, suffix)}
}

func responseDetailText(r response) string {
	var body struct {
		Detail  any `json:"detail"`
		Message any `json:"message"`
	}
	if json.Unmarshal(r.body, &body) != nil {
		return ""
	}
	for _, value := range []any{body.Detail, body.Message} {
		if text, ok := value.(string); ok && text != "" {
			if len(text) > 500 {
				text = text[:500]
			}
			return text
		}
	}
	return ""
}

func validationWarnings(metadata map[string]any) []string {
	warnings := []string{}
	validation, _ := metadata["artifact_validation"].(map[string]any)
	raw, _ := validation["warnings"].([]any)
	for _, item := range raw {
		if text, ok := item.(string); ok && strings.TrimSpace(text) != "" {
			warnings = append(warnings, text)
		}
	}
	return warnings
}

func defaultUploadVersion(identity *ScmIdentity) string {
	stamp := time.Now().UTC().Format("20060102-150405")
	if identity == nil {
		return stamp
	}
	return identity.Commit[:12] + "-" + stamp
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}
