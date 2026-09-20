import * as THREE from 'three';
import { applyCamoUVs, getTeamColor, makeCamoMaterial } from './CamoTexture.js';
import { makeMuzzleFlash, flashMuzzle, updateMuzzle, decayRecoil } from './GunFX.js';

export class Firebrat {
  constructor() {
    this.group     = new THREE.Group();
    this.hoverTime = 0;
    this.thrusters = [];
    this.pitch     = 0;
    this.roll      = 0;
    this._muzzles  = [];
    this._recoil   = 0;
    this._muzzleIx = 0;
    this._build();
  }

  _build() {
    this._buildModel();
  }

  // ── Shared helpers ────────────────────────────────────────────────────────────

  _makeMaterials() {
    const accentColor = getTeamColor();
    return {
      accentColor,
      bodyMat:   makeCamoMaterial({ roughness: 0.40, metalness: 0.78 }),
      darkMat:   new THREE.MeshStandardMaterial({ color: 0x0a0c10, roughness: 0.50, metalness: 0.70 }),
      accentMat: new THREE.MeshStandardMaterial({ color: accentColor, roughness: 0.25, metalness: 0.85, emissive: new THREE.Color(accentColor), emissiveIntensity: 0.40 }),
      glassMat:  new THREE.MeshStandardMaterial({ color: 0x0a0e16, roughness: 0.10, metalness: 0.30, transparent: true, opacity: 0.85 }),
    };
  }

  // Stretched sphere with baked-in scale (so UVs come out right).
  _ovoid(r, segW, segH, sx, sy, sz) {
    const g = new THREE.SphereGeometry(r, segW, segH);
    g.scale(sx, sy, sz);
    return applyCamoUVs(g);
  }

