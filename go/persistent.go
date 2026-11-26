package verify

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"time"
)

const (
	persistentBase        = "/api/v1/computer-runs"
	persistentNamespace   = "c4c351c9-f19a-49b9-b0a9-632ef6c3f486"
	persistentGenerations = 100
	persistentSaveWait    = 10 * time.Minute
	persistentNameRule    = "1-64 letters, digits, '.', '_' or '-', starting with a letter or digit, and not a UUID"
)

var persistentNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

var persistentRefusals = map[string]struct {
	code    Code
	message string
}{
	"persistent_computers_not_enabled": {ErrNotAvailableOnPlatform, "Persistent computers aren't enabled for this API key's organization yet (persistent_computers_not_enabled). Ask support@revyl.ai to turn them on."},
	"computer_not_enabled":             {ErrNotAvailableOnPlatform, "Mac computers aren't enabled for this API key's organization (computer_not_enabled). Ask support@revyl.ai about access."},
	"runtime_unavailable":              {ErrNotAvailableOnPlatform, "Revyl has no Mac computers available in this environment (runtime_unavailable)."},
	"persistent_computer_limit":        {ErrComputerLimit, "Your organization already keeps as many persistent computers as it may (persistent_computer_limit). ListPersistent shows them; delete one you no longer need with DeletePersistent, then try again."},
	"snapshot_limit":                   {ErrComputerLimit, "Your organization already keeps as many snapshots as it may (snapshot_limit). ListSnapshots shows them; delete one you no longer need with DeleteSnapshot, then try again."},
	"computer_limit":                   {ErrComputerLimit, "Revyl refused to start another computer right now (computer_limit): your organization is at its concurrency limit or has queued work. Stop a computer you no longer need, or try again later."},
	"computer_long_limit":              {ErrComputerLimit, "Revyl refused a lifetime over 2 hours: the organization already has 2 computers running longer than 2 hours (computer_long_limit). Pass a Timeout of 2 hours or less, or stop one of them."},
	"saved_disk_unavailable":           {ErrSessionStartFailed, "The Mac holding this computer's saved disk is offline and the save isn't copied off it yet, or no Mac can start it right now (saved_disk_unavailable). The disk is kept; try again later."},
	"saved_disk_expired":               {ErrSessionStartFailed, "This computer's saved disk has reached its end and can't start again (saved_disk_expired). Delete it with DeletePersistent; OpenPersistent with its name then creates a new one."},
	"snapshot_expired":                 {ErrSessionStartFailed, "This snapshot's saved disk has reached its end and can't start a computer (snapshot_expired). Save a new snapshot of a recently stopped computer."},
	"computer_not_persistent":          {ErrInvalidArgument, "This ID names a computer that isn't persistent (computer_not_persistent). Pass a name, or an ID from ListPersistent."},
	"inference_not_enabled":            {ErrNotAvailableOnPlatform, "Local inference isn't enabled for this API key's organization (inference_not_enabled). Ask support@revyl.ai to turn it on, or leave out Inference."},
	"inference_unavailable":            {ErrNotAvailableOnPlatform, "No Mac with its own vision model is up to take this computer right now (inference_unavailable), so nothing was started. Try again later; to start an existing computer without the model this once, set WithoutInference to true."},
	"run_conflict":                     {ErrSessionBusy, "The computer's last run hasn't finished stopping (run_conflict). Its disk is kept; try again in a few minutes."},
}

// PersistentOptions apply to every persistent-computer call. Leave them empty for Revyl's defaults. Credentials work
// as for Open: REVYL_API_KEY or a "verify login"; BackendURL and AppURL select another Revyl environment.
type PersistentOptions struct {
	BackendURL string
	AppURL     string
	HTTPClient *http.Client
	// Log receives progress lines. Nil means no progress output.
	Log func(string)
}

// OpenPersistentOptions configure OpenPersistent.
type OpenPersistentOptions struct {
	PersistentOptions
	// FromSnapshot is used only when this call creates the computer: its disk starts as this snapshot's (a name or
	// ID from ListSnapshots). If the computer already exists it opens as it is; check PersistentComputerSession.Created.
	FromSnapshot string
	// Timeout is how long this run may last before the computer stops itself (keeping its disk): whole seconds
	// from 1 minute to 24 hours, otherwise ErrInvalidArgument. Zero means 2 hours. Not applied when the computer
	// was already running. Same as Target.Timeout for Open.
	Timeout time.Duration
	// Inference is used only when this call creates the computer: run it on Macs whose own vision model is loaded, as
	// Target.Inference does for Open, so Validation and Extract work on it. The computer keeps this for every later start.
	Inference bool
	// WithoutInference is used only when this call starts a stopped computer that was created with Inference: start this
	// run on any Mac, without the model, for when no Mac with one is up. Later starts ask for the model again. Needs a
	// Revyl backend that offers it.
	WithoutInference bool
	// StartTimeout is how long OpenPersistent waits for the computer to be ready, from 10 seconds to 30 minutes.
	// Zero means 15 minutes. It covers waiting for an earlier stop to finish saving, and a start from a snapshot,
	// which takes about 3 minutes.
	StartTimeout time.Duration
}

