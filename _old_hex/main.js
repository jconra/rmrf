import * as THREE from 'three';
import { HexGrid }                   from './HexGrid.js';
import { Vehicle }                   from './Vehicle.js';
import { Enemy }                     from './Enemy.js';
import { Projectile }                from './Projectile.js';
import { VehicleType, VEHICLE_DEFS } from './VehicleDefs.js';

// --- Renderer ---
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
document.body.appendChild(renderer.domElement);

// --- Scene ---
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x12202e);
scene.fog = new THREE.FogExp2(0x12202e, 0.022);

// --- Camera ---
const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 300);
let camAngle = 0;
const CAM_DISTANCE = 11;
const CAM_HEIGHT   = 9;

// --- Lighting ---
const sun = new THREE.DirectionalLight(0xffd090, 2.2);
sun.position.set(20, 35, 12);
sun.castShadow = true;
sun.shadow.mapSize.setScalar(1024);
sun.shadow.camera.near   =   0.5;
sun.shadow.camera.far    = 180;
sun.shadow.camera.left   = -55;
sun.shadow.camera.right  =  55;
sun.shadow.camera.top    =  55;
sun.shadow.camera.bottom = -55;
scene.add(sun);

const skyFill = new THREE.DirectionalLight(0x4477bb, 0.7);
skyFill.position.set(-12, 10, -15);
scene.add(skyFill);

scene.add(new THREE.AmbientLight(0x604830, 1.3));

// --- Water plane ---
const waterGeo = new THREE.PlaneGeometry(700, 700);
waterGeo.rotateX(-Math.PI / 2);
const waterMat = new THREE.MeshStandardMaterial({
    color: 0x0e3d5a, emissive: new THREE.Color(0x052030),
    emissiveIntensity: 0.65, roughness: 0.06, metalness: 0.45,
});
const water = new THREE.Mesh(waterGeo, waterMat);
water.position.y = 0.04;
scene.add(water);

const bedGeo = new THREE.PlaneGeometry(700, 700);
bedGeo.rotateX(-Math.PI / 2);
const bed = new THREE.Mesh(bedGeo, new THREE.MeshStandardMaterial({ color: 0x040e18, roughness: 1 }));
bed.position.y = -0.02;
scene.add(bed);

// --- World ---
const PLAYER_TYPE = VehicleType.LURCHER;
const PLAYER_DEF  = VEHICLE_DEFS[PLAYER_TYPE];

const hexGrid  = new HexGrid(scene, 18, 1.1);
const basePos  = hexGrid.getBaseWorldPositions();
const vehicle  = new Vehicle(scene, basePos[0], PLAYER_TYPE);

// --- Enemies ---
function findSpawnPos(minD, maxD) {
    const candidates = [...hexGrid.tiles.values()].filter(t => {
        const d = Math.max(Math.abs(t.q), Math.abs(t.r), Math.abs(-t.q-t.r));
        return hexGrid.isPassable(t.q, t.r) && t.type !== 'base' && d >= minD && d <= maxD;
    });
    if (!candidates.length) return new THREE.Vector3(0, 0, 0);
    const t = candidates[Math.floor(Math.random() * candidates.length)];
    const { x, z } = hexGrid.hexToWorld(t.q, t.r);
    return new THREE.Vector3(x, 0, z);
}

const enemy = new Enemy(scene, findSpawnPos(6, 14), hexGrid, VehicleType.LURCHER);

// --- Projectiles & explosions ---
const projectiles  = [];
const explosions   = [];

function spawnExplosion(position, color) {
    const mat = new THREE.MeshBasicMaterial({ color });
    const particles = Array.from({ length: 12 }, () => {
        const geo = new THREE.SphereGeometry(0.09, 4, 4);
        const m   = new THREE.Mesh(geo, mat);
        m.position.copy(position);
        const vel = new THREE.Vector3(
            (Math.random()-0.5) * 2,
            Math.random() * 1.5,
            (Math.random()-0.5) * 2
        ).multiplyScalar(4 + Math.random() * 4);
        scene.add(m);
        return { mesh: m, vel, life: 0.3 + Math.random() * 0.3 };
    });
    const light = new THREE.PointLight(color, 4, 7);
    light.position.copy(position);
    scene.add(light);
    explosions.push({ particles, light });
}

