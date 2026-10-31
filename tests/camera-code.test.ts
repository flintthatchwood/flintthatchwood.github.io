import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { cameraCodeDirection, decodeCameraCode, encodeCameraCode } from '../src/camera-code.js';

test('ccc accepts five numbers in X Y Z Yaw Pitch order', () => {
    const expected = { position: [179012, 5646, -9695], yaw: -135.59, pitch: -6 };
    assert.deepEqual(decodeCameraCode('179012 5646 -9695 -135.59 -6.00'), expected);
    assert.deepEqual(decodeCameraCode(' ccc 179012, 5646, -9695, -135.59, -6.00 '), expected);
});

test('ccc copies yaw before pitch and rounds every field to two decimals', () => {
    const facing = cameraCodeDirection({ position: [0, 0, 0], yaw: 21.2884, pitch: -69.863 });
    const text = encodeCameraCode([-250411.123, -250164.876, 80975.844], facing);
    assert.equal(text, '-250411.12 -250164.88 80975.84 21.29 -69.86');
    assert.ok(cameraCodeDirection(decodeCameraCode(text)).distanceTo(facing) < 0.000125);
});

test('ccc converts Unreal yaw and pitch into the viewer XZY axes', () => {
    for (const [pitch, yaw, expected] of [
        [0, 0, [1, 0, 0]],
        [0, 90, [0, 0, 1]],
        [-90, 0, [0, -1, 0]],
        [45, -135, [-0.5, Math.SQRT1_2, -0.5]],
    ] as const) {
        const facing = cameraCodeDirection({ position: [0, 0, 0], pitch, yaw });
        assert.ok(facing.distanceTo(new THREE.Vector3(...expected)) < 1e-12);
    }
});

test('ccc round trips arbitrary camera headings and negative native positions', () => {
    const position: [number, number, number] = [179012.123456, -205606.456789, -117530.046875];
    for (const pitch of [-89.9, -45, -6, 0, 47, 86]) {
        for (const yaw of [-179.9, -135.59, -6, 0, 90, 179.9]) {
            const facing = cameraCodeDirection({ position, pitch, yaw });
            const text = encodeCameraCode(position, facing);
            assert.equal(text.split(' ').length, 5);
            const copy = decodeCameraCode(text);
            copy.position.forEach((value, axis) =>
                assert.ok(Math.abs(value - position[axis]) <= 0.005001),
            );
            assert.ok(cameraCodeDirection(copy).distanceTo(facing) < 2e-6);
        }
    }
});

test('invalid ccc inputs fail instead of moving to default coordinates', () => {
    for (const code of [
        '',
        'ccc',
        '1 2 3 4',
        '1 2 3 4 5 6',
        '1 2 3 NaN 5',
        'Infinity 2 3 4 5',
        '1 2 3 361 5',
        '100000001 2 3 4 5',
        '0xFF 2 3 4 5',
        '1 2 3 four 5',
        '1'.repeat(257),
    ])
        assert.throws(() => decodeCameraCode(code), undefined, code);
    assert.throws(() => encodeCameraCode([0, 0, 0], new THREE.Vector3()));
    assert.throws(() => encodeCameraCode([0, 0, 0], new THREE.Vector3(NaN, 0, 1)));
});
