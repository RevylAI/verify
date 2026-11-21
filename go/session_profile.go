package verify

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"maps"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"

	"gopkg.in/yaml.v3"
)

const (
	profileNone           = "none"
	profileNoneHint       = `Profile: "none"`
	profileScriptMaxBytes = 64 * 1024
	profileGitTimeout     = 5 * time.Second
)

var (
	profileNamePattern    = regexp.MustCompile(`^[a-z0-9-]{1,64}$`)
	profileBareCode       = regexp.MustCompile(`^[a-z0-9_]+$`)
	profileOldDevice      = regexp.MustCompile(`(?i)need a CLI start or Open preview`)
	profileYAMLLine       = regexp.MustCompile(`line (\d+)`)
	profileScriptSuffixes = []string{".js", ".py", ".sh", ".ts"}
	profileRetryDelays    = []time.Duration{time.Second, 2 * time.Second}
)

type profileInstruction struct {
	Instruction string `json:"instruction"`
	Name        string `json:"name,omitempty"`
}

type profileSource struct {
	ProjectID     string `json:"project_id"`
	GitBranchName string `json:"git_branch_name,omitempty"`
}

type profileScriptFile struct {
	ProjectRelativePath string `json:"project_relative_path"`
	Content             string `json:"content"`
}

type profileFiles struct {
	Script                     string             `json:"script"`
	RequiresRepositoryCheckout bool               `json:"requires_repository_checkout,omitempty"`
	ScriptFile                 *profileScriptFile `json:"script_file,omitempty"`
}

// sessionProfilePlan is what Open sends for a session profile, and the name it waits on. name is empty for Profile "none".
type sessionProfilePlan struct {
	name       string
	configPath string
	source     *profileSource
	files      *profileFiles
}

func (p *sessionProfilePlan) addTo(request map[string]any) {
	if p == nil {
		return
	}
	if p.name == "" {
		request["session_profile"] = profileInstruction{Instruction: profileNone}
		return
	}
	request["session_profile"] = profileInstruction{Instruction: "named", Name: p.name}
	request["session_profile_source"] = p.source
	request["session_profile_files"] = p.files
}

// reportedProfile is the session_profile object a start response or session report carries.
type reportedProfile struct {
	name                 string
	status               string
	outcome              string
	failureReason        string
	missingGitBranchName string
}

