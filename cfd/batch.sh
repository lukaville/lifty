#!/usr/bin/env bash
# Solve every site × wind direction, resumably: directions whose .bin already
# exists are skipped, so the script can be re-run after an interruption.
#   cfd/batch.sh [jobs=4] [procs-per-job=5] [sites...]
# Env: RUNS (case dir, default cfd/runs), OUT (default public/data/cfd),
#      DIRS (default the 16 compass points), NODE (e.g. a `docker run … node`
#      wrapper where the host Node is too old), DOCKER (passed to run.sh).
set -uo pipefail
cd "$(dirname "$0")/.."
JOBS=${1:-4}; NP=${2:-5}; shift 2 2>/dev/null || shift $#
SITES=${*:-$(ls public/data/terrain | sed 's/\.json$//')}
RUNS=${RUNS:-cfd/runs}; OUT=${OUT:-public/data/cfd}
DIRS=${DIRS:-"0 22.5 45 67.5 90 112.5 135 157.5 180 202.5 225 247.5 270 292.5 315 337.5"}
NODE=${NODE:-node}
export RUNS OUT NODE NP

one() {
  local slug=$1 dir=$2 name case
  name=d$(awk -v d="$dir" 'BEGIN{printf "%03d", int(d + 0.5)}')
  case=$RUNS/$slug/$name
  [ -f "$OUT/$slug/$name.bin" ] && return 0
  local t0=$SECONDS
  { $NODE cfd/make-case.mjs "$slug" "$dir" --dx 25 --nz 28 --iter 1200 --out "$RUNS" \
    && cfd/run.sh "$case" "$NP" \
    && $NODE cfd/extract.mjs "$case" --out "$OUT"; } > "$RUNS/$slug-$name.log" 2>&1
  local rc=$?
  echo "$(date +%T) $([ $rc = 0 ] && echo DONE || echo FAIL) $slug $name $(( (SECONDS - t0) / 60 )) min"
  # keep the log and the solution, drop the bulky mesh copies of old iterations
  [ $rc = 0 ] && rm -rf "$case"/processor*
}
export -f one

mkdir -p "$RUNS"
for s in $SITES; do for d in $DIRS; do echo "$s $d"; done; done \
  | xargs -P "$JOBS" -L 1 bash -c 'one "$0" "$1"'
