#!/usr/bin/env bash
# Publish the paper bot snapshot into this dashboard repo.
#
# Runs $TRADEBOT_DIR/scripts/dashboard_data.py (default TRADEBOT_DIR=/workspace/tradebot),
# copies stdout to data/snapshot.json, and commits + pushes only when that file changed.
#
# Authentication: GH_DASH_TOKEN is read from the environment and handed to git
# through an https remote used only for this push. The token is never written
# into the repo, git config, the askpass helper, or this script's logs.
# Refuses to run under xtrace (bash -x), which would print the token.

set -euo pipefail

case $- in
  *x*)
    echo "error: refusing to run under xtrace" >&2
    exit 1
    ;;
esac

umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TRADEBOT_DIR="${TRADEBOT_DIR:-/workspace/tradebot}"
PY="${TRADEBOT_DIR}/scripts/dashboard_data.py"
BRANCH="${DASH_BRANCH:-main}"

if [[ -z "${GH_DASH_TOKEN:-}" ]]; then
  echo "error: GH_DASH_TOKEN is not set" >&2
  exit 1
fi
case "${GH_DASH_TOKEN}" in
  *[[:space:]]*)
    echo "error: GH_DASH_TOKEN must not contain whitespace" >&2
    exit 1
    ;;
esac

if [[ ! -f "$PY" ]]; then
  echo "error: bot snapshot script not found: $PY" >&2
  echo "error: set TRADEBOT_DIR to the tradebot checkout" >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1 || ! command -v git >/dev/null 2>&1; then
  echo "error: python3 and git are required" >&2
  exit 1
fi

cd "$ROOT"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "error: $ROOT is not a git checkout" >&2
  exit 1
fi

current="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$current" != "$BRANCH" ]]; then
  echo "error: refusing to publish from branch $current (expected $BRANCH)" >&2
  exit 1
fi

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"; rm -f "$ROOT/data/snapshot.json.tmp"' EXIT

# The generator must not see the dashboard token.
(
  unset GH_DASH_TOKEN
  python3 "$PY"
) > "$tmpdir/snapshot.json"

python3 - "$tmpdir/snapshot.json" << 'PY'
import json, sys
path = sys.argv[1]
try:
    with open(path) as handle:
        data = json.load(handle)
except json.JSONDecodeError:
    sys.stderr.write("error: dashboard_data.py did not print JSON\n")
    sys.exit(1)
if not isinstance(data, dict) or "equity" not in data:
    sys.stderr.write("error: dashboard_data.py did not emit a snapshot object\n")
    sys.exit(1)
PY

mkdir -p "$ROOT/data"
cp "$tmpdir/snapshot.json" "$ROOT/data/snapshot.json.tmp"
mv "$ROOT/data/snapshot.json.tmp" "$ROOT/data/snapshot.json"

git add -- data/snapshot.json
did_commit=0
if ! git diff --cached --quiet -- data/snapshot.json; then
  if git config user.name >/dev/null 2>&1 && git config user.email >/dev/null 2>&1; then
    git commit -m "Update paper dashboard snapshot" -- data/snapshot.json
  else
    git -c user.name="${GIT_AUTHOR_NAME:-paper-dashboard}" \
        -c user.email="${GIT_AUTHOR_EMAIL:-paper-dashboard@users.noreply.github.com}" \
        commit -m "Update paper dashboard snapshot" -- data/snapshot.json
  fi
  did_commit=1
fi

ahead=0
if git rev-parse --verify "origin/${BRANCH}" >/dev/null 2>&1; then
  other=0
  while IFS= read -r path; do
    [[ -z "$path" ]] && continue
    if [[ "$path" != "data/snapshot.json" ]]; then
      other=1
    fi
  done < <(git diff --name-only "origin/${BRANCH}..HEAD")
  if [[ "$other" -eq 1 ]]; then
    echo "error: ${BRANCH} is ahead of origin/${BRANCH} by more than data/snapshot.json; not pushing" >&2
    exit 1
  fi
  ahead="$(git rev-list --count "origin/${BRANCH}..HEAD")"
elif [[ "$did_commit" -eq 1 ]]; then
  ahead=1
fi

if [[ "$ahead" -eq 0 ]]; then
  echo "snapshot unchanged; nothing to publish"
  exit 0
fi

origin="$(git remote get-url origin)"
repo="$(printf '%s' "$origin" | python3 -c '
import re, sys
url = sys.stdin.read().strip()
url = re.sub(r"^https://[^@/]+@", "https://", url)
url = re.sub(r"\.git$", "", url).rstrip("/")
match = re.search(r"github\.com[:/]([^/]+)/([^/]+)$", url)
if not match:
    sys.stderr.write("error: origin is not a github.com repository URL\n")
    sys.exit(2)
path = f"{match.group(1)}/{match.group(2)}"
if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", path):
    sys.stderr.write("error: origin repository path is not a simple owner/name\n")
    sys.exit(2)
sys.stdout.write(path)
')"

# Helper contains no secret. Git asks it for a username and a password.
cat > "$tmpdir/askpass.sh" << 'EOF'
#!/bin/sh
case "$1" in
  *Username*|*username*) printf '%s\n' "x-access-token" ;;
  *) printf '%s\n' "${GH_DASH_TOKEN}" ;;
esac
EOF
chmod 700 "$tmpdir/askpass.sh"

# Runtime https remote. The token stays in the environment, not in the URL,
# so git cannot store it in .git/config or print it in a remote URL.
remote="https://github.com/${repo}.git"

# Do not let an ambient trace or injected git config write or log the token.
unset GIT_TRACE GIT_TRACE_PACKET GIT_TRACE_PERFORMANCE GIT_CURL_VERBOSE GIT_DEBUG GIT_CONFIG_PARAMETERS
if [[ -n "${GIT_CONFIG_COUNT:-}" ]]; then
  i=0
  while [[ "$i" -lt "${GIT_CONFIG_COUNT}" ]]; do
    unset "GIT_CONFIG_KEY_${i}" "GIT_CONFIG_VALUE_${i}"
    i=$((i + 1))
  done
  unset GIT_CONFIG_COUNT
fi

set +e
output="$(
  GIT_ASKPASS="$tmpdir/askpass.sh" \
  GIT_TERMINAL_PROMPT=0 \
  git -c credential.helper= \
    push "$remote" "HEAD:${BRANCH}" 2>&1
)"
status=$?
set -e

printf '%s' "$output" | python3 -c 'import os, sys
token = os.environ.get("GH_DASH_TOKEN", "")
text = sys.stdin.read()
if token:
    text = text.replace(token, "***")
sys.stdout.write(text)
'
if [[ "$status" -ne 0 ]]; then
  exit "$status"
fi

git update-ref "refs/remotes/origin/${BRANCH}" HEAD
echo "published $(git rev-parse --short HEAD)"
