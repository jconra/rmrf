// Textures.js — shared procedural CanvasTextures for ANY asset (buildings,
// props, future plant bark/leaf, etc.): concrete / corrugated metal / canvas /
// crates / roof / accent plate. One home so no asset type duplicates texture
// code. (Formerly BuildingTextures.js — generalised, since these are material
// textures, not building-specific.)
// Colours are drawn as CSS strings (already sRGB) and the texture is tagged
// SRGBColorSpace, so there's no double-linearise darkening (the bug that bit the
// terrain grass — see TerrainMaterial.js).

import * as THREE from 'three';

function canvas(s = 128) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  return { cv, ctx: cv.getContext('2d'), s };
}
function finish(cv, repeat = 1, kind = '') {
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.anisotropy = 4;
  // Self-identify the procedural KIND so a tool (the asset designer) can record a short
  // id instead of baking the fat PNG data-URL into an export. Harmless metadata for the
  // game (it never reads it).
  if (kind) tex.userData.kind = kind;
  return tex;
}
// Fine value-noise speckle to break up a flat fill.
function speckle(ctx, s, amt, n = 2200) {
  for (let i = 0; i < n; i++) {
    const v = (Math.random() * 2 - 1) * amt | 0;
    ctx.fillStyle = `rgba(${v < 0 ? 0 : 255},${v < 0 ? 0 : 255},${v < 0 ? 0 : 255},${Math.abs(v) / 255})`;
    ctx.fillRect(Math.random() * s, Math.random() * s, 1, 1);
  }
}

// Poured concrete: base fill + speckle + soft weathering MOTTLE. No straight panel
// seams — those skew badly once a face is distorted into a trapezoid (a designer note);
// soft blobs read as weathered concrete from any shape and tile seamlessly.
export function concreteTexture(base = '#9a948a') {
  const { cv, ctx, s } = canvas(128);
  ctx.fillStyle = base; ctx.fillRect(0, 0, s, s);
  speckle(ctx, s, 60);
  for (let i = 0; i < 22; i++) {
    const x = Math.random() * s, y = Math.random() * s, r = 6 + Math.random() * 22;
    const dark = Math.random() < 0.6;
    wrapBlob(ctx, s, x, y, r, dark ? '74,70,63' : '184,179,170', 0.04 + Math.random() * 0.08);
  }
  return finish(cv, 1, "concrete");
}

// Corrugated metal: vertical light/dark ribs (for the quonset shell).
export function ribbedMetalTexture(base = '#b9bdc0') {
  const { cv, ctx, s } = canvas(128);
  ctx.fillStyle = base; ctx.fillRect(0, 0, s, s);
  const ribs = 16, w = s / ribs;
  for (let i = 0; i < ribs; i++) {
    const g = ctx.createLinearGradient(i * w, 0, (i + 1) * w, 0);
    g.addColorStop(0, 'rgba(0,0,0,0.22)');
    g.addColorStop(0.5, 'rgba(255,255,255,0.16)');
    g.addColorStop(1, 'rgba(0,0,0,0.22)');
    ctx.fillStyle = g; ctx.fillRect(i * w, 0, w, s);
  }
  speckle(ctx, s, 26, 800);
  return finish(cv, 1, "metal");
}

// Canvas tent fabric: woven weave + vertical seam lines.
export function fabricTexture(base = '#5f7a37') {
  const { cv, ctx, s } = canvas(128);
  ctx.fillStyle = base; ctx.fillRect(0, 0, s, s);
  ctx.strokeStyle = 'rgba(0,0,0,0.05)'; ctx.lineWidth = 1;
  for (let i = 0; i < s; i += 3) { ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(s, i); ctx.stroke(); }
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  for (let i = 0; i < s; i += 3) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, s); ctx.stroke(); }
  ctx.strokeStyle = 'rgba(0,0,0,0.16)'; ctx.lineWidth = 2;   // ridge seams
  for (const f of [0.25, 0.5, 0.75]) { ctx.beginPath(); ctx.moveTo(s * f, 0); ctx.lineTo(s * f, s); ctx.stroke(); }
  return finish(cv, 1, "fabric");
}

