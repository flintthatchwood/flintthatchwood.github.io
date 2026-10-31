// Simplified 3D R-tree implementation for point-based spatial queries
// Based on rbush-3d by Eronana which is based on rbush by Vladimir Agafonkin

export interface IndexedPoint3D extends Point3D {
    index: number;
}

export interface Point3D extends Point {
    z: number;
}

export interface Point {
    x: number;
    y: number;
}

interface BBox {
    minX: number;
    minY: number;
    minZ: number;
    maxX: number;
    maxY: number;
    maxZ: number;
}

interface Node extends BBox {
    children: (Node | Point3D)[];
    height: number;
    leaf: boolean;
}

// Optimized inline comparison functions
const compareMinX = (a: Point3D | Node, b: Point3D | Node) => {
    return ('x' in a ? a.x : a.minX) - ('x' in b ? b.x : b.minX);
};

const compareMinY = (a: Point3D | Node, b: Point3D | Node) => {
    return ('y' in a ? a.y : a.minY) - ('y' in b ? b.y : b.minY);
};

const compareMinZ = (a: Point3D | Node, b: Point3D | Node) => {
    return ('z' in a ? a.z : a.minZ) - ('z' in b ? b.z : b.minZ);
};

function extend(a: BBox, b: BBox | Point3D): void {
    if ('x' in b) {
        // Point
        a.minX = Math.min(a.minX, b.x);
        a.minY = Math.min(a.minY, b.y);
        a.minZ = Math.min(a.minZ, b.z);
        a.maxX = Math.max(a.maxX, b.x);
        a.maxY = Math.max(a.maxY, b.y);
        a.maxZ = Math.max(a.maxZ, b.z);
    } else {
        // BBox
        a.minX = Math.min(a.minX, b.minX);
        a.minY = Math.min(a.minY, b.minY);
        a.minZ = Math.min(a.minZ, b.minZ);
        a.maxX = Math.max(a.maxX, b.maxX);
        a.maxY = Math.max(a.maxY, b.maxY);
        a.maxZ = Math.max(a.maxZ, b.maxZ);
    }
}

function calcBBox(node: Node): void {
    node.minX = Infinity;
    node.minY = Infinity;
    node.minZ = Infinity;
    node.maxX = -Infinity;
    node.maxY = -Infinity;
    node.maxZ = -Infinity;

    for (const child of node.children) {
        extend(node, child as BBox);
    }
}

function createNode(children: (Node | Point3D)[]): Node {
    const node: Node = {
        children,
        height: 1,
        leaf: true,
        minX: Infinity,
        minY: Infinity,
        minZ: Infinity,
        maxX: -Infinity,
        maxY: -Infinity,
        maxZ: -Infinity,
    };

    // Fast path for empty nodes
    if (children.length === 0) {
        return node;
    }

    calcBBox(node);
    return node;
}

function intersects(a: BBox, b: BBox): boolean {
    return (
        b.minX <= a.maxX &&
        b.minY <= a.maxY &&
        b.minZ <= a.maxZ &&
        b.maxX >= a.minX &&
        b.maxY >= a.minY &&
        b.maxZ >= a.minZ
    );
}

export class RBush3D {
    private readonly data: Node;
    private readonly maxEntries: number;
    readonly points: IndexedPoint3D[]; // Expose points in index order
    readonly length: number;

    constructor(points: IndexedPoint3D[], maxEntries: number = 9) {
        this.maxEntries = Math.max(4, maxEntries);
        // Store points in index order for fast access
        this.points = points.slice().sort((a, b) => a.index - b.index);
        this.data = this.buildFromPoints(points);
        this.length = points.length;
    }

    private buildFromPoints(points: Point3D[]): Node {
        if (!points || points.length === 0) {
            return createNode([]);
        }

        // For small arrays, just create a leaf node directly
        if (points.length <= this.maxEntries) {
            return createNode(points.slice());
        }

        return this.build(points.slice(), 0, points.length - 1, 0);
    }

    search(bbox: BBox): IndexedPoint3D[] {
        const result: IndexedPoint3D[] = [];

        if (!intersects(bbox, this.data)) return result;

        const nodesToSearch: Node[] = [];
        let node: Node | undefined = this.data;

        while (node) {
            const children = node.children;
            const isLeaf = node.leaf;

            for (let i = 0; i < children.length; i++) {
                const child = children[i];

                if (isLeaf) {
                    const point = child as IndexedPoint3D;
                    if (
                        point.x >= bbox.minX &&
                        point.x <= bbox.maxX &&
                        point.y >= bbox.minY &&
                        point.y <= bbox.maxY &&
                        point.z >= bbox.minZ &&
                        point.z <= bbox.maxZ
                    ) {
                        result.push(point);
                    }
                } else {
                    const childNode = child as Node;
                    if (intersects(bbox, childNode)) {
                        nodesToSearch.push(childNode);
                    }
                }
            }
            node = nodesToSearch.pop();
        }

        return result;
    }

