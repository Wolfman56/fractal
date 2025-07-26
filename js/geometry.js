/**
 * A cache to store pre-calculated index buffers for different stitching patterns.
 * The key is a string combination of grid size and stitching flags (e.g., "512-T-B-L-R").
 * @type {Map<string, number[]>}
 */
const indexCache = new Map();

/**
 * Generates a simple, non-stitched index buffer for a grid.
 * @param {number} gridSize The size of the grid.
 * @returns {number[]} The generated indices.
 */
function generateBaseIndices(gridSize) {
    const indices = [];
    for (let y = 0; y < gridSize - 1; y++) {
        for (let x = 0; x < gridSize - 1; x++) {
            const tl = y * gridSize + x;
            const tr = y * gridSize + x + 1;
            const bl = (y + 1) * gridSize + x;
            const br = (y + 1) * gridSize + x + 1;
            // Correct CCW winding for our coordinate system.
            indices.push(tl, tr, br, tl, br, bl);
        }
    }
    return indices;
}

/**
 * Modifies a base index buffer to apply seam stitching.
 * This is the "modifier plan" pass.
 * @param {number[]} baseIndices The non-stitched index buffer.
 * @param {number} gridSize The size of the grid.
 * @param {boolean} stitchTop - Whether to stitch the top edge.
 * @param {boolean} stitchBottom - Whether to stitch the bottom edge.
 * @param {boolean} stitchLeft - Whether to stitch the left edge.
 * @param {boolean} stitchRight - Whether to stitch the right edge.
 * @returns {number[]} The modified, stitched indices.
 */
function applyStitching(baseIndices, gridSize, stitchTop, stitchBottom, stitchLeft, stitchRight) {
    const vertexMap = new Map(); // Map from a T-junction vertex to its stable pivot.

    // --- Create the "Modifier Plan" by populating the vertexMap ---
    // The core idea is to "weld" the odd-numbered vertices on a stitched edge
    // to their preceding even-numbered vertex.

    // Top edge (y = gridSize - 1, which is the top row in our coordinate system)
    if (stitchTop) {
        for (let x = 1; x < gridSize; x += 2) {
            const tJunctionIndex = (gridSize - 1) * gridSize + x;
            const pivotIndex = (gridSize - 1) * gridSize + (x - 1);
            vertexMap.set(tJunctionIndex, pivotIndex);
        }
    }

    // Bottom edge (y = 0)
    if (stitchBottom) {
        for (let x = 1; x < gridSize; x += 2) {
            const tJunctionIndex = x;
            const pivotIndex = x - 1;
            vertexMap.set(tJunctionIndex, pivotIndex);
        }
    }

    // Left edge (x = 0)
    if (stitchLeft) {
        for (let y = 1; y < gridSize; y += 2) {
            const tJunctionIndex = y * gridSize;
            const pivotIndex = (y - 1) * gridSize;
            vertexMap.set(tJunctionIndex, pivotIndex);
        }
    }

    // Right edge (x = gridSize - 1)
    if (stitchRight) {
        for (let y = 1; y < gridSize; y += 2) {
            const tJunctionIndex = y * gridSize + (gridSize - 1);
            const pivotIndex = (y - 1) * gridSize + (gridSize - 1);
            vertexMap.set(tJunctionIndex, pivotIndex);
        }
    }

    // --- Apply the Modifier Plan ---
    if (vertexMap.size === 0) {
        return baseIndices; // No modifications needed
    }

    const stitchedIndices = new (baseIndices.length > 65535 ? Uint32Array : Uint16Array)(baseIndices.length);
    for (let i = 0; i < baseIndices.length; i++) {
        const originalIndex = baseIndices[i];
        stitchedIndices[i] = vertexMap.get(originalIndex) ?? originalIndex;
    }

    // --- Final Pass: Remove Degenerate Triangles ---
    // The welding process creates triangles with duplicate indices (e.g., [1, 2, 1]), which have no area.
    const finalIndices = [];
    for (let i = 0; i < stitchedIndices.length; i += 3) {
        const iA = stitchedIndices[i];
        const iB = stitchedIndices[i + 1];
        const iC = stitchedIndices[i + 2];
        if (iA !== iB && iA !== iC && iB !== iC) {
            finalIndices.push(iA, iB, iC);
        }
    }

    return finalIndices;
}