// SaveSnapshotOptions configure SaveSnapshot.
type SaveSnapshotOptions struct {
	PersistentOptions
	// WaitTimeout is how long SaveSnapshot waits for the disk to be ready to snapshot, from 1 second to 1 hour.
	// Zero means 15 minutes. A disk is ready about 5-6 minutes after Close returns.
	WaitTimeout time.Duration
}

// PersistentComputerSession is a running persistent Mac. It has every method of the *Session that Open returns for
// a Mac, such as Exec, ReadFile, WriteFile, Screenshot and Extend; relative file paths are inside the computer's
// workspace folder, as on Open. ID() is the persistent computer's ID: it stays the same across stops and starts and
// matches the ID ListPersistent reports.
type PersistentComputerSession struct {
	*Session
	// Name is the name (or ID) you passed to OpenPersistent.
	Name string
	// Created is true when this OpenPersistent call created the computer, false when it already existed.
	Created bool
}

// Close stops the computer and keeps its disk: files, installed tools and settings are there the next time you
// OpenPersistent it. Memory and running processes are not kept. It returns once the disk is saved on its Mac, which
// can take a few minutes; a cancelled ctx stops the wait, not the save. A snapshot of this disk can be saved about
// 5-6 minutes after Close returns; SaveSnapshot waits for that. Unlike TypeScript and Python, Go does not stop it
// when the program exits, so always Close it.
func (c *PersistentComputerSession) Close(ctx context.Context) error {
	return c.Session.Close(ctx)
}

// PersistentComputer is one of your organization's persistent computers, as ListPersistent reports it.
type PersistentComputer struct {
	// ID stays the same across every stop and start, and works wherever a name does.
	ID string
	// State is "starting", "running", "stopping" or "stopped".
	State string
	// SavedAt is when its disk was last saved; zero until its first stop finishes saving.
	SavedAt time.Time
	// SavedOffHost is whether that save has been copied off the Mac that made it. SaveSnapshot needs this and
	// waits for it.
	SavedOffHost bool
	CreatedAt    time.Time
	// SavedDiskExpiresAt is when its current save stops being startable, if Revyl reports an end; zero otherwise. After
	// it, OpenPersistent returns ErrSessionStartFailed (saved_disk_expired).
	SavedDiskExpiresAt time.Time
}

// ComputerSnapshot is a saved disk that OpenPersistent can start a new computer from.
type ComputerSnapshot struct {
	ID   string
	Name string
	// ComputerID is the persistent computer whose disk it saved.
	ComputerID string
	SavedAt    time.Time
	// ExpiresAt is when the save stops being usable; zero when it has no end.
	ExpiresAt time.Time
	// SavedDiskExpiresAt is when a computer can no longer be created from it, if Revyl reports an end; zero otherwise.
	// After it, OpenPersistent with FromSnapshot returns ErrSessionStartFailed (snapshot_expired).
	SavedDiskExpiresAt time.Time
}

// OpenPersistent opens the persistent Mac with this name, creating it if it doesn't exist, starting it if it is
// stopped, and waiting until it is ready. Its disk outlives every stop: Close keeps it, and the next OpenPersistent
// with the same name boots from it. Names are 1-64 letters, digits, '.', '_' or '-', starting with a letter or
// digit; the same name opens the same computer from Go, TypeScript and Python. Pass an ID from ListPersistent to
// open an existing computer without creating one. If it is already running, OpenPersistent connects to it.
//
// Persistent computers are turned on per organization. Without them, OpenPersistent and SaveSnapshot return
// ErrNotAvailableOnPlatform with Reason ReasonPersistentComputersNotEnabled:
//
//	var verr *verify.Error
//	if errors.As(err, &verr) && verr.Reason == verify.ReasonPersistentComputersNotEnabled {
//		// ask support@revyl.ai to turn persistent computers on for this organization
//	}
//
// Every persistent-computer function returns a *Error; test it with errors.Is(err, verify.ErrNotFound) and read its
// Message for what to do: ErrNotFound (no computer or snapshot by that name or ID), ErrSessionBusy (the computer is
// running, or its last stop hasn't finished), ErrTimeout (a wait ran out; the call can be repeated),
// ErrComputerLimit (the organization keeps its maximum number of computers or snapshots, or can't start another
// computer now), ErrNotAvailableOnPlatform, ErrInvalidArgument, ErrAuthRejected, ErrSessionStartFailed and ErrAPI.
//
//	mac, err := verify.OpenPersistent(ctx, "build-cache")
//	if err != nil {
//		return err
//	}
//	if mac.Created {
//		_, err = mac.Exec(ctx, []string{"brew", "install", "jq"})
//	}
//	err = errors.Join(err, mac.Close(ctx)) // stops it and keeps the disk
func OpenPersistent(ctx context.Context, name string, options ...OpenPersistentOptions) (*PersistentComputerSession, error) {
	opt, err := singlePersistentOption(options)
	if err != nil {
		return nil, err
	}
	session, created, err := openPersistent(ctx, name, opt)
	if err != nil {
		return nil, err
	}
	return &PersistentComputerSession{Session: session, Name: name, Created: created}, nil
}

