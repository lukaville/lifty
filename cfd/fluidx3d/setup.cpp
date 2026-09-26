// Lifty terrain-flow setup for FluidX3D (https://github.com/ProjectPhysX/FluidX3D).
// Replaces FluidX3D's src/setup.cpp (see cfd/fluidx3d/build.sh); this file is the
// only change to FluidX3D, published as its licence requires.
//
// Large-eddy simulation (lattice Boltzmann, D3Q19, Smagorinsky subgrid model)
// of neutral wind over a site, in a frame where the wind blows along +x:
//   · terrain (raised by canopy displacement) as solid cells, relaxed to flat
//     toward the domain edges;
//   · periodic in x and y, driven by a pressure gradient (volume force) under a
//     top held at the log-law wind: the boundary layer produces its own
//     equilibrium turbulence over the long flat fetch, as in precursor ABL LES;
//   · a log-law wall model: 10 m cells can't resolve the surface layer, so the
//     first cell above the ground gets the drag of a rough surface,
//     f = −ρ (κ / ln(d/z0))² |u_h| u_h per cell (z0 from the landcover), applied
//     by the patched kernel (see build.sh);
//   · random initial disturbances and a strip of roughness blocks trip the
//     flow into turbulence quickly.
// After a spin-up, it averages the flow at the app's sample points (the 128²
// site grid × terrain-following layers): the mean velocity, its variances and
// how often the flow is reversed, i.e. the resolved gusts that steady RANS
// can't give.
//
// Input: the binary case file named by $LIFTY_CASE (written by cfd/lbm-case.mjs).
// Output: <case>.stats, float32 per point: mean ux, uy, uz, ⟨ux'²⟩, ⟨uy'²⟩,
// ⟨uz'²⟩, reversed-flow fraction; velocities in m/s for a 10 m/s wind at 10 m.
#include "setup.hpp"
#include <fstream>

struct CaseHeader {
	uint nx, ny, nz;          // lattice size
	float dx;                 // cell size, m
	float z_floor;            // height of the lattice floor (bottom of cell z=0), m
	float u_lattice;          // lattice velocity for the 10 m/s reference wind
	float z0;                 // roughness length of the inflow profile, m
	float h_inlet, h_outlet;  // ground height upwind / downwind (far field), m
	float fx;                 // driving volume force, lattice units
	uint spinup_steps, average_steps, sample_every, points;
};

static float log_profile(const float d, const float z0) { // wind / U_ref at d m above ground, 10 m reference
	return d<=0.0f ? 0.0f : logf((d+z0)/z0)/logf((10.0f+z0)/z0);
}

