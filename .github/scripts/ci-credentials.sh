#!/usr/bin/env bash
#
# The placeholder credentials every CI job boots a generated project with.
#
# ONE COPY, because there were two. The identical heredoc sat in ci.yml and in
# generator-matrix.yml, and it carried the identical malformed Clerk key —
# so the nightly matrix and the per-push pipeline had the same defect and
# fixing either alone would have left the other red with a diagnosis somebody
# had already written down. A fixture used by two jobs belongs to neither.
#
# A CONFIGURED APP, NOT A BLANK ONE, and that is the point of writing anything
# at all. Everything must boot with no credentials, and it must also boot and
# BUILD with them — those are different claims and only the first one is easy.
# A pipeline that never sets a credential cannot see the second class at all:
# `/setup/email` is prerendered at build time, the site header reads the Clerk
# session only once Clerk keys exist, and a build that never has keys never
# takes that branch. Every configuration in this matrix was reported green
# against a scaffold that no configured project could build.
#
# Variables belonging to packages a combination did not install are inert:
# src/env.ts is composed from the fragments the installed packages contributed,
# so it never looks at them. Nothing here reaches a network, and nothing here
# is a secret — every value is synthetic and safe to read in a public log.
#
# ---------------------------------------------------------------------------
# THE CLERK PUBLISHABLE KEY IS NOT AN OPAQUE STRING.
#
# This is what kept the nightly matrix red on every entry for days. Clerk
# decodes everything after `pk_test_` as base64 and requires the result to be a
# dotted frontend API host followed by exactly one `$` — the key ENCODES the
# host the browser will talk to, which is why a row of zeros behind the right
# prefix fails a check that a prefix alone would pass. `parsePublishableKey`
# rejects it with "Publishable key not valid (expected format: pk_test_... or
# pk_live_...)".
#
# It fails at RUNTIME, inside `clerkMiddleware`, and not at build time — which
# is why `next build` stayed green while `next start` answered nothing at all
# and the route sweep reported "next start never answered on
# http://127.0.0.1:3000/". Our own boot validation could not have caught it
# either: `authClient()` asks `prefixedSecret("pk_")` for a prefix and a
# minimum length, and by that standard a row of zeros is a valid key.
#
# The value below is base64("example.clerk.accounts.dev$"), which parses. The
# host is never dialled: with no cookies and no `Sec-Fetch-Dest: document`,
# `isRequestEligibleForHandshake` is false, Clerk skips the handshake redirect
# and returns a signed-out request — which is the state the sweep wants every
# route exercised in. It is the same key `scripts/verify-generated.mjs` writes,
# deliberately: two different fake hosts in one repository is exactly the drift
# this file exists to prevent.
#
# EVERY OTHER VALUE WAS CHECKED FOR THE SAME FAULT — right prefix, wrong shape
# — and none of them has it, because nothing else decodes:
#
#   CLERK_SECRET_KEY      `assertValidSecretKey` asserts a non-empty string and
#                         nothing more. The `_test_` marker matters only to our
#                         own `assertKeyMode`, which reads it as a substring.
#   whsec_ secrets        svix base64-decodes them and both decode cleanly, and
#                         in any case a `Webhook` is only constructed inside a
#                         webhook route handler — the sweep asks for pages.
#   STRIPE_SECRET_KEY     stripe-node keeps the string as a bearer token and
#                         never parses it. `new Stripe(...)` accepts it.
#   NEXT_PUBLIC_STRIPE_…  @stripe/stripe-js checks `typeof pk === "string"` and
#                         warns about version skew. Its module scope runs in a
#                         browser, which no step in this pipeline is.
#   RESEND_API_KEY        the constructor takes the string as given.
#   ANTHROPIC_API_KEY     likewise; `new Anthropic({ apiKey })` does not parse.
#
# ---------------------------------------------------------------------------
# EVERY VALUE IS QUOTED, and that is load-bearing rather than tidy.
#
# `.env.local` is read by three different parsers in this pipeline: Next's own
# loader, `process.loadEnvFile` in drizzle.config.ts, and — in the migration
# step — bash `source`. All three strip a matching pair of double quotes, but
# only bash cares that `EMAIL_FROM=CI <ci@example.com>` is a redirection
# followed by an unterminated `>`. It did care: sourcing died with a syntax
# error on that line, EMAIL_FROM and ANTHROPIC_API_KEY were never exported, and
# the step carried on regardless, because a failure in the middle of an
# `a && b && c` list is the one place `set -e` looks away. Quoting makes the
# file mean the same thing to all three readers.
#
# Invoked as `bash <path>` rather than executed directly, for the same reason as
# the other scripts here: this repository is developed on Windows, where git
# cannot record the executable bit, and a mode that depends on who last touched
# the file is a CI failure waiting for a new contributor.
#
# usage: ci-credentials.sh <app-dir>

set -euo pipefail

app="${1:?app directory}"
[ -d "$app" ] || { echo "::error title=credentials::$app is not a directory"; exit 1; }

cat > "$app/.env.local" <<'EOF'
NEXT_PUBLIC_APP_URL="http://localhost:3000"
DATABASE_URL="postgresql://u:p@ep-ci-pooler.us-east-2.aws.neon.tech/db"
DATABASE_URL_UNPOOLED="postgresql://u:p@ep-ci.us-east-2.aws.neon.tech/db"
CLERK_SECRET_KEY="sk_test_0000000000000000000000000000"
CLERK_WEBHOOK_SIGNING_SECRET="whsec_0000000000000000000000000000"
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY="pk_test_ZXhhbXBsZS5jbGVyay5hY2NvdW50cy5kZXYk"
STRIPE_SECRET_KEY="sk_test_1111111111111111111111111111"
STRIPE_WEBHOOK_SECRET="whsec_1111111111111111111111111111"
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY="pk_test_1111111111111111111111111111"
RESEND_API_KEY="re_22222222222222222222222222"
EMAIL_FROM="CI <ci@example.com>"
ANTHROPIC_API_KEY="sk-ant-api03-3333333333333333333333333"
EOF

# THE FIXTURE CHECKS ITSELF. See check-credentials.mjs for why a fixture needs
# a test of its own: the fault it guards against is a value that looks right,
# and the pipeline finds that one only after an install, a typecheck, a suite
# and a build, and then reports it as a server that never answered.
node "$(dirname "$0")/check-credentials.mjs" "$app"