// SaveSnapshot saves a stopped persistent computer's disk (by name or ID) as a named snapshot, which OpenPersistent
// with FromSnapshot can start a new computer from. The computer must be stopped: Close it first, or SaveSnapshot
// returns ErrSessionBusy. A disk is ready to snapshot about 5-6 minutes after Close returns, once it is copied off
// its Mac; SaveSnapshot waits for that (and for a stop still in progress) up to WaitTimeout, then returns
// ErrTimeout. Snapshot names follow the computer-name rule and are unique in your organization: a name already used
// for a different save returns ErrInvalidArgument, while calling it again for the same computer and save returns
// the snapshot it already saved. A snapshot lasts until you delete it.
func SaveSnapshot(ctx context.Context, computer, snapshot string, options ...SaveSnapshotOptions) (ComputerSnapshot, error) {
	opt, err := singlePersistentOption(options)
	if err != nil {
		return ComputerSnapshot{}, err
	}
	return saveSnapshot(ctx, computer, snapshot, opt)
}

// ListPersistent lists your organization's persistent computers, stopped ones included, other people's too. Revyl
// stores no names, so each one is shown by its ID; compare with the ID() of a session OpenPersistent returned. A name
// always maps to the same ID, so a name keeps working after stops and from any machine or language.
func ListPersistent(ctx context.Context, options ...PersistentOptions) ([]PersistentComputer, error) {
	opt, err := singlePersistentOption(options)
	if err != nil {
		return nil, err
	}
	c, _, err := persistentClient(opt)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	return listPersistentComputers(ctx, c)
}

// ListSnapshots lists your organization's snapshots.
func ListSnapshots(ctx context.Context, options ...PersistentOptions) ([]ComputerSnapshot, error) {
	opt, err := singlePersistentOption(options)
	if err != nil {
		return nil, err
	}
	c, _, err := persistentClient(opt)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	items, err := persistentPages(ctx, c, "snapshots")
	if err != nil {
		return nil, err
	}
	snapshots := make([]ComputerSnapshot, 0, len(items))
	for _, item := range items {
		snapshot, err := decodeSnapshot(item)
		if err != nil {
			return nil, err
		}
		snapshots = append(snapshots, snapshot)
	}
	return snapshots, nil
}

// DeletePersistent deletes a persistent computer (by name or ID) and its saved disk for good. A running computer
// stops first, without saving. Snapshots of it are kept until you DeleteSnapshot them. It returns ErrNotFound when
// there is no such computer, including one already deleted.
func DeletePersistent(ctx context.Context, computer string, options ...PersistentOptions) error {
	opt, err := singlePersistentOption(options)
	if err != nil {
		return err
	}
	return deletePersistent(ctx, computer, opt)
}

// DeleteSnapshot deletes a snapshot by name or ID. Computers already started from it keep their disks. It returns
// ErrNotFound when there is no such snapshot.
func DeleteSnapshot(ctx context.Context, snapshot string, options ...PersistentOptions) error {
	opt, err := singlePersistentOption(options)
	if err != nil {
		return err
	}
	return deleteSnapshot(ctx, snapshot, opt)
}

func singlePersistentOption[T any](options []T) (T, error) {
	var zero T
	if len(options) > 1 {
		return zero, failure(ErrInvalidArgument, "Pass at most one options value.")
	}
	if len(options) == 1 {
		return options[0], nil
	}
	return zero, nil
}

func persistentClient(options PersistentOptions) (*client, string, error) {
	return newClient(OpenOptions{BackendURL: options.BackendURL, AppURL: options.AppURL, HTTPClient: options.HTTPClient})
}

