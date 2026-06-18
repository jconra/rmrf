// TerrainMaterial.js — texture-splatting ground material. Detail comes from
// tiled procedural sand/grass textures sampled in world space and blended by a
// noise mask, so surface crispness is INDEPENDENT of mesh/tile resolution.
// Water + shoreline colours still come from per-vertex colour (attribute).

import * as THREE from 'three';
import { Noise2D } from './noise.js';

// --- Procedural, seamless-ish tiled textures (MirroredRepeat hides edges) ---
// srgb=true for colour maps; false for data maps (the mask) so it isn't decoded.
function canvasTex(size, paint, srgb = true) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(size, size);
  paint(img.data, size);
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.MirroredRepeatWrapping;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// Parse a hex colour to raw sRGB bytes (NO linearization — the canvas is sRGB).
function hexBytes(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function speckleTexture(size, baseHex, noise, opts) {
  const [br, bg, bb] = hexBytes(baseHex);
  const { mottle = 0.12, speckle = 0.10, freq = 6 } = opts || {};
  return canvasTex(size, (d, s) => {
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        // Low-frequency mottling from fbm + high-frequency per-pixel speckle.
        const m = (noise.fbm((x / s) * freq, (y / s) * freq, 4) - 0.5) * 2 * mottle;
        const sp = (Math.random() - 0.5) * 2 * speckle;
        const k = 1 + m + sp;
        const i = (y * s + x) * 4;
        d[i]     = Math.max(0, Math.min(255, br * k));
        d[i + 1] = Math.max(0, Math.min(255, bg * k));
        d[i + 2] = Math.max(0, Math.min(255, bb * k));
        d[i + 3] = 255;
      }
    }
  });
}

function noiseMaskTexture(size, noise) {
  return canvasTex(size, (d, s) => {
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const n = noise.fbm((x / s) * 4, (y / s) * 4, 5); // 0..1 organic blobs
        const v = Math.max(0, Math.min(255, n * 255));
        const i = (y * s + x) * 4;
        d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
      }
    }
  }, false);
}

// Build the splatting material. texWorld = world units per texture repeat.
export function makeTerrainMaterial(seed = 1337, grassAmount = 0.5, texWorld = 7) {
  const n1 = new Noise2D(seed ^ 0x1234);
  const n2 = new Noise2D(seed ^ 0x5678);
  const n3 = new Noise2D(seed ^ 0x9abc);
  // Keep mottle low so the grass stays the bright old olive (not muddy/dark).
  const sandMap  = speckleTexture(256, '#dcc88c', n1, { mottle: 0.10, speckle: 0.07, freq: 5 });
  const grassMap = speckleTexture(256, '#78973e', n2, { mottle: 0.07, speckle: 0.05, freq: 6 });
  const maskMap  = noiseMaskTexture(256, n3);

  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.95, metalness: 0.0,
  });

  mat.userData.maps = [sandMap, grassMap, maskMap];
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSand = { value: sandMap };
    shader.uniforms.uGrass = { value: grassMap };
    shader.uniforms.uMask = { value: maskMap };
    shader.uniforms.uTexScale = { value: 1 / texWorld };
    shader.uniforms.uGrassAmount = { value: grassAmount };

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>',
        '#include <common>\nattribute float aGrass;\nattribute float aLand;\nvarying float vGrass;\nvarying float vLand;\nvarying vec2 vTerrUV;')
      .replace('#include <begin_vertex>',
        '#include <begin_vertex>\nvGrass = aGrass;\nvLand = aLand;\nvTerrUV = position.xz;');

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>',
        '#include <common>\nuniform sampler2D uSand;\nuniform sampler2D uGrass;\nuniform sampler2D uMask;\nuniform float uTexScale;\nuniform float uGrassAmount;\nvarying float vGrass;\nvarying float vLand;\nvarying vec2 vTerrUV;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          vec2 uv = vTerrUV * uTexScale;
          // Sample each texture at two non-integer-related scales and average, so
          // the single-frequency tiling repeat dissolves into varied detail.
          vec3 sandC  = mix(texture2D(uSand,  uv).rgb, texture2D(uSand,  uv * 0.37 + 11.3).rgb, 0.5);
          vec3 grassC = mix(texture2D(uGrass, uv).rgb, texture2D(uGrass, uv * 0.37 + 4.7).rgb, 0.5);
          // Big-blob grass: smooth macro field (vGrass) defines the blob; a
          // LOW-frequency mask only wobbles its edge so it stays one big shape.
          float n = texture2D(uMask, vTerrUV * uTexScale * 0.12).r;
          float field = vGrass + (n - 0.5) * 0.16;
          float thr = 1.0 - uGrassAmount;
          float mask = smoothstep(thr - 0.05, thr + 0.05, field);
          // Huge-scale brightness drift (not tile-aligned) to hide the repeat.
          float macro = texture2D(uMask, vTerrUV * uTexScale * 0.035 + 2.0).r;
          vec3 landC = mix(sandC, grassC, mask) * (0.88 + macro * 0.26);
          diffuseColor.rgb = mix(diffuseColor.rgb, landC, vLand);
        }`);
  };
  return mat;
}
