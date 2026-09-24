// Minimal in-place iterative radix-2 Cooley–Tukey FFT (power-of-two lengths).
// Operates on separate real/imag Float64Arrays.

export function fft(re, im, inverse = false) {
  const n = re.length;
  // bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const xr = re[b] * cr - im[b] * ci;
        const xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }
}

// 2-D FFT on a row-major n×n complex field (in place).
export function fft2d(re, im, n, inverse = false) {
  const tr = new Float64Array(n), ti = new Float64Array(n);
  for (let r = 0; r < n; r++) {
    const off = r * n;
    for (let c = 0; c < n; c++) { tr[c] = re[off + c]; ti[c] = im[off + c]; }
    fft(tr, ti, inverse);
    for (let c = 0; c < n; c++) { re[off + c] = tr[c]; im[off + c] = ti[c]; }
  }
  for (let c = 0; c < n; c++) {
    for (let r = 0; r < n; r++) { const k = r * n + c; tr[r] = re[k]; ti[r] = im[k]; }
    fft(tr, ti, inverse);
    for (let r = 0; r < n; r++) { const k = r * n + c; re[k] = tr[r]; im[k] = ti[r]; }
  }
}