// planSessionProfile plans the session profile Open sends: "none", an explicit name, or the project's session.default_profile
// when profile is empty. Nil when nothing is sent. Reads .revyl/config.yaml at or above cwd.
func planSessionProfile(profile string, platform Platform, cwd string) (*sessionProfilePlan, error) {
	if profile != "" && profile != profileNone && !profileNamePattern.MatchString(profile) {
		return nil, failure(ErrInvalidArgument, "open(): profile must be a session profile name from session.profiles in .revyl/config.yaml (1-64 lowercase letters, digits or hyphens), or 'none'.")
	}
	if platform != Web && platform != IOS && platform != Android && platform != Mac {
		if profile == "" {
			return nil, nil
		}
		return nil, failure(ErrNotAvailableOnPlatform, fmt.Sprintf("open(): session profiles run on web, iOS, Android and Mac sessions, not %s. Leave out profile.", platform))
	}
	if profile == profileNone {
		return &sessionProfilePlan{}, nil
	}
	if absolute, err := filepath.Abs(cwd); err == nil {
		cwd = absolute
	}
	configPath := findProfileConfig(cwd)
	if configPath == "" {
		if profile == "" {
			return nil, nil
		}
		return nil, failure(ErrConfigNotFound, fmt.Sprintf("open(): profile '%s' needs .revyl/config.yaml, but none was found in %s or any folder above it. Run open() from your app's checkout, or pass %s.", profile, cwd, profileNoneHint))
	}
	project, session, err := readProfileConfig(configPath)
	if err != nil {
		return nil, err
	}
	invalid := func(message string) error { return failure(ErrConfigInvalid, configPath+": "+message) }
	name := profile
	if name == "" {
		fallback, ok := session["default_profile"]
		if !ok || fallback == nil || fallback == profileNone {
			return nil, nil
		}
		text, isText := fallback.(string)
		if !isText {
			return nil, invalid("session.default_profile must be a profile name, or none.")
		}
		name = text
	}
	projectID, _ := project["id"].(string)
	if !uuidPattern.MatchString(projectID) {
		return nil, invalid(fmt.Sprintf("project.id must be your Revyl project's UUID, which session profile %q needs. Run open() from your app's checkout, whose .revyl/config.yaml has project.id, or pass %s.", name, profileNoneHint))
	}
	var profiles map[string]any
	if raw := session["profiles"]; raw != nil {
		var isMapping bool
		if profiles, isMapping = yamlMapping(raw); !isMapping {
			return nil, invalid("session.profiles must be a mapping of profile names.")
		}
	}
	entry, defined := profiles[name]
	if !defined {
		names := slices.Sorted(maps.Keys(profiles))
		list := "none"
		if len(names) > 0 {
			list = strings.Join(names, ", ")
		}
		return nil, invalid(fmt.Sprintf("session.profiles doesn't define %q. Defined: %s. Pass one of those, or %s.", name, list, profileNoneHint))
	}
	definition, isMapping := yamlMapping(entry)
	script, isText := definition["script"].(string)
	if !isMapping || !isText || jsTrim(script) == "" {
		return nil, invalid(fmt.Sprintf("session.profiles.%s.script must be a non-empty string.", name))
	}
	requiresCheckout := definition["requires_repository_checkout"]
	if _, isBool := requiresCheckout.(bool); requiresCheckout != nil && !isBool {
		return nil, invalid(fmt.Sprintf("session.profiles.%s.requires_repository_checkout must be true or false.", name))
	}
	projectRoot := filepath.Dir(filepath.Dir(configPath))
	files, err := checkoutFiles(name, script, requiresCheckout == true, projectRoot, configPath)
	if err != nil {
		return nil, err
	}
	return &sessionProfilePlan{name: name, configPath: configPath, source: &profileSource{ProjectID: projectID, GitBranchName: gitBranch(projectRoot)}, files: files}, nil
}

func findProfileConfig(cwd string) string {
	for current := cwd; ; current = filepath.Dir(current) {
		candidate := filepath.Join(current, ".revyl", "config.yaml")
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
		if filepath.Dir(current) == current {
			return ""
		}
	}
}

func yamlMapping(value any) (map[string]any, bool) {
	switch mapping := value.(type) {
	case map[string]any:
		return mapping, true
	case map[any]any:
		converted := make(map[string]any, len(mapping))
		for key, item := range mapping {
			converted[fmt.Sprint(key)] = item
		}
		return converted, true
	default:
		return nil, false
	}
}

func readProfileConfig(configPath string) (project, session map[string]any, err error) {
	var parsed any
	data, err := os.ReadFile(configPath)
	if err == nil {
		err = yaml.Unmarshal(data, &parsed)
	}
	if err != nil {
		line := ""
		if match := profileYAMLLine.FindStringSubmatch(err.Error()); match != nil {
			line = " line " + match[1]
		}
		return nil, nil, failure(ErrConfigInvalid, configPath+line+": is not valid YAML.")
	}
	root, isMapping := yamlMapping(parsed)
	if !isMapping {
		return nil, nil, failure(ErrConfigInvalid, configPath+": must be a YAML mapping.")
	}
	if raw := root["project"]; raw != nil {
		if project, isMapping = yamlMapping(raw); !isMapping {
			return nil, nil, failure(ErrConfigInvalid, configPath+": project must be a mapping.")
		}
	}
	if raw := root["session"]; raw != nil {
		if session, isMapping = yamlMapping(raw); !isMapping {
			return nil, nil, failure(ErrConfigInvalid, configPath+": session must be a mapping.")
		}
	}
	return project, session, nil
}

