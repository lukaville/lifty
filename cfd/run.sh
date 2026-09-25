#!/usr/bin/env bash
# Run one generated case (cfd/make-case.mjs) with simpleFoam, in parallel.
#   cfd/run.sh cfd/runs/<slug>/dNNN [nprocs=4]
# Uses a native OpenFOAM if `simpleFoam` is on PATH, otherwise the official
# opencfd/openfoam-default Docker image. Log: <case>/log.simpleFoam
set -euo pipefail
CASE=$(cd "$1" && pwd)
NP=${2:-4}
IMAGE=opencfd/openfoam-default:2512
sed -i.bak "s/^numberOfSubdomains .*/numberOfSubdomains ${NP};/" "$CASE/system/decomposeParDict" && rm -f "$CASE/system/decomposeParDict.bak"

steps='
  set -e
  cd "$CASE"
  rm -rf processor* [1-9]*
  if [ "$NP" -gt 1 ]; then
    decomposePar -force > log.decomposePar 2>&1
    mpirun --allow-run-as-root --oversubscribe -np "$NP" simpleFoam -parallel > log.simpleFoam 2>&1
    reconstructPar -latestTime > log.reconstructPar 2>&1
    rm -rf processor*
  else
    simpleFoam > log.simpleFoam 2>&1
  fi
  grep -E "^(Time|SIMPLE solution converged)" log.simpleFoam | tail -1
'
if command -v simpleFoam >/dev/null 2>&1; then
  CASE="$CASE" NP="$NP" bash -c "$steps"
else
  RUNS=$(dirname "$(dirname "$CASE")")
  docker run --rm --cpus "$NP" -v "$RUNS":/runs -e CASE="/runs/${CASE#"$RUNS"/}" -e NP="$NP" \
    -e OMPI_ALLOW_RUN_AS_ROOT=1 -e OMPI_ALLOW_RUN_AS_ROOT_CONFIRM=1 \
    "$IMAGE" bash -c "source /usr/lib/openfoam/openfoam2512/etc/bashrc; $steps"
fi
