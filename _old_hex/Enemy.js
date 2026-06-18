import * as THREE from 'three';
import { VehicleType, VEHICLE_DEFS } from './VehicleDefs.js';

const CHASE_RANGE     = 26;
const ATTACK_RANGE    = 14;
const SHOOT_INTERVAL  = 1.6;
const PATROL_INTERVAL = 2.5;

export class Enemy {
    constructor(scene, startPos, hexGrid, vehicleType = VehicleType.LURCHER) {
        const def        = VEHICLE_DEFS[vehicleType];
        this.scene       = scene;
        this.hexGrid     = hexGrid;
        this.speed       = def.speed * 1.15;   // AI gets a slight edge
        this.health      = def.health;
        this.maxHealth   = def.health;
        this.dead        = false;

        this.group        = new THREE.Group();
        this.targetFacing = Math.random() * Math.PI * 2;
        this.hoverTime    = Math.random() * Math.PI * 2;
        this.shootTimer   = Math.random() * SHOOT_INTERVAL;
        this.patrolTimer  = 0;
        this.patrolDir    = new THREE.Vector3(Math.random()-0.5, 0, Math.random()-0.5).normalize();
        this.state        = 'patrol';
        this._hitFlash    = 0;

        this._buildMesh();
        this.group.position.set(startPos.x, 0.42, startPos.z);
        scene.add(this.group);
    }