function updateExplosions(delta) {
    for (let i = explosions.length - 1; i >= 0; i--) {
        const exp = explosions[i];
        exp.light.intensity = Math.max(0, exp.light.intensity - 14 * delta);
        let anyAlive = false;
        exp.particles.forEach(p => {
            if (p.life <= 0) return;
            anyAlive = true;
            p.life -= delta;
            p.mesh.position.addScaledVector(p.vel, delta);
            p.vel.y -= 6 * delta;
            p.mesh.scale.setScalar(Math.max(0, p.life / 0.4));
        });
        if (!anyAlive) {
            exp.particles.forEach(p => scene.remove(p.mesh));
            scene.remove(exp.light);
            explosions.splice(i, 1);
        }
    }
}

// --- Input ---
const keys = {};
document.addEventListener('keydown', e => { keys[e.code] = true;  e.preventDefault(); });
document.addEventListener('keyup',   e => { keys[e.code] = false; });
document.addEventListener('keydown', e => { if (e.code === 'KeyR') location.reload(); });

// --- Mouse aim ---
const mouse       = new THREE.Vector2();
let   mouseDown   = false;
const raycaster   = new THREE.Raycaster();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const aimPoint    = new THREE.Vector3();

renderer.domElement.addEventListener('mousemove', e => {
    mouse.x =  (e.clientX / window.innerWidth)  * 2 - 1;
    mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
});
renderer.domElement.addEventListener('mousedown', e => { if (e.button === 0) mouseDown = true;  });
renderer.domElement.addEventListener('mouseup',   e => { if (e.button === 0) mouseDown = false; });
renderer.domElement.addEventListener('contextmenu', e => e.preventDefault());

// --- Game state ---
let playerHp   = PLAYER_DEF.health;
let gameOver   = false;
let shootTimer = 0;
const SHOOT_CD = PLAYER_DEF.shootInterval;
let fpsEma     = 60;
let perfTick   = 0;

// --- HUD elements ---
const coordsEl   = document.getElementById('coords');
const tileTypeEl = document.getElementById('tile-type');
const healthEl   = document.getElementById('health');
const enemyHpEl  = document.getElementById('enemy-hp');
const perfEl     = document.getElementById('perf');
const overlay    = document.getElementById('overlay');
const overlayMsg = document.getElementById('overlay-msg');
const dmgFlash   = document.getElementById('dmg-flash');

const HP_BLOCKS = ['', '▪', '▪▪', '▪▪▪', '▪▪▪▪', '▪▪▪▪▪'];
function updateHealthHud() {
    healthEl.textContent = `HP: ${HP_BLOCKS[Math.max(0, playerHp)]}`;
}
function updateEnemyHpHud() {
    const hp = enemy.dead ? 0 : enemy.health;
    enemyHpEl.textContent = `ENEMY: ${HP_BLOCKS[Math.max(0, hp)]}`;
}

function triggerDamageFlash() {
    dmgFlash.style.background = 'rgba(255,0,0,0.35)';
    setTimeout(() => { dmgFlash.style.background = 'rgba(255,0,0,0)'; }, 140);
}

function endGame(msg) {
    gameOver = true;
    overlayMsg.textContent = msg;
    overlay.style.display  = 'block';
}

// --- Resize ---
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- Game loop ---
let lastTime = performance.now();

