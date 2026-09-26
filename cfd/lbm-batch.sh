#!/usr/bin/env bash
# Solve every site × wind direction with the FluidX3D LES, resumably (like
# batch.sh): directions whose .bin already exists are skipped.
#   cfd/lbm-batch.sh [jobs=2] [sites...]
# Several cases can share one GPU: each needs ~3 GB of VRAM, and while one
# copies its velocity field back and samples it on the CPU the other computes.
# Env: RUNS (cases, default cfd/runs/lbm), OUT (default cfd/runs/_lbm),
#      FLUIDX3D (the binary built by fluidx3d/build.sh), DIRS, NODE (as batch.sh),
#      CASE_ARGS (extra lbm-case.mjs options, e.g. "--dx 5 --lx 7000 --ly 4000 --top 700"),
#      OCL_ICD_VENDORS / OCL_ICD_FILENAMES if the OpenCL loader needs them.
set -uo pipefail
cd "$(dirname "$0")/.."
JOBS=${1:-2}; shift 1 2>/dev/null || true
SITES=${*:-$(ls public/data/terrain | sed 's/\.json$//')}
RUNS=${RUNS:-cfd/runs/lbm}; OUT=${OUT:-cfd/runs/_lbm}
DIRS=${DIRS:-"0 22.5 45 67.5 90 112.5 135 157.5 180 202.5 225 247.5 270 292.5 315 337.5"}
NODE=${NODE:-node}; FLUIDX3D=${FLUIDX3D:-cfd/fluidx3d/FluidX3D/bin/FluidX3D}
CASE_ARGS=${CASE_ARGS:-}
export RUNS OUT NODE FLUIDX3D CASE_ARGS

one() {
  local slug=$1 dir=$2 name log t0 rc
  name=d$(awk -v d="$dir" 'BEGIN{printf "%03d", int(d + 0.5)}')
  [ -f "$OUT/$slug/$name.bin" ] && return 0
  t0=$SECONDS; log="$RUNS/$slug-$name.log"
  { $NODE cfd/lbm-case.mjs "$slug" "$dir" --out "$RUNS" $CASE_ARGS \
    && LIFTY_CASE="$PWD/$RUNS/$slug/$name/case.bin" "$FLUIDX3D" | tr '\r' '\n' | grep -E "Info|Error|Warning" \
    && $NODE cfd/lbm-extract.mjs "$RUNS/$slug/$name" --out "$OUT"; } > "$log" 2>&1
  rc=$?
  [ -f "$OUT/$slug/$name.bin" ] || rc=1
  echo "$(date +%T) $([ $rc = 0 ] && echo DONE || echo FAIL) $slug $name $(( (SECONDS - t0) / 60 )) min"
  [ $rc = 0 ] && rm -f "$RUNS/$slug/$name/case.bin.stats"
}
export -f one

mkdir -p "$RUNS"
for s in $SITES; do for d in $DIRS; do echo "$s $d"; done; done \
  | xargs -P "$JOBS" -L 1 bash -c 'one "$0" "$1"'
