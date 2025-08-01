/**
 * Generates the vertex data for a single terrain tile, including seam stitching for different LODs.
 * @param {Float32Array} worldHeights - The un-normalized, world-space height data.
 * @param {object} params - Global terrain parameters (gridSize, heightMultiplier).
 * @param {Float32Array|null} waterHeights - The world-space water height data for the tile.
 * @returns {{positions: number[], normals: number[], indices: number[], waterDepths: number[]}}
 */
export function createTileGeometry(worldHeights, params, waterHeights) {
    const gridSize = Math.sqrt(worldHeights.length);

    const positions = [];
    const normals = [];
    const waterDepths = [];
    let indices = [];

    // --- Pass 1: Generate Vertex Attributes ---
    for (let y = 0; y < gridSize; y++) {
        for (let x = 0; x < gridSize; x++) {
            const idx = y * gridSize + x;
            const terrainHeight = worldHeights[idx];
            const erosionWaterDepth = waterHeights ? waterHeights[idx] : 0;

            // The water surface is the terrain height plus the dynamic water depth.
            const waterSurfaceHeight = terrainHeight + erosionWaterDepth;

            // The final depth is the difference between the surface and the land.
            const waterDepth = waterSurfaceHeight - terrainHeight;
            waterDepths.push(waterDepth);

            // The geometry's height is ALWAYS the terrain height to preserve underwater details.
            const finalHeight = terrainHeight; // This is now in world-space meters.

            // The geometry's normal is calculated from the world-space terrain slope.
            const h = (sampleX, sampleY) => {
                const clampedX = Math.max(0, Math.min(gridSize - 1, sampleX));
                const clampedY = Math.max(0, Math.min(gridSize - 1, sampleY));
                return worldHeights[clampedY * gridSize + clampedX];
            };

            // Calculate the world-space distance between two adjacent vertices in the full-res grid.
            const dx_world = params.metersPerSide / (gridSize - 1);

            // Calculate derivatives using central differences on the world-space heights.
            const df_dx = (h(x + 1, y) - h(x - 1, y)) / (2.0 * dx_world);
            const df_dz = (h(x, y + 1) - h(x, y - 1)) / (2.0 * dx_world); // Assume square cells

            // The normal is perpendicular to the surface gradient.
            const n = [-df_dx, 1.0, -df_dz];
            const len = Math.hypot(...n) || 1;
            const finalNormal = [n[0] / len, n[1] / len, n[2] / len];

            const nx = x / (gridSize - 1) - 0.5;
            const ny = y / (gridSize - 1) - 0.5;
            positions.push(nx * 2, finalHeight, ny * 2);
            normals.push(...finalNormal);
        }
    }

    // --- Pass 2: Generate Indices ---
    // No more stitching, just a simple grid.
    for (let y = 0; y < gridSize - 1; y++) {
        for (let x = 0; x < gridSize - 1; x++) {
            const i0 = y * gridSize + x;
            const i1 = y * gridSize + x + 1;
            const i2 = (y + 1) * gridSize + x;
            const i3 = (y + 1) * gridSize + x + 1;
            indices.push(i0, i1, i3, i0, i3, i2);
        }
    }

    return { positions, normals, indices, waterDepths };
}