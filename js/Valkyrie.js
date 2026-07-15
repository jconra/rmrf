import * as THREE from 'three';
import { applyCamoUVs, applyFacetedCamoUVs, getTeamColor, makeCamoMaterial } from './CamoTexture.js';
import { makeMuzzleFlash, flashMuzzle, updateMuzzle, decayRecoil } from './GunFX.js';
import { mergeStatic } from './MergeParts.js?v=1';

export class Valkyrie {
  constructor() {
    this.group      = new THREE.Group();
    this.hoverTime  = 0;
    this.tiltAngle  = 0;
    this.turnTilt   = 0;
    this._muzzles   = [];
    this._recoil    = 0;
    this._muzzleIx  = 0;
    this._build();
  }

  _build() {
    // The Valkyrie is the recon Samson — the signed-off keeper.
    this._buildSamson({ detailPkg: 'recon' });
    // DRAW-CALL MERGE (~158 meshes → a couple dozen): each rigid frame bakes to one mesh
    // per material — blades within each ROTOR (they only spin as a unit), nacelle bodies
    // within each NACELLE (they tilt as a unit, skipping the child rotor), and the whole
    // hull + arms + fins on the group (skipping the tilting nacelles). Muzzle flashes
    // stay separate (opacity-animated).
    mergeStatic(this.leftRotorGroup);
    mergeStatic(this.rightRotorGroup);
    mergeStatic(this.leftNacelleGroup, [this.leftRotorGroup, ...this._muzzles]);
    mergeStatic(this.rightNacelleGroup, [this.rightRotorGroup, ...this._muzzles]);
    mergeStatic(this.group, [this.leftNacelleGroup, this.rightNacelleGroup, ...this._muzzles]);
  }

  // ── Shared materials ──────────────────────────────────────────────────────────
  _mats() {
    const accentColor = getTeamColor();
    return {
      accentColor,
      bodyMat:   makeCamoMaterial({ roughness: 0.5, metalness: 0.7 }),
      darkMat:   new THREE.MeshStandardMaterial({ color: 0x12161c, roughness: 0.55, metalness: 0.6 }),
      accentMat: new THREE.MeshStandardMaterial({ color: accentColor, roughness: 0.25, metalness: 0.85, emissive: new THREE.Color(accentColor), emissiveIntensity: 0.35 }),
    };
  }

  // Smooth fore-aft hull segment: a cylinder whose length runs along Z.
  // rF = front (-Z) radius, rR = rear (+Z) radius, `sides` controls smoothness
  // (high = round, low = faceted), `flat` squashes height, `wide` stretches width.
  // Scale is baked into the geometry so camo UVs tile correctly.
  // Returns { mesh-ready geometry }. Helpers below read the radii/scale to anchor parts.
  _hull(rF, rR, length, sides, flat = 1, wide = 1, twist = 0, openEnded = false) {
    const g = new THREE.CylinderGeometry(rR, rF, length, sides, 1, openEnded);
    g.rotateX(Math.PI / 2);   // length → Z; radiusTop(rR) → +Z (rear)
    if (twist) g.rotateZ(twist);   // spin cross-section so facets land flat-top (e.g. PI/sides)
    g.scale(wide, flat, 1);
    return applyCamoUVs(g);
  }

  // Half-extents (X half-width, Y half-height) of a _hull at a given Z, so parts
  // can be anchored to the actual body surface instead of guessed coordinates.
  // zFrac is the position along the segment as a 0..1 value (0 = front, 1 = rear).
  _hullHalfAt(rF, rR, zFrac, flat, wide) {
    const r = rF + (rR - rF) * THREE.MathUtils.clamp(zFrac, 0, 1);
    return { halfW: r * wide, halfH: r * flat };
  }

