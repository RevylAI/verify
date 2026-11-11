// Command byomodel runs Verify's instruction and validation steps on a model you choose instead of Revyl's
// agent, then drives the device with exact actions. The device is a Revyl cloud iPhone running Settings.
//
//	cd go && go run ./examples/byomodel
//
// It needs REVYL_API_KEY (or a saved Revyl login) and the key of the provider in MODEL, which defaults to
// anthropic/claude-sonnet-5-5 and so reads ANTHROPIC_API_KEY. It starts a real, billable session.
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"time"

	verify "github.com/RevylAI/verify/go"
)

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() (err error) {
	ctx := context.Background()
	model := os.Getenv("MODEL")
	if model == "" {
		model = "anthropic/claude-sonnet-5-5"
	}
	s, err := verify.Open(ctx, verify.Target{Platform: verify.IOS, BundleID: "com.apple.Preferences"},
		verify.OpenOptions{Log: func(line string) { log.Println(line) }},
		verify.WithModel(model))
	if err != nil {
		return err
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		err = errors.Join(err, s.Close(cleanup))
	}()
	log.Println("Watch:", s.ViewerURL())
	step, err := s.Instruction(ctx, "Open General, then About")
	if err != nil {
		return err
	}
	fmt.Printf("%d turns, %d input and %d output tokens on %s\n", len(step.Model.Turns), step.Model.InputTokens, step.Model.OutputTokens, step.Model.ID)
	if _, err := s.Validation(ctx, "The screen shows the iOS version"); err != nil {
		return err
	}
	if _, err := s.Tap(ctx, verify.Element("Back button")); err != nil {
		return err
	}
	if err := s.Swipe(ctx, verify.SwipeUp); err != nil {
		return err
	}
	_, err = s.Screenshot(ctx, ".verify/settings.png")
	return err
}
