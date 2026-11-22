import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { worldGeometry, type WorldBounds } from './world-model.js';
import { encodeCameraCode } from './camera-code.js';
import {
    dollySurface,
    MIN_FOCUS_DISTANCE,
    moveCamera,
    pinchPixels,
    wheelPixels,
} from './surface-navigation.js';

interface Cell {
    x: number;
    y: number;
    z: number;
}
interface Contact {
    version: number;
    bounds: WorldBounds;
    tiedContactCells: number;
    firstContactDefinition: string;
    killZ: number;
    tiles: { x: number; y: number; contactCells: number }[];
    spawns: { worldCm: number[]; seamHopDistance: number }[];
}
interface Frontier {
    version: number;
    maximumDistance: number;
    unrepresentedComponents: number;
    nodes: number[][];
}
interface Witness {
    version: number;
    bounds: WorldBounds;
    cells: Cell[];
    sourceWorldCm: number[];
    playerWorldCm: number[];
    focusWorldCm: number[];
    sourceMesh: { url: string; vertices: number; triangles: number; bounds: WorldBounds };
}
const element = <T extends HTMLElement>(id: string): T => {
    const found = document.getElementById(id);
    if (!found) throw new Error(`Missing diagnostic control ${id}`);
    return found as T;
};
const step = element<HTMLInputElement>('step');
const mode = element<HTMLSelectElement>('mode');
const status = element('status');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14212b);
const camera = new THREE.PerspectiveCamera(48, innerWidth / innerHeight, 0.1, 100000);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
element('viewport').appendChild(renderer.domElement);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.enableZoom = false;
controls.minDistance = MIN_FOCUS_DISTANCE;
controls.maxDistance = 500000;
controls.mouseButtons.MIDDLE = THREE.MOUSE.PAN;
controls.touches.TWO = THREE.TOUCH.DOLLY_PAN;
const canvas = renderer.domElement;
canvas.tabIndex = 0;
canvas.setAttribute(
    'aria-label',
    '3D diagnostic. Wheel or pinch to move; WASD and Q/E to fly; Shift for faster travel.',
);
const keys = new Set<string>();
const touches = new Map<number, { x: number; y: number }>();
let pinchDistance: number | undefined;
let previousFrame: number | undefined;
const navigationSurfaces: THREE.Object3D[] = [];
const navigationRay = new THREE.Raycaster();
navigationRay.params.Points = { threshold: 4 };
navigationRay.params.Line = { threshold: 2 };
function dolly(pixels: number): void {
    const damping = controls.enableDamping;
    controls.enableDamping = false;
    controls.update();
    navigationRay.setFromCamera(new THREE.Vector2(), camera);
    const hit = navigationRay.intersectObjects(
        navigationSurfaces.filter((surface) => surface.visible),
        false,
    )[0];
    // Point/line picks have a tolerance; use their depth without steering toward an off-axis vertex.
    const surface = hit ? navigationRay.ray.at(hit.distance, new THREE.Vector3()) : undefined;
    dollySurface(camera, controls.target, surface, pixels, controls.maxDistance);
    controls.update();
    controls.enableDamping = damping;
}
canvas.addEventListener(
    'wheel',
    (event) => {
        event.preventDefault();
        dolly(wheelPixels(event.deltaY, event.deltaMode, canvas.clientHeight));
    },
    { passive: false },
);
canvas.addEventListener(
    'pointerdown',
    (event) => {
        canvas.focus({ preventScroll: true });
        if (event.pointerType !== 'touch') return;
        touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (touches.size === 2) {
            const [a, b] = [...touches.values()];
            pinchDistance = Math.hypot(a.x - b.x, a.y - b.y);
        }
    },
    true,
);
canvas.addEventListener(
    'pointermove',
    (event) => {
        if (!touches.has(event.pointerId)) return;
        touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (touches.size !== 2) return;
        const [a, b] = [...touches.values()];
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinchDistance && distance > 0) dolly(pinchPixels(pinchDistance, distance));
        pinchDistance = distance || undefined;
    },
    true,
);
const releaseTouch = (event: PointerEvent): void => {
    touches.delete(event.pointerId);
    if (touches.size < 2) pinchDistance = undefined;
};
canvas.addEventListener('pointerup', releaseTouch);
canvas.addEventListener('pointercancel', releaseTouch);
canvas.addEventListener('keydown', (event) => {
    if (
        !['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ShiftLeft', 'ShiftRight'].includes(
            event.code,
        )
    )
        return;
    event.preventDefault();
    keys.add(event.code);
});
canvas.addEventListener('keyup', (event) => {
    keys.delete(event.code);
});
canvas.addEventListener('blur', () => {
    keys.clear();
    touches.clear();
    pinchDistance = undefined;
});
scene.add(new THREE.HemisphereLight(0xd8efff, 0x29414a, 1));
const light = new THREE.DirectionalLight(0xffffff, 0.7);
light.position.set(1, 2, 1);
scene.add(light);
let playing = false;
let lastTick = 0;
const cm = (p: number[]): THREE.Vector3 => new THREE.Vector3(p[0] / 100, p[2] / 100, p[1] / 100);
const tuple = (p: THREE.Vector3): string =>
    [p.x * 100, p.z * 100, p.y * 100].map((v) => v.toFixed(1)).join(', ');
