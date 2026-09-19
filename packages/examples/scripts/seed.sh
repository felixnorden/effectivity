#!/usr/bin/env bash
#
# Seed example content and accounts through the public HTTP API, for querying
# and manual testing. Idempotent: existing documents/assets are updated via
# If-Match round-trip; existing users are skipped.
#
# Usage:
#   bun run seed                              # local dev at http://localhost:8788
#   CMS_URL=https://cms.example.com bun run seed
#   effectivity seed --url https://cms.example.com
#
# Environment overrides:
#   CMS_URL        base URL of the running worker (default http://localhost:8788)
#   ORIGIN         must match the worker's AUTH_URL (CSRF origin check)
#   ADMIN_EMAIL / ADMIN_PASSWORD   the boot-seeded admin (effectivity.config.ts auth.admin, .dev.vars)
set -u

CMS_URL="${CMS_URL:-http://localhost:8788}"
ORIGIN="${ORIGIN:-http://localhost:8787}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@effectivity.local}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-admin-seed-password-0123}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
CJ="$TMP/cookies"
JSON='content-type: application/json'
MD='content-type: text/markdown'
OCTET='content-type: application/octet-stream'
PLAIN='content-type: text/plain'

for _ in $(seq 1 40); do
  curl -s -o /dev/null -m 3 "$CMS_URL/openapi.json" 2>/dev/null && break
  sleep 2
done
if ! curl -s -o /dev/null -m 3 "$CMS_URL/openapi.json"; then
  echo "no server at $CMS_URL — start one first:" >&2
  echo "  cd packages/examples && bun run cms dev" >&2
  exit 1
fi

STATUS=$(curl -s -m 8 -c "$CJ" -o "$TMP/signin.json" -w "%{http_code}" -X POST \
  -H "$JSON" -H "origin: $ORIGIN" \
  --data "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" \
  "$CMS_URL/auth/sign-in/email")
if [ "$STATUS" != 200 ]; then
  echo "sign-in as $ADMIN_EMAIL failed ($STATUS) — check ADMIN_EMAIL/ADMIN_PASSWORD" >&2
  exit 1
fi
echo "signed in as $ADMIN_EMAIL"

# put_blob <kind> <path> <content-type> <body> — create (201) or update via
# the version returned in the GET etag header (200). Fails loudly otherwise.
put_blob() {
  local kind="$1" path="$2" ct="$3" body="$4" etag status
  etag=$(curl -s -m 8 -D "$TMP/h.txt" -o /dev/null "$CMS_URL/$kind/$path" \
    && awk 'tolower($1) == "etag:" { gsub(/\r/, "", $2); print $2 }' "$TMP/h.txt")
  if [ -n "$etag" ]; then
    status=$(curl -s -m 8 -b "$CJ" -o /dev/null -w "%{http_code}" -X PUT -H "$ct" \
      -H "origin: $ORIGIN" -H "if-match: $etag" --data-binary "$body" \
      "$CMS_URL/$kind/$path")
    echo "  updated $kind/$path ($status)"
  else
    status=$(curl -s -m 8 -b "$CJ" -o /dev/null -w "%{http_code}" -X PUT -H "$ct" \
      -H "origin: $ORIGIN" --data-binary "$body" "$CMS_URL/$kind/$path")
    echo "  created $kind/$path ($status)"
  fi
  if [ "$status" != 200 ] && [ "$status" != 201 ]; then
    echo "  !! unexpected status $status for $kind/$path" >&2
    exit 1
  fi
}

HELLO=$(cat <<'EOF'
---
title: Hello World
---
# Hello

Welcome to the effectivity CMS demo workspace.

![logo](assets/logo.txt)

The image reference above resolves to a seeded asset, so the reference report
labels it `present`. The one below is intentionally dangling:

![missing](assets/not-yet.jpg)

Guides: [Content model](guides/content-model) and [Authoring](guides/authoring).
EOF
)

CONTENT_MODEL=$(cat <<'EOF'
---
title: Content model
---
# Content model

Each document is a markdown file: frontmatter (validated `title` and whatever
your schema allows) plus a body. Assets are opaque bytes referenced from
bodies as images; `GET /references` re-scans them live.

![logo](assets/logo.txt)

See also [Authoring](guides/authoring).
EOF
)

AUTHORING=$(cat <<'EOF'
---
title: Authoring
---
# Authoring

Reads are public. Writes require a session cookie from `/auth/sign-in/email`
or an `x-api-key` header, and updates are conditional: send the `etag` from a
read back as `if-match`, or a stale client gets `412`.

See also [Content model](guides/content-model).
EOF
)

LOGO='effectivity-cms logo (seed asset)'

echo "== content"
put_blob documents hello-world "$MD" "$HELLO"
put_blob documents guides/content-model "$MD" "$CONTENT_MODEL"
put_blob documents guides/authoring "$MD" "$AUTHORING"
put_blob assets logo.txt "$PLAIN" "$LOGO"

echo "== accounts"
USER_STATUS=$(curl -s -m 8 -b "$CJ" -o /dev/null -w "%{http_code}" -X POST \
  -H "$JSON" -H "origin: $ORIGIN" \
  --data '{"email":"publisher@example.local","password":"publisher-password-0123","name":"Publisher"}' \
  "$CMS_URL/auth/admin/create-user")
case "$USER_STATUS" in
  200) echo "  created publisher@example.local (role: user)" ;;
  400 | 409 | 422) echo "  publisher@example.local already exists (skip)" ;;
  *) echo "  !! admin create-user -> $USER_STATUS" >&2 ;;
esac

curl -s -m 8 -b "$CJ" -o "$TMP/key.json" -X POST \
  -H "$JSON" -H "origin: $ORIGIN" --data '{"name":"seed-example"}' \
  "$CMS_URL/auth/api-key/create"
KEY=$(python3 -c "import json;print(json.load(open('$TMP/key.json')).get('key') or '')" 2>/dev/null || true)
if [ -n "$KEY" ]; then
  echo "  api key (shown once; delete+recreate to rotate): $KEY"
else
  echo "  !! api-key create failed" >&2
fi

echo
echo "Seeded. Try:"
echo "  curl $CMS_URL/documents                          # catalog listing"
echo "  curl $CMS_URL/documents/hello-world              # read (note the etag header)"
echo "  curl '$CMS_URL/documents/hello-world?view=model' # derived metadata"
echo "  curl $CMS_URL/references                         # present/dangling report"
echo "  curl $CMS_URL/openapi.json                       # full API surface"
echo "  curl -H 'x-api-key: \$KEY' -X PUT ...            # headless writes"
echo "  bun x wrangler d1 execute effectivity-auth --local --command \"SELECT email, role FROM user\""