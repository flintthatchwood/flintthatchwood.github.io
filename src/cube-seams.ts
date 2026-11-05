import * as THREE from 'three';
import type { WorldTile } from './world-model.js';

export interface CubeRectangle {
    start: number;
    end: number;
    low: number;
    high: number;
}
interface CubeEdge {
    axis: 0 | 1 | 2;
    plane: number;
    side: -1 | 1;
    start: number;
    end: number;
    low: number;
    high: number;
    rectangles: CubeRectangle[];
    ignored?: CubeRectangle[];
}
export interface CubeSurface {
    edges: CubeEdge[];
    spatial?: boolean;
}
export interface CubeSeamPlan {
    surface: CubeSurface;
    faces: { edge: CubeEdge; rectangle: CubeRectangle }[];
}

export function extractCubeSurface(
    geometry: THREE.BufferGeometry,
    tile: WorldTile,
    centerX: number,
    centerY: number,
    spatial = false,
): CubeSurface {
    const b = tile.bounds;
    const x0 = Math.fround((b.minX - centerX) / 100), x1 = Math.fround((b.maxX - centerX) / 100);
    const z0 = Math.fround((b.minY - centerY) / 100), z1 = Math.fround((b.maxY - centerY) / 100);
    const y0 = Math.fround(b.minZ / 100), y1 = Math.fround(b.maxZ / 100);
    const edges: CubeEdge[] = [
        { axis: 0, plane: x0, side: -1, start: z0, end: z1, low: y0, high: y1, rectangles: [] },
        { axis: 0, plane: x1, side: 1, start: z0, end: z1, low: y0, high: y1, rectangles: [] },
        { axis: 2, plane: z0, side: -1, start: x0, end: x1, low: y0, high: y1, rectangles: [] },
        { axis: 2, plane: z1, side: 1, start: x0, end: x1, low: y0, high: y1, rectangles: [] },
    ];
    if (spatial) edges.push(
        { axis: 1, plane: y0, side: -1, start: x0, end: x1, low: z0, high: z1, rectangles: [] },
        { axis: 1, plane: y1, side: 1, start: x0, end: x1, low: z0, high: z1, rectangles: [] },
    );
    const positions = geometry.getAttribute('position'), index = geometry.getIndex();
    if (!index) throw new Error('Cube surface requires indexed geometry.');
    const coordinate = (vertex: number, axis: number) =>
        axis === 0 ? positions.getX(vertex) : axis === 1 ? positions.getY(vertex) : positions.getZ(vertex);
    const kept = new Uint32Array(index.count);
    const groups: { start: number; count: number; materialIndex: number }[] = [];
    const seen = edges.map(() => new Map<string, number>());
    let cursor = 0;
    for (const group of geometry.groups) {
        const start = cursor;
        for (let i = group.start; i < group.start + group.count; i += 3) {
            const vertices = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
            const edgeIndex = spatial || group.materialIndex === 0 || group.materialIndex === 4
                ? edges.findIndex(edge => vertices.every(v => coordinate(v, edge.axis) === edge.plane))
                : -1;
            if (edgeIndex < 0) {
                if (group.materialIndex === 5)
                    throw new Error('Ignored partition masks must lie on spatial chunk boundaries.');
                kept.set(vertices, cursor);
                cursor += 3;
                continue;
            }
            const edge = edges[edgeIndex], along = edge.axis === 0 ? 2 : 0, vertical = edge.axis === 1 ? 2 : 1;
            const rectangle = {
                start: Math.min(...vertices.map(v => coordinate(v, along))),
                end: Math.max(...vertices.map(v => coordinate(v, along))),
                low: Math.min(...vertices.map(v => coordinate(v, vertical))),
                high: Math.max(...vertices.map(v => coordinate(v, vertical))),
            };
            const key = `${rectangle.start},${rectangle.end},${rectangle.low},${rectangle.high}`;
            let mask = 0;
            for (const vertex of vertices) {
                const horizontal = coordinate(vertex, along), height = coordinate(vertex, vertical);
                if ((horizontal !== rectangle.start && horizontal !== rectangle.end) ||
                    (height !== rectangle.low && height !== rectangle.high))
                    throw new Error('Cube partition cap is not a rectangular triangle pair.');
                mask |= 1 << (Number(horizontal === rectangle.end) + 2 * Number(height === rectangle.high));
            }
            const previous = seen[edgeIndex].get(key);
            if (previous !== undefined) {
                if (previous === 15 || (previous | mask) !== 15 || ![6, 9].includes(previous & mask))
                    throw new Error('Cube partition cap has overlapping or duplicate triangles.');
                seen[edgeIndex].set(key, 15);
            } else {
                seen[edgeIndex].set(key, mask);
                if (group.materialIndex === 5) (edge.ignored ??= []).push(rectangle);
                else edge.rectangles.push(rectangle);
            }
        }
        if (seen.some(edge => [...edge.values()].some(mask => mask !== 15)))
            throw new Error('Cube partition cap has an incomplete rectangular triangle pair.');
        if (cursor > start) groups.push({ start, count: cursor - start, materialIndex: group.materialIndex ?? 0 });
    }
    geometry.setIndex(new THREE.BufferAttribute(kept.slice(0, cursor), 1));
    geometry.clearGroups();
    for (const group of groups) geometry.addGroup(group.start, group.count, group.materialIndex);
    return { edges, spatial };
}

