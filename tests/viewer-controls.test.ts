import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync('root/index.html', 'utf8');
const viewer = readFileSync('src/viewer.ts', 'utf8');

test('movement modes, middle-click toggle, upright default and persistent cursor label are wired', () => {
    assert.match(html, /value="world" selected>World/);
    assert.match(html, /id="camera-invert-y" type="checkbox" \/>/);
    assert.match(html, /id="movement-mode-status">Movement mode: World/);
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

test('orthographic north-up defaults, projection selector and accessible panel toggle are wired', () => {
    assert.match(html, /value="orthographic" selected>Orthographic/);
    assert.match(html, /value="perspective">Perspective/);
    assert.match(html, /id="panel-toggle"[^>]+aria-controls="control-panel"[^>]+aria-expanded="true"/);
    assert.match(viewer, /private camera: MapCamera = new THREE.OrthographicCamera/);
    assert.match(viewer, /this.home\(true\);/);
    assert.match(viewer, /this.controls.object = this.camera/);
    assert.match(viewer, /fitMapCamera\(this.camera/);
    assert.match(html, /X Y Z Yaw Pitch/);
    assert.ok(!viewer.includes('World XYZ (cm): ${point.x},'));
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
    for (const id of ['warnings', 'world-model-status', 'world-model-details']) {
        assert.match(html, new RegExp(`<[^>]+id="${id}"[^>]+data-debug`));
    }
    for (const id of ['image-warning', 'error', 'world-model-retry']) {
        const tag = html.match(new RegExp(`<[^>]+id="${id}"[^>]*>`))?.[0];
        assert.ok(tag, id);
        assert.ok(!tag.includes('data-debug'), id);
    }
    assert.match(viewer, /!status.retry && this.worldModel.meshes.length > 0/);
    assert.match(viewer, /classList.toggle\('show-debug', checked\('debug-toggle'\)\)/);
});

test('viewer only loads and picks extracted 3D geometry, never heightfield tiles', () => {
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
    assert.match(viewer, /No 3D extraction published/);
    assert.ok(!html.includes('the heightfield fills uncovered'));
});

test('only cubes and triangles are offered; cube sizing and clipboard actions are public controls', () => {
    const select = html.match(/<select id="world-representation">([\s\S]*?)<\/select>/)![1];
    assert.deepEqual([...select.matchAll(/<option[^>]*value="([^"]+)"/g)].map(m => m[1]), ['cubes', 'triangles']);
    assert.match(select, /value="cubes" selected>Cubes/);
    assert.match(select, /value="triangles">Triangles/);
    for (const id of ['camera-copy', 'camera-paste', 'camera-status', 'cube-size-label']) {
        const tag = html.match(new RegExp(`<[^>]+id="${id}"[^>]*>`))![0];
        assert.ok(!tag.includes('data-debug'));
    }
    assert.match(viewer, /navigator.clipboard.readText\(\)/);
    assert.match(viewer, /this.worldModel.setCubeSizeFactor\(factor\)/);
});