  // Build a vectoring thruster: short tapered cylinder + emissive nozzle ring + glow light.
  // Pivots at the top so its exhaust swings around when tilted.
  _addThruster(x, y, z, scale, mats) {
    const tg = new THREE.Group();
    tg.position.set(x, y, z);
    this.group.add(tg);

    const r1 = 0.075 * scale;
    const r2 = 0.060 * scale;
    const h  = 0.09  * scale;   // half-height nozzle stack

    const tube = new THREE.Mesh(new THREE.CylinderGeometry(r1, r2, h, 10), mats.darkMat);
    tube.position.y = -h / 2;
    tg.add(tube);

    const nozzle = new THREE.Mesh(new THREE.TorusGeometry(r2 * 1.05, 0.014 * scale, 6, 16), mats.accentMat);
    nozzle.rotation.x = Math.PI / 2;
    nozzle.position.y = -h;
    tg.add(nozzle);

    // Exhaust flame — additive cone whose base sits at the nozzle and tapers to a
    // point below. Geometry is anchored at its base (y=0) so scale.y grows it
    // straight down; update() stretches it with thrust.
    const flameLen = 0.26 * scale;
    const flameGeo = new THREE.ConeGeometry(r2 * 0.9, flameLen, 8, 1, true);
    flameGeo.rotateX(Math.PI);              // apex points down (exhaust direction)
    flameGeo.translate(0, -flameLen / 2, 0); // base at y=0, apex at y=-flameLen
    const flameMat = new THREE.MeshBasicMaterial({
      color: mats.accentColor, transparent: true, opacity: 0.7,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const flame = new THREE.Mesh(flameGeo, flameMat);
    flame.position.y = -h;
    tg.add(flame);
    tg.userData.flame = flame;

    const glow = new THREE.PointLight(mats.accentColor, 0.35, 1.0 * scale);
    glow.position.y = -h - 0.08;
    tg.add(glow);
    tg.userData.glow = glow;
    tg.userData.baseGlow = 0.35;

    this.thrusters.push(tg);
    return tg;
  }

  // Raked dark knife-edge vertical tail: sharp leading edge, thick trailing edge,
  // flat top, with a contrasting camo "pylon" pod riding its top. The dark-fin /
  // camo-pod texture contrast is the look the user liked. baseZ seats the fin's
  // base on the rear hull.
  _tailAssembly(mats, baseZ = 0.60) {
    const { bodyMat, darkMat } = mats;

    const finHeight = 0.30;
    const finShape = new THREE.Shape();
    finShape.moveTo(-0.16,  0.000);   // leading edge — sharp point (front)
    finShape.lineTo( 0.16,  0.020);   // trailing edge, one side (thin)
    finShape.lineTo( 0.16, -0.020);   // trailing edge, other side (thin)
    finShape.lineTo(-0.16,  0.000);
    const finGeom = new THREE.ExtrudeGeometry(finShape, { depth: finHeight, bevelEnabled: false });
    // Cyclic axis remap: chord(x)→z, thickness(y)→x, height(extrude z)→y.
    finGeom.applyMatrix4(new THREE.Matrix4().set(
      0, 1, 0, 0,
      0, 0, 1, 0,
      1, 0, 0, 0,
      0, 0, 0, 1,
    ));
    // Rake the blade aft: shear z by height so edges slant back, top stays flat.
    const finRake = 0.8;
    finGeom.applyMatrix4(new THREE.Matrix4().set(
      1, 0,       0, 0,
      0, 1,       0, 0,
      0, finRake, 1, 0,
      0, 0,       0, 1,
    ));
    finGeom.translate(0, 0.04, baseZ);  // lift base into hull, seat on rear hull
    this.group.add(new THREE.Mesh(finGeom, darkMat));

    // Skinny camo mini-fuselage riding the fin's flat top (the contrasting pylon).
    const finPod = new THREE.Mesh(this._ovoid(0.055, 12, 8,  0.8, 0.8, 3.6), bodyMat);
    finPod.position.set(0, finHeight + 0.06, baseZ + finRake * finHeight - 0.02);
    this.group.add(finPod);
  }

  // ── Firebrat — slim central hull + twin outrigger pods, swept wings, tri-thrust
  // vectoring. Large V-matched canopy, flush glowing access hatches that hug the
  // deck, two-tone illuminated flank strakes, and the shared raked tail + camo pod.
  _buildModel() {
    const mats = this._makeMaterials();
    const { bodyMat, darkMat, accentMat, glassMat, accentColor } = mats;

    // Central hull — slender & flattened (lower/longer than V3 for a stealthier
    // profile). Half-extents: x≈0.167, y≈0.125, z≈0.817 (centered z=0.05).
    const hull = new THREE.Mesh(this._ovoid(0.19, 14, 10,  0.88, 0.66, 4.3), bodyMat);
    hull.position.z = 0.05;
    this.group.add(hull);

    // Faceted nose taper (low sides → arrow look)
    const nose = new THREE.Mesh(applyCamoUVs(new THREE.CylinderGeometry(0.135, 0, 0.62, 8)), bodyMat);
    nose.rotation.x = Math.PI / 2;
    nose.position.z = -0.90;
    this.group.add(nose);

    // Large elongated canopy (matches V3's — back edge reaches z≈0.43)
    const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.15, 14, 8), glassMat);
    canopy.scale.set(0.98, 0.65, 3.75);
    canopy.position.set(0, 0.12, -0.1325);
    this.group.add(canopy);

    // ── Surface detailing on the dorsal deck ──────────────────────────────────
    const TOP = 0.118;   // dorsal detail height — sits just proud of the hull crown

    // Brighter emissive for the lit strakes (matches V1's illuminated panels).
    const bayMat = new THREE.MeshStandardMaterial({
      color: accentColor, roughness: 0.20, metalness: 0.60,
      emissive: new THREE.Color(accentColor), emissiveIntensity: 1.1,
    });

    // Two flush access hatches — flat camo lids seated on the deck, each framed by
    // a thin glowing bay seam peeking out around the edges (closed, not popped).
    // Pushed outboard & aft to clear the enlarged canopy, and rolled to follow the
    // hull's curve where they sit out on the flank (outer edge dips with the body).
    for (const sx of [-1, 1]) {
      const hatchZ    = 0.48;
      const hatchY    = 0.10;          // hull surface height at x≈0.10 (below the crown)
      const hatchRoll = -sx * 0.50;    // tilt outer edge down to hug the curving deck

      // Glowing bay seam — slightly larger than the lid so it reads as a lit frame.
      const bay = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.01, 0.16), accentMat);
      bay.position.set(sx * 0.10, hatchY - 0.004, hatchZ);
      bay.rotation.z = hatchRoll;
      this.group.add(bay);