    // Search for items within a spherical radius
    searchRadius(x: number, y: number, z: number, radius: number): IndexedPoint3D[] {
        const bbox: BBox = {
            minX: x - radius,
            minY: y - radius,
            minZ: z - radius,
            maxX: x + radius,
            maxY: y + radius,
            maxZ: z + radius,
        };

        const candidates = this.search(bbox);
        const result: IndexedPoint3D[] = [];
        const radiusSquared = radius * radius; // Avoid sqrt by comparing squared distances

        // Filter by actual 3D distance
        for (const point of candidates) {
            const dx = x - point.x;
            const dy = y - point.y;
            const dz = z - point.z;
            const distSquared = dx * dx + dy * dy + dz * dz;

            if (distSquared <= radiusSquared) {
                result.push(point);
            }
        }

        return result;
    }

    private build(items: Point3D[], left: number, right: number, height: number): Node {
        const N = right - left + 1;
        let M = this.maxEntries;

        if (N <= M) {
            // Create leaf node directly from the range without extra slicing
            const children = new Array<Point3D>(N);
            for (let i = 0; i < N; i++) {
                children[i] = items[left + i];
            }
            return createNode(children);
        }

        if (!height) {
            height = Math.ceil(Math.log(N) / Math.log(M));
            M = Math.ceil(N / Math.pow(M, height - 1));
        }

        const node = createNode([]);
        node.leaf = false;
        node.height = height;

        const N3 = Math.ceil(N / M);
        const N2 = N3 * Math.ceil(Math.sqrt(M));

        this.multiSelect(items, left, right, N2, compareMinX);

        for (let i = left; i <= right; i += N2) {
            const right2 = Math.min(i + N2 - 1, right);
            this.multiSelect(items, i, right2, N3, compareMinY);

            for (let j = i; j <= right2; j += N3) {
                const right3 = Math.min(j + N3 - 1, right2);
                this.multiSelect(items, j, right3, 1, compareMinZ);

                node.children.push(this.build(items, j, right3, height - 1));
            }
        }

        calcBBox(node);
        return node;
    }

    private multiSelect(
        arr: Point3D[],
        left: number,
        right: number,
        n: number,
        compare: (a: Point3D | Node, b: Point3D | Node) => number,
    ): void {
        const stack = [left, right];

        while (stack.length) {
            right = stack.pop()!;
            left = stack.pop()!;

            if (right - left <= n) continue;

            const mid = left + Math.ceil((right - left) / n / 2) * n;
            this.quickselect(arr, mid, left, right, compare);

            stack.push(left, mid, mid, right);
        }
    }

    private quickselect(
        arr: Point3D[],
        k: number,
        left: number,
        right: number,
        compare: (a: Point3D | Node, b: Point3D | Node) => number,
    ): void {
        while (right > left) {
            if (right - left > 600) {
                const n = right - left + 1;
                const m = k - left + 1;
                const z = Math.log(n);
                const s = 0.5 * Math.exp((2 * z) / 3);
                const sd = 0.5 * Math.sqrt((z * s * (n - s)) / n) * (m - n / 2 < 0 ? -1 : 1);
                const newLeft = Math.max(left, Math.floor(k - (m * s) / n + sd));
                const newRight = Math.min(right, Math.floor(k + ((n - m) * s) / n + sd));
                this.quickselect(arr, k, newLeft, newRight, compare);
            }

            const t = arr[k];
            let i = left;
            let j = right;

            this.swap(arr, left, k);
            if (compare(arr[right], t) > 0) this.swap(arr, left, right);

            while (i < j) {
                this.swap(arr, i, j);
                i++;
                j--;
                while (compare(arr[i], t) < 0) i++;
                while (compare(arr[j], t) > 0) j--;
            }

            if (compare(arr[left], t) === 0) this.swap(arr, left, j);
            else {
                j++;
                this.swap(arr, j, right);
            }

            if (j <= k) left = j + 1;
            if (k <= j) right = j - 1;
        }
    }

    private swap(arr: Point3D[], i: number, j: number): void {
        const tmp = arr[i];
        arr[i] = arr[j];
        arr[j] = tmp;
    }
}
