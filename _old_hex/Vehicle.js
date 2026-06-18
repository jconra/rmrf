import * as THREE from 'three';
import { VehicleType, VEHICLE_DEFS } from './VehicleDefs.js';

export class Vehicle {
    constructor(scene, startPos = new THREE.Vector3(0, 0, 0), vehicleType = VehicleType.LURCHER) {
        const def         = VEHICLE_DEFS[vehicleType];
        this.scene        = scene;
        this.speed        = def.speed;
        this.turnRate     = def.turnRate;
        this.group        = new THREE.Group();
        this.targetFacing = 0;
        this.hoverTime    = 0;
        this._buildMesh();
        this.group.position.set(startPos.x, 0.42, startPos.z);
        scene.add(this.group);
    }

    _buildMesh() {
        const bodyMat = new THREE.MeshStandardMaterial({
            color: 0x2a4a6a,
            emissive: 0x0a1a2a,
            roughness: 0.2,
            metalness: 0.95,
        });

        const accentMat = new THREE.MeshStandardMaterial({
            color: 0x00aaff,
            emissive: 0x0055cc,
            emissiveIntensity: 1.2,
            roughness: 0.1,
            metalness: 0.8,
        });

        const darkMat = new THREE.MeshStandardMaterial({
            color: 0x111e2a,
            emissive: 0x050a10,
            roughness: 0.4,
            metalness: 0.9,
        });

        // Main hull
        const hull = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.2, 1.6), bodyMat);
        hull.castShadow = true;
        this.group.add(hull);


        // Turret group — rotates independently of the hull for mouse aiming
        this.turretGroup = new THREE.Group();
        this.group.add(this.turretGroup);

        const turretRing = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.12, 10), darkMat);
        turretRing.position.set(0, 0.16, -0.1);
        this.turretGroup.add(turretRing);

        const turretDome = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.30, 0.14, 10), bodyMat);
        turretDome.position.set(0, 0.27, -0.1);
        this.turretGroup.add(turretDome);

        const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.04, 0.85, 6), darkMat);
        barrel.rotation.x = Math.PI / 2;
        barrel.position.set(0, 0.26, -0.65);
        this.turretGroup.add(barrel);

        const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.055, 0.08, 6), accentMat);
        tip.rotation.x = Math.PI / 2;
        tip.position.set(0, 0.26, -1.06);
        this.turretGroup.add(tip);

        // Side nacelles + thrusters
        [-1, 1].forEach(side => {
            const skirt = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.14, 1.3), darkMat);
            skirt.position.set(side * 0.64, -0.06, 0.05);
            skirt.castShadow = true;
            this.group.add(skirt);

            const nacelle = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.11, 0.55, 8), bodyMat);
            nacelle.rotation.z = Math.PI / 2;
            nacelle.position.set(side * 0.70, -0.05, 0.52);
            nacelle.castShadow = true;
            this.group.add(nacelle);

            const thruster = new THREE.Mesh(new THREE.TorusGeometry(0.10, 0.025, 6, 12), accentMat);
            thruster.rotation.y = Math.PI / 2;
            thruster.position.set(side * 0.70, -0.05, 0.82);
            this.group.add(thruster);

            const thrusterLight = new THREE.PointLight(0x0088ff, 0.7, 1.8);
            thrusterLight.position.set(side * 0.70, -0.12, 0.90);
            this.group.add(thrusterLight);
        });

        // Forward running lights
        [-0.35, 0.35].forEach(side => {
            const runLight = new THREE.Mesh(new THREE.SphereGeometry(0.055, 6, 6), accentMat);
            runLight.position.set(side, 0.04, -1.0);
            this.group.add(runLight);
        });

        // Sensor antenna
        const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.28, 4), darkMat);
        antenna.position.set(0.22, 0.27, 0.38);
        this.group.add(antenna);

        const antennaTip = new THREE.Mesh(new THREE.SphereGeometry(0.045, 6, 6), accentMat);
        antennaTip.position.set(0.22, 0.42, 0.38);
        this.group.add(antennaTip);

        // Underside hover glow
        this.hoverGlowLight = new THREE.PointLight(0x0044cc, 0.5, 2.2);
        this.hoverGlowLight.position.set(0, -0.25, 0);
        this.group.add(this.hoverGlowLight);
    }

    update(moveVec, delta, hexGrid) {
        this.hoverTime += delta;

        if (moveVec.length() > 0) {
            // atan2(-x, -z) makes the nose (local -Z) align with the movement direction
            this.targetFacing = Math.atan2(-moveVec.x, -moveVec.z);

            const pos  = this.group.position;
            const newX = pos.x + moveVec.x * this.speed * delta;
            const newZ = pos.z + moveVec.z * this.speed * delta;

            // Multi-point collision
            const hw = 0.5, hl = 0.7;
            const passable = [
                [newX,    newZ   ],
                [newX+hw, newZ   ],
                [newX-hw, newZ   ],
                [newX,    newZ+hl],
                [newX,    newZ-hl],
            ].every(([cx, cz]) => {
                const hex = hexGrid.worldToHex(cx, cz);
                return hexGrid.isPassable(hex.q, hex.r);
            });

            if (passable) {
                pos.x = newX;
                pos.z = newZ;
            }
        }

        // Smooth rotation
        let diff = this.targetFacing - this.group.rotation.y;
        while (diff >  Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        this.group.rotation.y += diff * Math.min(delta * this.turnRate, 1);

        // Hover bob and gentle roll
        this.group.position.y = 0.42 + Math.sin(this.hoverTime * 2.3) * 0.03;
        this.group.rotation.z = Math.sin(this.hoverTime * 1.7) * 0.018;
        this.hoverGlowLight.intensity = 0.5 + Math.sin(this.hoverTime * 3.1) * 0.15;
    }

    // Aim the turret at a world-space angle (independent of hull rotation)
    setTurretAngle(worldAngle) {
        this.turretGroup.rotation.y = worldAngle - this.group.rotation.y;
    }

    // World-space position of the barrel tip (uses turret orientation)
    getBarrelTip() {
        const local = new THREE.Vector3(0, 0.26, -1.1);
        local.applyQuaternion(this.turretGroup.quaternion);
        local.applyQuaternion(this.group.quaternion);
        local.add(this.group.position);
        return local;
    }

    // Unit vector pointing along the turret barrel
    getForward() {
        const fwd = new THREE.Vector3(0, 0, -1);
        fwd.applyQuaternion(this.turretGroup.quaternion);
        fwd.applyQuaternion(this.group.quaternion);
        fwd.y = 0;
        return fwd.normalize();
    }

    getPosition() {
        return this.group.position;
    }
}
