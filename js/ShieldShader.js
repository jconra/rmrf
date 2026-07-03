// ShieldShader.js — a force-field bubble material: hex grid, fresnel edge glow, flowing noise,
// expanding rings where it gets HIT, and a blue->red colour shift as the shield drains. Adapted
// to vanilla Three.js from cortiz2894/flow-shield-effect (GLSL only; the React/Next scaffolding
// dropped). The reveal/dissolve was cut (shields just pop on) and MAX_HITS trimmed to 4 to keep
// the per-pixel cost down. Built on a UNIT sphere (radius 1) scaled to the vehicle, so the shader
// constants read the same at any size. Only a handful of these run at once (see the cap in main.js).

import * as THREE from 'three';

export const MAX_HITS = 4;

const vertexShader = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vViewDir;
  varying vec3 vObjPos;
  void main() {
    vObjPos  = position;
    vNormal  = normalize(normalMatrix * normal);
    vec4 vp  = modelViewMatrix * vec4(position, 1.0);
    vViewDir = normalize(-vp.xyz);
    gl_Position = projectionMatrix * vp;
  }
`;

const fragmentShader = /* glsl */ `
  #define MAX_HITS ${MAX_HITS}
  uniform float uTime;
  uniform vec3  uColor;
  uniform float uLife;          // 1 = full shield, 0 = empty (drives colour toward red)
  uniform float uOpacity;
  uniform float uHexScale, uEdgeWidth, uHexOpacity;
  uniform float uFresnelPower, uFresnelStrength;
  uniform float uFlashSpeed, uFlashIntensity;
  uniform float uFlowScale, uFlowSpeed, uFlowIntensity;
  uniform vec3  uHitPos[MAX_HITS];
  uniform float uHitTime[MAX_HITS];
  uniform float uHitRingSpeed, uHitRingWidth, uHitMaxRadius, uHitDuration, uHitIntensity, uHitImpactRadius;
  varying vec3 vNormal;
  varying vec3 vViewDir;
  varying vec3 vObjPos;

  vec3 mod289v3(vec3 x){ return x - floor(x*(1./289.))*289.; }
  vec4 mod289v4(vec4 x){ return x - floor(x*(1./289.))*289.; }
  vec4 permute(vec4 x){ return mod289v4(((x*34.)+1.)*x); }
  vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314*r; }
  float snoise(vec3 v){
    const vec2 C = vec2(1./6., 1./3.);
    const vec4 D = vec4(0., 0.5, 1., 2.);
    vec3 i  = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);
    vec3 g  = step(x0.yzx, x0.xyz);
    vec3 l  = 1. - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);
    vec3 x1 = x0 - i1 + C.xxx;
    vec3 x2 = x0 - i2 + C.yyy;
    vec3 x3 = x0 - D.yyy;
    i = mod289v3(i);
    vec4 p = permute(permute(permute(
      i.z+vec4(0.,i1.z,i2.z,1.))
     +i.y+vec4(0.,i1.y,i2.y,1.))
     +i.x+vec4(0.,i1.x,i2.x,1.));
    float n_ = 0.142857142857;
    vec3  ns = n_*D.wyz - D.xzx;
    vec4 j   = p - 49.*floor(p*ns.z*ns.z);
    vec4 x_  = floor(j*ns.z);
    vec4 y_  = floor(j - 7.*x_);
    vec4 x   = x_*ns.x + ns.yyyy;
    vec4 y   = y_*ns.x + ns.yyyy;
    vec4 h   = 1. - abs(x) - abs(y);
    vec4 b0  = vec4(x.xy, y.xy);
    vec4 b1  = vec4(x.zw, y.zw);
    vec4 s0  = floor(b0)*2.+1.;
    vec4 s1  = floor(b1)*2.+1.;
    vec4 sh  = -step(h, vec4(0.));
    vec4 a0  = b0.xzyw + s0.xzyw*sh.xxyy;
    vec4 a1  = b1.xzyw + s1.xzyw*sh.zzww;
    vec3 p0  = vec3(a0.xy, h.x);
    vec3 p1  = vec3(a0.zw, h.y);
    vec3 p2  = vec3(a1.xy, h.z);
    vec3 p3  = vec3(a1.zw, h.w);
    vec4 norm = taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
    p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
    vec4 m = max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.);
    m = m*m;
    return 42.*dot(m*m, vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
  }

  vec3 lifeColor(float life){ return mix(vec3(1.0,0.08,0.04), uColor, life); }

  float hexPattern(vec2 p){
    p *= uHexScale;
    const vec2 s = vec2(1., 1.7320508);
    vec4 hC = floor(vec4(p, p-vec2(0.5,1.))/s.xyxy) + 0.5;
    vec4 h  = vec4(p-hC.xy*s, p-(hC.zw+0.5)*s);
    vec2 cell = (dot(h.xy,h.xy) < dot(h.zw,h.zw)) ? h.xy : h.zw;
    cell = abs(cell);
    float d = max(dot(cell, s*0.5), cell.x);
    return smoothstep(0.5-uEdgeWidth, 0.5, d);
  }
  vec2 hexCellId(vec2 p){
    p *= uHexScale;
    const vec2 s = vec2(1., 1.7320508);
    vec4 hC = floor(vec4(p, p-vec2(0.5,1.))/s.xyxy) + 0.5;
    vec4 h  = vec4(p-hC.xy*s, p-(hC.zw+0.5)*s);
    return (dot(h.xy,h.xy) < dot(h.zw,h.zw)) ? hC.xy : hC.zw+0.5;
  }
  float cellFlash(vec2 id){
    float rnd = fract(sin(dot(id, vec2(127.1,311.7)))*43758.5453);
    return smoothstep(0.6,1.0, sin(uTime*uFlashSpeed*(0.5+rnd*1.5)+rnd*6.2831)) * uFlashIntensity;
  }

  void main(){
    float fresnel = pow(1.0 - dot(vNormal, vViewDir), uFresnelPower) * uFresnelStrength;

    float t = uTime*uFlowSpeed;
    float fn1 = snoise(vObjPos*uFlowScale + vec3(t, t*0.6, t*0.4));
    float flowNoise = fn1*0.5 + 0.5;

    // hex via cube-face triplanar with a seam fade so no ghost grid at the 45deg edges
    vec3 absN = abs(normalize(vObjPos));
    float dominance = max(absN.x, max(absN.y, absN.z));
    float hexFade = smoothstep(0.65, 0.85, dominance);
    vec2 faceUV = (absN.x >= absN.y && absN.x >= absN.z) ? vObjPos.yz
                : (absN.y >= absN.z) ? vObjPos.xz : vObjPos.xy;
    float hex   = hexPattern(faceUV) * hexFade;
    float flash = cellFlash(hexCellId(faceUV)) * hexFade;

    // expanding hit rings (geodesic) + a hex highlight zone at each impact
    vec3 normPos = normalize(vObjPos);
    float ringContrib = 0.0, hexHitBoost = 0.0;
    for (int i = 0; i < MAX_HITS; i++) {
      float ht = uHitTime[i];
      float elapsed = uTime - ht;
      float isActive = step(0.0, ht) * step(0.0, elapsed) * step(elapsed, uHitDuration);
      float dist = acos(clamp(dot(normPos, normalize(uHitPos[i])), -1.0, 1.0));
      float ringR = min(elapsed*uHitRingSpeed, uHitMaxRadius);
      float noiseD = snoise(normPos*5.0 + vec3(elapsed*2.0))*0.05;
      float ring = smoothstep(uHitRingWidth, 0.0, abs(dist + noiseD - ringR));
      float fade = 1.0 - smoothstep(uHitDuration*0.5, uHitDuration, elapsed);
      float radialFade = 1.0 - smoothstep(uHitMaxRadius*0.75, uHitMaxRadius, ringR);
      ringContrib += ring*fade*radialFade*isActive;
      float zone = smoothstep(uHitImpactRadius, 0.0, dist);
      hexHitBoost += zone * (1.0 - smoothstep(0.0, uHitDuration*0.35, elapsed)) * isActive;
    }
    ringContrib = min(ringContrib, 2.0);
    hexHitBoost = min(hexHitBoost, 1.0);

    vec3 lColor = lifeColor(uLife);
    float effHex = uHexOpacity + hexHitBoost*uHitIntensity;
    float intensity = hex*effHex*(0.3 + fresnel*0.7) + fresnel*0.4 + flash;
    vec3 shieldColor = lColor*intensity*2.0;
    shieldColor += lColor*(flowNoise*fresnel*uFlowIntensity);
    shieldColor += lColor*ringContrib*uHitIntensity;
    float alpha = clamp(intensity*uOpacity + ringContrib*0.4, 0.0, 1.0);
    gl_FragColor = vec4(shieldColor, alpha);
  }
