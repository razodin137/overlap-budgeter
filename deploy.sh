#!/usr/bin/env bash
# Publish the Overlap Time Budgeter image to GHCR and roll the ONCE deploy.
#
# Usage:
#   1. Make your changes to index.html.
#   2. git add . && git commit -m "..." && git push   # record history
#   3. ./deploy.sh                                     # build, push, roll out
#
# Requires: docker buildx, this host logged in to ghcr.io
# (gh auth token | docker login ghcr.io -u razodin137 --password-stdin),
# and the `once` CLI on PATH.

set -euo pipefail

cd "$(dirname "$0")"

IMAGE="ghcr.io/razodin137/overlap-budgeter"
HOST="timer.godisgood.top"
SHA="$(git rev-parse --short HEAD)"

if [ -n "$(git status --porcelain)" ]; then
  echo "WARNING: working tree is dirty — the image won't match commit ${SHA}." >&2
  echo "         Commit and push first if you want the deploy to match a real commit." >&2
fi

echo "==> Building + pushing ${IMAGE}:latest and ${IMAGE}:sha-${SHA}"
docker buildx build --platform linux/amd64 \
  -t "${IMAGE}:latest" \
  -t "${IMAGE}:sha-${SHA}" \
  --push .

echo "==> Rolling ${HOST} to ${IMAGE}:sha-${SHA}"
once update "${HOST}" --image "${IMAGE}:sha-${SHA}"

echo "==> Done. Verify: curl -s https://${HOST}/  |  once list"