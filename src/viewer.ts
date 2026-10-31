import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { DataLoader } from './data/DataLoader.js';
import { fetchMapImage } from './map-image.js';
import { groupedMaps, mapKeyFromUrl, mapUrl, orderedMaps } from './map-navigation.js';
import { MapData } from './data/types.js';
import { World, type WorldPoint } from './world/World.js';
import { resourcePositions } from './resource-positions.js';
import { freshJson as json } from './metadata.js';
import { WorldModelLayer, type WorldModelManifest } from './world-model.js';
import { cameraCodeDirection, decodeCameraCode, encodeCameraCode } from './camera-code.js';
import { changeProjection, fitMapCamera, resizeMapCamera, worldUnitsPerPixel, type MapCamera, type Projection } from './camera-view.js';
import { displayNumber as number } from './display-number.js';
import {
    dollySurface,
    moveCamera,
    lookCamera,
    terrainCameraTravel,
    orbitSurface,
    pinchPixels,
    MIN_FOCUS_DISTANCE,
    wheelPixels,
} from './surface-navigation.js';
import { initialRepresentation, validateManifest, type TerrainManifest } from './terrain.js';

const el = (id: string): HTMLElement => {
    const result = document.getElementById(id);
    if (!result) throw new Error(`Missing control ${id}`);
    return result;
};
const input = (id: string): HTMLInputElement => el(id) as HTMLInputElement;
const value = (id: string): number => Number(input(id).value);
const checked = (id: string): boolean => input(id).checked;

interface MarkerLayer {
    points: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
    glow: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
    nodes: WorldPoint[];
}

function dispose(group: THREE.Group): void {
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    const textures = new Set<THREE.Texture>();
    group.traverse((object) => {
        if (
            object instanceof THREE.Mesh ||
            object instanceof THREE.Points ||
            object instanceof THREE.LineSegments
        ) {
            geometries.add(object.geometry);
            for (const material of Array.isArray(object.material)
                ? object.material
                : [object.material]) {
                materials.add(material);
                if ('map' in material && material.map instanceof THREE.Texture)
                    textures.add(material.map);
            }
        }
    });
    geometries.forEach((geometry) => geometry.dispose());
    materials.forEach((material) => material.dispose());
    textures.forEach((texture) => texture.dispose());
    group.clear();
}

function markerTexture(glow: boolean): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 32;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas is unavailable.');
    if (glow) {
        const gradient = context.createRadialGradient(16, 16, 0, 16, 16, 16);
        gradient.addColorStop(0, '#ffffff');
        gradient.addColorStop(1, '#ffffff00');
        context.fillStyle = gradient;
        context.fillRect(0, 0, 32, 32);
    } else {
        context.fillStyle = '#ffffff';
        context.beginPath();
        context.arc(16, 16, 12, 0, Math.PI * 2);
        context.fill();
    }
    return new THREE.CanvasTexture(canvas);
}