    _buildMesh() {
        const bodyMat = new THREE.MeshStandardMaterial({
            color: 0x5a2018, emissive: 0x200808, roughness: 0.22, metalness: 0.93,
        });
        const accentMat = new THREE.MeshStandardMaterial({
            color: 0xff5500, emissive: 0xcc2200, emissiveIntensity: 1.3,
            roughness: 0.12, metalness: 0.78,
        });
        const darkMat = new THREE.MeshStandardMaterial({
            color: 0x1e0c0c, emissive: 0x060204, roughness: 0.42, metalness: 0.88,
        });

        const hull = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.2, 1.6), bodyMat);
        hull.castShadow = true;
        this.group.add(hull);


        const turretRing = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.12, 10), darkMat);
        turretRing.position.set(0, 0.16, -0.1);
        this.group.add(turretRing);

        const turretDome = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.30, 0.14, 10), bodyMat);
        turretDome.position.set(0, 0.27, -0.1);
        this.group.add(turretDome);

        const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.04, 0.85, 6), darkMat);
        barrel.rotation.x = Math.PI / 2;
        barrel.position.set(0, 0.26, -0.65);
        this.group.add(barrel);

        const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.055, 0.08, 6), accentMat);
        tip.rotation.x = Math.PI / 2;
        tip.position.set(0, 0.26, -1.06);
        this.group.add(tip);

        [-1, 1].forEach(side => {
            const skirt = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.14, 1.3), darkMat);
            skirt.position.set(side * 0.64, -0.06, 0.05);
            this.group.add(skirt);

            const nacelle = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.11, 0.55, 8), bodyMat);
            nacelle.rotation.z = Math.PI / 2;
            nacelle.position.set(side * 0.70, -0.05, 0.52);
            this.group.add(nacelle);

            const thruster = new THREE.Mesh(new THREE.TorusGeometry(0.10, 0.025, 6, 12), accentMat);
            thruster.rotation.y = Math.PI / 2;
            thruster.position.set(side * 0.70, -0.05, 0.82);
            this.group.add(thruster);

            const tl = new THREE.PointLight(0xff4400, 0.7, 1.8);
            tl.position.set(side * 0.70, -0.12, 0.90);
            this.group.add(tl);
        });

        this.hoverLight = new THREE.PointLight(0xcc1100, 0.5, 2.2);
        this.hoverLight.position.set(0, -0.25, 0);
        this.group.add(this.hoverLight);
    }

    // Returns { pos, dir } when firing this frame, otherwise null.
    update(delta, playerPos) {
        if (this.dead) return null;

        this.hoverTime  += delta;
        this.shootTimer -= delta;

        const pos      = this.group.position;
        const toPlayer = new THREE.Vector3().subVectors(playerPos, pos).setY(0);
        const dist     = toPlayer.length();

        // State transitions
        if (dist < ATTACK_RANGE)      this.state = 'attack';
        else if (dist < CHASE_RANGE)  this.state = 'chase';
        else                          this.state = 'patrol';

        let moveVec = new THREE.Vector3();
        let shot    = null;

        if (this.state === 'patrol') {
            this.patrolTimer -= delta;
            if (this.patrolTimer <= 0) {
                this.patrolTimer = PATROL_INTERVAL + Math.random() * 2;
                this.patrolDir.set(Math.random()-0.5, 0, Math.random()-0.5).normalize();
            }
            moveVec.copy(this.patrolDir);

        } else if (this.state === 'chase') {
            moveVec.copy(toPlayer).normalize();

        } else { // attack — circle player and shoot
            const dir = toPlayer.clone().normalize();
            this.targetFacing = Math.atan2(-dir.x, -dir.z);

            // Strafe perpendicular to player, oscillating direction
            const strafe = new THREE.Vector3(-dir.z, 0, dir.x);
            const strafeSign = Math.sin(this.hoverTime * 0.5) > 0 ? 1 : -1;
            moveVec.copy(dir).multiplyScalar(0.2).addScaledVector(strafe, strafeSign * 0.8).normalize();

            if (this.shootTimer <= 0) {
                this.shootTimer = SHOOT_INTERVAL;
                const shotPos = this._barrelTipWorld();
                shot = { pos: shotPos, dir: dir.clone() };
            }
        }

        if (moveVec.length() > 0) {
            moveVec.normalize();
            if (this.state !== 'attack') {
                this.targetFacing = Math.atan2(-moveVec.x, -moveVec.z);
            }

            const nx = pos.x + moveVec.x * this.speed * delta;
            const nz = pos.z + moveVec.z * this.speed * delta;
            const hex = this.hexGrid.worldToHex(nx, nz);
            if (this.hexGrid.isPassable(hex.q, hex.r)) {
                pos.x = nx;
                pos.z = nz;
            } else {
                // Try rotating to slide around the obstacle before giving up
                const rotAxis = new THREE.Vector3(0, 1, 0);
                const tryAngles = [Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2];
                let slid = false;
                for (const angle of tryAngles) {
                    const rot = moveVec.clone().applyAxisAngle(rotAxis, angle);
                    const tx = pos.x + rot.x * this.speed * delta;
                    const tz = pos.z + rot.z * this.speed * delta;
                    const th = this.hexGrid.worldToHex(tx, tz);
                    if (this.hexGrid.isPassable(th.q, th.r)) {
                        pos.x = tx;
                        pos.z = tz;
                        this.patrolDir.copy(rot);
                        slid = true;
                        break;
                    }
                }
                if (!slid) {
                    this.patrolDir.set(Math.random() - 0.5, 0, Math.random() - 0.5).normalize();
                    this.patrolTimer = 0;
                }
            }
        }

        // Smooth rotation
        let diff = this.targetFacing - this.group.rotation.y;
        while (diff >  Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        this.group.rotation.y += diff * Math.min(delta * 7, 1);

        // Hover bob
        this.group.position.y = 0.42 + Math.sin(this.hoverTime * 2.3) * 0.03;
        this.group.rotation.z = Math.sin(this.hoverTime * 1.7) * 0.018;
        this.hoverLight.intensity = 0.5 + Math.sin(this.hoverTime * 3.1) * 0.15;

        // Hit flash scale pulse
        if (this._hitFlash > 0) {
            this._hitFlash -= delta;
            this.group.scale.setScalar(1 + this._hitFlash * 1.2);
        } else {
            this.group.scale.setScalar(1);
        }

        return shot;
    }

    _barrelTipWorld() {
        const local = new THREE.Vector3(0, 0.26, -1.1);
        local.applyQuaternion(this.group.quaternion);
        local.add(this.group.position);
        return local;
    }

    takeDamage() {
        this.health--;
        this._hitFlash = 0.14;
        if (this.health <= 0) { this.destroy(); return true; }
        return false;
    }

    destroy() {
        this.dead = true;
        this.scene.remove(this.group);
    }

    getPosition() { return this.group.position; }
}