func openPersistent(ctx context.Context, name string, options OpenPersistentOptions) (*Session, bool, error) {
	if err := checkComputerReference(name, "OpenPersistent"); err != nil {
		return nil, false, err
	}
	if options.FromSnapshot != "" && !persistentNamePattern.MatchString(options.FromSnapshot) {
		return nil, false, failure(ErrInvalidArgument, "FromSnapshot takes a snapshot name or ID from ListSnapshots.")
	}
	if options.Timeout != 0 && (options.Timeout%time.Second != 0 || options.Timeout < time.Minute || options.Timeout > 24*time.Hour) {
		return nil, false, failure(ErrInvalidArgument, "Timeout must be whole seconds from 1 minute to 24 hours.")
	}
	startTimeout := options.StartTimeout
	if startTimeout == 0 {
		startTimeout = 15 * time.Minute
	}
	if startTimeout < 10*time.Second || startTimeout > 30*time.Minute {
		return nil, false, failure(ErrInvalidArgument, "StartTimeout must be from 10 seconds to 30 minutes.")
	}
	c, viewer, err := persistentClient(options.PersistentOptions)
	if err != nil {
		return nil, false, err
	}
	ctx, cancel := context.WithTimeout(ctx, startTimeout)
	defer cancel()
	id, status, err := findPersistentComputer(ctx, c, name)
	if err != nil {
		return nil, false, timeoutOr(ctx, err, fmt.Sprintf("%s was not found within %s. Call OpenPersistent again, or pass a larger StartTimeout.", name, startTimeout))
	}
	lifetime, stop := context.WithCancel(context.Background())
	s := &Session{client: c, id: id, platform: Mac, viewer: viewer + "/sessions/" + url.PathEscape(id) + "?kind=computer", viewerBase: viewer, lifetime: lifetime, stopLifetime: stop, stepTimeout: 3 * time.Minute, persistentName: name}
	if options.Log != nil {
		s.log = func(line string) { options.Log(strings.Replace(line, "mac: ", name+": ", 1)) }
	}
	var body any
	create := map[string]any{"computer_session_id": id, "os": "macos", "persistent": true}
	start := map[string]any{}
	if options.Timeout != 0 {
		start["timeout_seconds"] = int64(options.Timeout / time.Second)
		create["timeout_seconds"] = int64(options.Timeout / time.Second)
	}
	if options.WithoutInference {
		start["without_inference"] = true
	}
	if len(start) > 0 {
		body = start
	}
	if options.Inference {
		create["inference"] = true
	}
	started, attempted := false, false
	err = func() error {
		var r response
		if status == nil {
			suffix := ""
			if options.FromSnapshot != "" {
				suffix = " from snapshot " + options.FromSnapshot
			}
			s.logLine("creating persistent computer" + suffix + " " + s.viewer)
			if options.FromSnapshot != "" {
				create["from_snapshot"] = options.FromSnapshot
			}
			attempted = true
			r, err = persistentCall(ctx, c, "POST", persistentBase, create, true, "There is no snapshot named or with the ID "+options.FromSnapshot+". ListSnapshots shows your organization's snapshots.")
			if err != nil {
				return err
			}
			started = true
		} else {
			if options.FromSnapshot != "" {
				s.logLine("already exists, so FromSnapshot " + options.FromSnapshot + " was not used")
			}
			if options.Inference {
				s.logLine("already exists, so Inference was not changed; a computer keeps the inference it was created with")
			}
			waiting := false
			for status.State == "stopping" || status.State == "stopped" {
				if status.State == "stopped" {
					attempted = true
					r, err := persistentCall(ctx, c, "POST", persistentBase+"/"+id+"/start", body, true, "", "run_conflict")
					if err != nil && options.WithoutInference && errors.Is(err, ErrInvalidArgument) && persistentRefusals[persistentDetail(r)].code == "" {
						return &Error{Code: ErrInvalidArgument, HTTPStatus: r.status, Message: "This Revyl backend refused WithoutInference, which it does not offer yet. Leave it out to start the computer as it was created.", Cause: err}
					}
					if err != nil {
						return err
					}
					if r.status < 300 {
						started = true
						s.logLine("starting from its saved disk " + s.viewer)
						break
					}
				}
				if !waiting {
					s.logLine("waiting for its last stop to finish saving its disk")
				}
				waiting = true
				if err := pause(ctx, 5*time.Second); err != nil {
					return err
				}
				next, err := readPersistentStatus(ctx, c, id)
				if err != nil {
					return err
				}
				if next != nil {
					status = next
				}
			}
			if status.State == "running" || status.State == "starting" {
				s.logLine("already " + status.State + "; connecting " + s.viewer)
			}
			r, err = persistentCall(ctx, c, "GET", persistentBase+"/"+id+"/report", nil, false, "")
			if err != nil {
				return err
			}
		}
		started = true
		for {
			report, err := s.readComputerReport(r)
			if err != nil {
				return err
			}
			if report.ExpiresAt != nil {
				s.expiresAt = *report.ExpiresAt
			}
			if report.State == "active" {
				s.computerScreenReadyUntil = time.Now().Add(30 * time.Second)
				return nil
			}
			if report.State != "starting" {
				return failure(ErrSessionStartFailed, fmt.Sprintf("%s ended before it was ready (%s). Call OpenPersistent again; its disk is kept. See %s", name, report.State, s.viewer))
			}
			if err := pause(ctx, 2*time.Second); err != nil {
				return err
			}
			r, err = s.computerRequest(ctx, "GET", "/report", nil)
			if err != nil {
				return err
			}
		}
	}()
	if err == nil {
		s.logLine("ready")
		return s, status == nil, nil
	}
	var typed *Error
	refused := errors.As(err, &typed) && slices.Contains([]Code{ErrAuthRejected, ErrEdgeBlocked, ErrNotAvailableOnPlatform, ErrInvalidArgument, ErrComputerLimit, ErrNotFound}, typed.Code)
	stopped := started || (attempted && !refused)
	if stopped {
		s.persistentName = ""
		cleanup, cancelCleanup := context.WithTimeout(context.WithoutCancel(ctx), computerObservationTimeout)
		defer cancelCleanup()
		_ = s.Close(cleanup)
	} else {
		stop()
	}
	kept := ""
	if stopped {
		kept = " It was stopped again and keeps its disk."
	}
	return nil, false, timeoutOr(ctx, err, fmt.Sprintf("%s was not ready within %s.%s Call OpenPersistent(ctx, %q) again, or pass a larger StartTimeout. See %s", name, startTimeout, kept, name, s.viewer))
}