`;

// Tuned defaults (the reference's "default" preset, radius-normalised for a unit sphere).
function defaultUniforms(hex) {
  const hits = [], times = [];
  for (let i = 0; i < MAX_HITS; i++) { hits.push(new THREE.Vector3(0, 1, 0)); times.push(-1e3); }
  return {
    uTime:            { value: 0 },
    uColor:           { value: new THREE.Color(hex || '#26aeff') },
    uLife:            { value: 1 },
    uOpacity:         { value: 0.76 },
    uHexScale:        { value: 3.0 },
    uEdgeWidth:       { value: 0.06 },
    uHexOpacity:      { value: 0.13 },
    uFresnelPower:    { value: 1.8 },
    uFresnelStrength: { value: 1.75 },
    uFlashSpeed:      { value: 0.6 },
    uFlashIntensity:  { value: 0.11 },
    uFlowScale:       { value: 2.4 },
    uFlowSpeed:       { value: 1.13 },
    uFlowIntensity:   { value: 4.0 },
    uHitPos:          { value: hits },
    uHitTime:         { value: times },
    uHitRingSpeed:    { value: 1.75 },
    uHitRingWidth:    { value: 0.12 },
    uHitMaxRadius:    { value: 2.4 },
    uHitDuration:     { value: 1.6 },
    uHitIntensity:    { value: 1.0 },
    uHitImpactRadius: { value: 0.5 },
  };
}

// Make a force-field material tinted to `hex` (a team colour). Additive so it glows over the hull.
export function makeShieldMaterial(hex) {
  const mat = new THREE.ShaderMaterial({
    vertexShader, fragmentShader,
    uniforms: defaultUniforms(hex),
    transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
  });
  mat.userData.hitCursor = 0;   // round-robin index into the hit ring buffer
  return mat;
}

// Register a hit at object-space direction `dir` (a unit Vector3 on the sphere) at time `now`.
export function pushShieldHit(mat, dir, now) {
  const u = mat.uniforms; const i = mat.userData.hitCursor % MAX_HITS;
  u.uHitPos.value[i].copy(dir).normalize();
  u.uHitTime.value[i] = now;
  mat.userData.hitCursor = (mat.userData.hitCursor + 1) % MAX_HITS;
}

// Per-frame: advance time, set colour + drain (0..1 life). now is seconds.
export function stepShield(mat, now, life, hex) {
  const u = mat.uniforms;
  u.uTime.value = now;
  u.uLife.value = life;
  if (hex) u.uColor.value.set(hex);
}
