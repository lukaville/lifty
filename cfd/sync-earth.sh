#!/usr/bin/env bash
# Pull finished simulation results from a remote machine and pack them for the
# app, every few minutes (local viewing while a batch runs).
#   cfd/sync-earth.sh [host=earth] [remote dir=/media/nickolay/Data_1.5TB/lifty-cfd/repo] [interval s=600]
set -uo pipefail
cd "$(dirname "$0")/.."
HOST=${1:-earth}; REMOTE=${2:-/media/nickolay/Data_1.5TB/lifty-cfd/repo}; EVERY=${3:-600}
while true; do
  rsync -a "$HOST:$REMOTE/cfd/runs/_bins/" cfd/runs/_earth/     # OpenFOAM, full precision, for compare.mjs
  rsync -a "$HOST:$REMOTE/cfd/runs/_lbm/" cfd/runs/_lbm/ && node cfd/pack.mjs cfd/runs/_lbm --out public/data/les | tail -n +1
  date +%T; sleep "$EVERY"
done