func (s *Session) awaitPersistentSave(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, persistentSaveWait)
	defer cancel()
	for {
		status, err := readPersistentStatus(ctx, s.client, s.id)
		if err != nil {
			return timeoutOr(ctx, err, fmt.Sprintf("%s is stopped, but saving its disk was not confirmed within %s. The save continues on its own; ListPersistent shows it as stopped once done. See %s", s.persistentName, persistentSaveWait, s.viewer))
		}
		if status != nil && status.State == "stopped" {
			s.logLine("stopped; disk saved")
			return nil
		}
		if status != nil && status.State != "stopping" {
			s.logLine("stopped; it was started again elsewhere (" + status.State + ")")
			return nil
		}
		if err := pause(ctx, 3*time.Second); err != nil {
			return timeoutOr(ctx, err, fmt.Sprintf("%s is stopped, but saving its disk was not confirmed within %s. The save continues on its own; ListPersistent shows it as stopped once done. See %s", s.persistentName, persistentSaveWait, s.viewer))
		}
	}
}

func saveSnapshot(ctx context.Context, computer, snapshot string, options SaveSnapshotOptions) (ComputerSnapshot, error) {
	if err := checkComputerReference(computer, "SaveSnapshot"); err != nil {
		return ComputerSnapshot{}, err
	}
	if !persistentNamePattern.MatchString(snapshot) || uuidPattern.MatchString(snapshot) {
		return ComputerSnapshot{}, failure(ErrInvalidArgument, "SaveSnapshot takes a snapshot name of "+persistentNameRule+".")
	}
	timeout := options.WaitTimeout
	if timeout == 0 {
		timeout = 15 * time.Minute
	}
	if timeout < time.Second || timeout > time.Hour {
		return ComputerSnapshot{}, failure(ErrInvalidArgument, "WaitTimeout must be from 1 second to 1 hour.")
	}
	c, _, err := persistentClient(options.PersistentOptions)
	if err != nil {
		return ComputerSnapshot{}, err
	}
	say := func(line string) {
		if options.Log != nil {
			options.Log(computer + ": " + line)
		}
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	result, err := func() (ComputerSnapshot, error) {
		id, status, err := findPersistentComputer(ctx, c, computer)
		if err != nil {
			return ComputerSnapshot{}, err
		}
		if status == nil {
			return ComputerSnapshot{}, computerNotFound(computer)
		}
		waiting := false
		for {
			r, err := persistentCall(ctx, c, "POST", persistentBase+"/"+id+"/snapshots", map[string]any{"name": snapshot}, true, computerNotFound(computer).(*Error).Message, "computer_not_stopped", "saved_disk_not_durable", "snapshot_name_taken")
			if err != nil {
				return ComputerSnapshot{}, err
			}
			if r.status < 300 {
				say("saved snapshot " + snapshot)
				return decodeSnapshot(r.body)
			}
			detail := persistentDetail(r)
			status, err := readPersistentStatus(ctx, c, id)
			if err != nil {
				return ComputerSnapshot{}, err
			}
			if detail == "snapshot_name_taken" {
				existing, err := persistentCall(ctx, c, "GET", persistentBase+"/snapshots/"+url.PathEscape(snapshot), nil, false, "", "inaccessible")
				if err != nil {
					return ComputerSnapshot{}, err
				}
				if existing.status == 200 && status != nil {
					saved, err := decodeSnapshot(existing.body)
					if err == nil && saved.ComputerID == id && saved.SavedAt.Equal(status.SavedAt) {
						return saved, nil
					}
				}
				return ComputerSnapshot{}, &Error{Code: ErrInvalidArgument, HTTPStatus: r.status, Message: fmt.Sprintf("Your organization already has a snapshot named %s (snapshot_name_taken). Pick another name, or delete the old one with DeleteSnapshot(ctx, %q) first.", snapshot, snapshot)}
			}
			if detail == "computer_not_stopped" && status != nil && (status.State == "running" || status.State == "starting") {
				return ComputerSnapshot{}, &Error{Code: ErrSessionBusy, HTTPStatus: r.status, Message: computer + " is running. A snapshot saves a stopped computer's disk: Close its session first (that keeps the disk), then call SaveSnapshot again."}
			}
			if !waiting {
				if detail == "saved_disk_not_durable" {
					say("waiting for its saved disk to be copied off its Mac (usually about 5 minutes)")
				} else {
					say("waiting for it to finish stopping")
				}
			}
			waiting = true
			if err := pause(ctx, 15*time.Second); err != nil {
				return ComputerSnapshot{}, err
			}
		}
	}()
	if err != nil {
		return ComputerSnapshot{}, timeoutOr(ctx, err, fmt.Sprintf("%s's disk was not ready to snapshot within %s, so nothing was saved. Call SaveSnapshot again to keep waiting, or pass a larger WaitTimeout.", computer, timeout))
	}
	return result, nil
}

func deletePersistent(ctx context.Context, computer string, options PersistentOptions) error {
	if err := checkComputerReference(computer, "DeletePersistent"); err != nil {
		return err
	}
	c, _, err := persistentClient(options)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	id, status, err := findPersistentComputer(ctx, c, computer)
	if err != nil {
		return err
	}
	if status == nil {
		return computerNotFound(computer)
	}
	if _, err := persistentCall(ctx, c, "DELETE", persistentBase+"/"+id, nil, true, computerNotFound(computer).(*Error).Message); err != nil {
		return err
	}
	if options.Log != nil {
		options.Log(computer + ": deleted")
	}
	return nil
}

func deleteSnapshot(ctx context.Context, snapshot string, options PersistentOptions) error {
	if !persistentNamePattern.MatchString(snapshot) {
		return failure(ErrInvalidArgument, "DeleteSnapshot takes a snapshot name or ID from ListSnapshots.")
	}
	c, _, err := persistentClient(options)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	if _, err := persistentCall(ctx, c, "DELETE", persistentBase+"/snapshots/"+url.PathEscape(snapshot), nil, true, "There is no snapshot named or with the ID "+snapshot+". ListSnapshots shows your organization's snapshots."); err != nil {
		return err
	}
	if options.Log != nil {
		options.Log("snapshot " + snapshot + ": deleted")
	}
	return nil
}

func findPersistentComputer(ctx context.Context, c *client, reference string) (string, *PersistentComputer, error) {
	live, err := listPersistentComputers(ctx, c)
	if err != nil {
		return "", nil, err
	}
	find := func(id string) *PersistentComputer {
		for i := range live {
			if live[i].ID == id {
				return &live[i]
			}
		}
		return nil
	}
	if uuidPattern.MatchString(reference) {
		if status := find(strings.ToLower(reference)); status != nil {
			return status.ID, status, nil
		}
		return "", nil, computerNotFound(reference)
	}
	var who struct {
		OrgID string `json:"org_id"`
	}
	if err := c.json(ctx, "GET", "/api/v1/entity/users/get_user_uuid", nil, true, 30*time.Second, &who); err != nil {
		return "", nil, err
	}
	if !uuidPattern.MatchString(who.OrgID) {
		return "", nil, failure(ErrAPI, "Revyl did not say which organization this API key belongs to.")
	}
	for generation := 0; generation < persistentGenerations; generation++ {
		id := computerOperationID(persistentNamespace, fmt.Sprintf("%s/%s/%d", strings.ToLower(who.OrgID), reference, generation))
		if status := find(id); status != nil {
			return id, status, nil
		}
		r, err := persistentCall(ctx, c, "GET", persistentBase+"/"+id, nil, false, "", "inaccessible")
		if err != nil {
			return "", nil, err
		}
		if r.status == 404 {
			return id, nil, nil
		}
		status, err := decodePersistentDetail(r.body)
		if err != nil {
			return "", nil, err
		}
		if status != nil {
			return id, status, nil
		}
	}
	return "", nil, failure(ErrAPI, fmt.Sprintf("%s has been deleted and re-created %d times; use a new name.", reference, persistentGenerations))
}

func readPersistentStatus(ctx context.Context, c *client, id string) (*PersistentComputer, error) {
	r, err := persistentCall(ctx, c, "GET", persistentBase+"/"+id, nil, false, "")
	if err != nil {
		return nil, err
	}
	return decodePersistentDetail(r.body)
}

func listPersistentComputers(ctx context.Context, c *client) ([]PersistentComputer, error) {
	items, err := persistentPages(ctx, c, "persistent")
	if err != nil {
		return nil, err
	}
	computers := make([]PersistentComputer, 0, len(items))
	for _, item := range items {
		computer, err := decodePersistentComputer(item)
		if err != nil {
			return nil, err
		}
		computers = append(computers, computer)
	}
	return computers, nil
}

func persistentPages(ctx context.Context, c *client, kind string) ([]json.RawMessage, error) {
	var items []json.RawMessage
	for page := 0; page < 10; page++ {
		r, err := persistentCall(ctx, c, "GET", fmt.Sprintf("%s/%s?limit=100&offset=%d", persistentBase, kind, len(items)), nil, false, "")
		if err != nil {
			return nil, err
		}
		var body struct {
			Computers []json.RawMessage `json:"computers"`
			Snapshots []json.RawMessage `json:"snapshots"`
			Total     *int              `json:"total"`
		}
		if json.Unmarshal(r.body, &body) != nil || body.Total == nil {
			return nil, invalidPersistentResponse()
		}
		batch := body.Computers
		if kind == "snapshots" {
			batch = body.Snapshots
		}
		items = append(items, batch...)
		if len(batch) == 0 || len(items) >= *body.Total {
			break
		}
	}
	return items, nil
}

func persistentCall(ctx context.Context, c *client, method, path string, body any, retry bool, notFound string, accept ...string) (response, error) {
	r, err := c.send(ctx, method, path, body, retry || method == http.MethodGet, time.Minute, false)
	if err != nil {
		var typed *Error
		if errors.As(err, &typed) && typed.Code == ErrTimeout && ctx.Err() != nil {
			return r, contextError(ctx)
		}
		return r, err
	}
	if r.status >= 200 && r.status < 300 {
		return r, nil
	}
	detail := persistentDetail(r)
	for _, accepted := range accept {
		if detail == accepted {
			return r, nil
		}
	}
	if blocked := responseFailure(r, ErrAPI, ""); errors.Is(blocked, ErrEdgeBlocked) {
		return r, blocked
	}
	if detail == "computer_not_enabled" {
		if upgrade := macUpgradeMessage(r); upgrade != "" {
			return r, &Error{Code: ErrNotAvailableOnPlatform, Reason: ReasonUpgradeRequired, HTTPStatus: r.status, Message: upgrade}
		}
	}
	if known, ok := persistentRefusals[detail]; ok {
		var reason RefusalReason
		switch RefusalReason(detail) {
		case ReasonPersistentComputersNotEnabled, ReasonInferenceNotEnabled, ReasonInferenceUnavailable:
			reason = RefusalReason(detail)
		}
		return r, &Error{Code: known.code, Reason: reason, HTTPStatus: r.status, Message: known.message}
	}
	suffix := ""
	if detail != "" {
		suffix = ", " + detail
	}
	switch {
	case r.status == 401 || r.status == 403:
		return r, &Error{Code: ErrAuthRejected, HTTPStatus: r.status, Message: fmt.Sprintf("Revyl rejected the request (HTTP %d%s). Check that REVYL_API_KEY is a current key and that its owner has the Member role or above.", r.status, suffix)}
	case r.status == 404:
		if notFound == "" {
			notFound = "Revyl could not find " + path + " (inaccessible)."
		}
		return r, &Error{Code: ErrNotFound, HTTPStatus: r.status, Message: notFound}
	case r.status == 422 || detail == "invalid_request":
		if detail == "" {
			detail = fmt.Sprintf("HTTP %d", r.status)
		}
		return r, &Error{Code: ErrInvalidArgument, HTTPStatus: r.status, Message: "Revyl refused the request as invalid (" + detail + "). Check the call's arguments against its doc comment; if they match, update Verify."}
	}
	return r, &Error{Code: ErrAPI, HTTPStatus: r.status, Message: fmt.Sprintf("Revyl request %s %s failed (HTTP %d%s). It is safe to try again; if it keeps failing, send this message to support@revyl.ai.", method, path, r.status, suffix)}
}

func persistentDetail(r response) string {
	var body struct {
		Detail json.RawMessage `json:"detail"`
	}
	var detail string
	if json.Unmarshal(r.body, &body) != nil || json.Unmarshal(body.Detail, &detail) != nil {
		return ""
	}
	return detail
}

func timeoutOr(ctx context.Context, err error, message string) error {
	if ctx.Err() == nil || !errors.Is(err, ErrTimeout) {
		return err
	}
	return &Error{Code: ErrTimeout, Message: message, Cause: err}
}

func computerNotFound(reference string) error {
	kind := "named"
	if uuidPattern.MatchString(reference) {
		kind = "with the ID"
	}
	return failure(ErrNotFound, fmt.Sprintf("There is no persistent computer %s %s. ListPersistent shows your organization's persistent computers; OpenPersistent with a name creates one.", kind, reference))
}

func checkComputerReference(value, call string) error {
	if persistentNamePattern.MatchString(value) || uuidPattern.MatchString(value) {
		return nil
	}
	return failure(ErrInvalidArgument, call+" takes a computer name of "+persistentNameRule+", or an ID from ListPersistent.")
}

type persistentStatusJSON struct {
	ComputerID         string     `json:"computer_id"`
	State              string     `json:"state"`
	SavedAt            *time.Time `json:"saved_at"`
	Durable            *bool      `json:"durable"`
	CreatedAt          time.Time  `json:"created_at"`
	SavedDiskExpiresAt *time.Time `json:"saved_disk_expires_at"`
}

func decodePersistentDetail(body []byte) (*PersistentComputer, error) {
	var detail struct {
		Persistent json.RawMessage `json:"persistent"`
	}
	if json.Unmarshal(body, &detail) != nil {
		return nil, invalidPersistentResponse()
	}
	if len(detail.Persistent) == 0 || string(detail.Persistent) == "null" {
		return nil, nil
	}
	computer, err := decodePersistentComputer(detail.Persistent)
	if err != nil {
		return nil, err
	}
	return &computer, nil
}

func decodePersistentComputer(raw []byte) (PersistentComputer, error) {
	var status persistentStatusJSON
	if json.Unmarshal(raw, &status) != nil || !uuidPattern.MatchString(status.ComputerID) || status.Durable == nil || status.CreatedAt.IsZero() {
		return PersistentComputer{}, invalidPersistentResponse()
	}
	switch status.State {
	case "starting", "running", "stopping", "stopped":
	default:
		return PersistentComputer{}, invalidPersistentResponse()
	}
	computer := PersistentComputer{ID: strings.ToLower(status.ComputerID), State: status.State, SavedOffHost: *status.Durable, CreatedAt: status.CreatedAt}
	if status.SavedAt != nil {
		computer.SavedAt = *status.SavedAt
	}
	if status.SavedDiskExpiresAt != nil {
		computer.SavedDiskExpiresAt = *status.SavedDiskExpiresAt
	}
	return computer, nil
}

func decodeSnapshot(raw []byte) (ComputerSnapshot, error) {
	var snapshot struct {
		ID                 string     `json:"id"`
		Name               string     `json:"name"`
		ComputerID         string     `json:"computer_id"`
		SavedAt            time.Time  `json:"saved_at"`
		ExpiresAt          *time.Time `json:"expires_at"`
		SavedDiskExpiresAt *time.Time `json:"saved_disk_expires_at"`
	}
	if json.Unmarshal(raw, &snapshot) != nil || !uuidPattern.MatchString(snapshot.ID) || !uuidPattern.MatchString(snapshot.ComputerID) || snapshot.Name == "" || snapshot.SavedAt.IsZero() {
		return ComputerSnapshot{}, invalidPersistentResponse()
	}
	result := ComputerSnapshot{ID: strings.ToLower(snapshot.ID), Name: snapshot.Name, ComputerID: strings.ToLower(snapshot.ComputerID), SavedAt: snapshot.SavedAt}
	if snapshot.ExpiresAt != nil {
		result.ExpiresAt = *snapshot.ExpiresAt
	}
	if snapshot.SavedDiskExpiresAt != nil {
		result.SavedDiskExpiresAt = *snapshot.SavedDiskExpiresAt
	}
	return result, nil
}

func invalidPersistentResponse() error {
	return failure(ErrAPI, "Revyl returned an invalid persistent computer response.")
}
