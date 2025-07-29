/**
 * A cache to store pre-calculated index buffers for different stitching patterns.
 * The key is a string combination of grid size and stitching flags (e.g., "512-T-B-L-R").
 * @type {Map<string, number[]>}
 */
const indexCache = new Map();

/**
 * Subsamples a high-resolution heightmap to create a lower-resolution one.
 * @param {Float32Array} heights - The original high-resolution height data.
 * @param {Float32Array|null} waterHeights - The original high-resolution water data.
 * @param {number} fullGridSize - The grid size of the original data.
 * @param {number} step - The step rate for subsampling (e.g., 2 for LOD 1).
 * @returns {{geoGridSize: number, geoHeights: Float32Array, geoWaterHeights: Float32Array|null}}
 */
function subsample(heights, waterHeights, fullGridSize, step) {
    const geoGridSize = (fullGridSize - 1) / step + 1;
    const newSize = geoGridSize * geoGridSize;
    const geoHeights = new Float32Array(newSize);
    const geoWaterHeights = waterHeights ? new Float32Array(newSize) : null;

    for (let y = 0; y < geoGridSize; y++) {
        for (let x = 0; x < geoGridSize; x++) {
            const highResIdx = (y * step) * fullGridSize + (x * step);
            const lowResIdx = y * geoGridSize + x;
            geoHeights[lowResIdx] = heights[highResIdx];
            if (geoWaterHeights) {
                geoWaterHeights[lowResIdx] = waterHeights[highResIdx];
            }
        }
    }
    return { geoGridSize, geoHeights, geoWaterHeights };
}

/**
 * Generates the vertex data for a single terrain tile, including seam stitching for different LODs.
 * @param {Float32Array} heights - The normalized height data for the tile.
 * @param {object} params - Global terrain parameters (gridSize, heightMultiplier).
 * @param {Float32Array|null} waterHeights - The normalized water height data for the tile.
 * @param {object} neighborLODs - LODs of the four neighboring tiles.
 * @param {number} tileLOD - The LOD of the current tile.
 * @returns {{positions: number[], normals: number[], indices: number[], yValues: number[], normalizedHeights: number[], isWater: number[], waterDepths: number[]}}
 */