/**
 * Generates the vertex data for a single terrain tile, including seam stitching for different LODs.
 * @param {Float32Array} heights - The normalized height data for the tile.
 * @param {object} params - Global terrain parameters (gridSize, heightMultiplier).
 * @param {object} neighborLODs - LODs of the four neighboring tiles.
 * @param {number} tileLOD - The LOD of the current tile.
 * @param {number} [globalOffset=0] - A global Y-offset to apply to all vertices.
 * @returns {{positions: number[], normals: number[], colors: number[], indices: number[], yValues: number[]}}
 */
export function createTileGeometry(heights, params, neighborLODs, tileLOD, globalOffset = 0) {
    const gridSize = Math.sqrt(heights.length);
    const positions = [];
    const normals = [];
    const colors = [];
    const yValues = [];

    // --- Pass 1: Generate Vertex Attributes ---
    for (let y = 0; y < gridSize; y++) {
        for (let x = 0; x < gridSize; x++) {
            const idx = y * gridSize + x;
            let height = (heights[idx] * params.heightMultiplier) - globalOffset;
            yValues.push(height);
            const nx = x / (gridSize - 1) - 0.5;
            const ny = y / (gridSize - 1) - 0.5;
            positions.push(nx * 2, height, ny * 2);
            
            let color;
            const normHeight = heights[idx];
            if (normHeight < 0.2) { color = [0.0, 0.0, 1.0]; }
            else if (normHeight < 0.4) { color = [0.0, 0.4, 0.0]; }
            else if (normHeight < 0.6) { color = [0.2, 0.8, 0.2]; }
            else if (normHeight < 0.7) { color = [0.6, 0.4, 0.2]; }
            else if (normHeight < 0.8) { color = [0.4, 0.2, 0.0]; }
            else if (normHeight < 0.9) { color = [0.5, 0.5, 0.5]; }
            else { color = [1.0, 1.0, 1.0]; }
            colors.push(...color);
            
            const h = (x, y) => heights[Math.max(0, Math.min(gridSize - 1, y)) * gridSize + Math.max(0, Math.min(gridSize - 1, x))] * params.heightMultiplier;
            const hL = h(x - 1, y);
            const hR = h(x + 1, y);
            const hD = h(x, y - 1);
            const hU = h(x, y + 1);
            const n = [hL - hR, 4.0 / (gridSize - 1), hD - hU];
            const len = Math.hypot(...n) || 1;
            normals.push(n[0] / len, n[1] / len, n[2] / len);
        }
    }

    // --- Pass 2: Generate and Modify Indices ---
    const stitchTop = neighborLODs.top !== -1 && neighborLODs.top > tileLOD;
    const stitchBottom = neighborLODs.bottom !== -1 && neighborLODs.bottom > tileLOD;
    const stitchLeft = neighborLODs.left !== -1 && neighborLODs.left > tileLOD;
    const stitchRight = neighborLODs.right !== -1 && neighborLODs.right > tileLOD;

    let cacheKey = `${gridSize}`;
    if (stitchTop) cacheKey += '-T';
    if (stitchBottom) cacheKey += '-B';
    if (stitchLeft) cacheKey += '-L';
    if (stitchRight) cacheKey += '-R';

    let indices;
    if (indexCache.has(cacheKey)) {
        indices = indexCache.get(cacheKey);
    } else {
        const baseIndices = generateBaseIndices(gridSize);
        indices = applyStitching(baseIndices, gridSize, stitchTop, stitchBottom, stitchLeft, stitchRight);
        console.log(`%c--- Index Generation for pattern: ${cacheKey} ---`, 'color: #569cd6; font-weight: bold;');
        console.log('Base Indices:', baseIndices);
        console.log('Stitched Indices:', indices);
        indexCache.set(cacheKey, indices);
        console.log(`%cGenerated and cached new index pattern: ${cacheKey}`, 'color: #9cdcfe;');
    }

    return { positions, normals, colors, indices, yValues };
}