void main_setup() { // required extensions in defines.hpp: FP16S, EQUILIBRIUM_BOUNDARIES, SUBGRID, VOLUME_FORCE, FORCE_FIELD
	const char* case_env = getenv("LIFTY_CASE");
	if(!case_env) print_error("set LIFTY_CASE to a case file written by cfd/lbm-case.mjs");
	const string case_path = case_env;
	std::ifstream in(case_path, std::ios::binary);
	if(!in) print_error("cannot open "+case_path);
	CaseHeader h;
	in.read((char*)&h, sizeof(h));
	vector<float> surface((ulong)h.nx*h.ny);        // ground (terrain + displacement) per column, m
	vector<float> z0s((ulong)h.nx*h.ny);            // surface roughness length per column, m
	vector<uchar> rough((ulong)h.nx*h.ny);          // trip-block height per column, cells
	vector<float> pts((ulong)h.points*3u);          // sample points, lattice coordinates
	in.read((char*)surface.data(), surface.size()*sizeof(float));
	in.read((char*)z0s.data(), z0s.size()*sizeof(float));
	in.read((char*)rough.data(), rough.size());
	in.read((char*)pts.data(), pts.size()*sizeof(float));
	if(!in) print_error("truncated case file "+case_path);

	// air: nu = 1.5e-5 m²/s; lattice time step dt = dx · u_lattice / U_ref
	const float dt = h.dx*h.u_lattice/10.0f;
	const float lbm_nu = 1.5E-5f*dt/(h.dx*h.dx);
	LBM lbm(h.nx, h.ny, h.nz, lbm_nu, h.fx, 0.0f, 0.0f);
	print_info("lattice "+to_string(h.nx)+"x"+to_string(h.ny)+"x"+to_string(h.nz)+", dx "+to_string(h.dx, 1u)+" m, dt "+to_string(dt, 4u)+" s");

	const uint Nx=lbm.get_Nx(), Ny=lbm.get_Ny(), Nz=lbm.get_Nz();
	const float z_top = h.z_floor+((float)(Nz-1u)+0.5f)*h.dx;
	const float u_top = h.u_lattice*log_profile(z_top-h.h_inlet, h.z0);
	auto solid_at = [&](const uint x, const uint y, const uint z) {
		const ulong c = (ulong)y*Nx+x;
		const float zc = h.z_floor+((float)z+0.5f)*h.dx;
		return z==0u || zc<surface[c] || (float)z<(surface[c]-h.z_floor)/h.dx+(float)rough[c];
	};
	auto noise = [](ulong n, uint k) { ulong v = (n*0x9E3779B97F4A7C15ull)^(k*0xC2B2AE3D27D4EB4Full); v ^= v>>29; v *= 0xBF58476D1CE4E5B9ull; v ^= v>>32; return (float)(v&0xFFFFFF)/(float)0x1000000-0.5f; };
	parallel_for(lbm.get_N(), [&](ulong n) { uint x=0u, y=0u, z=0u; lbm.coordinates(n, x, y, z);
		if(solid_at(x, y, z)) { lbm.flags[n] = TYPE_S; return; }
		const ulong c = (ulong)y*Nx+x;
		const float zc = h.z_floor+((float)z+0.5f)*h.dx;
		const float d = zc-surface[c];                               // height above the local ground, m
		const float u = h.u_lattice*log_profile(fmaxf(d, 0.5f*h.dx), h.z0);
		// initial wind: log law over the local ground, ±10% random disturbances
		lbm.u.x[n] = u*(1.0f+0.2f*noise(n, 0u)); lbm.u.y[n] = 0.2f*u*noise(n, 1u); lbm.u.z[n] = 0.2f*u*noise(n, 2u);
		if(z==Nz-1u) { lbm.u.x[n] = u_top; lbm.u.y[n] = lbm.u.z[n] = 0.0f; lbm.flags[n] = TYPE_E; return; }
		// wall model in the first fluid cell above the ground
		if(solid_at(x, y, z-1u)) {
			const float z0 = fmaxf(z0s[c], 1E-4f), dd = fmaxf(d, 0.5f*h.dx);
			lbm.F.x[n] = sq(0.41f/logf((dd+z0)/z0));
		}
	});

	// trilinear sampling of the (host copy of the) velocity field
	auto sample = [&](const float px, const float py, const float pz, float& ux, float& uy, float& uz) {
		const float fx = fminf(fmaxf(px-0.5f, 0.0f), (float)Nx-1.001f), fy = fminf(fmaxf(py-0.5f, 0.0f), (float)Ny-1.001f), fz = fminf(fmaxf(pz-0.5f, 0.0f), (float)Nz-1.001f);
		const uint x0 = (uint)fx, y0 = (uint)fy, z0 = (uint)fz;
		const uint x1 = min(x0+1u, Nx-1u), y1 = min(y0+1u, Ny-1u), z1 = min(z0+1u, Nz-1u);
		const float tx = fx-(float)x0, ty = fy-(float)y0, tz = fz-(float)z0;
		ux = uy = uz = 0.0f; float wsum = 0.0f;
		for(uint k=0u; k<8u; k++) {
			const uint xi = k&1u ? x1 : x0, yi = k&2u ? y1 : y0, zi = k&4u ? z1 : z0;
			const ulong n = lbm.index(xi, yi, zi);
			if(lbm.flags[n]&TYPE_S) continue;                         // don't average in solid cells
			const float w = (k&1u ? tx : 1.0f-tx)*(k&2u ? ty : 1.0f-ty)*(k&4u ? tz : 1.0f-tz);
			ux += w*lbm.u.x[n]; uy += w*lbm.u.y[n]; uz += w*lbm.u.z[n]; wsum += w;
		}
		if(wsum>0.0f) { ux /= wsum; uy /= wsum; uz /= wsum; }
	};

	// only the bottom of the lattice holds sample points: copy back just those
	// layers (the velocity components are stored one after another, each N long)
	float pz_max = 0.0f;
	for(uint p=0u; p<h.points; p++) pz_max = fmaxf(pz_max, pts[3u*p+2u]);
	const ulong z_read = min((ulong)Nz, (ulong)pz_max+3ull), slab = (ulong)Nx*Ny*z_read, N = lbm.get_N();
	print_info("sampling the bottom "+to_string(z_read)+" of "+to_string(Nz)+" layers");
	// (u on the device is only current after update_fields(), which the full
	// Memory_Container read does implicitly)
	auto read_velocity = [&]() { lbm.update_fields(); for(uint c=0u; c<3u; c++) lbm.lbm_domain[0]->u.read_from_device(c*N, slab); };

	const ulong total = (ulong)h.spinup_steps+(ulong)h.average_steps;
	lbm.run(0u, total);
	lbm.run(h.spinup_steps, total);
	const uint P = h.points;
	vector<double> acc((ulong)P*7u, 0.0);
	uint samples = 0u;
	const float to_si = 10.0f/h.u_lattice;
	while(lbm.get_t()<total) {
		lbm.run(h.sample_every, total);
		read_velocity();
		parallel_for((ulong)P, [&](ulong p) {
			float ux, uy, uz;
			sample(pts[3u*p], pts[3u*p+1u], pts[3u*p+2u], ux, uy, uz);
			ux *= to_si; uy *= to_si; uz *= to_si;
			double* a = &acc[7u*p];
			a[0] += ux; a[1] += uy; a[2] += uz; a[3] += ux*ux; a[4] += uy*uy; a[5] += uz*uz; a[6] += ux<0.0f ? 1.0 : 0.0;
		});
		samples++;
	}
	vector<float> out((ulong)P*7u);
	for(ulong p=0u; p<P; p++) {
		const double* a = &acc[7u*p];
		const double mx = a[0]/samples, my = a[1]/samples, mz = a[2]/samples;
		out[7u*p+0u] = (float)mx; out[7u*p+1u] = (float)my; out[7u*p+2u] = (float)mz;
		out[7u*p+3u] = (float)fmax(0.0, a[3]/samples-mx*mx);
		out[7u*p+4u] = (float)fmax(0.0, a[4]/samples-my*my);
		out[7u*p+5u] = (float)fmax(0.0, a[5]/samples-mz*mz);
		out[7u*p+6u] = (float)(a[6]/samples);
	}
	std::ofstream o(case_path+".stats", std::ios::binary);
	o.write((const char*)out.data(), out.size()*sizeof(float));
	print_info("wrote "+case_path+".stats: "+to_string(P)+" points, "+to_string(samples)+" samples");
}