export function createTileGeometry(heights, params, waterHeights, neighborLODs, tileLOD) {
    const fullGridSize = Math.sqrt(heights.length);
    const step = 2 ** tileLOD;

    // If we are creating a lower-LOD mesh, we must subsample the input heightmaps.
    // The rest of the function will then operate on these smaller, self-contained grids.
    const { geoGridSize: gridSize, geoHeights, geoWaterHeights } = (step > 1)
        ? subsample(heights, waterHeights, fullGridSize, step)
        : { geoGridSize: fullGridSize, geoHeights: heights, geoWaterHeights: waterHeights };

    const positions = [];
    const normals = [];
    const yValues = [];
    const normalizedHeights = [];
    const isWater = [];
    const waterDepths = [];
    let indices = [];

    // --- Pass 1: Generate Vertex Attributes ---
    for (let y = 0; y < gridSize; y++) {
        for (let x = 0; x < gridSize; x++) {
            const idx = y * gridSize + x;
            const terrainHeightNormalized = geoHeights[idx];
            const erosionWaterNormalized = geoWaterHeights ? geoWaterHeights[idx] : 0;

            const seaLevelNorm = params.seaLevel ?? 0.0;

            // The terrain height is now relative to the sea level.
            const terrainHeight = (terrainHeightNormalized - seaLevelNorm) * params.heightMultiplier;

            // The water surface is the higher of the dynamic water or the static sea level.
            const waterSurfaceHeight = (Math.max(terrainHeightNormalized + erosionWaterNormalized, seaLevelNorm) - seaLevelNorm) * params.heightMultiplier;

            // The final depth is the difference between the surface and the land.
            const waterDepth = waterSurfaceHeight - terrainHeight;
            waterDepths.push(waterDepth);
            normalizedHeights.push(terrainHeightNormalized);

            const hasWater = waterDepth > 0.001;
            isWater.push(hasWater ? 1.0 : 0.0);

            // The geometry's height is ALWAYS the terrain height to preserve underwater details.
            const finalHeight = terrainHeight;

            // The geometry's normal is ALWAYS calculated from the terrain slope.
            // For accurate normals on low-LOD meshes, we must sample the original, full-resolution heightmap.
            const h = (sampleX, sampleY) => {
                const fullResX = Math.max(0, Math.min(fullGridSize - 1, sampleX * step));
                const fullResY = Math.max(0, Math.min(fullGridSize - 1, sampleY * step));
                return heights[fullResY * fullGridSize + fullResX] * params.heightMultiplier;
            };
            const n = [h(x - 1, y) - h(x + 1, y), 4.0 / (gridSize - 1), h(x, y - 1) - h(x, y + 1)];
            const len = Math.hypot(...n) || 1;
            const finalNormal = [n[0] / len, n[1] / len, n[2] / len];

            yValues.push(finalHeight);
            const nx = x / (gridSize - 1) - 0.5;
            const ny = y / (gridSize - 1) - 0.5;
            positions.push(nx * 2, finalHeight, ny * 2);
            normals.push(...finalNormal);
        }
    }

    // --- Pass 2: Generate Indices with Stitching ---
    const stitchTop = neighborLODs.top !== -1 && neighborLODs.top > tileLOD;
    const stitchBottom = neighborLODs.bottom !== -1 && neighborLODs.bottom > tileLOD;
    const stitchLeft = neighborLODs.left !== -1 && neighborLODs.left > tileLOD;
    const stitchRight = neighborLODs.right !== -1 && neighborLODs.right > tileLOD;

    const cacheKey = `${gridSize}-${stitchTop}-${stitchBottom}-${stitchLeft}-${stitchRight}`;

    if (indexCache.has(cacheKey)) {
        indices = indexCache.get(cacheKey);
    } else {
        let y = 0;
        while (y < gridSize - 1) {
            let isTallRow = false;
            let x = 0;
            while (x < gridSize - 1) {

                // Determine if the current 2x2 block is on a stitch boundary.
                const onTopBoundary = stitchTop && y === gridSize - 2;
                const onBottomBoundary = stitchBottom && y === 0;
                const onLeftBoundary = stitchLeft && x === 0;
                const onRightBoundary = stitchRight && x === gridSize - 2;

                // The stitching logic processes 2x2 blocks of quads. To prevent reading out of
                // bounds on the top and right edges, we shift the block's origin inward.
                let blockY = y;
                if (onTopBoundary) blockY = y - 1;
                let blockX = x;
                if (onRightBoundary) blockX = x - 1;

                const p = (dy, dx) => (blockY + dy) * gridSize + (blockX + dx);

                if (onTopBoundary || onBottomBoundary || onLeftBoundary || onRightBoundary) {
                    isTallRow = true;
                }

                // --- Block-based Stitching ---
                // The logic checks for the most complex case (corners) first, then edges,
                // then falls back to a standard quad. It processes blocks of quads (2x2, 2x1, or 1x2)
                // and advances the loop counters accordingly. By shifting the block for top/right
                // edges, the internal logic becomes symmetrical and avoids out-of-bounds access.

                if ((onTopBoundary || onBottomBoundary) && (onLeftBoundary || onRightBoundary)) { // 2x2 Corner block
                    const pivot = p(1, 1);
                    // The 8 high-res vertices forming the perimeter of the 2x2 block
                    const p00=p(0,0), p01=p(0,1), p02=p(0,2);
                    const p10=p(1,0),             p12=p(1,2);
                    const p20=p(2,0), p21=p(2,1), p22=p(2,2);

                    // Create an 8-triangle fan from the pivot, decimating vertices on the boundary.
                    const v00 = onBottomBoundary && onLeftBoundary ? p(0,0) : p00;
                    const v01 = onBottomBoundary ? p(0,0) : p01;
                    const v02 = onBottomBoundary && onRightBoundary ? p(0,2) : p02;
                    const v10 = onLeftBoundary ? p(0,0) : p10;
                    const v12 = onRightBoundary ? p(0,2) : p12;
                    const v20 = onTopBoundary && onLeftBoundary ? p(2,0) : p20;
                    const v21 = onTopBoundary ? p(2,0) : p21;
                    const v22 = onTopBoundary && onRightBoundary ? p(2,2) : p22;

                    indices.push(v00, v10, pivot);
                    indices.push(v10, v20, pivot);
                    indices.push(v20, v21, pivot);
                    indices.push(v21, v22, pivot);
                    indices.push(v22, v12, pivot);
                    indices.push(v12, v02, pivot);
                    indices.push(v02, v01, pivot);
                    indices.push(v01, v00, pivot);

                    x += 2;
                } else if (onTopBoundary || onBottomBoundary) { // 2x1 Horizontal edge block
                    const pivot = p(1, 1);
                    const p00=p(0,0), p01=p(0,1), p02=p(0,2);
                    const p10=p(1,0),             p12=p(1,2);
                    const p20=p(2,0), p21=p(2,1), p22=p(2,2);

                    indices.push(p10, p20, p21,  p10, p21, pivot);
                    indices.push(p12, pivot, p21,  p12, p21, p22);
                    indices.push(p00, p10, pivot,  p00, pivot, p01);
                    indices.push(p02, p01, pivot,  p02, pivot, p12);
                    x += 2;
                } else if (onLeftBoundary || onRightBoundary) { // 1x2 Vertical edge block
                    const pivot = p(1, 1);
                    const p00=p(0,0), p01=p(0,1), p02=p(0,2);
                    const p10=p(1,0),             p12=p(1,2);
                    const p20=p(2,0), p21=p(2,1), p22=p(2,2);

                    indices.push(p01, p12, p22,  p01, p22, p21,  p01, p21, p02);
                    indices.push(p00, p10, pivot,  p10, p20, pivot,  p20, p21, pivot,  p21, p12, pivot,  p12, p02, pivot,  p02, p01, pivot);
                    x += 1;
                } else {
                    // 1x1 Default block (standard quad)
                    indices.push(p(0,0), p(0,1), p(1,1),  p(0,0), p(1,1), p(1,0));
                    x += 1;
                }
            }
            // Advance y by 2 if the row contained any "tall" stitched blocks, otherwise by 1.
            y += isTallRow ? 2 : 1;
        }
        indexCache.set(cacheKey, indices);
        console.log(`%cGenerated and cached new index pattern: ${cacheKey}`, 'color: #9cdcfe;');
    }

    return { positions, normals, indices, yValues, normalizedHeights, isWater, waterDepths };
}