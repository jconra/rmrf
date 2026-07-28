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

// ── SURF / WAVE TUNABLES ─────────────────────────────────────────────────────────────────────
// Every number the shoreline look is made of, in one place, live-settable. These are the values
// that used to be hardcoded in the shader below, so nothing changes until something moves them.
// lab/surf.html drives these against the REAL island, which is the point: whatever is dialled in
// there is what the game does — no porting by hand, no lab-vs-game drift.
// Dialled in in lab/surf.html against the real island, 2026-07-27. The shape of the look: a wide
// band held hard against the waterline (a big foamWidth, but slope-normalised and then clamped low
// by foamMaxUp, so it hugs the shore instead of climbing the beach), no surf at all in the
// sheltered middle of the map, long lazy crests that break out of step bay to bay, and most of the
// sea's texture coming from the noise chop rather than the swell.
export const SURF = {
  foamWidth: 0.60,      // band half-width, in world HEIGHT either side of the waterline
  foamSlope: 1.00,      // 0 = width measured in height (a flat shore spreads it); 1 = constant width on the GROUND
  foamStrength: 0.37,   // how white the foam goes
  foamInland: 1.00,     // 0 = foam is equally strong everywhere; 1 = fully faded out toward the middle
  foamInlandR: 145,     // world radius from map centre at which foam is back to full strength
  foamMaxUp: 0.10,      // world height above the waterline where foam is fully gone — keeps wash off the
                        // grass. Low, so the surf stays pinned to the water's edge (beachHeight is 1.0).
  waveLen: 24.0,        // crest spacing (phase per unit of height)
  waveSpeed: 1.60,      // how fast crests roll in
  phaseSpread: 4.75,    // how far out of step stretches of coast are (a full cycle is 2π ≈ 6.28)
  coastScale: 0.090,    // how QUICKLY that stagger varies as you walk the shoreline
  crestLo: 0.47, crestHi: 1.00,     // crest ramp: narrow = a hard bright line, wide = a soft wash
  blotchLo: 0.50, blotchHi: 0.66,   // froth patch cut
  frothScale: 1.0,      // froth feature size multiplier
  waveAmp: 0.21,        // overall strength of the surface-normal ripple (the sea's glint)
  // Surface ripple octaves, each [size, strength, speed]. 1 = SWELL (a cosine — the one long
  // directional roll). 2 and 3 = mid and fine CHOP, sampled from noise so they stay irregular
  // instead of reading as repeating lines. The swell is deliberately quiet here; the chop carries
  // the look, which is why the sea stopped reading as repeating diagonal lines.
  o1: [0.34, 0.14, 1.40],
  o2: [0.52, 0.43, 1.90],
  o3: [1.60, 0.28, 3.20],
};
const _surfShaders = new Set();   // every live terrain shader, so a change reaches all of them
function _pushSurf(sh) {
  const u = sh.uniforms;
  u.uFoamW.value = SURF.foamWidth; u.uFoamSlope.value = SURF.foamSlope; u.uFoamStr.value = SURF.foamStrength;
  u.uInland.value = SURF.foamInland; u.uInlandR.value = SURF.foamInlandR;
  u.uFoamUp.value = SURF.foamMaxUp;
  u.uWaveLen.value = SURF.waveLen; u.uWaveSpd.value = SURF.waveSpeed;
  u.uSpread.value = SURF.phaseSpread; u.uCoast.value = SURF.coastScale;
  u.uCrest.value.set(SURF.crestLo, SURF.crestHi);
  u.uBlotch.value.set(SURF.blotchLo, SURF.blotchHi);
  u.uFroth.value = SURF.frothScale; u.uWAmp.value = SURF.waveAmp;
  u.uOct1.value.set(...SURF.o1); u.uOct2.value.set(...SURF.o2); u.uOct3.value.set(...SURF.o3);
}
export function setSurf(patch) { Object.assign(SURF, patch); for (const sh of _surfShaders) _pushSurf(sh); return SURF; }

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
    // Surf/wave tunables — see SURF at the top of this file. setSurf() pushes to every live shader.
    shader.uniforms.uFoamW = { value: 0 };  shader.uniforms.uFoamSlope = { value: 0 };
    shader.uniforms.uFoamStr = { value: 0 }; shader.uniforms.uWaveLen = { value: 0 };
    shader.uniforms.uWaveSpd = { value: 0 }; shader.uniforms.uSpread = { value: 0 };
    shader.uniforms.uCoast = { value: 0 };   shader.uniforms.uFroth = { value: 1 };
    shader.uniforms.uWAmp = { value: 0 };
    shader.uniforms.uInland = { value: 0 }; shader.uniforms.uInlandR = { value: 150 };
    shader.uniforms.uFoamUp = { value: 0.9 };
    shader.uniforms.uCrest = { value: new THREE.Vector2() };
    shader.uniforms.uBlotch = { value: new THREE.Vector2() };
    shader.uniforms.uOct1 = { value: new THREE.Vector3() };
    shader.uniforms.uOct2 = { value: new THREE.Vector3() };
    shader.uniforms.uOct3 = { value: new THREE.Vector3() };
    _surfShaders.add(shader); _pushSurf(shader);
    mat.userData.shader = shader;   // so the map can drive uTime each frame (wave animation)

    // Everything keys off vHeight (the per-PIXEL interpolated height), not per-vertex
    // attributes — so the water/sand/grass bands follow a smooth contour instead of
    // faceting on the coarse terrain grid. vWaveX/vWaveZ = world X/Z axes in VIEW space
    // (so the fragment can tilt the normal along the wave slope without the normal matrix).
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>',
        '#include <common>\nattribute float aGrass;\nattribute float aShore;\nvarying float vGrass;\nvarying float vHeight;\nvarying float vShore;\nvarying vec2 vTerrUV;\nvarying vec3 vWaveX;\nvarying vec3 vWaveZ;\nvarying vec3 vWaveY;\nvarying float vSlope;')
      .replace('#include <begin_vertex>',
        '#include <begin_vertex>\nvGrass = aGrass;\nvShore = aShore;\nvHeight = position.y;\nvTerrUV = position.xz;\nvWaveX = normalMatrix * vec3(1.0, 0.0, 0.0);\nvWaveZ = normalMatrix * vec3(0.0, 0.0, 1.0);\nvWaveY = normalMatrix * vec3(0.0, 1.0, 0.0);\nfloat _ny = clamp(normalize(normal).y, 0.001, 1.0);\nvSlope = sqrt(max(0.0, 1.0 - _ny * _ny)) / _ny;');

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>',
        '#include <common>\nuniform sampler2D uSand;\nuniform sampler2D uGrass;\nuniform sampler2D uMask;\nuniform float uTexScale;\nuniform float uGrassAmount;\nuniform float uTime;\nuniform vec3 uWetDark;\nuniform vec3 uShallow;\nuniform vec3 uDeep;\nuniform float uFloor;\nuniform float uFoamW;\nuniform float uFoamSlope;\nuniform float uFoamStr;\nuniform float uWaveLen;\nuniform float uWaveSpd;\nuniform float uSpread;\nuniform float uCoast;\nuniform float uFroth;\nuniform float uWAmp;\nuniform float uInland;\nuniform float uInlandR;\nuniform float uFoamUp;\nuniform vec2 uCrest;\nuniform vec2 uBlotch;\nuniform vec3 uOct1;\nuniform vec3 uOct2;\nuniform vec3 uOct3;\nvarying float vGrass;\nvarying float vHeight;\nvarying float vShore;\nvarying vec2 vTerrUV;\nvarying vec3 vWaveX;\nvarying vec3 vWaveZ;\nvarying vec3 vWaveY;\nvarying float vSlope;')
      // color_fragment runs first: build the whole surface colour per-pixel and stash the
      // depth / water-mask / gloss terms for the roughness + normal stages below.
      .replace('#include <color_fragment>', `#include <color_fragment>
        float vDepth = max(0.0, -vHeight);
        float vWaterF = 1.0 - smoothstep(-0.06, 0.06, vHeight);    // 1 on water (smooth per-pixel waterline)
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
          // Away from shore (vShore→0) settle to a UNIFORM deep blue, so the bumpy seabed
          // no longer traces "ghost" colour patches in open water (the depth gradient would
          // otherwise reveal every underwater hump even though the surface is shaded flat).
          // Near shore keeps the full wet-sand→turquoise→deep gradient.
          waterC = mix(uDeep, waterC, vShore);
          diffuseColor.rgb = mix(landC, waterC, vWaterF);
          // SURF FOAM that washes IN toward the island. The surf LINE (band centre) climbs the
          // beach and recedes, and because its position is keyed off vHeight it follows the
          // shoreline CONTOUR — so the foam advances inward all around the island instead of
          // diagonal stripes crossing it. Coarse noise desyncs different stretches of coast so
          // it's not one uniform pulse; finer noise breaks the band into froth. Pure fragment
          // maths + the mask sampler already bound → zero new geometry or draw calls.
          float wcoarse = texture2D(uMask, vTerrUV * uCoast + 2.3).r;                // slow, LARGE along-coast desync
          // WAVE CRESTS that roll IN from deep water to the beach. The crest phase = vHeight*K −
          // uTime*S: equal-depth lines are parallel to shore, and the phase advances toward higher
          // ground over time, so each crest is a shore-parallel band MARCHING from deep → shallow →
          // up the beach. Foam tops the crests only, inside the surf zone around the waterline.
          // BAND WIDTH. Measured in HEIGHT, the band's width ON THE GROUND is inversely
          // proportional to beach slope — so a flat shelf whites out while a steep face gets a
          // thin line. Dividing by the terrain GRADIENT converts it to a roughly constant ground
          // width; uFoamSlope blends between the two (0 = the original).
          // vSlope is |∇height|, derived in the vertex shader from the geometry normal. That is
          // deliberate: the obvious way to get it here is fwidth(), but derivatives are an
          // EXTENSION under GLSL ES 1.00 and three only emits the pragma on WebGL1 — so an
          // fwidth() here compiles under SwiftShader and fails on a real WebGL2 GPU. The normal
          // carries the same information and needs no extension anywhere.
          float wband = mix(abs(vHeight) / uFoamW,
                            abs(vHeight) / max(vSlope * uFoamW * 12.0, 1e-4), uFoamSlope);
          float surfZone = 1.0 - smoothstep(0.0, 1.0, wband);                       // wave-action band
          // HARD CEILING UP THE BEACH. Slope-normalising trades height for ground distance, so on
          // a steep face a fixed ground width reaches a long way UP — far enough to wash over the
          // sand and onto the grass, which reads as wrong however good the band looks. Cap it by
          // absolute height above the waterline; the map's beachHeight is 1.0, so a cap just under
          // that keeps surf on sand. Only bites upward — underwater is untouched.
          surfZone *= 1.0 - smoothstep(uFoamUp * 0.55, uFoamUp, max(0.0, vHeight));
          float wavePhase = vHeight * uWaveLen - uTime * uWaveSpd + wcoarse * uSpread;   // crests travel deep→shallow (+ per-coast desync)
          float crest = smoothstep(uCrest.x, uCrest.y, 0.5 + 0.5 * sin(wavePhase)); // bright only on the crest tops
          // BLOTCHY froth: three octaves at LARGER, incommensurate scales (bigger features, and a
          // repeat period so long it never reads as tiling) summed into FBM, then thresholded into
          // sharp irregular patches. Smooth UVs (drift is a time offset only) → no mip wash-out.
          float n1 = texture2D(uMask, vTerrUV * 0.34 * uFroth + vec2(uTime * 0.005, uTime * 0.016)).r;
          float n2 = texture2D(uMask, vTerrUV * 0.135 * uFroth + vec2(uTime * 0.008, -uTime * 0.006) + 3.7).r;
          float n3 = texture2D(uMask, vTerrUV * 0.052 * uFroth + vec2(-uTime * 0.003, uTime * 0.002) + 8.1).r;
          float fbm = n1 * 0.42 + n2 * 0.37 + n3 * 0.34;                 // ~0.56 mean, big organic blobs
          float blotch = smoothstep(uBlotch.x, uBlotch.y, fbm);          // sharp-ish cut → blotchy patches, not a smooth wash
          // INLAND FADE. Surf is driven by open water with a long fetch, so the outer coast should
          // break hardest and sheltered inland water — lagoons, inland seas near the middle of the
          // map — should barely foam at all. Scale by distance from the map centre: 0 at the
          // middle, full by uInlandR. uInland is how much of that falloff to apply (0 = none).
          float inland = mix(1.0, smoothstep(0.0, max(uInlandR, 1.0), length(vTerrUV)), uInland);
          float foam = surfZone * vShore * crest * blotch * uFoamStr * inland;
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.96, 0.98, 0.99), foam);
        }`)
      // ALL water is glossy (near-mirror 0.12) so the whole sea reflects the sky env +
      // the overhead sun as a glint — matched by the open-ocean floor plane (set to the
      // same gloss in IslandMap._buildWater). Land (vWaterF=0) keeps its own roughness.
      .replace('#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\n  roughnessFactor = mix(roughnessFactor, 0.12, vWaterF);')
      .replace('#include <metalnessmap_fragment>',
        '#include <metalnessmap_fragment>\n  metalnessFactor = mix(metalnessFactor, 0.15, vWaterF);')
      // Water normal: IGNORE the bumpy sea-floor geometry normal — it shaded the
      // underwater noise humps as visible "bulges". For water pixels use a FLAT upward
      // surface (vWaveY = world up) and let only the animated wave ripple tilt it, so the
      // whole sea reads as one smooth glossy animated sheet regardless of the floor under
      // it. The ripple amplitude scales by vShore (1 at the shoreline → 0 far out to sea)
      // so the waves hug the islands and calm to flat by the time they reach the open-ocean
      // plane — no rippled square at the mesh edge. Land (vWaterF=0) is untouched.
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
        {
          // SWELL is a cosine — the ocean's one long directional roll, and it should read as
          // directional. The CHOP is not. Summed cosines are periodic and axis-aligned, which is
          // exactly what made the sea look linear and repetitive: real chop is isotropic, dense,
          // and never repeats. So octaves 2 and 3 are sampled from the noise mask and DIFFERENCED
          // to get a surface slope, rather than evaluated as waves. Each stays [size, strength,
          // speed] so the same three sliders still mean the same things.
          float wt = uTime; vec2 wp = vTerrUV;
          float gx = uOct1.y * cos(wp.x * uOct1.x + wt * uOct1.z);
          float gz = uOct1.y * cos(wp.y * uOct1.x * 0.9 - wt * uOct1.z * 0.86);
          float chopMask = vWaterF * vShore;
          float ruffle = 1.0;   // NOT "patch" — that is a RESERVED word in GLSL ES 3.00 (tessellation) and fails to compile on a real GPU, while SwiftShader compiles ES 1.00 and accepts it
          if (chopMask > 0.002) {                 // land pays nothing for the sea's detail
            const vec2 dd = vec2(0.0037, 0.0);
            // Two noise octaves drifting on different headings, so they never beat into a pattern.
            vec2 uv2 = wp * uOct2.x * 0.06 + vec2(wt * uOct2.z * 0.010, wt * uOct2.z * -0.006);
            float m2 = texture2D(uMask, uv2).r;
            gx += (texture2D(uMask, uv2 + dd.xy).r - m2) * uOct2.y * 26.0;
            gz += (texture2D(uMask, uv2 + dd.yx).r - m2) * uOct2.y * 26.0;
            // FINE CHOP is the most expensive third of this block (3 of its 7 texture taps) and
            // the least visible, so make switching it off actually free: at strength 0 the taps
            // were still being fetched and merely multiplied by zero, which cost the same as
            // leaving it on. Now the slider genuinely buys back the work.
            if (uOct3.y > 0.001) {
              vec2 uv3 = wp * uOct3.x * 0.06 + vec2(wt * uOct3.z * -0.004, wt * uOct3.z * 0.013) + 5.1;
              float m3 = texture2D(uMask, uv3).r;
              gx += (texture2D(uMask, uv3 + dd.xy).r - m3) * uOct3.y * 26.0;
              gz += (texture2D(uMask, uv3 + dd.yx).r - m3) * uOct3.y * 26.0;
            }
            // WIND PATCHES: a very large, very slow field that leaves some stretches glassy and
            // ruffles others. It's what stops an evenly-textured sheet reading as a material.
            ruffle = 0.45 + 1.15 * texture2D(uMask, wp * 0.004 + vec2(wt * 0.002, wt * 0.0015)).r;
          }
          vec3 flatN = normalize(vWaveY);
          normal = normalize(mix(normal, flatN, vWaterF) - (vWaveX * gx + vWaveZ * gz) * (uWAmp * chopMask * ruffle));
        }`);
  };
  return mat;
}
