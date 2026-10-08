#!/bin/sh
# Deploy-observability event → Vector :9880 → ClickHouse logs.entries.
# Contract and pitfalls: docs/ops-traps.md, «Деплой-наблюдаемость».
#   ci-notify.sh <step> start
#   ci-notify.sh <step> finish <success|fail> [duration_s]
#   ci-notify.sh <step> finish-unless-done          ← for a CI job's after_script
# Env: OBS_TOKEN (empty → silent no-op), OBS_ENDPOINT, OBS_PROJECT.
# duration_s may be omitted: start writes /tmp/obs_t0_<step>, finish computes it itself.
# <step> — [a-z0-9-] only: values are spliced into JSON without escaping, a quote/space = a broken event (Vector drops it silently).
# ANY outcome — exit 0: observability has no right to take down the pipeline.
# POSIX sh: alpine jobs live on busybox ash, there is no bash there.
#
# About finish-unless-done (MINIPC-78). A CI job used to report ONLY via the last
# line of script, i.e. only about success: any failure cut the job off before it,
# and "failed" became indistinguishable from "never ran". This is fixed by
# `after_script`, but that one runs after success too — hence the phase is not
# "send fail" but "send fail if finish has not been sent yet". The tell is the
# marker /tmp/obs_done_<step>, which finish itself sets.
# A marker, not $CI_JOB_STATUS: nobody has measured GitFlic's support for that
# variable, and a missing variable would silently turn the condition into "always fail".
# start REMOVES the marker: the runner reuses the container for the same job of the
# next pipeline, and yesterday's marker would mute today's failure.

STEP="${1:-unknown}"
PHASE="${2:-start}"
STATUS="${3:-}"
DURATION="${4:-}"

[ -n "${OBS_TOKEN:-}" ] || exit 0

ENDPOINT="${OBS_ENDPOINT:-http://10.8.1.12:9880}"
PROJECT="${OBS_PROJECT:-itgame}"
T0F="/tmp/obs_t0_${STEP}"
DONEF="/tmp/obs_done_${STEP}"

if [ "$PHASE" = "start" ]; then
  date +%s > "$T0F" 2>/dev/null || true
  rm -f "$DONEF" 2>/dev/null || true
elif [ "$PHASE" = "finish-unless-done" ]; then
  # The job has already reported by itself — stay silent. This is the normal path of a successful job, not an error.
  [ -f "$DONEF" ] && exit 0
  PHASE=finish
  STATUS=fail
fi

if [ "$PHASE" = "finish" ] && [ -z "$DURATION" ] && [ -f "$T0F" ]; then
  # t0 may be empty/corrupt (interrupted write): a non-number in $(( )) fatally
  # kills busybox ash BEFORE exit 0 — just send the event without duration.
  T0="$(cat "$T0F" 2>/dev/null || true)"
  case "$T0" in
    ''|*[!0-9]*) ;;
    *) DURATION=$(( $(date +%s) - T0 )) ;;
  esac
fi

# ci-image-check (bare alpine) has no git — sha is simply omitted.
SHA="$(git rev-parse HEAD 2>/dev/null || true)"
LEVEL=info; [ "$STATUS" = "fail" ] && LEVEL=error
MSG="deploy: ${STEP} ${PHASE}${STATUS:+ ${STATUS}}${DURATION:+ ${DURATION}s}"

FIELDS="\"step\":\"${STEP}\",\"phase\":\"${PHASE}\""
[ -n "$STATUS" ]   && FIELDS="${FIELDS},\"status\":\"${STATUS}\""
[ -n "$DURATION" ] && FIELDS="${FIELDS},\"duration_s\":\"${DURATION}\""
[ -n "$SHA" ]      && FIELDS="${FIELDS},\"sha\":\"${SHA}\""
[ -n "${CI_PIPELINE_ID:-}" ] && FIELDS="${FIELDS},\"pipeline\":\"${CI_PIPELINE_ID}\""

BODY="{\"project\":\"${PROJECT}\",\"source\":\"deploy\",\"level\":\"${LEVEL}\",\"message\":\"${MSG}\",\"fields\":{${FIELDS}}}"

if command -v curl >/dev/null 2>&1; then
  curl -s --max-time 5 -H "Content-Type: application/json" -H "x-token: ${OBS_TOKEN}" \
    -d "$BODY" "$ENDPOINT" >/dev/null 2>&1 || true
elif command -v wget >/dev/null 2>&1; then
  # busybox wget (alpine): supports --header/--post-data, but not --max-time.
  wget -q -T 5 -t 1 --header="Content-Type: application/json" --header="x-token: ${OBS_TOKEN}" \
    --post-data="$BODY" -O /dev/null "$ENDPOINT" 2>/dev/null || true
fi

# The marker is set AFTER sending and on every finish, including fail: after_script
# must not send a second event on top of what the job sent itself.
[ "$PHASE" = "finish" ] && { : > "$DONEF" 2>/dev/null || true; }
exit 0
