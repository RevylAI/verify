#!/usr/bin/env bash
set -euo pipefail

curl -fsS -c jar.txt -o /dev/null \
  -d 'username=tomsmith&password=SuperSecretPassword!' \
  https://the-internet.herokuapp.com/authenticate

cookie=$(awk -F'\t' '$6 == "rack.session" { print $7 }' jar.txt)
test -n "$cookie"

jq -n --arg value "$cookie" '{
  cookies: [{ name: "rack.session", value: $value, domain: "the-internet.herokuapp.com", path: "/", httpOnly: true, secure: true }],
  origins: []
}' > "$REVYL_BROWSER_STORAGE_STATE_FILE"

printf '/secure' > "$REVYL_DEEP_LINK_FILE"
