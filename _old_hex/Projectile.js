import * as THREE from 'three';

const SPEED     = 24;
const MAX_RANGE = 24;

export class Projectile {
    constructor(scene, position, direction, fromPlayer) {
        this.scene      = scene;
        this.direction  = direction.clone().normalize();
        this.fromPlayer = fromPlayer;
        this.traveled   = 0;
        this.dead       = false;

        const color = fromPlayer ? 0x00eeff : 0xff5500;

        // Elongated sphere = plasma bolt
        const geo = new THREE.SphereGeometry(0.09, 6, 4);
        geo.scale(1, 1, 3.5);
        this.mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color }));
        this.mesh.position.copy(position);
        this.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), this.direction);
        scene.add(this.mesh);

        this.light = new THREE.PointLight(color, 2.0, 5);
        this.light.position.copy(position);
        scene.add(this.light);
    }

    update(delta, hexGrid) {
        if (this.dead) return;
        const step = this.direction.clone().multiplyScalar(SPEED * delta);
        this.mesh.position.add(step);
        this.light.position.copy(this.mesh.position);
        this.traveled += step.length();

        const hex = hexGrid.worldToHex(this.mesh.position.x, this.mesh.position.z);
        if (hexGrid.blocksProjectile(hex.q, hex.r) || this.traveled >= MAX_RANGE) {
            this.destroy();
        }
    }

    destroy() {
        if (this.dead) return;
        this.dead = true;
        this.scene.remove(this.mesh);
        this.scene.remove(this.light);
    }

    getPosition() { return this.mesh.position; }
}
