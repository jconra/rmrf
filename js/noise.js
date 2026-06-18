// noise.js — seeded 2D simplex noise + fractal Brownian motion (fbm).
// No dependencies. Deterministic from an integer seed so map gen is repeatable.

// --- mulberry32: tiny seeded PRNG, returns floats in [0,1) ---
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GRAD2 = [
  [1, 1], [-1, 1], [1, -1], [-1, -1],
  [1, 0], [-1, 0], [1, 0], [-1, 0],
  [0, 1], [0, -1], [0, 1], [0, -1],
];

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;

// A self-contained simplex noise instance built from a seed.
export class Noise2D {
  constructor(seed = 1337) {
    const rand = mulberry32(seed);
    // Build a shuffled 0..255 permutation, then double it to avoid index wrapping.
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = p[i]; p[i] = p[j]; p[j] = t;
    }
    this.perm = new Uint8Array(512);
    this.permMod12 = new Uint8Array(512);
    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255];
      this.permMod12[i] = this.perm[i] % 12;
    }
  }

  // Single octave simplex noise, output in roughly [-1, 1].
  noise(xin, yin) {
    const perm = this.perm, permMod12 = this.permMod12;
    let n0 = 0, n1 = 0, n2 = 0;

    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const X0 = i - t, Y0 = j - t;
    const x0 = xin - X0, y0 = yin - Y0;

    let i1, j1;
    if (x0 > y0) { i1 = 1; j1 = 0; } else { i1 = 0; j1 = 1; }

    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;

    const ii = i & 255, jj = j & 255;

    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 >= 0) {
      const gi0 = permMod12[ii + perm[jj]];
      t0 *= t0;
      n0 = t0 * t0 * (GRAD2[gi0][0] * x0 + GRAD2[gi0][1] * y0);
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 >= 0) {
      const gi1 = permMod12[ii + i1 + perm[jj + j1]];
      t1 *= t1;
      n1 = t1 * t1 * (GRAD2[gi1][0] * x1 + GRAD2[gi1][1] * y1);
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 >= 0) {
      const gi2 = permMod12[ii + 1 + perm[jj + 1]];
      t2 *= t2;
      n2 = t2 * t2 * (GRAD2[gi2][0] * x2 + GRAD2[gi2][1] * y2);
    }
    return 70 * (n0 + n1 + n2);
  }

  // Fractal Brownian motion: layered octaves. Output normalized to ~[0,1].
  fbm(x, y, octaves = 5, lacunarity = 2.0, persistence = 0.5) {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.noise(x * freq, y * freq);
      norm += amp;
      amp *= persistence;
      freq *= lacunarity;
    }
    return (sum / norm) * 0.5 + 0.5;
  }
}