function focus(point: number[], distance: number): void {
    const damping = controls.enableDamping;
    controls.enableDamping = false;
    controls.update();
    controls.target.copy(cm(point));
    camera.position
        .copy(controls.target)
        .add(new THREE.Vector3(distance, distance * 0.65, -distance));
    controls.update();
    controls.enableDamping = damping;
}
function animate(now: number): void {
    requestAnimationFrame(animate);
    if (previousFrame !== undefined && keys.size) {
        moveCamera(
            camera,
            controls.target,
            Number(keys.has('KeyW')) - Number(keys.has('KeyS')),
            Number(keys.has('KeyD')) - Number(keys.has('KeyA')),
            (now - previousFrame) / 1000,
            camera.position.distanceTo(controls.target),
            keys.has('ShiftLeft') || keys.has('ShiftRight'),
            'camera',
            Number(keys.has('KeyE')) - Number(keys.has('KeyQ')),
        );
    }
    previousFrame = now;
    if (playing && now - lastTick > (mode.value === 'components' ? 160 : 60)) {
        step.value = String(
            Math.min(Number(step.max), Number(step.value) + (mode.value === 'components' ? 1 : 10)),
        );
        step.dispatchEvent(new Event('input'));
        lastTick = now;
        if (step.value === step.max) {
            playing = false;
            element('play').textContent = 'Play replay';
        }
    }
    controls.update();
    renderer.render(scene, camera);
}
requestAnimationFrame(animate);
addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
});
async function load(): Promise<void> {
    const query = new URLSearchParams(location.search);
    const reportUrl = new URL(
        query.get('report') ?? 'diagnostic/death-contact.json',
        location.href,
    );
    const witnessUrl = new URL('witness.json', reportUrl);
    const fetchJson = async <T>(url: URL): Promise<T> => {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`${url.pathname}: HTTP ${response.status}`);
        return response.json() as Promise<T>;
    };
    const [report, witness, frontier] = await Promise.all([
        fetchJson<Contact>(reportUrl),
        fetchJson<Witness>(witnessUrl),
        fetchJson<Frontier>(new URL('frontier.json', reportUrl)),
    ]);
    if (report.version !== 1 || witness.version !== 1 || witness.cells.length < 2)
        throw new Error('Unsupported or empty diagnostic evidence.');
    const { bounds } = witness;
    const world = (c: Cell): number[] => [
        bounds.minX + (c.x + 0.5) * 100,
        bounds.minY + (c.y + 0.5) * 100,
        bounds.minZ + (c.z + 0.5) * 100,
    ];
    const points = witness.cells.map((c) => cm(world(c)));
    const fullGeometry = new THREE.BufferGeometry().setFromPoints(points);
    const unreached = new THREE.Line(
        fullGeometry,
        new THREE.LineBasicMaterial({
            color: 0x79cfff,
            depthTest: false,
            transparent: true,
            opacity: 0.45,
        }),
    );
    unreached.renderOrder = 20;
    scene.add(unreached);
    const reachedGeometry = new THREE.BufferGeometry().setFromPoints(points);
    const reached = new THREE.Line(
        reachedGeometry,
        new THREE.LineBasicMaterial({ color: 0xff8975, depthTest: false, transparent: true }),
    );
    reached.renderOrder = 21;
    scene.add(reached);
    const marker = new THREE.Mesh(
        new THREE.SphereGeometry(3, 16, 12),
        new THREE.MeshBasicMaterial({ color: 0xff8975, depthTest: false, transparent: true }),
    );
    marker.renderOrder = 22;
    scene.add(marker);
    const spawn = new THREE.Mesh(
        new THREE.SphereGeometry(3, 16, 12),
        new THREE.MeshBasicMaterial({ color: 0xffe28c, depthTest: false, transparent: true }),
    );
    spawn.position.copy(cm(witness.playerWorldCm));
    spawn.renderOrder = 23;
    scene.add(spawn);
    navigationSurfaces.push(unreached, reached);
    if (frontier.version !== 1 || frontier.unrepresentedComponents !== 0)
        throw new Error('The saved full-map component frontier is incomplete.');
    const frontierPositions = frontier.nodes.flatMap((n) => {
        const p = cm(world({ x: n[1], y: n[2], z: n[3] }));
        return [p.x, p.y, p.z];
    });
    const frontierAttribute = new THREE.Float32BufferAttribute(frontierPositions, 3);
    const pendingFrontierGeometry = new THREE.BufferGeometry().setAttribute(
        'position',
        frontierAttribute,
    );
    const reachedFrontierGeometry = new THREE.BufferGeometry().setAttribute(
        'position',
        frontierAttribute,
    );
    const pendingFrontier = new THREE.Points(
        pendingFrontierGeometry,
        new THREE.PointsMaterial({
            color: 0x79cfff,
            size: 2,
            sizeAttenuation: false,
            transparent: true,
            opacity: 0.25,
            depthTest: false,
        }),
    );
    const reachedFrontier = new THREE.Points(
        reachedFrontierGeometry,
        new THREE.PointsMaterial({
            color: 0xff8975,
            size: 4,
            sizeAttenuation: false,
            transparent: true,
            depthTest: false,
        }),
    );
    pendingFrontier.renderOrder = 20;
    reachedFrontier.renderOrder = 21;
    pendingFrontier.visible = reachedFrontier.visible = false;
    scene.add(pendingFrontier, reachedFrontier);
    navigationSurfaces.push(pendingFrontier, reachedFrontier);
    const spawnPositions = report.spawns.flatMap((s) => {
        const p = cm(s.worldCm);
        return [p.x, p.y, p.z];
    });
    const spawnPoints = new THREE.Points(
        new THREE.BufferGeometry().setAttribute(
            'position',
            new THREE.Float32BufferAttribute(spawnPositions, 3),
        ),
        new THREE.PointsMaterial({
            color: 0xffe28c,
            size: 6,
            sizeAttenuation: false,
            transparent: true,
            depthTest: false,
        }),
    );
    spawnPoints.renderOrder = 22;
    spawnPoints.visible = false;
    scene.add(spawnPoints);
    const tilePositions: number[] = [];
    const tileColors: number[] = [];
    for (const tile of report.tiles) {
        if (tile.contactCells === 0) continue;
        const x = (bounds.minX + tile.x * 12800) / 100;
        const z = (bounds.minY + tile.y * 12800) / 100;
        const corners = [
            [x, z],
            [x + 128, z],
            [x + 128, z + 128],
            [x, z + 128],
        ];
        const color = new THREE.Color(0xff8975).multiplyScalar(
            0.3 + 0.7 * Math.min(1, tile.contactCells / 16384),
        );
        for (const index of [0, 1, 2, 0, 2, 3]) {
            tilePositions.push(corners[index][0], report.killZ / 100, corners[index][1]);
            tileColors.push(color.r, color.g, color.b);
        }
    }
    const tileGeometry = new THREE.BufferGeometry();
    tileGeometry.setAttribute('position', new THREE.Float32BufferAttribute(tilePositions, 3));
    tileGeometry.setAttribute('color', new THREE.Float32BufferAttribute(tileColors, 3));
    const tiles = new THREE.Mesh(
        tileGeometry,
        new THREE.MeshBasicMaterial({
            vertexColors: true,
            transparent: true,
            opacity: 0.5,
            side: THREE.DoubleSide,
            depthWrite: false,
        }),
    );
    tiles.visible = false;
    scene.add(tiles);
    const grid = new THREE.GridHelper((bounds.maxX - bounds.minX) / 100, 104, 0x54798e, 0x36505e);
    grid.position.set(
        (bounds.minX + bounds.maxX) / 200,
        report.killZ / 100 - 1,
        (bounds.minY + bounds.maxY) / 200,
    );
    grid.visible = false;
    scene.add(grid);
    element<HTMLInputElement>('ties').addEventListener('change', (event) => {
        tiles.visible = (event.target as HTMLInputElement).checked;
    });
    const descriptor = witness.sourceMesh;
    status.textContent = 'Loading bounded original source geometry…';
    const response = await fetch(new URL(descriptor.url, witnessUrl));
    if (!response.ok || !response.body) throw new Error(`Source mesh HTTP ${response.status}`);
    const bytes = await new Response(
        response.body.pipeThrough(new DecompressionStream('gzip')),
    ).arrayBuffer();
    const geometry = worldGeometry(
        bytes,
        { ...descriptor, maxErrorCm: 0 },
        descriptor.bounds,
        0,
        0,
        bounds,
    );
    const source = new THREE.Mesh(
        geometry,
        new THREE.MeshStandardMaterial({
            color: 0x7394a1,
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.7,
            roughness: 1,
        }),
    );
    scene.add(source);
    element<HTMLInputElement>('source').addEventListener('change', (event) => {
        source.visible = (event.target as HTMLInputElement).checked;
    });
    const sourceSeed = witness.sourceWorldCm.map((v) => v.toFixed(0)).join(', ');
    status.textContent = `${report.tiedContactCells.toLocaleString()} tied KillZ cells in player-seeded physical components.`;
    element('definition').textContent = report.firstContactDefinition;
    element<HTMLAnchorElement>('report').href = reportUrl.href;
    element<HTMLAnchorElement>('witness').href = witnessUrl.href;
    step.max = String(points.length - 1);
    step.disabled = false;
    function update(): void {
        const index = Number(step.value);
        const ccc = encodeCameraCode(
            [camera.position.x * 100, camera.position.z * 100, camera.position.y * 100],
            camera.getWorldDirection(new THREE.Vector3()),
        );
        const projection = `Perspective: FOV ${camera.fov}°, zoom ${camera.zoom}`;
        const components = mode.value === 'components';
        reached.visible = unreached.visible = marker.visible = spawn.visible = !components;
        pendingFrontier.visible = reachedFrontier.visible = spawnPoints.visible = components;
        if (components) {
            const count = frontier.nodes.findIndex((n) => n[4] > index);
            reachedFrontierGeometry.setDrawRange(0, count < 0 ? frontier.nodes.length : count);
            element('step-value').textContent = `${index} / ${frontier.maximumDistance} tile seams`;
            element('coordinates').textContent =
                `Reached components: ${(count < 0 ? frontier.nodes.length : count).toLocaleString()} / ${frontier.nodes.length.toLocaleString()}\nRaised spawns reached: ${report.spawns.filter((s) => s.seamHopDistance <= index).length} / ${report.spawns.length}\nFirst physical player-air overlap: 0\nFocus cm: ${tuple(controls.target)}\nCamera CCC: ${ccc}\n${projection}`;
            return;
        }
        reachedGeometry.setDrawRange(0, index + 1);
        marker.position.copy(points[index]);
        element('step-value').textContent =
            `${index.toLocaleString()} / ${(points.length - 1).toLocaleString()} m along witness`;
        element('coordinates').textContent =
            `Front XYZ cm: ${tuple(points[index])}\nCell XYZ: ${Object.values(witness.cells[index]).join(', ')}\nKillZ source cm: ${sourceSeed}\nFocus cm: ${tuple(controls.target)}\nCamera CCC: ${ccc}\n${projection}`;
    }
    step.addEventListener('input', update);
    const witnessNote = element('replay-note').textContent;
    function witnessMode(): void {
        mode.value = 'witness';
        step.max = String(points.length - 1);
        element('replay-note').textContent = witnessNote;
    }
    mode.addEventListener('change', () => {
        playing = false;
        element('play').textContent = 'Play replay';
        step.value = '0';
        if (mode.value === 'components') {
            step.max = String(frontier.maximumDistance);
            element('replay-note').textContent =
                'Simultaneous KillZ-seeded BFS. Each portal-split tile component fills instantly; each tile seam costs one. Dots mark exact representative cells, not voxel volumes. Spawn arrival is not first player-air overlap.';
            focus(
                [
                    (bounds.minX + bounds.maxX) / 2,
                    (bounds.minY + bounds.maxY) / 2,
                    report.killZ + 80000,
                ],
                9000,
            );
            tiles.visible = grid.visible = true;
            element<HTMLInputElement>('ties').checked = true;
        } else witnessMode();
        update();
    });
    controls.addEventListener('change', update);
    for (const id of ['play', 'reset', 'spawn', 'shaft', 'map'])
        element<HTMLButtonElement>(id).disabled = false;
    element('play').addEventListener('click', () => {
        if (step.value === step.max) step.value = '0';
        playing = !playing;
        element('play').textContent = playing ? 'Pause replay' : 'Play replay';
    });
    element('reset').addEventListener('click', () => {
        witnessMode();
        playing = false;
        step.value = '0';
        element('play').textContent = 'Play replay';
        focus(witness.sourceWorldCm, 650);
        update();
    });
    element('spawn').addEventListener('click', () => {
        witnessMode();
        playing = false;
        element('play').textContent = 'Play replay';
        step.value = step.max;
        focus(witness.playerWorldCm, 200);
        update();
    });
    const shaftTop = Math.max(
        0,
        witness.cells.findIndex((c) => c.x !== witness.cells[0].x || c.y !== witness.cells[0].y) -
            1,
    );
    element('shaft').addEventListener('click', () => {
        witnessMode();
        playing = false;
        element('play').textContent = 'Play replay';
        step.value = String(shaftTop);
        focus(world(witness.cells[shaftTop]), 200);
        update();
    });
    element('map').addEventListener('click', () => {
        playing = false;
        element('play').textContent = 'Play replay';
        element<HTMLInputElement>('ties').checked = true;
        tiles.visible = true;
        grid.visible = true;
        focus(
            [(bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2, report.killZ],
            9000,
        );
    });
    focus(
        witness.sourceWorldCm.map((v, i) => (v + witness.playerWorldCm[i]) / 2),
        1000,
    );
    update();
    const preset = query.get('view');
    const presetButtons: Record<string, string> = {
        shaft: 'shaft',
        spawn: 'spawn',
        first: 'reset',
        map: 'map',
    };
    if (preset && presetButtons[preset]) element<HTMLButtonElement>(presetButtons[preset]).click();
    if (preset === 'expansion') {
        mode.value = 'components';
        mode.dispatchEvent(new Event('change'));
    }
    const requestedStep = query.get('step');
    if (
        requestedStep &&
        /^\d+$/.test(requestedStep) &&
        Number.isSafeInteger(Number(requestedStep))
    ) {
        step.value = String(Math.min(Number(step.max), Number(requestedStep)));
        update();
    }
}
load().catch((error: unknown) => {
    status.textContent = `Diagnostic unavailable: ${error instanceof Error ? error.message : String(error)}. Check the report URL and reload.`;
});
