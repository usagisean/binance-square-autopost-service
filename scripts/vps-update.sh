#!/usr/bin/env bash
set -euo pipefail

# Run this on the VPS inside the cloned repository.
# It pulls latest code and rebuilds/restarts the local Docker image.

git pull --ff-only
mkdir -p data
chown -R 1000:1000 data
docker compose up -d --build
sleep 2
docker compose ps
