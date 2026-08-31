#!/usr/bin/env bash
#
# Turn a failed matrix entry into something readable without opening the log.
#
# A matrix of six generated projects fails in the most annoying way available:
# the run page shows six red dots, the job name is an id somebody chose, and the
# actual compiler output is forty screens down inside a step that scrolled past.
# This prints the three things needed to act — which combination, which step,
# and what the compiler actually said — into the job summary, into an annotation
# on the run, and into the log itself.
#
# Invoked as `bash <path>` by the workflow rather than executed directly. This
# repository is developed on Windows, where git cannot record the executable
# bit, and a mode that depends on who last touched the file is a CI failure
# waiting for a new contributor.
#
# The full log is echoed as well as excerpted. The excerpt is for reading; the
# full copy is for the error that only makes sense in context.

set -uo pipefail

id="${1:?combination id}"
flags="${2:?generator flags}"
step="${3:?step name}"
log="${4:?log file}"

lines=60

# Annotation on the run itself, so the failure has a title on the summary page
# rather than only a red dot. Newlines are not permitted in an annotation, so
# this is the first meaningful line and nothing more.
first=$(grep -m1 -E "error|Error|ERROR" "$log" 2>/dev/null || head -n 1 "$log")
echo "::error title=${id}: ${step} failed::${first}"

{
  echo "## ${id} — ${step} failed"
  echo
  echo "Reproduce:"
  echo
  echo '```'
  echo "pnpm --filter @adminigloo/create-app build"
  echo "node packages/create-app/dist/index.js app --yes ${flags}"
  echo '```'
  echo
  echo "Last ${lines} lines of \`${step}\`:"
  echo
  echo '```'
  tail -n "${lines}" "$log"
  echo '```'
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"

echo "----- ${id}: ${step} failed, full output follows -----"
cat "$log"
echo "----- end ${id}: ${step} -----"