  // Flat polygon panel from 3 or 4 corner points (THREE.Vector3). Used to build a
  // faceted greenhouse out of individual flat glass panes. `mat` should be DoubleSide.
  _pane(pts, mat, camoUV = false) {
    const v = [];
    const push = (p) => v.push(p.x, p.y, p.z);
    push(pts[0]); push(pts[1]); push(pts[2]);
    if (pts.length === 4) { push(pts[0]); push(pts[2]); push(pts[3]); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    g.computeVertexNormals();
    if (camoUV) applyCamoUVs(g);   // world-space camo projection for body-colour panes
    return new THREE.Mesh(g, mat);
  }

  // Square-section strut spanning two points — a frame spar / window mullion.
  _spar(p1, p2, mat, thick = 0.022) {
    const len = p1.distanceTo(p2);
    const m = new THREE.Mesh(new THREE.BoxGeometry(thick, thick, len), mat);
    m.position.copy(p1).add(p2).multiplyScalar(0.5);
    m.lookAt(p2);   // box symmetric, so its Z-axis aligning the p1→p2 line is enough
    return m;
  }

  // Twin landing skids. Struts splay OUTWARD: each strut's top attaches high and
  // inboard under the belly (topHalfWidth), its bottom reaches down and out to the
  // wider rail (railHalfWidth). topY embeds up into the hull so it reads attached.
  _skids(mat, { topY, railY, topHalfWidth, railHalfWidth, length }) {
    const up = new THREE.Vector3(0, 1, 0);
    for (const sx of [-1, 1]) {
      const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, length, 8), mat);
      rail.rotation.x = Math.PI / 2;
      rail.position.set(sx * railHalfWidth, railY, 0.1);
      this.group.add(rail);
      for (const sz of [-length * 0.32, length * 0.32]) {
        const top = new THREE.Vector3(sx * topHalfWidth,  topY,  sz + 0.1);
        const bot = new THREE.Vector3(sx * railHalfWidth, railY, sz + 0.1);
        const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, top.distanceTo(bot), 8), mat);
        strut.position.copy(top).add(bot).multiplyScalar(0.5);
        strut.quaternion.setFromUnitVectors(up, bot.clone().sub(top).normalize());
        this.group.add(strut);
      }
      // Up-turned toe pieces at each rail end (helicopter-skid style)
      const railFront = 0.1 - length / 2, railBack = 0.1 + length / 2;
      const TOE_RISE = 0.10, TOE_RUN = 0.13;
      for (const [endZ, dir] of [[railFront, -1], [railBack, 1]]) {
        const a = new THREE.Vector3(sx * railHalfWidth, railY, endZ);
        const b = new THREE.Vector3(sx * railHalfWidth, railY + TOE_RISE, endZ + dir * TOE_RUN);
        const toe = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, a.distanceTo(b), 8), mat);
        toe.position.copy(a).add(b).multiplyScalar(0.5);
        toe.quaternion.setFromUnitVectors(up, b.clone().sub(a).normalize());
        this.group.add(toe);
      }
    }
  }

  // Slim stub wing carrying underslung missiles. Sits low on the flank (well below
  // the shoulder fans) so it clears the rotor sweep. Built in a group pivoted at the
  // wing root on the flank, so `sweep` (back) and `droop` (anhedral, tip down) rotate
  // the wing AND its missiles together. `hullHalfW` is the body half-width at the
  // wing's Z; we embed past it so the wing meets the flat side facet (which sits a
  // touch inboard of that vertex radius).
  _missileWing(bodyMat, darkMat, accentMat, sx, { y, z, span, chord, thickness = 0.04, tipScale = 0.4, sweep = 0, droop = 0, hullHalfW, missiles = 2 }) {
    const inner = hullHalfW - 0.06;           // embed root into the flat side facet
    const g = new THREE.Group();
    g.position.set(sx * inner, y, z);         // pivot at the wing root
    if (sweep) g.rotation.y = sx * sweep;     // sweep trailing edge back
    g.rotation.z = -sx * droop;               // droop the tip downward (anhedral)
    this.group.add(g);

    // Wing extends straight outboard along the local X axis from the root. Taper its
    // cross-section (chord Z + thickness Y) down to `tipScale` at the tip so the
    // pylon is fat where it meets the hull and slim at the end.
    const wingGeo = new THREE.BoxGeometry(span, thickness, chord);
    const wp = wingGeo.attributes.position;
    for (let i = 0; i < wp.count; i++) {
      const t = (wp.getX(i) * sx + span / 2) / span;     // 0 at root, 1 at tip
      const s = THREE.MathUtils.lerp(1, tipScale, t);
      wp.setY(i, wp.getY(i) * s);
      wp.setZ(i, wp.getZ(i) * s);
    }
    wp.needsUpdate = true;
    wingGeo.computeVertexNormals();
    const wing = new THREE.Mesh(applyCamoUVs(wingGeo), bodyMat);
    wing.position.set(sx * span / 2, 0, 0);
    g.add(wing);

    // Missiles slung under the wing (top tangent to the underside), fore-aft, spread
    // evenly along the pylon span and centred on the mount point.
    const mx = span * 0.55, pitch = 0.12, my = -(thickness / 2 + 0.045);
    const offs = Array.from({ length: missiles }, (_, i) => (i - (missiles - 1) / 2) * pitch);
    for (const off of offs) {
      const x = sx * mx + off;
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.5, 10), darkMat);
      body.rotation.x = Math.PI / 2;
      body.position.set(x, my, 0);
      g.add(body);
      const nose = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.13, 10), accentMat);
      nose.rotation.x = -Math.PI / 2;
      nose.position.set(x, my, -0.315);
      g.add(nose);
      for (const [fx, fy] of [[0.07, 0], [-0.07, 0], [0, 0.07], [0, -0.07]]) {
        const fin = new THREE.Mesh(new THREE.BoxGeometry(fx ? 0.06 : 0.01, fy ? 0.06 : 0.01, 0.09), darkMat);
        fin.position.set(x + fx, my + fy, 0.22);
        g.add(fin);
      }
    }

    // Launch flash for this wing's missile cluster (one per wing, fired alternately).
    const flash = makeMuzzleFlash(0xffd49a, 0.5);
    flash.position.set(sx * mx, my, -0.46);
    g.add(flash);
    this._muzzles.push(flash);
  }

  // ── "Samson" — faceted utility gunship, big twin shrouded fans ────────────────
  // Grounded on the SA-2 Samson reference: chunky angular body, large thick ducted
  // fans on shoulder pylons, faceted forward greenhouse, chin FLIR + nose gun.
  //   transBoxX — |X| centre of the gearbox housings at the wing/fuselage joint
  //   detailPkg — 'recon' adds the sensor/antenna fit (the Valkyrie's loadout)
  _buildSamson({ transBoxX = 0.52, detailPkg = 'recon' } = {}) {
    const { accentColor, bodyMat, darkMat, accentMat } = this._mats();

    // Faceted hull: SIDES=8 + TWIST gives flat top/bottom & beveled flanks (military,
    // not the smooth tube). Every attached part is derived from these dims.
    const SIDES = 8, TWIST = Math.PI / 8;
    const RF = 0.36, RR = 0.42, FLAT = 0.84, WIDE = 1.2;
    const FUSE_LEN = 1.7, FUSE_HALF = FUSE_LEN / 2;        // shortened; spans z -0.85 .. +0.85

    // Hollow shell: open-ended tube + double-sided camo so the interior walls
    // render — you see into the cabin through the cockpit glass.
    const hollowMat = makeCamoMaterial({ roughness: 0.5, metalness: 0.7 });
    hollowMat.side = THREE.DoubleSide;
    // Two equal halves meeting at the centre, bulged out to FUSE_MID where they
    // join, so the body peaks in the middle (spindle shape) instead of a flat tube.
    const FUSE_MID = 0.47, HALF_LEN = FUSE_LEN / 2;
    const fwdHalf = new THREE.Mesh(this._hull(RF, FUSE_MID, HALF_LEN, SIDES, FLAT, WIDE, TWIST, true), hollowMat);
    fwdHalf.position.z = -HALF_LEN / 2;   // spans z -0.85 .. 0
    this.group.add(fwdHalf);
    const aftHalf = new THREE.Mesh(this._hull(FUSE_MID, RR, HALF_LEN, SIDES, FLAT, WIDE, TWIST, true), hollowMat);
    aftHalf.position.z = HALF_LEN / 2;    // spans z 0 .. +0.85
    this.group.add(aftHalf);

    // The front is sheared off flat — the new nose will be rebuilt below.

    // Tail cone sheared UPWARD: the top stays level (no downward slope rearward);
    // the whole taper is pushed onto the underside / belly.
    const TAIL_LEN = 0.95, TAIL_RR = 0.08;
    const tailGeo = this._hull(RR, TAIL_RR, TAIL_LEN, SIDES, FLAT, WIDE, TWIST);
    const tailDrop = (RR - TAIL_RR) * FLAT;     // how far the top would otherwise drop
    tailGeo.applyMatrix4(new THREE.Matrix4().makeShear(0, 0, 0, 0, 0, tailDrop / TAIL_LEN)); // y += slope*z
    tailGeo.translate(0, tailDrop / 2, 0);      // lift so the front edge re-mates flush, top level
    // Per-face UVs: the tail is a strongly-tapered+sheared 8-gon, so its bevel facets
    // are well off-axis. Dominant-axis applyCamoUVs would stretch those facets; the
    // per-face projection keeps the camo 1:1 on every facet (top, side, AND bevel).
    const tail = new THREE.Mesh(applyFacetedCamoUVs(tailGeo), bodyMat);
    // Butt exactly against the fuselage rear plane (both radius RR there) — no inward
    // overlap, which previously let the wider fuselage rim poke past the tapering tail.
    tail.position.z = FUSE_HALF + TAIL_LEN / 2;
    this.group.add(tail);
    const tailEndZ = tail.position.z + TAIL_LEN / 2;

    // ── Front canopy: two-stage faceted greenhouse (rebuilt to Samson ref) ─────
    // Step 1 (silhouette): the glass only. A long SHALLOW pair of windows runs
    // forward from the hull's flat top edge, then a support spar, then a STEEPER
    // pair drops to the nose tip. Sides/chin/gun come in later steps.
    //
    // KEY FIX: the hull's real flat-top EDGE is the pair of facet corners at
    // cross-section angle ±67.5° (because _hull does rotateZ(PI/8)). We anchor the
    // canopy to those exact corners so its base sits flush on the body's top facet.
    const V = (x, y, z) => new THREE.Vector3(x, y, z);
    const FRONT_Z = -FUSE_HALF;                       // body front cap (z = -0.85)
    const rimPt = (deg) => V(                          // hull front-rim point at XY angle `deg`
      RF * WIDE * Math.cos(deg * Math.PI / 180),
      RF * FLAT * Math.sin(deg * Math.PI / 180),
      FRONT_Z);
    const TR = rimPt(67.5), TL = rimPt(112.5);        // hull flat-top edge corners (≈±0.165, 0.279)
    const TOPW = TR.x, ROOF_Y = TR.y;
    const TC = V(0, ROOF_Y, FRONT_Z);                 // top edge centre

    // Break line: end of the shallow upper windows / start of the steep windscreen.
    const MW = 0.13, MID_Y = ROOF_Y - 0.10, MID_Z = FRONT_Z - 0.42;   // shallow: long fwd, small drop
    const MR = V(MW, MID_Y, MID_Z), ML = V(-MW, MID_Y, MID_Z), MC = V(0, MID_Y, MID_Z);
    // Nose tip line.
    const TPW = MW, TIP_Y = MID_Y - 0.336, TIP_Z = MID_Z - 0.256;     // steep: big drop, full-width (no taper); 80% length
    const NR = V(TPW, TIP_Y, TIP_Z), NL = V(-TPW, TIP_Y, TIP_Z), NC = V(0, TIP_Y, TIP_Z);

    const glass = new THREE.MeshStandardMaterial({
      color: 0x0a0e16, roughness: 0.1, metalness: 0.4,
      transparent: true, opacity: 0.84, side: THREE.DoubleSide,
    });

    // Shallow upper pair (split L/R by the centre mullion).
    this.group.add(this._pane([TC, TR, MR, MC], glass));
    this.group.add(this._pane([TC, MC, ML, TL], glass));
    // Steep lower pair, running to the tip.
    this.group.add(this._pane([MC, MR, NR, NC], glass));
    this.group.add(this._pane([MC, NC, NL, ML], glass));

    // Framing: top edge, centre spine, side rails, and the support spar at the break.
    const fr = (p, q, t = 0.024) => this.group.add(this._spar(p, q, bodyMat, t));
    fr(TC, MC); fr(MC, NC);    // centre spine mullion (shallow then steep)
    fr(TR, MR); fr(MR, NR);    // right side rail
    fr(TL, ML); fr(ML, NL);    // left side rail
    fr(MR, ML, 0.03);          // ← support spar across the break

    // ── Side window guide spar: nose tip → body flank corner ───────────────────
    // The forward side window should sweep from the body upper-flank corner all the
    // way forward to the nose tip (NC) — the same point both middle (steep) windows
    // reach. This spar marks that outer edge; the pane gets built once it's right.
    const BR = rimPt(22.5), BL = rimPt(157.5);   // body upper-flank corners (front cap)
    fr(NR, BR, 0.03);   // right guide spar (window corner → body flank)
    fr(NL, BL, 0.03);   // left guide spar
    // Side-rail joint (where the shallow/steep panes meet) down to the side support,
    // closing the forward side-window frame.
    fr(MR, BR, 0.03);   // right
    fr(ML, BL, 0.03);   // left
    fr(NL, NR, 0.03);   // cross-spar capping the very nose tip

    // Side windows: glass filling the now-framed forward triangles
    // (panel joint MR/ML → nose tip NR/NL → body flank BR/BL).
    this.group.add(this._pane([MR, NR, BR], glass));
    this.group.add(this._pane([ML, NL, BL], glass));
    // Back-side windows: upper triangle behind the MR–BR spar
    // (top corner TR/TL → panel joint MR/ML → body flank BR/BL).
    this.group.add(this._pane([TR, MR, BR], glass));
    this.group.add(this._pane([TL, ML, BL], glass));

    // ── Enclose the lower cockpit with solid camo panels ───────────────────────
    // The nose was an open top-shell (glass only). Build the bottom half: solid
    // panels run from the fuselage front rim down to the nose tip, closing the
    // lower flanks (below the side windows) and the belly. DoubleSide so winding
    // can't hide a panel.
    const shellMat = makeCamoMaterial({ roughness: 0.5, metalness: 0.7 });
    shellMat.side = THREE.DoubleSide;
    // Lower body corners on the fuselage front rim (8-gon facets w/ a flat bottom).
    const CR = rimPt(-22.5),  CL = rimPt(202.5);     // lower-flank corners
    const ER = rimPt(292.5),  EL = rimPt(247.5);     // flat-bottom edge corners (mirror TR/TL)
    // Lower flanks: two facets per side, below the side windows, fanning to the tip.
    this.group.add(this._pane([BR, CR, NR], shellMat, true));
    this.group.add(this._pane([BL, CL, NL], shellMat, true));
    this.group.add(this._pane([CR, ER, NR], shellMat, true));
    this.group.add(this._pane([CL, EL, NL], shellMat, true));
    // Flat belly: rectangle matching the body's flat-bottom facet (rim edge → nose tip).
    this.group.add(this._pane([EL, ER, NR, NL], shellMat, true));


    // ── Slender swept-back V-tail: thin canted fins on the level tail top ──────
    // Planform (chord x / height y): vertical trailing edge, leading edge raked
    // back = the sweep. No forward/back lean — the sweep is in the shape.
    const finZ = tailEndZ - 0.40;
    const FIN_H = 0.60, ROOT_C = 0.34, TIP_C = 0.14, SWEEP = 0.40, FIN_T = 0.05;
    const finShape = new THREE.Shape();
    finShape.moveTo(0, 0);                     // root leading edge
    finShape.lineTo(ROOT_C, 0);                // root trailing edge
    finShape.lineTo(SWEEP + TIP_C, FIN_H);     // tip trailing edge
    finShape.lineTo(SWEEP, FIN_H);             // tip leading edge (swept back)
    finShape.closePath();
    const finGeo = new THREE.ExtrudeGeometry(finShape, { depth: FIN_T, bevelEnabled: false });
    finGeo.translate(0, 0, -FIN_T / 2);        // centre thickness on X-after-rotate
    finGeo.rotateY(-Math.PI / 2);              // chord → +Z (trailing aft), thickness → X
    // Sharpen the leading edge: taper thickness (X) from 0 at the swept LE to full
    // at the trailing edge, giving a wedge airfoil with a knife-edge front.
    {
      const pos = finGeo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const f   = THREE.MathUtils.clamp(pos.getY(i) / FIN_H, 0, 1);  // height fraction
        const zLE = SWEEP * f;                                          // swept leading edge
        const zTE = ROOT_C + (SWEEP + TIP_C - ROOT_C) * f;             // trailing edge
        const t   = zTE > zLE ? THREE.MathUtils.clamp((pos.getZ(i) - zLE) / (zTE - zLE), 0, 1) : 0;
        pos.setX(i, pos.getX(i) * t);
      }
      pos.needsUpdate = true;
      finGeo.computeVertexNormals();
    }
    applyCamoUVs(finGeo);

    for (const sx of [-1, 1]) {
      const finGroup = new THREE.Group();
      finGroup.position.set(sx * 0.10, 0.30, finZ);
      finGroup.rotation.z = -sx * 0.70;        // cant well outward into a wide, low V (more horizontal, less tall)
      this.group.add(finGroup);

      finGroup.add(new THREE.Mesh(finGeo, bodyMat));

      // Slim accent cap along the swept tip chord
      const tip = new THREE.Mesh(new THREE.BoxGeometry(FIN_T + 0.006, 0.04, TIP_C), accentMat);
      tip.position.set(0, FIN_H, SWEEP + TIP_C / 2);
      finGroup.add(tip);
    }

    // Landing skids: close to the belly, wide stance, struts splayed outward.
    // Anchored to the real (bulged) belly at centre, not the linear-taper estimate.
    const BELLY_Y = -FUSE_MID * FLAT, BELLY_W = FUSE_MID * WIDE;
    this._skids(darkMat, {
      topY:          BELLY_Y + 0.22,   // strut tops reach well up into the belly so they meet it even where the spindle narrows toward the strut Z
      railY:         BELLY_Y - 0.05,   // rails sit just below the body (close)
      topHalfWidth:  BELLY_W * 0.6,    // inboard attach under the belly
      railHalfWidth: BELLY_W * 1.0,    // wider rails — struts splay out to reach them
      length: 1.55,
    });

    // ── Stub weapon wings: small swept fins low on the flanks, missiles underslung ──
    // Set at mid-body, below the shoulder fans and between the skid struts, so they
    // clear the rotors. Inner edge anchored to the real hull side at the wing's Z.
    const WING_Z = -0.05, WING_Y = -0.12;
    const wingFrac = (WING_Z + HALF_LEN) / HALF_LEN;                 // forward half: z -0.85..0 → 0..1
    const wingHalf = this._hullHalfAt(RF, FUSE_MID, wingFrac, FLAT, WIDE).halfW;
    for (const sx of [-1, 1]) {
      this._missileWing(bodyMat, darkMat, accentMat, sx, {
        y: WING_Y, z: WING_Z, span: 0.78, chord: 0.3, thickness: 0.04, tipScale: 0.4,
        sweep: 0, droop: 0.18, hullHalfW: wingHalf, missiles: 6,
      });
    }

    const craftGlow = new THREE.PointLight(accentColor, 0.6, 3.0);
    this.group.add(craftGlow);

    // ── Arms + BIG shrouded fans on the shoulders (heavy nacelle, pulled in close) ──
    const NAC_X = 1.25, ARM_Y = 0.2, ARM_Z = -0.05, ARM_THICK = 0.16;   // pulled inboard to narrow the vehicle
    const FAN_Y = ARM_Y + 0.12;   // fans sit a bit higher than the bay so the canted arm meets the hull cleanly
    const NAC_OPTS = { ductR: 0.62, depth: 0.32, rimThick: 0.07, rimYScale: 2.2, mesh: true, finlets: false, blades: 4 };

    this.leftArmGroup = new THREE.Group();
    this.leftArmGroup.position.set(-NAC_X, FAN_Y, ARM_Z);
    this.group.add(this.leftArmGroup);

    this.rightArmGroup = new THREE.Group();
    this.rightArmGroup.position.set(NAC_X, FAN_Y, ARM_Z);
    this.group.add(this.rightArmGroup);

    this.leftNacelleGroup  = new THREE.Group();
    this.rightNacelleGroup = new THREE.Group();
    this.leftRotorGroup    = new THREE.Group();
    this.rightRotorGroup   = new THREE.Group();

    const armHull = this._hullHalfAt(RF, RR, (ARM_Z + FUSE_HALF) / FUSE_LEN, FLAT, WIDE);
    this._buildArm(this.leftArmGroup,  this.leftNacelleGroup,  this.leftRotorGroup,  -1, { nacelleX: NAC_X, hullHalfW: armHull.halfW, armThick: ARM_THICK, nacelleOpts: NAC_OPTS, stopAtRim: true, armInNacelle: true });
    this._buildArm(this.rightArmGroup, this.rightNacelleGroup, this.rightRotorGroup,  1, { nacelleX: NAC_X, hullHalfW: armHull.halfW, armThick: ARM_THICK, nacelleOpts: NAC_OPTS, stopAtRim: true, armInNacelle: true });

    // Cant the ducted fans upward (outboard rim raised) so the "wings" sit in a
    // dihedral. Applied to the nacelle groups so the arms still bridge level to the
    // hull; update() only writes rotation.x, so this static z-cant persists.
    const FAN_TILT = 0.28;
    // Order ZYX so the per-frame thrust tilt (rotation.x, set in update()) is the
    // INNERMOST rotation — about the nacelle's local X axis, which is also the arm's
    // long axis. The arm's hull end sits on that axis, so tilting can't move it. The
    // static cant (rotation.z) is then applied outside it. With the default XYZ order
    // the cant ran first and the x-tilt swung about the parent X, dragging the arm's
    // hull connection through an arc.
    this.leftNacelleGroup.rotation.order  = 'ZYX';
    this.rightNacelleGroup.rotation.order = 'ZYX';
    this.leftNacelleGroup.rotation.z  = -FAN_TILT;   // outboard (-X) edge up
    this.rightNacelleGroup.rotation.z =  FAN_TILT;   // outboard (+X) edge up

    // ── Transmission housings at the wing/fuselage joint ───────────────────────
    // The arm pivots about its hull end, so a fixed black gearbox here (a main
    // housing + a small raised cap) makes the moving "wing" look driven from inside
    // the body. Mounted on this.group (static) so the arm visibly works against it.
    for (const sx of [-1, 1]) {
      const hx = sx * transBoxX * 0.70;   // pulled inboard toward the centreline
      // Single gearbox housing cylinder. Built along Z, then spun 90° about Y so its
      // axis runs along X (lateral, pointing out toward the fans).
      const housingGeo = new THREE.CylinderGeometry(0.1664, 0.1664, 0.32, 16);
      housingGeo.rotateX(Math.PI / 2);   // axis → Z (fore-aft)
      housingGeo.rotateY(Math.PI / 2);   // spin 90° on Y → axis now along X (lateral)
      const housing = new THREE.Mesh(housingGeo, darkMat);
      housing.position.set(hx, 0.11, ARM_Z);
      this.group.add(housing);
    }

    // ── Central engine bay: diamond fairing between the nacelles ───────────────
    // A cube turned 45° about Y (diamond from above), ~half the earlier size and
    // spun so the LONG axis runs fore-aft — sharp points into the airflow, the
    // aerodynamic orientation. Scale baked in BEFORE applyCamoUVs so camo tiles.
    const BAY_LEN = 0.756, BAY_WIDTH = 0.5, BAY_H = ARM_THICK * 1.5;   // fore-aft / across / height(1.5×arm)
    const BAY_Y = ARM_Y - 0.025;             // dropped a smidgen below the arm level
    const bayGeo = new THREE.BoxGeometry(1, 1, 1);
    bayGeo.rotateY(Math.PI / 4);             // 45° → diamond plan view
    bayGeo.scale(BAY_WIDTH / Math.SQRT1_2, BAY_H, BAY_LEN / Math.SQRT1_2); // X tips = WIDTH, Z tips = LEN
    applyCamoUVs(bayGeo);
    const bay = new THREE.Mesh(bayGeo, bodyMat);
    bay.position.set(0, BAY_Y, ARM_Z);
    this.group.add(bay);

    // ── Twin squished intake/exhaust ducts through the diamond bay ─────────────
    // Black oval cylinders running fore-aft (front = intake, rear = exhaust),
    // squished wide-and-flat, set side by side and poking out both ends.
    const intakeMat = new THREE.MeshStandardMaterial({ color: 0x05060a, roughness: 0.5, metalness: 0.6 });
    const INT_R = 0.14, INT_WIDE = 1.4, INT_FLAT = 0.55, INT_LEN = 0.7, INT_X = 0.2;
    const INT_Z = ARM_Z - 0.20;              // shifted forward so only the front pokes out
    const intakeGeo = new THREE.CylinderGeometry(INT_R, INT_R, INT_LEN, 20);
    intakeGeo.rotateX(Math.PI / 2);          // axis → Z (fore-aft)
    intakeGeo.scale(INT_WIDE, INT_FLAT, 1);  // squish: wide in X, short in Y
    for (const sx of [-1, 1]) {
      const intake = new THREE.Mesh(intakeGeo, intakeMat);
      intake.position.set(sx * INT_X, ARM_Y + 0.03, INT_Z);
      this.group.add(intake);
    }

    // Black exhaust vents: flat dark strips on the rear fuselage top, behind the
    // engines toward the tail. Two rows fore-aft (the second slid rearward), and each
    // row is split into a LEFT and RIGHT strip with the centre third of the old
    // 0.30-wide vent removed — leaving two 0.10-wide strips on either side of the
    // centreline. Y is derived from the aft hull radius at each Z so each sits just
    // proud of the (tapering) top surface and stays visible.
    const EXH_W = 0.30 / 3;          // each strip = an outer third of the old vent
    const EXH_X = EXH_W;             // centre-third-wide gap between the two strips
    for (const [EXH_Z, drop] of [[0.55, 0.05], [0.72, 0.05], [0.89, 0.04]]) {
      const exhTopR = FUSE_MID + (RR - FUSE_MID) * (EXH_Z / FUSE_HALF);  // aft-half radius at EXH_Z
      for (const sx of [-1, 1]) {
        const exhaust = new THREE.Mesh(new THREE.BoxGeometry(EXH_W, 0.10, 0.48), intakeMat);
        exhaust.position.set(sx * EXH_X, exhTopR * FLAT - 0.04 - drop, EXH_Z);  // dropped a touch so the front edge sinks in; rear one dropped a bit more
        exhaust.rotation.x = -0.15;  // slight tip: front edge into the body, rear lifts a touch
        this.group.add(exhaust);
      }
    }

    // ── Recon sensor fit ─────────────────────────────────────────────────────────
    // Positions are anchored to real body dims / the nose-tip vertex (NC) so they
    // sit on the surface, not at guessed coords.
    // Helper: top-surface Y of the aft fuselage half at a given Z.
    const aftTopY = (z) => (FUSE_MID + (RR - FUSE_MID) * (z / FUSE_HALF)) * FLAT;

    if (detailPkg === 'recon') {
      // Black sensor dome centred on the diamond engine bay, between the fans.
      const radome = new THREE.Mesh(
        new THREE.SphereGeometry(0.17, 18, 12, 0, Math.PI * 2, 0, Math.PI / 2), darkMat);
      radome.scale.set(1.4, 0.7, 1.4);
      radome.position.set(0, BAY_Y + BAY_H / 2 - 0.02, ARM_Z);   // sits on the bay's top face
      this.group.add(radome);

      // Twin whip antennas raked aft off the rear spine. Geometry is shifted so the
      // BASE sits at the mesh origin — then the lean pivots about the mount point on
      // the spine instead of the rod's centre, so it bends back without floating.
      for (const sx of [-1, 1]) {
        const whipZ = 0.46;
        const whipGeo = new THREE.CylinderGeometry(0.007, 0.013, 0.40, 6);
        whipGeo.translate(0, 0.20, 0);   // pivot at the base, not the centre
        const whip = new THREE.Mesh(whipGeo, darkMat);
        whip.position.set(sx * 0.08, aftTopY(whipZ) - 0.02, whipZ);   // base embedded on the spine
        whip.rotation.x = 1.0;   // sweep back from the base
        this.group.add(whip);
      }

      // Chin sensor ball (FLIR) under the nose tip, accent lens facing forward.
      const flir = new THREE.Mesh(new THREE.SphereGeometry(0.11, 16, 12), darkMat);
      flir.position.set(0, NC.y - 0.03, NC.z + 0.17);
      this.group.add(flir);
      const flirEye = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.04, 14), accentMat);
      flirEye.rotation.x = Math.PI / 2;
      flirEye.position.set(0, NC.y - 0.06, NC.z + 0.07);
      this.group.add(flirEye);
    }

  }

  // The arm bridges from the hull side to the nacelle center. nacelleX is the
  // arm group's world X; hullHalfW is the body half-width at the arm's Z. The arm
  // length/position are derived from both so it always meets the hull and duct.
  _buildArm(armGroup, nacelleGroup, rotorGroup, side, { nacelleX, hullHalfW, armThick = 0.11, nacelleOpts = {}, stopAtRim = false, armInNacelle = false }) {
    const bodyMat = makeCamoMaterial({ roughness: 0.5, metalness: 0.7 });

    const innerX = hullHalfW - 0.04;          // embed slightly into the hull side
    const ductR  = nacelleOpts.ductR ?? 0.46;
    // When stopAtRim, the arm ends at the duct's inboard rim instead of the centre,
    // so the pylon never spears through the fan throat.
    const reach  = (nacelleX - innerX) - (stopAtRim ? ductR : 0);
    const localC = side * (innerX - nacelleX - (stopAtRim ? ductR : 0)) / 2;
    const armMesh = new THREE.Mesh(applyCamoUVs(new THREE.BoxGeometry(reach, armThick, 0.26)), bodyMat);
    armMesh.position.set(localC, 0, 0);

    nacelleGroup.position.set(0, 0, 0);
    armGroup.add(nacelleGroup);
    // When armInNacelle, parent the arm to the nacelle so it inherits the fan's cant
    // + per-frame tilt and reads as one rigid unit; otherwise keep it on the arm
    // group (static), which is what V2/V3 expect. The arm lies on the local X axis,
    // so the fore/aft x-tilt leaves its hull end fixed — the connection stays glued.
    (armInNacelle ? nacelleGroup : armGroup).add(armMesh);

    this._buildNacelle(nacelleGroup, rotorGroup, nacelleOpts);
  }

  // Ducted fan. opts.heavy builds the thick Samson-style shroud (deep ring wall,
  // safety mesh, rim winglet-fins, more blades); defaults reproduce the original
  // light nacelle so V2/V3 are unchanged.
  _buildNacelle(nacelleGroup, rotorGroup, opts = {}) {
    const {
      ductR = 0.46, depth = 0.14, rimThick = 0.07, rimYScale = 1,
      mesh = false, finlets = false, blades = 3,
    } = opts;
    const accentColor = getTeamColor();
    const bodyMat   = makeCamoMaterial({ roughness: 0.5, metalness: 0.7 });
    const darkMat   = new THREE.MeshStandardMaterial({ color: 0x141e0c, roughness: 0.55, metalness: 0.6 });
    const accentMat = new THREE.MeshStandardMaterial({ color: accentColor, roughness: 0.25, metalness: 0.85, emissive: new THREE.Color(accentColor), emissiveIntensity: 0.35 });

    const ringGeo = new THREE.TorusGeometry(ductR, rimThick, 12, 40);
    ringGeo.rotateX(Math.PI / 2);        // ring plane = XZ, shroud axis along Y
    ringGeo.scale(1, rimYScale, 1);      // stretch the tube only in global Y — taller shroud, same radial thickness
    const ductRing = new THREE.Mesh(applyCamoUVs(ringGeo), bodyMat);
    nacelleGroup.add(ductRing);

    // Rim winglet-fins (the little blades poking off the duct, fore/aft/outboard)
    if (finlets) {
      for (const a of [0, Math.PI, Math.PI / 2, -Math.PI / 2]) {
        const fin = new THREE.Mesh(applyCamoUVs(new THREE.BoxGeometry(0.05, 0.06, 0.22)), bodyMat);
        fin.position.set(Math.sin(a) * (ductR + 0.12), 0, Math.cos(a) * (ductR + 0.12));
        fin.rotation.y = a;
        nacelleGroup.add(fin);
      }
    }

    // Radial struts holding the hub
    const struts  = mesh ? 6 : 3;
    const strutMidR = (ductR + 0.06) / 2;
    const strutLen  = ductR - 0.06;
    for (let i = 0; i < struts; i++) {
      const angle = (i * 2 * Math.PI) / struts;
      const strut = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.022, strutLen), darkMat);
      strut.rotation.y = angle;
      strut.position.set(Math.sin(angle) * strutMidR, 0, Math.cos(angle) * strutMidR);
      nacelleGroup.add(strut);
    }

    nacelleGroup.add(rotorGroup);
    rotorGroup.userData.noShadow = true;   // keep the (static) fan disc out of the ground shadow — leave a clean duct ring

    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.08, 8), darkMat);
    rotorGroup.add(hub);

    const bladeMat = new THREE.MeshStandardMaterial({ color: 0x1e2e16, roughness: 0.4, metalness: 0.8 });
    const bladeLen = ductR * 0.74;
    for (let i = 0; i < blades; i++) {
      const bladeGroup = new THREE.Group();
      bladeGroup.rotation.y = (i * 2 * Math.PI) / blades;
      rotorGroup.add(bladeGroup);

      const bladeMesh = new THREE.Mesh(new THREE.BoxGeometry(bladeLen, 0.022, 0.072), bladeMat);
      bladeMesh.position.x = bladeLen / 2 + 0.06;
      bladeGroup.add(bladeMesh);
    }
  }

  update(delta, forwardInput = 0, turnInput = 0) {
    this.hoverTime += delta;

    // Gentle hover bob and roll
    this.group.position.y = Math.sin(this.hoverTime * 1.6) * 0.05;
    this.group.rotation.z = Math.sin(this.hoverTime * 1.1) * 0.012;

    // Nacelle tilt driven by input: negative = forward thrust. Both the fore/aft tilt
    // and the differential turn tilt ease toward their target (same smoothing) so they
    // ramp in gradually rather than snapping.
    const targetTilt = forwardInput * -0.65;
    this.tiltAngle  += (targetTilt - this.tiltAngle) * Math.min(1, delta * 4.5);
    this.turnTilt   += (turnInput  - this.turnTilt)  * Math.min(1, delta * 4.5);

    this.leftRotorGroup.rotation.y  += delta * Math.PI * 6;
    this.rightRotorGroup.rotation.y -= delta * Math.PI * 6;
    const TURN_TILT = 0.35;   // differential fan tilt per unit turn input (bigger = more pronounced banking)
    this.leftNacelleGroup.rotation.x  = this.tiltAngle + this.turnTilt * TURN_TILT;
    this.rightNacelleGroup.rotation.x = this.tiltAngle - this.turnTilt * TURN_TILT;

    // Launch recoil: a soft nose-up rock as a missile leaves the rail; flashes fade.
    this._recoil = decayRecoil(this._recoil, delta, 0.22);
    this.group.position.y += this._recoil * 0.025;
    this.group.rotation.x = -this._recoil * 0.04;
    for (const m of this._muzzles) updateMuzzle(m, delta);
  }

  // Fire one wing's launcher (alternating sides) — launch flash + a soft rock.
  // Returns the fired muzzle (for projectile spawning).
  fire() {
    const m = this._muzzles[this._muzzleIx % this._muzzles.length];
    this._muzzleIx++;
    flashMuzzle(m);
    this._recoil = 1;
    return m;
  }
}
