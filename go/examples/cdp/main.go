// Command cdp attaches chromedp to a Verify web session over the Chrome DevTools Protocol (CDP), next to Verify's
// steps. It opens Sauce Demo, a public practice store, listens for network requests and console messages, signs in
// and reads the page heading with chromedp, runs a Verify validation while attached, then disconnects and closes.
//
//	cd go/examples/cdp && go run .
//
// It needs REVYL_API_KEY (or a saved Revyl login). Verify finds or creates the Revyl web app for the URL's origin and
// logs its ID. It is its own Go module, so chromedp is not a dependency of the Verify module. It starts a real, billable session.
package main

import (
	"context"
	"errors"
	"log"
	"time"

	verify "github.com/RevylAI/verify/go"
	"github.com/chromedp/cdproto/network"
	"github.com/chromedp/cdproto/runtime"
	"github.com/chromedp/cdproto/target"
	"github.com/chromedp/chromedp"
	"github.com/chromedp/chromedp/remote"
)

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() (err error) {
	ctx := context.Background()
	s, err := verify.Open(ctx, verify.Target{Platform: verify.Web, URL: "https://www.saucedemo.com"},
		verify.OpenOptions{Log: func(line string) { log.Println(line) }})
	if err != nil {
		return err
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		err = errors.Join(err, s.Close(cleanup))
	}()

	endpoint, err := s.CDP(ctx) // works for one connection, within 60 seconds
	if err != nil {
		return err
	}
	allocCtx, disconnect := remote.NewAllocator(ctx, endpoint.URL, remote.NoModifyURL)
	defer disconnect() // closes the connection; the session keeps running until Close
	browserCtx, cancelBrowser := chromedp.NewContext(allocCtx)
	defer cancelBrowser()
	targets, err := chromedp.Targets(browserCtx)
	if err != nil {
		return err
	}
	var tab target.ID
	for _, t := range targets {
		if t.Type == "page" {
			tab = t.TargetID
			break
		}
	}
	// Attach to the session's own tab, and detach without closing it when done.
	tabCtx, detach := chromedp.NewContext(browserCtx, chromedp.WithTargetID(tab), chromedp.WithDetachOnCancel())
	defer detach()

	if err := chromedp.Listen(tabCtx, func(event any) {
		switch event := event.(type) {
		case *network.EventRequestWillBeSent:
			log.Println("request:", event.Request.URL)
		case *runtime.EventConsoleAPICalled:
			for _, arg := range event.Args {
				log.Println("console:", string(arg.Value))
			}
		}
	}); err != nil {
		return err
	}
	if err := chromedp.Do(tabCtx, chromedp.Navigate("https://www.saucedemo.com")); err != nil {
		return err
	}
	title, err := chromedp.Run(tabCtx, chromedp.Title())
	if err != nil {
		return err
	}
	// Sauce Demo publishes these practice credentials on its sign-in page.
	if err := chromedp.Do(tabCtx,
		chromedp.SendKeys(chromedp.CSS("#user-name"), "standard_user"),
		chromedp.SendKeys(chromedp.CSS("#password"), "secret_sauce"),
		chromedp.Click(chromedp.CSS("#login-button")),
	); err != nil {
		return err
	}
	heading, err := chromedp.Run(tabCtx, chromedp.Text(chromedp.CSS(".title")))
	if err != nil {
		return err
	}
	log.Printf("title: %s, heading: %s", title, heading)
	if err := chromedp.Do(tabCtx, chromedp.Evaluate[chromedp.Void]("console.log('hello from chromedp')")); err != nil {
		return err
	}

	// Verify steps keep working while chromedp is attached.
	_, err = s.Validation(ctx, "A list of products is shown")
	return err
}
