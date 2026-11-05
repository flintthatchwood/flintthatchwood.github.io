import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync('root/index.html', 'utf8');
const viewer = readFileSync('src/viewer.ts', 'utf8');

test('renderer preserves distant cube depth precision without sacrificing close camera clearance', () => {
    assert.match(viewer, /new THREE\.WebGLRenderer\(\{[^}]*logarithmicDepthBuffer: true/);
});

test('movement modes, middle-click toggle, upright default and compact coordinates are wired', () => {
    assert.match(html, /value="world" selected>World/);
    assert.match(html, /id="camera-invert-y" type="checkbox" \/>/);
    assert.match(html, /id="camera-details">ARK:/);
    assert.match(html, /id="cursor-details">Cursor:/);
    assert.ok(!viewer.includes("el('coordinates').textContent"));
    assert.match(viewer, /const toggleMovement = event.button === 1/);
    assert.match(viewer, /!this.surfaceDrag.started/);
    assert.match(viewer, /lookCamera\(this.camera/);
    assert.match(viewer, /this.enforceCameraCollision\(\)/);
    assert.match(viewer, /terrainCameraTravel\(this.lastCameraPosition/);
    assert.match(viewer, /Movement paused: 3D terrain is loading/);
});

test('WASD flight is continuous, does not steal form input and stops on focus loss', () => {
    assert.match(viewer, /this.updateFlight\(now\)/);
    assert.match(viewer, /window.addEventListener\('keydown'/);
    assert.match(viewer, /window.addEventListener\('keyup'/);
    assert.match(viewer, /event.ctrlKey \|\| event.altKey \|\| event.metaKey/);
    assert.match(viewer, /input, textarea, select, button, \[contenteditable\]/);
    assert.match(viewer, /window.addEventListener\('blur', \(\) => this.stopFlight\(\)\)/);
    assert.match(viewer, /document.addEventListener\('visibilitychange'/);
    assert.match(viewer, /event.repeat && !this.flightKeys.has\(event.code\)/);
    assert.match(viewer, /canvas.focus\(\{ preventScroll: true \}\)/);
    assert.match(html, /WASD: World pan \/ Camera flight · Shift: faster/);
    assert.ok(!html.includes('Mouse mode'));
    assert.ok(!viewer.includes('mouseMode'));
    assert.match(viewer, /this.flightFast,\s+this.movementMode/);
});

test('Space and C share continuous movement, input guards and key-release handling with WASD', () => {
    assert.match(viewer, /const FLIGHT_KEYS = \['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'KeyC'\]/);
    assert.match(viewer, /if \(FLIGHT_KEYS.includes\(event.code\)\)/);
    assert.match(viewer, /!FLIGHT_KEYS.some\(key => this.flightKeys.has\(key\)\)/);
    assert.match(viewer, /const vertical = Number\(this.flightKeys.has\('Space'\)\) - Number\(this.flightKeys.has\('KeyC'\)\)/);
    assert.match(viewer, /this.movementMode,\s+vertical,/);
    assert.match(viewer, /Space up, C down/);
    assert.match(html, /Space: up · C: down/);
});

test('perspective-only north-up camera and accessible panel toggle are wired', () => {
    assert.doesNotMatch(html, /camera-projection|orthographic/i);
    assert.doesNotMatch(viewer, /setProjection|changeProjection|orthographic/i);
    assert.match(html, /id="panel-toggle"[^>]+aria-controls="control-panel"[^>]+aria-expanded="true"/);
    assert.match(viewer, /private camera: MapCamera = new THREE.PerspectiveCamera/);
    assert.match(viewer, /this.home\(true\);/);
    assert.match(viewer, /fitMapCamera\(this.camera/);
    assert.match(html, /X Y Z Yaw Pitch/);
    assert.ok(!viewer.includes('World XYZ (cm): ${point.x},'));
});

test('terrain context menu snapshots the clicked surface CCC and preserves right-drag panning', () => {
    assert.match(html, /id="terrain-context-menu" popover="auto" role="menu"/);
    assert.match(html, /id="terrain-point-copy"[^>]+role="menuitem"[^>]+disabled>Copy CCC/);
    assert.match(viewer, /canvas.addEventListener\('contextmenu'/);
    assert.match(viewer, /if \(event.button === 2 && contextPress\?\.dragged\) return/);
    assert.match(viewer, /this.surfaceAt\(event.clientX, event.clientY\)/);
    assert.match(viewer, /\[world.x, world.y, world.z\]/);
    assert.match(viewer, /copyPoint.disabled = code === undefined/);
    assert.match(viewer, /void this.copyCoordinates\(code\)/);
    assert.match(viewer, /const code = pointCode \?\? this.ccc\(\)/);
    assert.match(viewer, /contextPress.dragged = true/);
    assert.match(viewer, /\(event.buttons & 2\) !== 0/);
    assert.match(viewer, /innerWidth - rect.width - 8/);
    assert.match(viewer, /innerHeight - rect.height - 8/);
    assert.match(viewer, /menu.showPopover\(\)/);
    assert.match(viewer, /hidePopover\(\)/);
});

test('retired terrain controls have no markup or viewer wiring', () => {
    for (const id of [
        'terrain-style',
        'exaggeration',
        'factor',
        'despike-enabled',
        'spike-threshold',
        'spike-threshold-value',
        'despike-status',
        'walkability-enabled',
        'walkability-retry',
        'walkability-status',
        'walkability-slope',
        'walkability-warnings',
    ]) {
        assert.ok(!html.includes(`id="${id}"`), id);
        assert.ok(!viewer.includes(`'${id}'`), id);
    }
    assert.ok(!viewer.includes("from './walkability.js'"));
    assert.ok(!viewer.includes("from './despike.js'"));
    assert.ok(!viewer.includes("from './terrain-blocks.js'"));
    assert.match(viewer, /exaggeration: 1/);
    assert.match(viewer, /slopes: false/);
});

test('panel diagnostics are debug-only without hiding actionable failures', () => {
    assert.match(html, /body:not\(\.show-debug\) \[data-debug\]/);
    for (const id of ['warnings', 'world-model-status', 'world-model-details', 'near-cube-size-label', 'cube-size-label']) {
        assert.match(html, new RegExp(`<[^>]+id="${id}"[^>]+data-debug`));
    }
    for (const id of ['shading', 'wireframe'])
        assert.match(html, new RegExp(`<label data-debug><input id="${id}"`));
    for (const id of ['image-warning', 'error', 'world-model-retry']) {
        const tag = html.match(new RegExp(`<[^>]+id="${id}"[^>]*>`))?.[0];
        assert.ok(tag, id);
        assert.ok(!tag.includes('data-debug'), id);
    }
    assert.match(viewer, /!status.retry && this.worldModel.meshes.length > 0/);
    assert.match(viewer, /classList.toggle\('show-debug', checked\('debug-toggle'\)\)/);
});

test('clicking the pinned voxel unpins while other voxel clicks replace the selection', () => {
    for (const id of ['debug-inspection-details', 'debug-unpin'])
        assert.match(html, new RegExp(`id="${id}"`));
    assert.match(html, /id="debug-unpin" type="button" hidden[^>]*>Unpin/);
    assert.match(viewer, /this\.worldModel\.cubeSizeCm\(ground\.object\)/);
    assert.match(viewer, /voxelAt\(world, normal, this\.worldModelManifest\.bounds, pinned\.sizeCm\)\.tuple === pinned\.tuple/);
    assert.match(viewer, /this\.pinnedDebug = unpin \? undefined : this\.hoverDebug/);
    assert.match(viewer, /if \(!unpin && voxel\) this\.pinVoxel\(voxel\)/);
    assert.match(viewer, /this\.pinnedDebug \?\? this\.hoverDebug/);
    assert.match(viewer, /new THREE\.EdgesGeometry\(box\)/);
    assert.match(viewer, /outline\.raycast = \(\) => \{\}/);
    assert.match(viewer, /el\('debug-unpin'\)\.addEventListener\('click'/);
    const loading = viewer.slice(viewer.indexOf('private async load('), viewer.indexOf('private async load(') + 600);
    assert.match(loading, /this\.pinnedDebug = undefined/);
});

test('camera and cursor coordinates share a compact readout with debug-only diagnostics', () => {
    assert.match(html, /id="coordinates"[^>]+aria-label="Terrain inspection"/);
    assert.match(html, /id="debug-panel" data-debug/);
    assert.match(html, /id="world-dimensions" data-debug/);
    assert.ok(html.indexOf('id="world-dimensions"') > html.indexOf('id="debug-toggle"'));
    assert.ok(html.indexOf('id="world-dimensions"') < html.indexOf('</aside>'));
    assert.match(viewer, /'Pinned' : 'Cursor'/);
    assert.match(viewer, /\\nVoxel: \$\{voxel\.tuple\.slice\(1, -1\)\}m/);
    assert.match(viewer, /\\nCanvas:/);
    assert.doesNotMatch(viewer, /Solid fill:|Under cursor:|Min XYZ \(m\):|Max XYZ \(m\):/);
    assert.match(viewer, /World:\\nBounds:\\n {2}X:/);
});

test('near and far cube sliders share resolution limits and send the changed control to linked sizing', () => {
    assert.match(html, /Near cube minimum/);
    assert.match(html, /id="near-cube-size" type="range"[^>]+value="0"/);
    assert.match(html, /id="near-cube-size-value" for="near-cube-size"/);
    assert.match(viewer, /updateCubeSizeControl\('near'\)/);
    assert.match(viewer, /updateCubeSizeControl\('far'\)/);
    assert.match(viewer, /for \(const id of \['near-cube-size', 'cube-size'\]\)/);
    assert.match(viewer, /cubeSizeFactors\(2 \*\* value\('near-cube-size'\), 2 \*\* value\('cube-size'\), changed\)/);
    assert.match(viewer, /this.worldModel.setCubeSizeFactors\(factors.near, factors.far\)/);
    assert.match(viewer, /el\('near-cube-size-label'\).hidden = !this.blockModelUrl/);
});

test('resource markers and glow use fixed screen sizes without an attenuation control', () => {
    assert.ok(!html.includes('size-attenuation'));
    assert.ok(!html.includes('Size attenuation'));
    assert.ok(!viewer.includes('size-attenuation'));
    for (const texture of ['marker', 'glow'])
        assert.match(viewer, new RegExp(`map: this\\.${texture},\\s+sizeAttenuation: false`));
    assert.match(viewer, /layer\.points\.material\.size = value\('resource-size'\)/);
    assert.match(viewer, /layer\.glow\.material\.size = value\('resource-size'\) \* 2\.5/);
});

test('world barriers have an independent non-debug visibility toggle and never enter terrain camera collision', () => {
    assert.match(html, /id="show-world-boundaries" type="checkbox" checked/);
    assert.match(viewer, /'show-world-boundaries',/);
    assert.match(viewer, /worldBoundaries\.group\.visible = checked\('show-world-boundaries'\)/);
    const collision = viewer.slice(viewer.indexOf('private enforceCameraCollision():'), viewer.indexOf('private viewRay('));
    assert.match(collision, /const meshes = this\.worldModel\.meshes/);
    assert.ok(!collision.includes('worldBoundaries'));
    const toggle = html.match(/<label id="world-boundary-toggle"[^>]*>/)![0];
    assert.ok(!toggle.includes('data-debug'));
});

test('clustering controls follow the resource list and summary', () => {
    const list = html.indexOf('id="resource-options"');
    const summary = html.indexOf('id="resource-summary"');
    const enabled = html.indexOf('id="cluster-enabled"');
    const radius = html.indexOf('id="cluster-radius"');
    assert.ok(list >= 0 && summary > list && enabled > summary && radius > enabled);
    for (const id of ['cluster-enabled', 'cluster-radius'])
        assert.equal(html.match(new RegExp(`id="${id}"`, 'g'))?.length, 1);
});

test('viewer uses extracted geometry or an explicit flat map, never sampled heightfield tiles', () => {
    for (const retired of [
        'decodeHeights',
        'terrainGeometry',
        'lodStride',
        'visibleTiles',
        'rebuild(',
        'this.terrain',
        'this.surfaces',
        'suppressFallback',
        'Smooth · 5 m source',
    ])
        assert.ok(!viewer.includes(retired), retired);
    assert.match(viewer, /intersectObjects\(\[\.\.\.modelMeshes\], false\)/);
    assert.match(viewer, /this.flatMap = flatMapMesh/);
    assert.match(viewer, /const visible = this.worldModel.meshes.length === 0/);
    assert.match(viewer, /positions.setY\(i, visible \? 0 : elevations.getX\(i\)\)/);
    assert.ok(!viewer.includes('this.resources.scale.y = 0'));
    assert.match(viewer, /Terrain metadata unavailable/);
    assert.ok(!html.includes('the heightfield fills uncovered'));
});

test('viewer is cube-only without representation selection; clipboard remains public and cube sizing is wired', () => {
    assert.ok(!html.includes('world-representation'));
    assert.ok(!html.includes('World representation'));
    assert.ok(!viewer.includes('world-representation'));
    assert.ok(!viewer.includes('progressiveModel'));
    assert.ok(!viewer.includes("searchParams.get('world')"));
    assert.match(viewer, /this.blockModelUrl = manifest.cubeModel/);
    assert.match(viewer, /const modelUrl = this.blockModelUrl;/);
    assert.match(viewer, /el\('cube-size-label'\).hidden = !this.blockModelUrl/);
    for (const id of ['camera-copy', 'camera-paste', 'camera-status']) {
        const tag = html.match(new RegExp(`<[^>]+id="${id}"[^>]*>`))![0];
        assert.ok(!tag.includes('data-debug'));
    }
    assert.match(viewer, /navigator.clipboard.readText\(\)/);
    assert.match(viewer, /this.worldModel.setCubeSizeFactors\(factors.near, factors.far\)/);
});