export class Viewer {
    private loader = new DataLoader();
    private world = new World();
    private scene = new THREE.Scene();
    private renderer = new THREE.WebGLRenderer({ antialias: true });
    private camera: MapCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 1000000);
    private controls = new OrbitControls(this.camera, this.renderer.domElement);
    private homeView?: boolean;
    private movementMode: 'world' | 'camera' = 'world';
    private lastCameraPosition = new THREE.Vector3();
    private flightKeys = new Set<string>();
    private flightDistance?: number;
    private flightTime?: number;
    private flightFast = false;
    private resources = new THREE.Group();
    private layers: MarkerLayer[] = [];
    private hidden = new Set<string>();
    private manifest?: TerrainManifest;
    private map?: MapData;
    private texture?: THREE.Texture;
    private abort?: AbortController;
    private generation = 0;
    private selectedKey = '';
    private marker = markerTexture(false);
    private glow = markerTexture(true);
    private down?: { x: number; y: number };
    private orbitPivot = new THREE.Vector3();
    private surfaceDrag?: {
        id: number;
        x: number;
        y: number;
        started: boolean;
        mode: 'orbit' | 'dolly';
    };
    private touchPointers = new Map<number, { x: number; y: number }>();
    private pinchDistance?: number;
    private lastHover = 0;
    private blockModelUrl?: string;
    private progressiveModelUrl?: string;
    private worldModelManifest?: WorldModelManifest;
    private lastWorldCheck = 0;
    private worldModel = new WorldModelLayer((status) => {
        const bounds = status.manifest?.bounds,
            extent = this.map?.coordinates;
        const margin = status.manifest?.cellSizeCm ?? 0;
        const regional =
            bounds &&
            extent &&
            (bounds.minX > extent.minX + margin ||
                bounds.minY > extent.minY + margin ||
                bounds.maxX < extent.maxX - margin ||
                bounds.maxY < extent.maxY - margin);
        el('world-model-status').textContent =
            (regional ? 'Regional world export. ' : '') + status.text;
        el('world-model-status').toggleAttribute(
            'data-debug',
            !status.retry && this.worldModel.meshes.length > 0,
        );
        el('world-model-retry').hidden = !status.retry;
        if (status.manifest && status.manifest !== this.worldModelManifest) {
            const m = (this.worldModelManifest = status.manifest);
            if (m.statistics.hierarchyVersion === 3) this.updateCubeSizeControl();
            el('world-model-details').hidden = false;
            const errorMeaning = m.statistics.errorMeaning;
            el('world-model-resolution').textContent =
                (m.statistics.representation === 'blocks'
                    ? `${number(m.cellSizeCm / 100)} m nearby cubes; coarse cubes conservatively cover fine solid cells. `
                    : `${number(m.cellSizeCm / 100)} m extraction cells; ${number(m.maxErrorCm / 100)} m base error budget. `) +
                (typeof errorMeaning === 'string' ? `${errorMeaning} ` : '') +
                (m.statistics.representation === 'blocks'
                    ? 'Cubic occupancy of reconstructed solid, not a heightfield or player navigation.'
                    : 'Exterior-connected skin, not player navigation. Source-slope flags are independent of mesh simplification.');
            const warnings = el('world-model-warnings');
            warnings.replaceChildren();
            for (const warning of m.warnings) {
                const item = document.createElement('li');
                item.textContent = warning;
                warnings.append(item);
            }
            const slider = input('world-cutaway');
            slider.min = String(
                Math.floor(Math.min(m.bounds.minZ, this.manifest?.minZ ?? m.bounds.minZ) / 100) - 1,
            );
            slider.max = String(
                Math.ceil(Math.max(m.bounds.maxZ, this.manifest?.maxZ ?? m.bounds.maxZ) / 100) + 1,
            );
            slider.value = slider.max;
            el('world-cutaway-label').hidden = false;
            this.appearance();
        }
    });

    getApplication(): Viewer {
        return this;
    }
    getCurrentMapData(): MapData | undefined {
        return this.map;
    }
    getAvailableMaps(): ReturnType<DataLoader['getMapList']> {
        return this.loader.getMapList().then(orderedMaps);
    }
    switchToMap(key: string): Promise<void> {
        (el('mapSelect') as HTMLSelectElement).value = key;
        return this.load(key);
    }

    ccc(): string;
    ccc(code: string): void;
    ccc(code?: string): string | void {
        if (!this.manifest || !this.map || !el('loading').hidden)
            throw new Error('Wait for a map to finish loading before using camera coordinates.');
        if (code === undefined) {
            const position = this.toWorld(this.camera.position);
            return encodeCameraCode(
                [position.x, position.y, position.z],
                this.camera.getWorldDirection(new THREE.Vector3()),
            );
        }
        const view = decodeCameraCode(code);
        const direction = cameraCodeDirection(view);
        if (Math.acos(THREE.MathUtils.clamp(-direction.y, -1, 1)) > this.controls.maxPolarAngle)
            throw new Error('This camera angle exceeds the current terrain-view orbit limit.');
        const m = this.manifest;
        const focusDistance = THREE.MathUtils.clamp(
            this.camera.position.distanceTo(this.controls.target),
            this.controls.minDistance,
            this.controls.maxDistance,
        );
        this.homeView = undefined;
        this.stopFlight();
        this.down = undefined;
        this.surfaceDrag = undefined;
        this.touchPointers.clear();
        this.pinchDistance = undefined;
        const position = new THREE.Vector3(
            (view.position[0] - (m.originX + m.maxX) / 2) / 100,
            view.position[2] / 100,
            (view.position[1] - (m.originY + m.maxY) / 2) / 100,
        );
        this.camera.position.copy(position);
        this.controls.target.copy(position).addScaledVector(direction, focusDistance);
        this.controls.update();
        // OrbitControls nudges exact vertical views; keep the requested position, not its target.
        this.controls.target.add(position.clone().sub(this.camera.position));
        this.camera.position.copy(position);
        this.orbitPivot.copy(this.controls.target);
        this.lastCameraPosition.copy(this.camera.position);
        this.worldModel.update(
            this.camera,
            this.controls.target,
            this.renderer.domElement.clientHeight,
        );
    }

    async start(): Promise<void> {
        this.scene.background = new THREE.Color('#14212b');
        this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
        this.renderer.outputEncoding = THREE.sRGBEncoding;
        this.renderer.localClippingEnabled = true;
        el('viewport').append(this.renderer.domElement);
        this.scene.add(
            this.resources,
            this.worldModel.group,
            new THREE.AmbientLight(0xffffff, 0.65),
        );
        const sun = new THREE.DirectionalLight(0xfff3dd, 0.8);
        sun.position.set(-3000, 9000, -5000);
        this.scene.add(sun);
        this.controls.enableDamping = false;
        this.controls.enableRotate = false;
        this.controls.enableZoom = false;
        this.controls.maxPolarAngle = this.movementMode === 'camera' ? Math.PI - 0.001 : Math.PI * 0.495;
        this.controls.screenSpacePanning = true;
        this.controls.minDistance = MIN_FOCUS_DISTANCE;
        this.controls.maxDistance = 500000;
        const resize = () => {
            const rect = el('viewport').getBoundingClientRect();
            this.renderer.setSize(rect.width, rect.height);
            resizeMapCamera(this.camera, rect.width / Math.max(1, rect.height));
            if (this.homeView !== undefined) this.home(this.homeView);
        };
        new ResizeObserver(resize).observe(el('viewport'));
        resize();
        this.bind();
        this.renderer.setAnimationLoop(() => {
            const now = performance.now();
            this.updateFlight(now);
            this.worldModel.animate(now);
            this.controls.update();
            this.enforceCameraCollision();
            this.lastCameraPosition.copy(this.camera.position);
            if (performance.now() - this.lastWorldCheck > this.worldModel.selectionIntervalMs) {
                this.lastWorldCheck = performance.now();
                this.worldModel.update(
                    this.camera,
                    this.controls.target,
                    this.renderer.domElement.clientHeight,
                );
            }
            this.renderer.render(this.scene, this.camera);
        });
        try {
            const maps = await this.getAvailableMaps();
            const select = el('mapSelect') as HTMLSelectElement;
            for (const group of groupedMaps(maps)) {
                const options = document.createElement('optgroup');
                options.label = group.label;
                for (const map of group.maps) options.append(new Option(map.name, map.key));
                select.append(options);
            }
            select.addEventListener('change', () => void this.switchToMap(select.value));
            const navigate = async () => {
                try {
                    await this.switchToMap(mapKeyFromUrl(new URL(location.href), maps));
                } catch (error) {
                    this.error(error);
                }
            };
            window.addEventListener('popstate', () => void navigate());
            await navigate();
        } catch (error) {
            this.error(error);
        }
    }

    private error(error: unknown): void {
        el('error').hidden = false;
        el('error-message').textContent = error instanceof Error ? error.message : String(error);
        el('loading').hidden = true;
    }

    private bind(): void {
        el('movement-mode').addEventListener('change', () => {
            const mode = (el('movement-mode') as HTMLSelectElement).value;
            if (mode !== 'world' && mode !== 'camera') throw new Error('Unsupported movement mode.');
            this.setMovementMode(mode);
        });
        const editing = (target: EventTarget | null) =>
            target instanceof Element &&
            !!target.closest('input, textarea, select, button, [contenteditable]:not([contenteditable="false"]), [role="textbox"]');
        window.addEventListener('keydown', (event) => {
            if (event.ctrlKey || event.altKey || event.metaKey) {
                this.stopFlight();
                return;
            }
            if (
                editing(event.target) ||
                document.hidden || !this.map || !this.manifest || !el('loading').hidden
            ) return;
            if (!['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft', 'ShiftRight'].includes(event.code))
                return;
            if (event.repeat && !this.flightKeys.has(event.code)) return;
            this.flightFast = event.shiftKey;
            if (event.code.startsWith('Key')) {
                if (this.flightDistance === undefined)
                    this.flightDistance = this.camera.position.distanceTo(this.surfaceAt() ?? this.controls.target);
                this.homeView = undefined;
                event.preventDefault();
            }
            this.flightKeys.add(event.code);
        });
        window.addEventListener('keyup', (event) => {
            this.flightFast = event.shiftKey;
            this.flightKeys.delete(event.code);
            if (!['KeyW', 'KeyA', 'KeyS', 'KeyD'].some(key => this.flightKeys.has(key))) {
                this.flightDistance = undefined;
                this.flightTime = undefined;
            }
        });
        window.addEventListener('blur', () => this.stopFlight());
        window.addEventListener('focusin', (event) => {
            if (editing(event.target)) this.stopFlight();
        });
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) this.stopFlight();
        });
        el('panel-toggle').addEventListener('click', () =>
            this.setPanelExpanded(el('control-panel').hidden),
        );
        el('camera-projection').addEventListener('change', () => {
            const projection = (el('camera-projection') as HTMLSelectElement).value;
            if (projection !== 'perspective' && projection !== 'orthographic')
                throw new Error('Unsupported camera projection.');
            this.setProjection(projection);
        });
        el('world-representation').addEventListener('change', () => {
            const url = new URL(location.href);
            url.searchParams.set('world', (el('world-representation') as HTMLSelectElement).value);
            history.replaceState(history.state, '', url);
            this.updateWorldModel();
        });
        el('camera-copy').addEventListener('click', () => {
            void (async () => {
                let captured = false;
                try {
                    const code = this.ccc();
                    const field = el('camera-code') as HTMLTextAreaElement;
                    field.value = code;
                    captured = true;
                    if (!navigator.clipboard) throw new Error('Clipboard unavailable.');
                    await navigator.clipboard.writeText(code);
                    el('camera-status').textContent = 'Coordinates copied.';
                } catch (error) {
                    if (captured) {
                        this.setPanelExpanded(true);
                        const field = el('camera-code') as HTMLTextAreaElement;
                        field.closest('details')!.open = true;
                        document.body.classList.add('show-debug');
                        input('debug-toggle').checked = true;
                        field.focus();
                        field.select();
                    }
                    el('camera-status').textContent =
                        `Copy failed: ${error instanceof Error ? error.message : String(error)}${captured ? ' Copy the selected coordinates manually.' : ''}`;
                }
            })();
        });
        el('camera-paste').addEventListener('click', () => {
            void (async () => {
                try {
                    if (!navigator.clipboard?.readText) throw new Error('Clipboard reading unavailable.');
                    const code = await navigator.clipboard.readText();
                    this.ccc(code);
                    (el('camera-code') as HTMLTextAreaElement).value = code;
                    el('camera-status').textContent = 'Camera restored from clipboard.';
                } catch (error) {
                    el('camera-status').textContent =
                        `Paste failed: ${error instanceof Error ? error.message : String(error)} Use Camera / ccc in Show debug for manual input.`;
                }
            })();
        });
        input('cube-size').addEventListener('input', () => {
            this.updateCubeSizeControl();
        });
        el('camera-go').addEventListener('click', () => {
            try {
                this.ccc((el('camera-code') as HTMLTextAreaElement).value);
                el('camera-status').textContent =
                    'Camera restored. World tiles stream at the restored view.';
            } catch (error) {
                el('camera-status').textContent =
                    `Restore failed: ${error instanceof Error ? error.message : String(error)}`;
            }
        });
        el('world-model-retry').addEventListener('click', () => this.worldModel.retry());
        input('world-cutaway').addEventListener('input', () => this.appearance());
        el('retry').addEventListener('click', () => {
            if (this.selectedKey) void this.load(this.selectedKey);
            else location.reload();
        });
        el('home').addEventListener('click', () => this.home(false));
        el('top').addEventListener('click', () => this.home(true));
        for (const id of ['cluster-enabled', 'cluster-radius'])
            input(id).addEventListener('input', () => {
                if (this.map) this.buildResources();
            });
        for (const id of [
            'resource-size',
            'resource-glow',
            'resource-through',
            'size-attenuation',
            'terrain-opacity',
            'shading',
            'wireframe',
            'debug-toggle',
        ])
            input(id).addEventListener('input', () => this.appearance());
        for (const [id, visible] of [
            ['resources-all', true],
            ['resources-none', false],
        ] as const) {
            el(id).addEventListener('click', () => {
                if (!this.map) return;
                for (const resource of this.map.resources) {
                    if (visible) this.hidden.delete(resource.resourceType);
                    else this.hidden.add(resource.resourceType);
                }
                this.updateVisibility();
            });
        }
        const canvas = this.renderer.domElement;
        canvas.tabIndex = 0;
        canvas.setAttribute('aria-label', 'Map camera: WASD movement, Shift for faster movement');
        canvas.addEventListener(
            'pointerdown',
            (event) => {
                canvas.focus({ preventScroll: true });
                if (event.button === 1) event.preventDefault();
                this.homeView = undefined;
                this.down = event.button === 0 ? { x: event.clientX, y: event.clientY } : undefined;
                if (event.pointerType === 'touch') {
                    this.touchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
                    if (this.touchPointers.size > 1) {
                        this.down = undefined;
                        this.surfaceDrag = undefined;
                        const [a, b] = [...this.touchPointers.values()];
                        this.pinchDistance = Math.hypot(a.x - b.x, a.y - b.y);
                        return;
                    }
                }
                if (this.movementMode === 'world') this.rebaseSurfaceFocus();
                if (
                    (event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey) ||
                    event.pointerType === 'touch'
                ) {
                    const pivot = this.movementMode === 'world' ? this.surfaceAt(event.clientX, event.clientY) : undefined;
                    this.orbitPivot.copy(pivot ?? this.controls.target);
                    this.surfaceDrag = {
                        id: event.pointerId,
                        x: event.clientX,
                        y: event.clientY,
                        started: false,
                        mode: 'orbit',
                    };
                } else if (event.button === 1) {
                    this.surfaceDrag = {
                        id: event.pointerId,
                        x: event.clientX,
                        y: event.clientY,
                        started: false,
                        mode: 'dolly',
                    };
                }
                if (this.surfaceDrag && event.isTrusted) canvas.setPointerCapture(event.pointerId);
            },
            true,
        );
        canvas.addEventListener(
            'pointermove',
            (event) => {
                if (
                    this.down &&
                    Math.hypot(event.clientX - this.down.x, event.clientY - this.down.y) >= 4
                )
                    this.down = undefined;
                if (this.touchPointers.has(event.pointerId)) {
                    this.touchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
                    if (this.touchPointers.size === 2) {
                        const [a, b] = [...this.touchPointers.values()];
                        const distance = Math.hypot(a.x - b.x, a.y - b.y);
                        if (this.pinchDistance && distance > 0)
                            this.dolly(pinchPixels(this.pinchDistance, distance));
                        this.pinchDistance = distance;
                        return;
                    }
                }
                const drag = this.surfaceDrag;
                if (!drag || drag.id !== event.pointerId) return;
                const dx = event.clientX - drag.x,
                    dy = event.clientY - drag.y;
                if (!drag.started && Math.hypot(dx, dy) < 4) return;
                drag.started = true;
                drag.x = event.clientX;
                drag.y = event.clientY;
                if (drag.mode === 'dolly') this.dolly(dy);
                else if (this.movementMode === 'camera') {
                    lookCamera(this.camera, this.controls.target, dx, dy, canvas.clientHeight, checked('camera-invert-y'));
                    this.controls.update();
                }
                else {
                    orbitSurface(
                        this.camera,
                        this.controls.target,
                        this.orbitPivot,
                        dx,
                        dy,
                        canvas.clientHeight,
                        this.controls.maxPolarAngle,
                    );
                    this.controls.update();
                }
            },
            true,
        );
        const release = (event: PointerEvent) => {
            this.touchPointers.delete(event.pointerId);
            if (this.touchPointers.size < 2) this.pinchDistance = undefined;
            if (this.surfaceDrag?.id === event.pointerId) this.surfaceDrag = undefined;
            if (canvas.hasPointerCapture(event.pointerId))
                canvas.releasePointerCapture(event.pointerId);
        };
        canvas.addEventListener('auxclick', (event) => {
            if (event.button === 1) event.preventDefault();
        });
        canvas.addEventListener('pointercancel', () => {
            this.down = undefined;
        });
        canvas.addEventListener('pointercancel', release);
        canvas.addEventListener('lostpointercapture', (event) => {
            this.down = undefined;
            release(event);
        });
        canvas.addEventListener('pointerup', (event) => {
            const down = this.down;
            const toggleMovement = event.button === 1 && this.surfaceDrag?.id === event.pointerId &&
                !this.surfaceDrag.started;
            this.down = undefined;
            if (down && Math.hypot(event.clientX - down.x, event.clientY - down.y) <= 4)
                this.pick(event, true);
            release(event);
            if (toggleMovement) this.setMovementMode(this.movementMode === 'world' ? 'camera' : 'world');
        });
        canvas.addEventListener(
            'wheel',
            (event) => {
                event.preventDefault();
                this.homeView = undefined;
                if (event.deltaY)
                    this.dolly(wheelPixels(event.deltaY, event.deltaMode, canvas.clientHeight));
            },
            { passive: false },
        );
        canvas.addEventListener('pointermove', (event) => {
            if (performance.now() - this.lastHover < 50) return;
            this.lastHover = performance.now();
            this.pick(event, false);
        });
        canvas.addEventListener('pointerleave', () => {
            el('cursor-details').textContent = 'Cursor: —';
        });
    }

    private async load(key: string): Promise<void> {
        this.stopFlight();
        this.surfaceDrag = undefined;
        this.touchPointers.clear();
        this.pinchDistance = undefined;
        this.selectedKey = key;
        this.worldModel.clear();
        this.blockModelUrl = undefined;
        (el('world-representation') as HTMLSelectElement).value = 'cubes';
        el('world-representation-label').hidden = true;
        this.worldModelManifest = undefined;
        el('world-model-status').textContent =
            'World-model export not available (or map still loading).';
        el('world-model-status').setAttribute('data-debug', '');
        el('world-model-retry').hidden = true;
        el('world-model-details').hidden = true;
        el('world-cutaway-label').hidden = true;
        this.controls.maxPolarAngle = this.movementMode === 'camera' ? Math.PI - 0.001 : Math.PI * 0.495;
        this.abort?.abort();
        const controller = (this.abort = new AbortController());
        const signal = controller.signal;
        const generation = ++this.generation;
        this.manifest = undefined;
        this.map = undefined;
        this.world = new World();
        this.layers = [];
        dispose(this.resources);
        this.texture?.dispose();
        this.texture = undefined;
        this.marker.dispose();
        this.glow.dispose();
        this.marker = markerTexture(false);
        this.glow = markerTexture(true);
        el('resource-options').replaceChildren();
        el('resource-details').textContent = 'No resource selected.';
        el('warning-summary').textContent = '';
        el('warning-list').replaceChildren();
        el('warning-details').hidden = true;
        (el('warning-details') as HTMLDetailsElement).open = false;
        el('image-warning').hidden = true;
        el('cursor-details').textContent = 'Cursor: —';
        el('error').hidden = true;
        el('loading').hidden = false;
        el('loading').textContent = 'Loading map and 3D extraction metadata…';
        try {
            const maps = await this.loader.getMapList();
            signal.throwIfAborted();
            const info = maps.find((map) => map.key === key);
            if (!info) throw new Error(`Unknown map ${key}`);
            history.replaceState(history.state, '', mapUrl(new URL(location.href), key));
            const indexUrl = new URL('./terrain/index.json', document.baseURI).href;
            const index = await json<{ version: number; maps: { mapKey: string; url: string }[] }>(
                indexUrl,
                signal,
            );
            if (index.version !== 1 || !Array.isArray(index.maps))
                throw new Error('Invalid terrain index.');
            const entry = index.maps.find((map) => map.mapKey === key);
            if (!entry) throw new Error(`No 3D extraction metadata published for ${info.name}.`);
            const manifestUrl = new URL(entry.url, indexUrl).href;
            const manifest = await json<TerrainManifest>(manifestUrl, signal);
            validateManifest(manifest, key);
            if (!manifest.cubeModel && !manifest.progressiveModel)
                throw new Error(`No 3D extraction published for ${info.name}.`);
            // This request is abortable, unlike the legacy DataLoader.loadMapByName path.
            const dataUrl =
                info.dataUrl.startsWith('http') || info.dataUrl.startsWith('/')
                    ? info.dataUrl
                    : `./data/${info.dataUrl.replace(/^\.\//, '')}`;
            const raw = await json<ConstructorParameters<typeof MapData>[0]>(
                new URL(dataUrl, document.baseURI).href,
                signal,
            );
            const map = new MapData(raw);
            if (map.mapKey !== key || !map.imageName)
                throw new Error('Map metadata/image is missing or mismatched.');
            const image = await fetchMapImage(
                new URL(`./images/${map.imageName}`, document.baseURI),
                signal,
            );
            if (image.kind === 'image') {
                const bitmap = await createImageBitmap(image.blob, {
                    imageOrientation: 'flipY',
                });
                if (signal.aborted) {
                    bitmap.close();
                    signal.throwIfAborted();
                }
                const texture = new THREE.Texture();
                texture.image = bitmap;
                texture.encoding = THREE.sRGBEncoding;
                texture.needsUpdate = true;
                texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
                texture.addEventListener('dispose', () => bitmap.close());
                this.texture = texture;
            } else {
                el('image-warning').hidden = false;
                el('image-warning').textContent =
                    `Map image unavailable (HTTP ${image.status}: ${map.imageName}). Showing untextured 3D geometry; recorded resource positions are unchanged.`;
            }
            this.map = map;
            this.manifest = manifest;
            el('map-title').textContent = info.name;
            el('warning-summary').textContent =
                '3D extraction only. Unloaded or unavailable geometry remains empty.';
            el('warning-details').hidden = manifest.warnings.length === 0;
            el('warning-count').textContent =
                `${manifest.warnings.length.toLocaleString()} map warnings — full details`;
            const warnings = document.createDocumentFragment();
            for (const warning of manifest.warnings) {
                const item = document.createElement('li');
                item.textContent = warning;
                warnings.append(item);
            }
            el('warning-list').append(warnings);
            this.world.setMapData(map, this.loader.getResourceTypes());
            this.buildResources();
            this.home(true);
            el('loading').hidden = true;
            this.blockModelUrl = manifest.cubeModel
                ? new URL(manifest.cubeModel.url, manifestUrl).href
                : undefined;
            this.progressiveModelUrl = manifest.progressiveModel
                ? new URL(manifest.progressiveModel.url, manifestUrl).href
                : undefined;
            const representation = el('world-representation') as HTMLSelectElement;
            representation.value = initialRepresentation(
                manifest,
                new URL(location.href).searchParams.get('world'),
            );
            el('world-representation-label').hidden =
                !this.blockModelUrl && !this.progressiveModelUrl;
            for (const option of Array.from(representation.options))
                option.disabled = option.value === 'cubes' ? !this.blockModelUrl : !this.progressiveModelUrl;
            this.updateWorldModel();
        } catch (error) {
            if (generation !== this.generation) return;
            controller.abort();
            this.worldModel.clear();
            this.manifest = undefined;
            this.map = undefined;
            this.layers = [];
            dispose(this.resources);
            this.texture?.dispose();
            this.texture = undefined;
            this.error(error);
        }
    }

    private get blockMode(): boolean {
        return (
            !!this.blockModelUrl &&
            (el('world-representation') as HTMLSelectElement).value === 'cubes'
        );
    }

    private updateCubeSizeControl(): void {
        const size = this.worldModelManifest?.cellSizeCm;
        if (size) {
            input('cube-size').max = String(Math.log2(6400 / size));
            el('cube-size-note').textContent = `${number(size / 100)} m nearby. Distant detail is budget-limited; the complete coarse base stays loaded.`;
        }
        const factor = 2 ** value('cube-size');
        el('cube-size-value').textContent = size
            ? `${factor}\u00d7 (${number(factor * size / 100)} m)`
            : `${factor}\u00d7 (loading resolution)`;
        this.worldModel.setCubeSizeFactor(factor);
    }

    private updateWorldModel(): void {
        this.worldModelManifest = undefined;
        el('cube-size-label').hidden = !this.blockMode;
        this.updateCubeSizeControl();
        el('world-cutaway-label').hidden = true;
        const modelUrl =
            (el('world-representation') as HTMLSelectElement).value === 'triangles'
                ? this.progressiveModelUrl
                : this.blockModelUrl;
        if (!modelUrl || !this.manifest || !this.map) {
            this.worldModel.clear();
            el('world-model-status').textContent =
                'No 3D geometry available. Unavailable areas remain empty.';
            el('world-model-retry').hidden = true;
            this.controls.maxPolarAngle = this.movementMode === 'camera' ? Math.PI - 0.001 : Math.PI * 0.495;
        } else {
            const m = this.manifest;
            this.controls.maxPolarAngle = this.movementMode === 'camera' ? Math.PI - 0.001 : Math.PI * 0.98;
            void this.worldModel.enable({
                url: modelUrl,
                mapKey: this.selectedKey,
                centerX: (m.originX + m.maxX) / 2,
                centerY: (m.originY + m.maxY) / 2,
                mapBounds: this.map.coordinates,
                texture: this.texture,
            });
        }
        this.appearance();
    }

    private setPanelExpanded(expanded: boolean): void {
        el('control-panel').hidden = !expanded;
        document.body.classList.toggle('panel-collapsed', !expanded);
        const toggle = el('panel-toggle');
        toggle.setAttribute('aria-expanded', String(expanded));
        toggle.setAttribute('aria-label', expanded ? 'Collapse controls' : 'Expand controls');
        toggle.title = expanded ? 'Collapse controls' : 'Expand controls';
        toggle.textContent = expanded ? '\u2039' : '\u203a';
    }

    private setProjection(projection: Projection): void {
        this.stopFlight();
        const previous = this.camera.position.clone();
        const rect = this.renderer.domElement.getBoundingClientRect();
        this.camera = changeProjection(this.camera, this.controls.target, projection, rect.width / Math.max(1, rect.height));
        this.controls.object = this.camera;
        this.controls.update();
        this.lastCameraPosition.copy(previous);
        this.enforceCameraCollision();
        this.lastCameraPosition.copy(this.camera.position);
        this.surfaceDrag = undefined;
        this.appearance();
    }

    private home(top: boolean): void {
        if (!this.manifest) return;
        this.stopFlight();
        const m = this.manifest;
        const span = Math.max(m.maxX - m.originX, m.maxY - m.originY) / 100;
        const elevation = (m.minZ + m.maxZ) / 200;
        this.controls.target.set(0, elevation, 0);
        this.orbitPivot.copy(this.controls.target);
        this.camera.position.set(
            top ? 0 : span * 0.7,
            elevation + span * (top ? 1.5 : 0.8),
            top ? 0.01 : span * 0.9,
        );
        this.camera.near = 1;
        this.controls.update();
        const rect = this.renderer.domElement.getBoundingClientRect();
        fitMapCamera(this.camera, new THREE.Box3(
            new THREE.Vector3(-(m.maxX - m.originX) / 200, m.minZ / 100, -(m.maxY - m.originY) / 200),
            new THREE.Vector3((m.maxX - m.originX) / 200, m.maxZ / 100, (m.maxY - m.originY) / 200),
        ), rect.width / Math.max(1, rect.height));
        this.controls.update();
        this.homeView = top;
        this.lastCameraPosition.copy(this.camera.position);
    }

    private setMovementMode(mode: 'world' | 'camera'): void {
        this.stopFlight();
        this.homeView = undefined;
        this.surfaceDrag = undefined;
        this.movementMode = mode;
        (el('movement-mode') as HTMLSelectElement).value = mode;
        el('movement-mode-status').textContent = `Movement mode: ${mode === 'camera' ? 'Camera' : 'World'}`;
        el('camera-look-options').hidden = mode !== 'camera';
        this.controls.maxPolarAngle = mode === 'camera' ? Math.PI - 0.001 :
            this.worldModel.active ? Math.PI * 0.98 : Math.PI * 0.495;
        this.controls.update();
        this.lastCameraPosition.copy(this.camera.position);
        el('camera-collision-status').textContent = '';
    }

    private enforceCameraCollision(): void {
        const status = el('camera-collision-status');
        status.textContent = '';
        if (this.movementMode !== 'camera') return;
        this.camera.near = Math.min(this.camera.near, 0.1);
        this.camera.updateProjectionMatrix();
        const requested = this.camera.position.clone().sub(this.lastCameraPosition);
        if (requested.lengthSq() < 1e-12) return;
        this.scene.updateMatrixWorld(true);
        const meshes = this.worldModel.meshes;
        const allowed = meshes.length === 0 ? new THREE.Vector3() :
            terrainCameraTravel(this.lastCameraPosition, this.camera.position,
                ray => ray.intersectObjects(meshes, false)[0]?.distance);
        const correction = allowed.sub(requested);
        if (correction.lengthSq() < 1e-12) return;
        this.camera.position.add(correction);
        this.controls.target.add(correction);
        this.orbitPivot.add(correction);
        this.controls.update();
        status.textContent = meshes.length === 0
            ? 'Movement paused: 3D terrain is loading.'
            : 'Movement blocked by streamed terrain.';
    }

    private viewRay(ndc: THREE.Vector2): THREE.Raycaster {
        this.scene.updateMatrixWorld(true);
        this.camera.updateMatrixWorld();
        const ray = new THREE.Raycaster();
        ray.setFromCamera(ndc, this.camera);
        return ray;
    }

    private surfaceHit(ray: THREE.Raycaster): THREE.Intersection | undefined {
        if (!this.map || !this.manifest) return;
        const modelMeshes = new Set(this.worldModel.meshes);
        return ray.intersectObjects([...modelMeshes], false).find((hit) => {
            const world = this.toWorld(hit.point),
                c = this.map!.coordinates;
            return (
                world.x >= c.minX &&
                world.x <= c.maxX &&
                world.y >= c.minY &&
                world.y <= c.maxY &&
                this.worldModel.clipPlane.distanceToPoint(hit.point) >= 0
            );
        });
    }

    private surfaceAt(x?: number, y?: number): THREE.Vector3 | undefined {
        const rect = this.renderer.domElement.getBoundingClientRect();
        const ndc =
            x === undefined || y === undefined
                ? new THREE.Vector2()
                : new THREE.Vector2(
                      ((x - rect.left) / rect.width) * 2 - 1,
                      (-(y - rect.top) / rect.height) * 2 + 1,
                  );
        return this.surfaceHit(this.viewRay(ndc))?.point;
    }

    private rebaseSurfaceFocus(): void {
        const focus = this.surfaceAt();
        if (focus) {
            this.controls.target.copy(focus);
            this.controls.update();
        }
    }

    private stopFlight(): void {
        this.flightKeys.clear();
        this.flightDistance = undefined;
        this.flightTime = undefined;
        this.flightFast = false;
    }

    private updateFlight(now: number): void {
        if (this.flightDistance === undefined) return;
        const previous = this.flightTime ?? now;
        this.flightTime = now;
        const forward = Number(this.flightKeys.has('KeyW')) - Number(this.flightKeys.has('KeyS'));
        const strafe = Number(this.flightKeys.has('KeyD')) - Number(this.flightKeys.has('KeyA'));
        this.orbitPivot.add(moveCamera(
            this.camera,
            this.controls.target,
            forward,
            strafe,
            (now - previous) / 1000,
            this.flightDistance,
            this.flightFast,
            this.movementMode,
        ));
    }

    private dolly(pixels: number): void {
        if (!this.manifest || !this.map) return;
        dollySurface(
            this.camera,
            this.controls.target,
            this.surfaceAt(),
            pixels,
            this.controls.maxDistance,
        );
        this.controls.update();
    }

    private buildResources(): void {
        if (!this.map || !this.manifest) return;
        el('resource-details').textContent = 'No resource selected.';
        // Marker textures are shared across redraws.
        this.resources.traverse((object) => {
            if (object instanceof THREE.Points) {
                object.geometry.dispose();
                (object.material as THREE.Material).dispose();
            }
        });
        this.resources.clear();
        this.layers = [];
        this.world.updateClusterConfig({
            enabled: checked('cluster-enabled'),
            radius: value('cluster-radius'),
            minClusterSize: 3,
            maxLevels: 4,
        });
        el('cluster-radius-value').textContent = `${number(value('cluster-radius'))} cm`;
        const options = el('resource-options');
        options.replaceChildren();
        for (const [name, nodes] of Object.entries(this.world.pointsByResource)) {
            if (!nodes.length) continue;
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute(
                'position',
                new THREE.BufferAttribute(
                    resourcePositions(
                        nodes.map((point) => [point.x, point.y, point.z]),
                        this.manifest,
                    ),
                    3,
                ),
            );
            geometry.computeBoundingSphere();
            const points = new THREE.Points(
                geometry,
                new THREE.PointsMaterial({
                    color: nodes[0].colorHex,
                    map: this.marker,
                    transparent: true,
                    alphaTest: 0.2,
                    clippingPlanes: [this.worldModel.clipPlane],
                    depthWrite: false,
                }),
            );
            const glow = new THREE.Points(
                geometry,
                new THREE.PointsMaterial({
                    color: nodes[0].colorHex,
                    map: this.glow,
                    transparent: true,
                    opacity: 0.5,
                    blending: THREE.AdditiveBlending,
                    clippingPlanes: [this.worldModel.clipPlane],
                    depthWrite: false,
                }),
            );
            points.renderOrder = 10;
            glow.renderOrder = 9;
            this.resources.add(glow, points);
            this.layers.push({ points, glow, nodes });
            const label = document.createElement('label');
            label.className = 'resource-option';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.dataset.resource = name;
            checkbox.checked = !this.hidden.has(name);
            const count = nodes.reduce(
                (sum, point) => sum + (point.type === 'cluster' ? point.count : 1),
                0,
            );
            const swatch = document.createElement('span');
            swatch.className = 'swatch';
            swatch.style.backgroundColor = nodes[0].colorHex;
            label.append(
                checkbox,
                swatch,
                document.createTextNode(
                    `${name}: ${count.toLocaleString()} (${nodes.filter((point) => point.type === 'cluster').length} clusters)`,
                ),
            );
            options.append(label);
            checkbox.addEventListener('change', () => {
                if (checkbox.checked) this.hidden.delete(name);
                else this.hidden.add(name);
                this.updateVisibility();
            });
        }
        this.appearance();
    }

    private updateVisibility(clearSelection = true): void {
        let total = 0;
        let visibleCount = 0;
        for (const layer of this.layers) {
            const name = layer.nodes[0].resourceType;
            const visible = !this.hidden.has(name) && (name !== 'Debug' || checked('debug-toggle'));
            layer.points.visible = visible;
            layer.glow.visible = visible && checked('resource-glow');
            const count = layer.nodes.reduce(
                (sum, point) => sum + (point.type === 'cluster' ? point.count : 1),
                0,
            );
            total += count;
            if (visible) visibleCount += count;
        }
        el('resource-options')
            .querySelectorAll<HTMLInputElement>('input')
            .forEach((checkbox) => {
                checkbox.checked = !this.hidden.has(checkbox.dataset.resource ?? '');
                if (checkbox.dataset.resource === 'Debug' && checkbox.parentElement)
                    checkbox.parentElement.hidden = !checked('debug-toggle');
            });
        el('resource-summary').textContent =
            `${visibleCount.toLocaleString()} / ${total.toLocaleString()} resource nodes`;
        if (clearSelection) el('resource-details').textContent = 'No resource selected.';
    }

    private appearance(): void {
        const cutHeight = value('world-cutaway');
        el('world-cutaway-value').textContent = `${number(cutHeight)} m`;
        this.worldModel.setAppearance({
            exaggeration: 1,
            opacity: value('terrain-opacity'),
            lighting: checked('shading'),
            wireframe: checked('wireframe'),
            slopes: false,
            cutHeightCm: cutHeight * 100,
        });
        el('terrain-opacity-value').textContent = `${number(value('terrain-opacity') * 100)}%`;
        el('debug-panel').hidden = !checked('debug-toggle');
        document.body.classList.toggle('show-debug', checked('debug-toggle'));
        for (const layer of this.layers) {
            layer.points.material.size = value('resource-size');
            layer.glow.material.size = value('resource-size') * 2.5;
            layer.points.material.depthTest = layer.glow.material.depthTest =
                !checked('resource-through');
            layer.points.material.sizeAttenuation = layer.glow.material.sizeAttenuation =
                checked('size-attenuation');
        }
        this.updateVisibility(false);
    }

    private pick(event: PointerEvent, select: boolean): void {
        if (!this.map || !this.manifest) return;
        const rect = this.renderer.domElement.getBoundingClientRect();
        const ray = this.viewRay(
            new THREE.Vector2(
                ((event.clientX - rect.left) / rect.width) * 2 - 1,
                (-(event.clientY - rect.top) / rect.height) * 2 + 1,
            ),
        );
        const ground = this.surfaceHit(ray);
        if (ground) {
            const world = this.toWorld(ground.point);
            const ark = this.map.coordinates.getArkCoordinates(world);
            el('cursor-details').textContent =
                `Cursor: Lat ${ark.lat.toFixed(2)} / Long ${ark.long.toFixed(2)}`;
            const c = this.map.coordinates;
            el('debug-panel').textContent =
                `Canvas ${number(event.clientX - rect.left)}, ${number(event.clientY - rect.top)}\nWorld XYZ (cm): ${number(world.x)}, ${number(world.y)}, ${number(world.z)}\nARK: ${number(ark.lat)}, ${number(ark.long)}\nBounds: ${number(c.minX)}…${number(c.maxX)} / ${number(c.minY)}…${number(c.maxY)}`;
            el('debug-panel').textContent +=
                `\nZ bounds: ${number(c.minZ)}…${number(c.maxZ)}\nCenter XY: ${number(c.centerX)}, ${number(c.centerY)}\nScale XY: ${number(c.scaleX)}, ${number(c.scaleY)}\nARK Z: ${number(ark.z)}`;
        } else el('cursor-details').textContent = 'Cursor: no terrain';
        if (ray.params.Points)
            ray.params.Points.threshold =
                worldUnitsPerPixel(this.camera, rect.height, this.camera.position.distanceTo(this.controls.target)) *
                (value('resource-size') + 4) / 2;
        const hits = ray
            .intersectObjects(
                this.layers.filter((layer) => layer.points.visible).map((layer) => layer.points),
            )
            .filter(
                (hit) =>
                    this.worldModel.clipPlane.distanceToPoint(hit.point) >= 0 &&
                    (checked('resource-through') ||
                        hit.distance <= (ground?.distance ?? Infinity) + 0.01),
            )
            .sort((a, b) => (a.distanceToRay ?? Infinity) - (b.distanceToRay ?? Infinity));
        const hit = hits[0];
        const layer = hit && this.layers.find((layer) => layer.points === hit.object);
        if (layer && hit.index !== undefined) {
            const point = layer.nodes[hit.index];
            const ark = this.map.coordinates.getArkCoordinates(point);
            const text = `${point.resourceType}${point.type === 'cluster' ? ` · ${point.count} nodes (centroid)` : ''}\nLat ${number(ark.lat)} / Long ${number(ark.long)}\nWorld XYZ (cm): ${number(point.x)}, ${number(point.y)}, ${number(point.z)}\nHeight ${number(point.z / 100)} m`;
            if (select) el('resource-details').textContent = text;
            else el('cursor-details').textContent += `\n${text}`;
        } else if (select) el('resource-details').textContent = 'No resource selected.';
    }

    private toWorld(point: THREE.Vector3): { x: number; y: number; z: number } {
        const m = this.manifest!;
        return {
            x: point.x * 100 + (m.originX + m.maxX) / 2,
            y: point.z * 100 + (m.originY + m.maxY) / 2,
            z: point.y * 100,
        };
    }
}
