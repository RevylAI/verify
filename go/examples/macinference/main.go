// Command macinference checks a Mac computer's screen with the Mac's own vision model: it opens a Mac with
// inference, prints whether the model is ready, runs a validation and an extract on the Mac's screen and, when
// IOS_APP_ID and IOS_BUILD_ID are set, opens that iOS app inside the Mac, where its steps run on the same model first.
//
//	cd go && go run ./examples/macinference
//
// It needs REVYL_API_KEY (or a saved Revyl login) and an organization with Mac computers and local inference (ask
// support@revyl.ai). It starts a real, billable Mac computer.
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
	mac, err := verify.Open(ctx, verify.Target{Platform: verify.Mac, Inference: new(true)},
		verify.OpenOptions{Log: func(line string) { log.Println(line) }})
	if err != nil {
		return err
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 310*time.Second)
		defer cancel()
		err = errors.Join(err, mac.Close(cleanup))
	}()
	log.Println("Watch:", mac.ViewerURL())
	fmt.Println("Mac model:", mac.Inference())
	if _, err := mac.Validation(ctx, "The Dock is visible at the bottom of the screen"); err != nil {
		return err
	}
	date, err := mac.Extract(ctx, "the date at the right end of the menu bar")
	if err != nil {
		return err
	}
	fmt.Printf("Menu bar date: %q (engine %s)\n", date.Value, date.Engine)

	appID, buildID := os.Getenv("IOS_APP_ID"), os.Getenv("IOS_BUILD_ID")
	if appID == "" || buildID == "" {
		fmt.Println("Set IOS_APP_ID and IOS_BUILD_ID to also open your iOS app inside this Mac.")
		return nil
	}
	app, err := mac.Open(ctx, verify.Target{Platform: verify.IOS, AppID: appID, BuildID: buildID})
	if err != nil {
		return err
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		err = errors.Join(err, app.Close(cleanup))
	}()
	step, err := app.Validation(ctx, "The app's first screen is showing", verify.ValidationOptions{Soft: true})
	if err != nil {
		return err
	}
	fmt.Printf("First screen showing: %v (engine %s)\n", step.Passed, step.Engine)
	return nil
}