// Wooden crate: plank lines + grain (for the depot).
export function crateTexture(base = '#6f6a61') {
  const { cv, ctx, s } = canvas(64);
  ctx.fillStyle = base; ctx.fillRect(0, 0, s, s);
  speckle(ctx, s, 40, 500);
  ctx.strokeStyle = 'rgba(0,0,0,0.3)'; ctx.lineWidth = 2;
  ctx.strokeRect(2, 2, s - 4, s - 4);                                  // frame
  ctx.beginPath(); ctx.moveTo(0, s / 2); ctx.lineTo(s, s / 2); ctx.stroke();   // mid plank
  ctx.beginPath(); ctx.moveTo(2, 2); ctx.lineTo(s - 2, s - 2); ctx.stroke();   // diagonal brace
  return finish(cv, 1, "crate");
}

// Painted-armour plate, NEUTRAL (near-white) so a coloured material tints it through a
// multiply (map × color). Used for the team-colour caps / gate lintels / turret stripes
// so they read as bolted painted plate instead of a flat cartoony block — the material
// keeps the team accent as its colour (setAccent still recolours), this only adds the
// darker bolts/seams/grime the colour multiplies down.
export function accentPlateTexture() {
  const { cv, ctx, s } = canvas(128);
  ctx.fillStyle = '#f4f4f4'; ctx.fillRect(0, 0, s, s);
  speckle(ctx, s, 30, 1400);
  ctx.strokeStyle = 'rgba(0,0,0,0.26)'; ctx.lineWidth = 2;        // inset panel border
  ctx.strokeRect(s * 0.07, s * 0.07, s * 0.86, s * 0.86);
  ctx.strokeStyle = 'rgba(0,0,0,0.14)'; ctx.lineWidth = 1;        // centre division seam
  ctx.beginPath(); ctx.moveTo(0, s / 2); ctx.lineTo(s, s / 2); ctx.stroke();
  const bolts = [[0.15, 0.15], [0.85, 0.15], [0.15, 0.85], [0.85, 0.85]];
  ctx.fillStyle = 'rgba(0,0,0,0.34)';                            // corner bolts
  for (const [bx, by] of bolts) { ctx.beginPath(); ctx.arc(s * bx, s * by, 2.3, 0, Math.PI * 2); ctx.fill(); }
  ctx.fillStyle = 'rgba(255,255,255,0.55)';                      // bolt highlight
  for (const [bx, by] of bolts) { ctx.beginPath(); ctx.arc(s * bx - 0.7, s * by - 0.7, 0.9, 0, Math.PI * 2); ctx.fill(); }
  ctx.strokeStyle = 'rgba(0,0,0,0.05)';                          // faint grime streaks
  for (let i = 0; i < 8; i++) { const x = Math.random() * s; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + (Math.random() - 0.5) * 5, s); ctx.stroke(); }
  return finish(cv, 1, "accent");
}

// Diagonal yellow/black caution stripes. Tileable (the 45° bands repeat seamlessly
// across the square), so it works for the elevator shaft collar AND flat "interact
// here" floor markings flanking the supply points. Set .repeat on a clone to scale
// the stripe size to a strip's length.
export function hazardTexture(yellow = '#e8c84a', dark = '#16181c') {
  const { cv, ctx, s } = canvas(64);
  ctx.fillStyle = yellow; ctx.fillRect(0, 0, s, s);
  ctx.fillStyle = dark;
  const band = s / 4;   // stripe width; period = 2·band divides s, so the diagonal tiles
  for (let x = -s; x < s * 2; x += band * 2) {
    ctx.beginPath();
    ctx.moveTo(x, 0); ctx.lineTo(x + band, 0);
    ctx.lineTo(x + band + s, s); ctx.lineTo(x + s, s);
    ctx.closePath(); ctx.fill();
  }
  return finish(cv, 1, "hazard");
}

// Flat roof / panel: darker with horizontal seams.
export function roofTexture(base = '#6f6a61') {
  const { cv, ctx, s } = canvas(64);
  ctx.fillStyle = base; ctx.fillRect(0, 0, s, s);
  speckle(ctx, s, 30, 400);
  ctx.strokeStyle = 'rgba(0,0,0,0.22)'; ctx.lineWidth = 1;
  for (const f of [0.33, 0.66]) { ctx.beginPath(); ctx.moveTo(0, s * f); ctx.lineTo(s, s * f); ctx.stroke(); }
  return finish(cv, 1, "roof");
}

