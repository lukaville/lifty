#!/usr/bin/env bash
# Fetch FluidX3D (pinned), drop in Lifty's setup.cpp, enable the extensions it
# needs and build a headless binary.
#   cfd/fluidx3d/build.sh [dir=cfd/fluidx3d/FluidX3D]
# FluidX3D is free for non-commercial use under its own licence
# (https://github.com/ProjectPhysX/FluidX3D/blob/master/LICENSE.md); it is not
# part of this repository. Needs git, g++, make and an OpenCL driver.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
DIR=${1:-$HERE/FluidX3D}
COMMIT=9f3a995
[ -d "$DIR/.git" ] || git clone -q https://github.com/ProjectPhysX/FluidX3D.git "$DIR"
cd "$DIR"
git fetch -q --depth 50 origin master 2>/dev/null || true
git checkout -q "$COMMIT" 2>/dev/null || git checkout -q -f "$COMMIT"
git checkout -q -- src/setup.cpp src/defines.hpp src/kernel.cpp
cp "$HERE/setup.cpp" src/setup.cpp
# Kernel changes (the only changes to FluidX3D besides setup.cpp), for a
# wall-modelled LES of the atmospheric surface layer:
#  1. free-slip ground: where the cell below is solid, the diagonal DDFs coming
#     up from the ground are swapped in pairs, (+x,+z)↔(−x,+z) and
#     (+y,+z)↔(−y,+z), turning the implicit bounce-back into a specular
#     reflection; vertical faces keep no-slip bounce-back;
#  2. wall model: the force field's x component holds a per-cell drag
#     coefficient c ≥ 0 instead of a force, and the kernel applies
#     f = −ρ c |u_h| u_h (the log-law surface stress, see setup.cpp).
# Without 1 the no-slip wall plus the subgrid viscosity gives ~15× the log-law
# surface stress at 10 m cells and the near-ground wind stalls.
python3 - <<'PY'
import re
p = "src/kernel.cpp"; s = open(p).read()
old = '''		fxn += F[                 n]; // apply force field
		fyn += F[    def_N+(ulong)n];
		fzn += F[2ul*def_N+(ulong)n];'''
new = '''		const float cdn = F[n]; // Lifty wall model: F.x = drag coefficient, f = -rho*c*|u_h|*u_h
		if(cdn>0.0f) { const float uhn = sqrt(sq(uxn)+sq(uyn)); fxn -= rhon*cdn*uhn*uxn; fyn -= rhon*cdn*uhn*uyn; }'''
n = s.count(old)
assert n >= 1, "kernel.cpp: force-field block not found"
s = s.replace(old, new)   # stream_collide and update_fields
load = "\tload_f(n, fhn, fi, j, t); // perform streaming (part 2)\n"
slip = load + """\t{ // Lifty free-slip ground (D3Q19): specular instead of bounce-back where the cell below is solid
\t\tif((flags[j[6]]&TYPE_BO)==TYPE_S) {
\t\t\tif((flags[j[10]]&TYPE_BO)==TYPE_S&&(flags[j[15]]&TYPE_BO)==TYPE_S) { const float f9 = fhn[9]; fhn[9] = fhn[16]; fhn[16] = f9; }
\t\t\tif((flags[j[12]]&TYPE_BO)==TYPE_S&&(flags[j[17]]&TYPE_BO)==TYPE_S) { const float f11 = fhn[11]; fhn[11] = fhn[18]; fhn[18] = f11; }
\t\t}
\t}
"""
parts = s.split(load)
assert len(parts) >= 3, "kernel.cpp: streaming loads not found"
s = slip.join(parts[:3]) + (load + load.join(parts[3:]) if len(parts) > 3 else "")   # stream_collide and update_fields only
open(p, "w").write(s)
print(f"patched kernel.cpp: wall model in {n} places, free-slip ground in 2")
PY
d=src/defines.hpp
sed -i.bak -E \
  -e 's|^#define BENCHMARK|//#define BENCHMARK|' \
  -e 's|^//#define FP16S|#define FP16S|' \
  -e 's|^//#define EQUILIBRIUM_BOUNDARIES|#define EQUILIBRIUM_BOUNDARIES|' \
  -e 's|^//#define SUBGRID|#define SUBGRID|' \
  -e 's|^//#define VOLUME_FORCE|#define VOLUME_FORCE|' \
  -e 's|^//#define FORCE_FIELD|#define FORCE_FIELD|' \
  -e 's|^#define INTERACTIVE_GRAPHICS |//#define INTERACTIVE_GRAPHICS |' \
  -e 's|^#define GRAPHICS |//#define GRAPHICS |' "$d" && rm -f "$d.bak"
grep -E '^#define (FP16S|EQUILIBRIUM_BOUNDARIES|SUBGRID|BENCHMARK|GRAPHICS|INTERACTIVE)' "$d"
make -s Linux -j"$(nproc)"
echo "built $DIR/bin/FluidX3D"