function animate(now) {
    requestAnimationFrame(animate);
    const delta = Math.min((now - lastTime) / 1000, 0.05);
    lastTime = now;
    const time = now / 1000;

    if (keys['KeyQ']) camAngle -= delta * 1.5;
    if (keys['KeyE']) camAngle += delta * 1.5;

    // Camera-relative movement
    const raw = new THREE.Vector3(
        (keys['KeyD'] || keys['ArrowRight'] ? 1 : 0) - (keys['KeyA'] || keys['ArrowLeft']  ? 1 : 0),
        0,
        (keys['KeyS'] || keys['ArrowDown']  ? 1 : 0) - (keys['KeyW'] || keys['ArrowUp']   ? 1 : 0)
    );
    if (raw.length() > 0) {
        raw.normalize();
        const cos = Math.cos(camAngle), sin = Math.sin(camAngle);
        raw.set(raw.x * cos + raw.z * sin, 0, -raw.x * sin + raw.z * cos);
    }

    if (!gameOver) {
        vehicle.update(raw, delta, hexGrid);

        // Player shooting
        shootTimer -= delta;
        if ((keys['Space'] || mouseDown) && shootTimer <= 0) {
            shootTimer = SHOOT_CD;
            projectiles.push(new Projectile(
                scene,
                vehicle.getBarrelTip(),
                vehicle.getForward(),
                true
            ));
        }

        // Update enemy
        const shot = enemy.update(delta, vehicle.getPosition());
        if (shot) {
            projectiles.push(new Projectile(scene, shot.pos, shot.dir, false));
        }

        // Update projectiles
        for (let i = projectiles.length - 1; i >= 0; i--) {
            const p = projectiles[i];
            p.update(delta, hexGrid);
            if (p.dead) { projectiles.splice(i, 1); continue; }

            if (p.fromPlayer) {
                if (!enemy.dead && p.getPosition().distanceTo(enemy.getPosition()) < 0.95) {
                    spawnExplosion(p.getPosition().clone(), 0xff5500);
                    p.destroy();
                    if (enemy.takeDamage()) {
                        endGame('SECTOR CLEAR');
                    } else {
                        updateEnemyHpHud();
                    }
                }
            } else {
                // Check against player
                if (p.getPosition().distanceTo(vehicle.getPosition()) < 0.95) {
                    spawnExplosion(p.getPosition().clone(), 0x00eeff);
                    p.destroy();
                    playerHp--;
                    updateHealthHud();
                    triggerDamageFlash();
                    if (playerHp <= 0) endGame('DESTROYED');
                }
            }
        }

        updateExplosions(delta);
        hexGrid.update(time);
    }

    // Animate water
    waterMat.emissiveIntensity = 0.55 + Math.sin(time * 0.65) * 0.15;

    // Camera follows vehicle
    const vPos = vehicle.getPosition();
    camera.position.set(
        vPos.x + Math.sin(camAngle) * CAM_DISTANCE,
        CAM_HEIGHT,
        vPos.z + Math.cos(camAngle) * CAM_DISTANCE
    );
    camera.lookAt(vPos.x, 0.5, vPos.z);

    // Turret tracks mouse aim on ground plane
    raycaster.setFromCamera(mouse, camera);
    if (raycaster.ray.intersectPlane(groundPlane, aimPoint)) {
        const aimAngle = Math.atan2(-(aimPoint.x - vPos.x), -(aimPoint.z - vPos.z));
        vehicle.setTurretAngle(aimAngle);
    }

    // HUD
    const hex  = hexGrid.worldToHex(vPos.x, vPos.z);
    const tile = hexGrid.getTile(hex.q, hex.r);
    coordsEl.textContent   = `POS: (${hex.q}, ${hex.r})`;
    tileTypeEl.textContent = `TILE: ${tile ? tile.type.toUpperCase() : 'VOID'}`;

    renderer.render(scene, camera);

    perfTick++;
    fpsEma += (1 / delta - fpsEma) * 0.08;
    if (perfTick % 20 === 0) {
        const calls = renderer.info.render.calls;
        const tris  = renderer.info.render.triangles;
        perfEl.innerHTML =
            `FPS: ${Math.round(fpsEma)}<br>` +
            `MS: &nbsp;${(delta * 1000).toFixed(1)}<br>` +
            `DRAW: ${calls}<br>` +
            `TRIS: ${(tris / 1000).toFixed(1)}K`;
    }
}

updateHealthHud();
updateEnemyHpHud();
animate(performance.now());
