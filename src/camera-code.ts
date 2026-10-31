import * as THREE from 'three';
import { displayNumber } from './display-number.js';

export interface CameraCode {
    position: [number, number, number];
    pitch: number;
    yaw: number;
}

export function decodeCameraCode(code: string): CameraCode {
    if (code.length > 256) throw new Error('Camera coordinates are too long.');
    const fields = code
        .trim()
        .replace(/^ccc\s+/i, '')
        .split(/[,\s]+/);
    if (
        fields.length !== 5 ||
        fields.some((field) => !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(field))
    )
        throw new Error('Enter X Y Z Yaw Pitch as five numbers.');
    const values = fields.map(Number);
    if (
        values.some((value) => !Number.isFinite(value)) ||
        values.slice(0, 3).some((value) => Math.abs(value) > 100_000_000) ||
        values.slice(3).some((value) => Math.abs(value) > 360)
    )
        throw new Error('Camera coordinates or angles are outside the supported range.');
    return { position: [values[0], values[1], values[2]], yaw: values[3], pitch: values[4] };
}

export function encodeCameraCode(
    position: [number, number, number],
    facing: THREE.Vector3,
): string {
    if (![facing.x, facing.y, facing.z].every(Number.isFinite) || facing.lengthSq() === 0)
        throw new Error('Cannot copy an invalid camera direction.');
    const pitch = THREE.MathUtils.radToDeg(Math.atan2(facing.y, Math.hypot(facing.x, facing.z)));
    const yaw = THREE.MathUtils.radToDeg(Math.atan2(facing.z, facing.x));
    const code = [
        ...position.map(displayNumber),
        displayNumber(yaw),
        displayNumber(pitch),
    ].join(' ');
    decodeCameraCode(code);
    return code;
}

export function cameraCodeDirection(code: CameraCode): THREE.Vector3 {
    const pitch = THREE.MathUtils.degToRad(code.pitch),
        yaw = THREE.MathUtils.degToRad(code.yaw);
    // Unreal XYZ becomes scene XZY; positive pitch looks upward and yaw turns X toward Y.
    return new THREE.Vector3(
        Math.cos(pitch) * Math.cos(yaw),
        Math.sin(pitch),
        Math.cos(pitch) * Math.sin(yaw),
    );
}
