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
function finish(cv, repeat = 1) {
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.anisotropy = 4;
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

// Poured concrete: base fill + speckle + faint panel seams + corner weathering.
export function concreteTexture(base = '#9a948a') {
  const { cv, ctx, s } = canvas(128);
  ctx.fillStyle = base; ctx.fillRect(0, 0, s, s);
  speckle(ctx, s, 60);
  ctx.strokeStyle = 'rgba(0,0,0,0.18)'; ctx.lineWidth = 1;
  for (const f of [0.5]) { ctx.beginPath(); ctx.moveTo(0, s * f); ctx.lineTo(s, s * f); ctx.moveTo(s * f, 0); ctx.lineTo(s * f, s); ctx.stroke(); }
  // soft weather streaks
  ctx.strokeStyle = 'rgba(0,0,0,0.06)';
  for (let i = 0; i < 10; i++) { const x = Math.random() * s; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + (Math.random() - 0.5) * 6, s); ctx.stroke(); }
  return finish(cv, 1);
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
  return finish(cv, 1);
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
  return finish(cv, 1);
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
  return finish(cv, 1);
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
  return finish(cv, 1);
}

// Flat roof / panel: darker with horizontal seams.
export function roofTexture(base = '#6f6a61') {
  const { cv, ctx, s } = canvas(64);
  ctx.fillStyle = base; ctx.fillRect(0, 0, s, s);
  speckle(ctx, s, 30, 400);
  ctx.strokeStyle = 'rgba(0,0,0,0.22)'; ctx.lineWidth = 1;
  for (const f of [0.33, 0.66]) { ctx.beginPath(); ctx.moveTo(0, s * f); ctx.lineTo(s, s * f); ctx.stroke(); }
  return finish(cv, 1);
}