// ── Grungy / "dirty" textures (also handy as BUMP or SPEC maps) ──────────────
const _clamp255 = v => v < 0 ? 0 : v > 255 ? 255 : v;
// A soft radial blob fading to transparent — drawn as a square fill of the gradient.
function softBlob(ctx, x, y, r, rgb, alpha) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, `rgba(${rgb},${alpha})`);
  g.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = g; ctx.fillRect(x - r, y - r, r * 2, r * 2);
}
// Same blob drawn at every edge-wrapped offset so it tiles seamlessly.
function wrapBlob(ctx, s, x, y, r, rgb, alpha) {
  for (const dx of [-s, 0, s]) for (const dy of [-s, 0, s]) softBlob(ctx, x + dx, y + dy, r, rgb, alpha);
}

// Fine value-noise grain — gritty static. Per-pixel, so it tiles perfectly. Great as a
// BUMP map for a rough, dirty surface.
export function noiseTexture(base = '#8a8782') {
  const { cv, ctx, s } = canvas(128);
  ctx.fillStyle = base; ctx.fillRect(0, 0, s, s);
  const img = ctx.getImageData(0, 0, s, s), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 78;
    d[i] = _clamp255(d[i] + n); d[i + 1] = _clamp255(d[i + 1] + n); d[i + 2] = _clamp255(d[i + 2] + n);
  }
  ctx.putImageData(img, 0, 0);
  return finish(cv, 1, "noise");
}

// Dirt / grime: a muddy base with soft dark smudges + a few pale dusty patches.
export function grimeTexture(base = '#6b675e') {
  const { cv, ctx, s } = canvas(128);
  ctx.fillStyle = base; ctx.fillRect(0, 0, s, s);
  speckle(ctx, s, 50, 1900);
  for (let i = 0; i < 30; i++) {
    const x = Math.random() * s, y = Math.random() * s, r = 5 + Math.random() * 18;
    const dark = Math.random() < 0.72;
    wrapBlob(ctx, s, x, y, r, dark ? '24,20,13' : '210,205,190', 0.05 + Math.random() * 0.13);
  }
  return finish(cv, 1, "grime");
}

// Rust: corroded brown with mottled patches of lighter/darker oxide.
export function rustTexture(base = '#7a4a30') {
  const { cv, ctx, s } = canvas(128);
  ctx.fillStyle = base; ctx.fillRect(0, 0, s, s);
  speckle(ctx, s, 46, 1700);
  const cols = ['92,52,28', '56,33,20', '120,74,40', '38,28,22', '150,96,52'];
  for (let i = 0; i < 38; i++) {
    const x = Math.random() * s, y = Math.random() * s, r = 3 + Math.random() * 15;
    wrapBlob(ctx, s, x, y, r, cols[(Math.random() * cols.length) | 0], 0.1 + Math.random() * 0.18);
  }
  return finish(cv, 1, "rust");
}

// Scuffed metal: light/dark hairline scratches at random angles. Scratches are drawn at
// the wrapped offsets too, so any that cross an edge continue on the far side (tiles).
export function scratchedTexture(base = '#8d9094') {
  const { cv, ctx, s } = canvas(128);
  ctx.fillStyle = base; ctx.fillRect(0, 0, s, s);
  speckle(ctx, s, 30, 1100);
  ctx.lineWidth = 1;
  for (let i = 0; i < 64; i++) {
    const x = Math.random() * s, y = Math.random() * s, a = Math.random() * Math.PI, len = 4 + Math.random() * 24;
    const ex = Math.cos(a) * len, ey = Math.sin(a) * len;
    ctx.strokeStyle = `rgba(${Math.random() < 0.5 ? '255,255,255' : '0,0,0'},${0.04 + Math.random() * 0.11})`;
    for (const dx of [-s, 0, s]) for (const dy of [-s, 0, s]) {
      ctx.beginPath(); ctx.moveTo(x + dx, y + dy); ctx.lineTo(x + dx + ex, y + dy + ey); ctx.stroke();
    }
  }
  return finish(cv, 1, "scratched");
}
