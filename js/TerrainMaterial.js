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
export function makeTerrainMaterial(seed = 1337, grassAmount = 0.5, texWorld = 7, colors = {}) {
  const n1 = new Noise2D(seed ^ 0x1234);
  const n2 = new Noise2D(seed ^ 0x5678);
  const n3 = new Noise2D(seed ^ 0x9abc);
  // Keep mottle low so the grass stays the bright old olive (not muddy/dark).
  const sandMap  = speckleTexture(256, '#dcc88c', n1, { mottle: 0.10, speckle: 0.07, freq: 5 });
  const grassMap = speckleTexture(256, '#78973e', n2, { mottle: 0.07, speckle: 0.05, freq: 6 });
  const maskMap  = noiseMaskTexture(256, n3);

  const wetdark = colors.wetdark || new THREE.Color('#8a784a');
  const shallow = colors.shallow || new THREE.Color('#3bb2ba');
  const deep    = colors.deep    || new THREE.Color('#0e4f78');
  const floor   = colors.floor != null ? colors.floor : 2.4;   // |sea-floor depth| → where water reads fully deep

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
    shader.uniforms.uTime = { value: 0 };
    shader.uniforms.uWetDark = { value: wetdark };
    shader.uniforms.uShallow = { value: shallow };
    shader.uniforms.uDeep = { value: deep };
    shader.uniforms.uFloor = { value: floor };
    mat.userData.shader = shader;   // so the map can drive uTime each frame (wave animation)

    // Everything keys off vHeight (the per-PIXEL interpolated height), not per-vertex
    // attributes — so the water/sand/grass bands follow a smooth contour instead of
    // faceting on the coarse terrain grid. vWaveX/vWaveZ = world X/Z axes in VIEW space
    // (so the fragment can tilt the normal along the wave slope without the normal matrix).
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>',
        '#include <common>\nattribute float aGrass;\nvarying float vGrass;\nvarying float vHeight;\nvarying vec2 vTerrUV;\nvarying vec3 vWaveX;\nvarying vec3 vWaveZ;')
      .replace('#include <begin_vertex>',
        '#include <begin_vertex>\nvGrass = aGrass;\nvHeight = position.y;\nvTerrUV = position.xz;\nvWaveX = normalMatrix * vec3(1.0, 0.0, 0.0);\nvWaveZ = normalMatrix * vec3(0.0, 0.0, 1.0);');

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>',
        '#include <common>\nuniform sampler2D uSand;\nuniform sampler2D uGrass;\nuniform sampler2D uMask;\nuniform float uTexScale;\nuniform float uGrassAmount;\nuniform float uTime;\nuniform vec3 uWetDark;\nuniform vec3 uShallow;\nuniform vec3 uDeep;\nuniform float uFloor;\nvarying float vGrass;\nvarying float vHeight;\nvarying vec2 vTerrUV;\nvarying vec3 vWaveX;\nvarying vec3 vWaveZ;')
      // color_fragment runs first: build the whole surface colour per-pixel and stash the
      // depth / water-mask / gloss terms for the roughness + normal stages below.
      .replace('#include <color_fragment>', `#include <color_fragment>
        float vDepth = max(0.0, -vHeight);
        float vWaterF = 1.0 - smoothstep(-0.06, 0.06, vHeight);    // 1 on water (smooth per-pixel waterline)
        float vGloss = 1.0 - smoothstep(0.5, 1.7, vDepth);          // shallow glossy → deep matte (matches the flat ocean plane, no seam)
        {
          vec2 uv = vTerrUV * uTexScale;
          vec3 sandC  = mix(texture2D(uSand,  uv).rgb, texture2D(uSand,  uv * 0.37 + 11.3).rgb, 0.5);
          vec3 grassC = mix(texture2D(uGrass, uv).rgb, texture2D(uGrass, uv * 0.37 + 4.7).rgb, 0.5);
          float nmask = texture2D(uMask, vTerrUV * uTexScale * 0.12).r;
          float hgate = smoothstep(0.05, 0.7, vHeight);             // sand low on the beach, grass higher (per-pixel → no blocky edge)
          float field = vGrass * hgate + (nmask - 0.5) * 0.16;
          float thr = 1.0 - uGrassAmount;
          float gmask = smoothstep(thr - 0.05, thr + 0.05, field);
          float macro = texture2D(uMask, vTerrUV * uTexScale * 0.035 + 2.0).r;
          vec3 landC = mix(sandC, grassC, gmask) * (0.88 + macro * 0.26);
          float wet = 1.0 - smoothstep(0.0, 1.2, vHeight);          // dark wet sand at the waterline
          landC = mix(landC, landC * vec3(0.34, 0.32, 0.29), wet);  // darker than before — the sky env map was lifting the wet band
          // Per-pixel water depth gradient: dark wet sand → turquoise → deep blue.
          // LINEAR segments (not smoothstep) so the colour never plateaus at 'shallow'
          // — a smoothstep shelf flattens to zero slope at the join, leaving a uniform
          // turquoise band that then drops to deep, which reads as a hard seam line.
          // Shallow turquoise is only a thin rim hugging the shore; the colour reaches
          // full deep blue by ~0.7 units of depth. The inner sea is mostly shallow
          // GEOMETRY, but colouring it deep makes the whole open sea match the deep
          // map-border apron + ocean plane — killing the big square seam that showed
          // when only the apron was deep-coloured. (uFloor unused now.)
          vec3 waterC = vDepth < 0.15
            ? mix(uWetDark, uShallow, vDepth / 0.15)
            : mix(uShallow, uDeep, smoothstep(0.15, 0.7, vDepth));
          diffuseColor.rgb = mix(landC, waterC, vWaterF);
        }`)
      // Water is glossy so it reflects the sky env + the overhead sun as a glint:
      // shallow is near-mirror (0.10), deep settles to 0.58 — still smooth enough to
      // catch the sun, but matte enough to read as open sea (and to match the flat
      // ocean plane, which is set to the same 0.58 → no seam).
      .replace('#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\n  roughnessFactor = mix(roughnessFactor, mix(0.58, 0.10, vGloss), vWaterF);')
      .replace('#include <metalnessmap_fragment>',
        '#include <metalnessmap_fragment>\n  metalnessFactor = mix(metalnessFactor, 0.15 * vGloss, vWaterF);')
      // Animated ripples on SHALLOW water only (vGloss→0 in the deep keeps it calm + matte
      // so it matches the static plane); land (vWaterF=0) is untouched.
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
        {
          float wt = uTime; vec2 wp = vTerrUV;
          float gx = 0.30 * cos(wp.x * 0.20 + wt * 1.4) + 0.16 * cos((wp.x * 0.52 + wp.y * 0.40) + wt * 1.9);
          float gz = 0.30 * cos(wp.y * 0.18 - wt * 1.2) + 0.16 * cos((wp.x * 0.40 - wp.y * 0.52) - wt * 1.7);
          normal = normalize(normal - (vWaveX * gx + vWaveZ * gz) * (0.18 * vWaterF * vGloss));
        }`);
  };
  return mat;
}