// checkoutFiles is the profile's definition and script file as the checkout has them, uncommitted changes included, as the Revyl
// CLI's CheckoutFiles builds them.
func checkoutFiles(name, script string, requiresCheckout bool, projectRoot, configPath string) (*profileFiles, error) {
	files := &profileFiles{Script: script, RequiresRepositoryCheckout: requiresCheckout}
	unavailable := func(reason string) error {
		return &Error{Code: ErrSessionProfileFailed, Message: fmt.Sprintf("session profile %q: %s. Fix session.profiles.%s.script in %s, or pass %s.", name, reason, name, configPath, profileNoneHint), Outcome: "script_unavailable", FailureReason: reason}
	}
	var filePath, relativePath string
	if strings.Contains(script, "/") {
		var err error
		if filePath, err = resolveRepositoryPath(projectRoot, script, unavailable); err != nil {
			return nil, err
		}
		relativePath = path.Clean(script)
	} else {
		if jsTrim(script) != script || strings.Contains(script, "\\") {
			return files, nil
		}
		found, err := findRepositoryScript(filepath.Join(filepath.Dir(configPath), "scripts"), script, unavailable)
		if err != nil || found == "" {
			return files, err
		}
		filePath, relativePath = found, ".revyl/scripts/"+filepath.Base(found)
	}
	content, err := os.ReadFile(filePath)
	if err != nil {
		return nil, unavailable("could not read script " + relativePath)
	}
	if len(content) > profileScriptMaxBytes {
		return nil, unavailable(fmt.Sprintf("script %s is %d bytes, over the %d Revyl takes", relativePath, len(content), profileScriptMaxBytes))
	}
	if !utf8.Valid(content) {
		return nil, unavailable("script " + relativePath + " isn't UTF-8 text")
	}
	files.ScriptFile = &profileScriptFile{ProjectRelativePath: relativePath, Content: string(content)}
	return files, nil
}