      const lid = new THREE.Mesh(applyCamoUVs(new THREE.BoxGeometry(0.10, 0.012, 0.14)), bodyMat);
      lid.position.set(sx * 0.10, hatchY + 0.004, hatchZ);
      lid.rotation.z = hatchRoll;
      this.group.add(lid);
    }

    // Two-tone flank intakes (stolen from V1): a bright illuminated strip seated on
    // a black housing strip, so the lit strake reads against a dark backing.
    for (const sx of [-1, 1]) {
      const housing = new THREE.Mesh(new THREE.BoxGeometry(0.026, 0.06, 0.38), darkMat);
      housing.position.set(sx * 0.150, 0.0, -0.18);
      this.group.add(housing);

      const slit = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.03, 0.32), bayMat);
      slit.position.set(sx * 0.158, 0.0, -0.18);
      this.group.add(slit);
    }

    // ── Twin outrigger pods on swept wings (slimmer than V3, gentle dihedral) ──
    const wingMat = new THREE.MeshStandardMaterial({ color: 0x0a0c10, roughness: 0.50, metalness: 0.70, side: THREE.DoubleSide });
    const wingShape = new THREE.Shape();
    wingShape.moveTo( 0.14,  0.000);   // leading edge — sharp point (front)
    wingShape.lineTo(-0.14,  0.025);   // trailing edge, upper (thin)
    wingShape.lineTo(-0.14, -0.025);   // trailing edge, lower (thin)
    wingShape.lineTo( 0.14,  0.000);
    const wingGeom = new THREE.ExtrudeGeometry(wingShape, { depth: 0.50, bevelEnabled: false });
    wingGeom.rotateY(Math.PI / 2);     // chord→z (sharp edge forward), span→+x, thickness→y

    for (const sx of [-1, 1]) {
      const wingGroup = new THREE.Group();
      wingGroup.position.set(sx * 0.46, 0.0, 0.18);
      wingGroup.rotation.y = -sx * 0.30;  // sweep back: root forward
      wingGroup.rotation.z = -sx * 0.10;  // gentle dihedral: root at hull flank, tip dips to pod
      this.group.add(wingGroup);

      const wing = new THREE.Mesh(wingGeom, wingMat);
      wing.scale.x = -sx;
      wingGroup.add(wing);

      // Slim outrigger pod at the wing tip
      const pod = new THREE.Mesh(this._ovoid(0.075, 12, 8,  0.85, 0.85, 4.2), bodyMat);
      pod.position.set(sx * 0.50, -0.02, 0.20);
      this.group.add(pod);

      // Pod-tip sensor barrel (dark) with camo muzzle
      const podGun = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.30, 6), darkMat);
      podGun.rotation.x = Math.PI / 2;
      podGun.position.set(sx * 0.50, -0.02, -0.28);
      this.group.add(podGun);

      const podMuzzle = new THREE.Mesh(applyCamoUVs(new THREE.CylinderGeometry(0.026, 0.022, 0.05, 8)), bodyMat);
      podMuzzle.rotation.x = Math.PI / 2;
      podMuzzle.position.set(sx * 0.50, -0.02, -0.44);
      this.group.add(podMuzzle);

      // Small fast muzzle flash at each pod tip.
      const flash = makeMuzzleFlash(0xbff4ff, 0.22);
      flash.position.set(sx * 0.50, -0.02, -0.50);
      this.group.add(flash);
      this._muzzles.push(flash);
    }

    // Shared V3 vertical tail assembly (dark fin + contrasting camo pylon pod)
    this._tailAssembly(mats, 0.60);

    // Tri-thrusters: front-center + two rear-outer (matches the V3 vectoring rig)
    const frontThruster = this._addThruster( 0.00, -0.04, -0.80, 0.74, mats);
    frontThruster.userData.isFront = true;
    this._addThruster(-0.50, -0.06,  0.40, 0.70, mats);
    this._addThruster( 0.50, -0.06,  0.40, 0.70, mats);

    // Under-glow
    const underGlow = new THREE.PointLight(accentColor, 0.40, 2.0);
    underGlow.position.set(0, -0.14, 0.10);
    this.group.add(underGlow);
  }

  update(delta, forwardInput = 0, turnInput = 0) {
    this.hoverTime += delta;

    // Hover bob
    this.group.position.y = Math.sin(this.hoverTime * 3.0) * 0.025;

    // Vehicle banks into turns + idle sway
    const targetBank = -turnInput * 0.20 + Math.sin(this.hoverTime * 0.7) * 0.020;
    this.group.rotation.z += (targetBank - this.group.rotation.z) * Math.min(1, delta * 5);

    // Thrust vectoring — pitch with forward input, roll with turn
    const TILT_PITCH = 0.55;
    const TILT_ROLL  = 0.40;
    const targetPitch = -forwardInput * TILT_PITCH;
    const targetRoll  =  turnInput    * TILT_ROLL;
    this.pitch += (targetPitch - this.pitch) * Math.min(1, delta * 7);
    this.roll  += (targetRoll  - this.roll)  * Math.min(1, delta * 7);

    // Combined thrust demand drives glow + flame length; turning counts too.
    const thrust     = Math.min(1, Math.abs(forwardInput) + Math.abs(turnInput) * 0.7);
    const thrustGlow = 0.35 + thrust * 0.55;
    const flicker    = 0.85 + Math.sin(this.hoverTime * 40) * 0.15;  // exhaust shimmer

    for (const t of this.thrusters) {
      t.rotation.x = this.pitch;
      // Front thruster vectors opposite the rears so A/D reads as a yaw spin.
      // Sideways tilt reversed from the bank direction.
      t.rotation.z = t.userData.isFront ? this.roll : -this.roll;
      if (t.userData.glow) t.userData.glow.intensity = thrustGlow;

      const flame = t.userData.flame;
      if (flame) {
        flame.scale.y = (0.55 + thrust * 1.7) * flicker;
        flame.scale.x = flame.scale.z = 0.8 + thrust * 0.5;
        flame.material.opacity = 0.5 + thrust * 0.4;
      }
    }

    // Firing kick: quick nose-up pop + tiny lift, settles fast (it's a light craft).
    this._recoil = decayRecoil(this._recoil, delta, 0.10);
    this.group.position.y += this._recoil * 0.03;
    this.group.rotation.x = -this._recoil * 0.05;
    for (const m of this._muzzles) updateMuzzle(m, delta);
  }

  // Fire one pod (alternating) — fast little flash + a light kick. Returns the
  // fired muzzle (for projectile spawning).
  fire() {
    const m = this._muzzles[this._muzzleIx % this._muzzles.length];
    this._muzzleIx++;
    flashMuzzle(m);
    this._recoil = 1;
    return m;
  }
}