function subtract(rectangle: CubeRectangle, cutter: CubeRectangle): CubeRectangle[] {
    const start = Math.max(rectangle.start, cutter.start), end = Math.min(rectangle.end, cutter.end);
    const low = Math.max(rectangle.low, cutter.low), high = Math.min(rectangle.high, cutter.high);
    if (start >= end || low >= high) return [rectangle];
    const pieces: CubeRectangle[] = [];
    if (rectangle.start < start) pieces.push({ ...rectangle, end: start });
    if (end < rectangle.end) pieces.push({ ...rectangle, start: end });
    if (rectangle.low < low) pieces.push({ start, end, low: rectangle.low, high: low });
    if (high < rectangle.high) pieces.push({ start, end, low: high, high: rectangle.high });
    return pieces;
}

export function planCubeSeams(surfaces: CubeSurface[]): CubeSeamPlan[] {
    const planes = new Map<string, CubeEdge[]>();
    for (const surface of surfaces)
        for (const edge of surface.edges) {
            const key = `${edge.axis}:${edge.plane}`;
            const bucket = planes.get(key) ?? [];
            bucket.push(edge);
            planes.set(key, bucket);
        }
    return surfaces.map(surface => {
        const faces: CubeSeamPlan['faces'] = [];
        for (const edge of surface.edges) {
            const neighbors = planes.get(`${edge.axis}:${edge.plane}`)!
                .filter(other => other.side !== edge.side && other.start < edge.end && other.end > edge.start &&
                    other.low < edge.high && other.high > edge.low);
            for (const rectangle of edge.rectangles) {
                if (surface.spatial) {
                    let pieces = [rectangle];
                    for (const neighbor of neighbors)
                        for (const cutter of [...neighbor.rectangles, ...(neighbor.ignored ?? [])])
                            pieces = pieces.flatMap(piece => subtract(piece, cutter));
                    for (const piece of pieces) faces.push({ edge, rectangle: piece });
                    continue;
                }
                for (const neighbor of neighbors) {
                    const start = Math.max(rectangle.start, neighbor.start), end = Math.min(rectangle.end, neighbor.end);
                    const low = Math.max(rectangle.low, neighbor.low), high = Math.min(rectangle.high, neighbor.high);
                    if (start >= end || low >= high) continue;
                    let pieces = [{ start, end, low, high }];
                    for (const cutter of neighbor.rectangles) {
                        if (cutter.start >= end || cutter.end <= start ||
                            cutter.low >= rectangle.high || cutter.high <= rectangle.low) continue;
                        pieces = pieces.flatMap(piece => subtract(piece, cutter));
                        if (!pieces.length) break;
                    }
                    for (const piece of pieces) faces.push({ edge, rectangle: piece });
                }
            }
        }
        return { surface, faces };
    });
}

export function cubeSeamGeometry(
    plan: CubeSeamPlan,
    bounds: { minX: number; minY: number; maxX: number; maxY: number },
    centerX: number,
    centerY: number,
): THREE.BufferGeometry {
    const positions = new Float32Array(plan.faces.length * 12);
    const uv = new Float32Array(plan.faces.length * 8);
    const indices = new Uint32Array(plan.faces.length * 6);
    for (let i = 0; i < plan.faces.length; i++) {
        const { edge, rectangle: r } = plan.faces[i];
        const corners = [[r.start, r.low], [r.end, r.low], [r.end, r.high], [r.start, r.high]];
        for (let j = 0; j < corners.length; j++) {
            const [along, height] = corners[j], vertex = i * 4 + j;
            const x = edge.axis === 0 ? edge.plane : along;
            const y = edge.axis === 1 ? edge.plane : height;
            const z = edge.axis === 2 ? edge.plane : edge.axis === 1 ? height : along;
            positions.set([x, y, z], vertex * 3);
            uv.set([
                (x * 100 + centerX - bounds.minX) / (bounds.maxX - bounds.minX),
                1 - (z * 100 + centerY - bounds.minY) / (bounds.maxY - bounds.minY),
            ], vertex * 2);
        }
        const a = i * 4, reverse = edge.axis === 2 ? edge.side < 0 : edge.side > 0;
        indices.set(reverse ? [a, a + 2, a + 1, a, a + 3, a + 2] : [a, a + 1, a + 2, a, a + 2, a + 3], i * 6);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    for (let i = 0; i < plan.faces.length; i++) {
        const edge = plan.faces[i].edge;
        const material = edge.axis === 1 ? (edge.side > 0 ? 1 : 0) : 4;
        const previous = geometry.groups[geometry.groups.length - 1];
        if (previous?.materialIndex === material) previous.count += 6;
        else geometry.addGroup(i * 6, 6, material);
    }
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
}