func resolveRepositoryPath(projectRoot, ref string, unavailable func(string) error) (string, error) {
	realRoot, err := filepath.EvalSymlinks(projectRoot)
	if err == nil {
		realRoot, err = filepath.Abs(realRoot)
	}
	if err != nil {
		return "", unavailable("could not resolve the project root for script " + ref)
	}
	repositoryRoot := realRoot
	for current := realRoot; ; current = filepath.Dir(current) {
		if _, err := os.Stat(filepath.Join(current, ".git")); err == nil {
			repositoryRoot = current
			break
		}
		if filepath.Dir(current) == current {
			break
		}
	}
	realScript, err := filepath.EvalSymlinks(filepath.Join(append([]string{realRoot}, strings.Split(ref, "/")...)...))
	if err != nil {
		return "", unavailable("script " + ref + " was not found in the repository")
	}
	if realScript != repositoryRoot && !strings.HasPrefix(realScript, repositoryRoot+string(filepath.Separator)) {
		return "", unavailable("script " + ref + " resolves outside the repository")
	}
	info, err := os.Stat(realScript)
	if err != nil {
		return "", unavailable("script " + ref + " could not be read")
	}
	if !info.Mode().IsRegular() {
		return "", unavailable("script " + ref + " is not a regular file")
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o111 == 0 {
		return "", unavailable("script " + ref + " is not executable (chmod +x it)")
	}
	return realScript, nil
}

func findRepositoryScript(scriptsDir, name string, unavailable func(string) error) (string, error) {
	var matches []string
	for _, suffix := range profileScriptSuffixes {
		candidate := filepath.Join(scriptsDir, name+suffix)
		info, err := os.Lstat(candidate)
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil || !info.Mode().IsRegular() {
			return "", unavailable(".revyl/scripts/" + name + suffix + " is not a readable regular file")
		}
		matches = append(matches, candidate)
	}
	if len(matches) > 1 {
		return "", unavailable(".revyl/scripts holds more than one file named " + name + "; keep one")
	}
	if len(matches) == 0 {
		return "", nil
	}
	return matches[0], nil
}

func gitBranch(projectRoot string) string {
	ctx, cancel := context.WithTimeout(context.Background(), profileGitTimeout)
	defer cancel()
	command := exec.CommandContext(ctx, "git", "rev-parse", "--abbrev-ref", "HEAD")
	command.Dir = projectRoot
	command.WaitDelay = time.Second
	output, err := command.Output()
	if err != nil {
		return ""
	}
	branch := jsTrim(string(output))
	if branch == "HEAD" || textLength(branch) > 255 {
		return ""
	}
	return branch
}

// jsTrim trims what JavaScript's String.prototype.trim does, so names and scripts compare as the TypeScript SDK compares them.
func jsTrim(text string) string {
	return strings.TrimFunc(text, func(r rune) bool {
		return r == '\uFEFF' || r != '\u0085' && unicode.IsSpace(r)
	})
}

// reportedSessionProfile reads the session_profile field of a start response or session report, in this one place.
func reportedSessionProfile(raw json.RawMessage) *reportedProfile {
	var profile map[string]any
	if json.Unmarshal(raw, &profile) != nil || profile == nil {
		return nil
	}
	text := func(key string) string {
		value, _ := profile[key].(string)
		return value
	}
	return &reportedProfile{name: text("name"), status: text("status"), outcome: text("outcome"), failureReason: text("failure_reason"), missingGitBranchName: text("missing_git_branch_name")}
}

// missingBranchNotice is the progress line for a branch Git doesn't have, from the start or create response.
func missingBranchNotice(profile *reportedProfile, plan *sessionProfilePlan) string {
	if profile == nil || profile.missingGitBranchName == "" {
		return ""
	}
	name := profile.name
	if name == "" {
		name = plan.name
	}
	return fmt.Sprintf("Git has no branch %q, so session profile %s reads the repository's default branch instead", profile.missingGitBranchName, name)
}

var profileOutcomeFixes = map[string]string{
	"script_failed":      "Its script exited with an error. Run the script yourself from the project root to see its output; Revyl doesn't show the output because setup scripts often print secrets.",
	"script_timed_out":   "Its script didn't finish within Revyl's 300-second limit. Make it finish sooner.",
	"script_unavailable": "Revyl could not find its script: commit it, or check session.profiles in .revyl/config.yaml. A script name with no .revyl/scripts file must be a Library Script in your Revyl organization.",
	"output_invalid":     "An output file the script wrote broke a rule, as the reason says. Fix what the script writes there.",
	"runner_failed":      "It failed on Revyl's side. Open the session again.",
}

// profileFailedError is SESSION_PROFILE_FAILED for a profile Revyl reported as failed. Revyl stops the session itself.
func profileFailedError(profile *reportedProfile, plan *sessionProfilePlan, viewer string) error {
	name := profile.name
	if name == "" {
		name = plan.name
	}
	outcome := profile.outcome
	if outcome == "" {
		outcome = "unknown"
	}
	reason := "."
	if profile.failureReason != "" {
		reason = ": " + profileSentence(profile.failureReason)
	}
	fix, known := profileOutcomeFixes[outcome]
	if !known {
		fix = "Check the session link for what happened."
	}
	return &Error{Code: ErrSessionProfileFailed, Message: fmt.Sprintf("Session profile %q failed (%s)%s %s Revyl stopped the session. See %s", name, outcome, reason, fix, viewer), Outcome: profile.outcome, FailureReason: profile.failureReason}
}

// profileNotReportedError is NOT_AVAILABLE_ON_PLATFORM for a session that became active without reporting the profile Verify sent.
func profileNotReportedError(platform Platform, viewer string) error {
	return failure(ErrNotAvailableOnPlatform, fmt.Sprintf("This Revyl backend doesn't run session profiles on %s yet, so Verify stopped the session. Pass %s to start without one. See %s", platform, profileNoneHint, viewer))
}

func profileConfigPath(plan *sessionProfilePlan) string {
	if plan.configPath == "" {
		return ".revyl/config.yaml"
	}
	return plan.configPath
}

var profileRefusals = map[string]struct {
	code Code
	fix  func(*sessionProfilePlan) string
}{
	"session_profile_undefined": {ErrConfigInvalid, func(plan *sessionProfilePlan) string {
		return "Check that session.profiles in " + profileConfigPath(plan) + " defines it and that project.id names the project that holds it."
	}},
	"session_profile_source_required": {ErrInvalidArgument, func(*sessionProfilePlan) string {
		return "Update Verify to the latest version; it sends the project with every named profile."
	}},
	"session_profile_files_need_named": {ErrInvalidArgument, func(*sessionProfilePlan) string {
		return "Update Verify to the latest version; it sends checkout files only with a named profile."
	}},
	"session_profile_script_unavailable": {ErrSessionProfileFailed, func(*sessionProfilePlan) string {
		return "Commit the script or add it to .revyl/scripts, or create the Library Script with that name in your Revyl organization."
	}},
	"repository_connection_missing": {ErrConfigInvalid, func(*sessionProfilePlan) string {
		return "Connect the repository's GitHub or GitLab app to the project in Revyl, then open the session again."
	}},
	"project_not_found": {ErrConfigInvalid, func(plan *sessionProfilePlan) string {
		return "project.id in " + profileConfigPath(plan) + " isn't a project in this API key's organization. Use a key from that organization, or fix project.id."
	}},
	"repository_unavailable": {ErrAPI, func(*sessionProfilePlan) string {
		return "Revyl couldn't read the repository after 3 attempts. Try again in a few minutes."
	}},
}

// profileRefusalError is the error for a start or create Revyl refused because of the session profile fields, or nil when the
// refusal is about something else. Reads the top-level code, falling back to the sentence an older backend sends.
func profileRefusalError(r response, plan *sessionProfilePlan, platform Platform) error {
	var body map[string]any
	if json.Unmarshal(r.body, &body) != nil || body == nil {
		return nil
	}
	code, _ := body["code"].(string)
	raw := ""
	for _, key := range []string{"detail", "message"} {
		if text, ok := body[key].(string); ok && jsTrim(text) != "" && !profileBareCode.MatchString(jsTrim(text)) {
			raw = text
			break
		}
	}
	said := ""
	if raw != "" {
		said = profileSentence(utf16Prefix(jsTrim(raw), 500))
	}
	subject := "the session profile request"
	if plan.name != "" {
		subject = fmt.Sprintf("session profile %q", plan.name)
	}
	if refusal, known := profileRefusals[code]; known {
		detail := "."
		if said != "" {
			detail = ": " + said
		}
		failed := &Error{Code: refusal.code, Reason: RefusalReason(code), HTTPStatus: r.status, Message: fmt.Sprintf("Revyl refused %s (%s)%s %s", subject, code, detail, refusal.fix(plan))}
		if code == "session_profile_script_unavailable" {
			failed.Outcome, failed.FailureReason = "script_unavailable", said
		}
		return failed
	}
	detail, _ := body["detail"].(string)
	oldDevice := platform != Mac && r.status == 422 && profileOldDevice.MatchString(raw)
	oldComputer := platform == Mac && detail == "invalid_request"
	if !oldDevice && !oldComputer {
		return nil
	}
	reason := ""
	if said != "" {
		reason = " (" + said[:len(said)-1] + ")"
	}
	return &Error{Code: ErrNotAvailableOnPlatform, HTTPStatus: r.status, Message: fmt.Sprintf("This Revyl backend doesn't support session profiles on %s yet%s. Pass %s to start without one.", platform, reason, profileNoneHint)}
}

// withRepositoryRetry runs a start or create, repeating it with the same body while Revyl answers repository_unavailable: 3
// attempts in all.
func withRepositoryRetry[T any](ctx context.Context, start func() (T, error)) (T, error) {
	for attempt := 0; ; attempt++ {
		result, err := start()
		var typed *Error
		if err == nil || !errors.As(err, &typed) || typed.Reason != ReasonRepositoryUnavailable || attempt >= len(profileRetryDelays) {
			return result, err
		}
		if err := pause(ctx, profileRetryDelays[attempt]); err != nil {
			return result, err
		}
	}
}

func profileSentence(text string) string {
	trimmed := jsTrim(text)
	if strings.HasSuffix(trimmed, ".") || strings.HasSuffix(trimmed, "!") || strings.HasSuffix(trimmed, "?") {
		return trimmed
	}
	return trimmed + "."
}

func utf16Prefix(text string, limit int) string {
	units := utf16.Encode([]rune(text))
	if len(units) <= limit {
		return text
	}
	return string(utf16.Decode(units[:limit]))
}
