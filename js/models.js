import { withTimeout, getPaddedByteRange, padBuffer } from './utils.js';
import mat4 from './mat4.js';

/**
 * The base class for all data models. It handles the common GPU resources and
 * the core logic for executing compute shaders.
 */
export class BaseModel {
    constructor(device, shaderStrategy) {
        this.device = device;
        this.shaderStrategy = shaderStrategy;
        this.gridSize = 0;

        // GPU resources managed by the model
        this.computeUniformBuffer = null;
        this.computeMinMaxBuffer = null;
        this.computeOutputBuffer = null;
        this.computeStagingBuffer = null;
        this.computeMinMaxStagingBuffer = null;
        this.erosionParamsBuffer = null;
        this.heightmapTextureA = null;
        this.heightmapTextureB = null; // Ping-pong buffer for terrain

        // Bind Groups
        this.computeBindGroup = null;

        // Data state
        this.lastGeneratedHeightmap = null;
        this.originalHeightmap = null; // A pristine copy for measuring erosion
        this.lastGeneratedParams = null;
        this.erosionFrameCounter = 0;
    }

    recreateResources(gridSize) {
        this.gridSize = gridSize;
        this.originalHeightmap = null;

        [this.computeUniformBuffer, this.computeMinMaxBuffer, this.erosionParamsBuffer,
         this.computeOutputBuffer, this.computeStagingBuffer, this.computeMinMaxStagingBuffer, this.heightmapTextureA,
         this.heightmapTextureB].forEach(r => r?.destroy());
        
        // The uniform struct in the shaders has padding and alignment requirements that result in a 56-byte size.
        this.computeUniformBuffer = this.device.createBuffer({ size: 56, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        this.computeMinMaxBuffer = this.device.createBuffer({ size: 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
        this.computeOutputBuffer = this.device.createBuffer({ size: gridSize * gridSize * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
        const { bufferSize } = getPaddedByteRange(gridSize, gridSize, 4);
        this.computeStagingBuffer = this.device.createBuffer({ size: bufferSize, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
        this.computeMinMaxStagingBuffer = this.device.createBuffer({ size: 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });

        const r32fDescriptor = {
            size: [gridSize, gridSize],
            format: 'r32float',
            usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
        };

        this.heightmapTextureA = this.device.createTexture(r32fDescriptor);
        this.heightmapTextureB = this.device.createTexture(r32fDescriptor);

        // If the pipeline failed to create (e.g., shader not found), it will be null.
        // We should not attempt to create a bind group for it.
        if (this.shaderStrategy.computePipeline) {
            this.computeBindGroup = this.device.createBindGroup({
                layout: this.shaderStrategy.computePipeline.getBindGroupLayout(0),
                entries: [
                    { binding: 0, resource: { buffer: this.computeUniformBuffer } },
                    { binding: 1, resource: { buffer: this.computeOutputBuffer } },
                    { binding: 2, resource: { buffer: this.computeMinMaxBuffer } },
                ],
            });
        } else {
            // Log a warning. The model will be unusable but won't crash the whole app
            // during the resource creation loop.
            console.warn(`Compute pipeline for strategy '${this.shaderStrategy.name}' not available. Skipping bind group creation.`);
            this.computeBindGroup = null;
        }
    }

    /**
     * Extracts and un-pads data from a staging buffer that was used for a texture-to-buffer copy.
     * @param {ArrayBuffer} mappedRange The mapped range of the staging buffer.
     * @param {number} width The width of the original texture.
     * @param {number} height The height of the original texture.
     * @param {number} bytesPerRow The padded bytes per row used in the copy.
     * @returns {Float32Array | null} The compact, un-padded data.
     */
    _unpadBuffer(mappedRange, width, height, bytesPerRow) {
        if (!mappedRange || mappedRange.byteLength === 0) return null;
        const dest = new Float32Array(width * height);
        const srcView = new Uint8Array(mappedRange);
        for (let y = 0; y < height; y++) {
            const srcOffset = y * bytesPerRow;
            const dstOffset = y * width; // in floats
            dest.set(new Float32Array(srcView.buffer, srcView.byteOffset + srcOffset, width), dstOffset);
        }
        return dest;
    }

    async generateTileData(params, tileParams) {
        if (!this.shaderStrategy || !this.shaderStrategy.computePipeline || !this.computeBindGroup) {
            console.error(`Cannot generate tile data for strategy '${this.shaderStrategy?.name}' because its pipeline or bind group is invalid. Check for shader compilation errors.`);
            // Return a flat, empty heightmap to prevent crashes downstream.
            return new Float32Array(params.gridSize * params.gridSize).fill(0);
        }

        this.lastGeneratedParams = params;
        const uniformArrayBuffer = new ArrayBuffer(56);
        this.shaderStrategy.prepareUniforms(uniformArrayBuffer, params, tileParams);

        this.device.queue.writeBuffer(this.computeUniformBuffer, 0, uniformArrayBuffer);

        // If the strategy has a normalization pipeline, manage the global min/max.
        if (this.shaderStrategy.normalizePipeline) {
            // The shader uses i32 atomics on floats scaled by a factor. We replicate that.
            const INT_SCALE_FACTOR = 10000.0;
            const I32_MAX = 0x7FFFFFFF;
            const I32_MIN = -0x7FFFFFFF; // Matching original implementation's max value

            const initialMin = this.shaderStrategy.globalMin === Infinity
                ? I32_MAX
                : Math.floor(this.shaderStrategy.globalMin * INT_SCALE_FACTOR);
            const initialMax = this.shaderStrategy.globalMax === -Infinity
                ? I32_MIN
                : Math.floor(this.shaderStrategy.globalMax * INT_SCALE_FACTOR);

            this.device.queue.writeBuffer(this.computeMinMaxBuffer, 0, new Int32Array([initialMin, initialMax]));
        } else {
            // For strategies like TiledLOD that don't normalize on GPU, reset to default.
            this.device.queue.writeBuffer(this.computeMinMaxBuffer, 0, new Int32Array([0x7FFFFFFF, -0x7FFFFFFF]));
        }

        const encoder = this.device.createCommandEncoder();
        let pass = encoder.beginComputePass();
        pass.setPipeline(this.shaderStrategy.computePipeline);
        pass.setBindGroup(0, this.computeBindGroup);
        pass.dispatchWorkgroups(Math.ceil(this.gridSize / 8), Math.ceil(this.gridSize / 8));
        pass.end();

        if (this.shaderStrategy.normalizePipeline) {
            pass = encoder.beginComputePass();
            pass.setPipeline(this.shaderStrategy.normalizePipeline);
            pass.setBindGroup(0, this.computeBindGroup);
            pass.dispatchWorkgroups(Math.ceil(this.gridSize / 8), Math.ceil(this.gridSize / 8));
            pass.end();

            // Read back the updated min/max values to update our JS-side state.
            encoder.copyBufferToBuffer(this.computeMinMaxBuffer, 0, this.computeMinMaxStagingBuffer, 0, 8);
        }

        encoder.copyBufferToBuffer(this.computeOutputBuffer, 0, this.computeStagingBuffer, 0, this.computeOutputBuffer.size);
        this.device.queue.submit([encoder.finish()]);

        // Asynchronously wait for buffer mappings
        const mapPromises = [withTimeout(this.computeStagingBuffer.mapAsync(GPUMapMode.READ), 10000)];
        if (this.shaderStrategy.normalizePipeline) {
            mapPromises.push(withTimeout(this.computeMinMaxStagingBuffer.mapAsync(GPUMapMode.READ), 10000));
        }
        await Promise.all(mapPromises);

        // If we ran normalization, process the min/max results
        if (this.shaderStrategy.normalizePipeline) {
            const INT_SCALE_FACTOR = 10000.0;
            const minMaxResult = new Int32Array(this.computeMinMaxStagingBuffer.getMappedRange());
            // The buffer contains [min, max] as scaled integers.
            const newMin = minMaxResult[0] / INT_SCALE_FACTOR;
            const newMax = minMaxResult[1] / INT_SCALE_FACTOR;
            this.computeMinMaxStagingBuffer.unmap();

            // Update the strategy's state for the next run.
            this.shaderStrategy.globalMin = newMin;
            this.shaderStrategy.globalMax = newMax;
        }

        const { bytesPerRow: paddedBytesPerRow } = getPaddedByteRange(this.gridSize, this.gridSize, 4);
        const heights = this._unpadBuffer(this.computeStagingBuffer.getMappedRange(), this.gridSize, this.gridSize, paddedBytesPerRow);
        this.computeStagingBuffer.unmap();
        
        this.lastGeneratedHeightmap = heights;
        this.originalHeightmap = heights.slice(); // Store a pristine copy for erosion measurement
        this.erosionFrameCounter = 0;

        // For writeTexture, the source buffer layout must have bytesPerRow aligned to 256.
        const { paddedBuffer, bytesPerRow } = padBuffer(heights, this.gridSize, this.gridSize);
        this.device.queue.writeTexture({ texture: this.heightmapTextureA }, paddedBuffer, { bytesPerRow }, { width: this.gridSize, height: this.gridSize });

        return heights;
    }

    async runErosion(iterations, params, erosionModel) {
        // The terrain model and erosion model now use the same power-of-two grid size.
        const erosionGridSize = erosionModel.gridSize;
        if (!erosionGridSize || erosionGridSize !== this.gridSize) {
            console.warn("Erosion model and terrain model grid sizes are incompatible or uninitialized. Aborting erosion.");
            return { heights: this.lastGeneratedHeightmap, waterHeights: null, erosionAmount: 0, depositionAmount: 0 };
        }

        const { bytesPerRow, bufferSize } = getPaddedByteRange(erosionGridSize, erosionGridSize, 4);

        const encoder = this.device.createCommandEncoder();

        // 1. Copy the full terrain into the erosion model's input texture.
        encoder.copyTextureToTexture(
            { texture: this.heightmapTextureA },
            { texture: erosionModel.terrainTextureA },
            { width: erosionGridSize, height: erosionGridSize }
        );

        // 2. Run the self-contained erosion simulation.
        erosionModel.run(encoder, iterations, params);

        // 3. Copy the result back into the main terrain texture.
        const finalErodedTexture = erosionModel.getFinalTerrainTexture(iterations);
        encoder.copyTextureToTexture(
            { texture: finalErodedTexture },
            { texture: this.heightmapTextureA },
            { width: erosionGridSize, height: erosionGridSize }
        );

        // 4. Read back the heightmap and water map for display.
        const finalWaterTexture = (iterations % 2 === 0) ? erosionModel.waterTextureA : erosionModel.waterTextureB;
        const waterStagingBuffer = this.device.createBuffer({ size: bufferSize, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
        encoder.copyTextureToBuffer({ texture: this.heightmapTextureA }, { buffer: this.computeStagingBuffer, bytesPerRow }, { width: this.gridSize, height: this.gridSize });
        if (finalWaterTexture) {
            encoder.copyTextureToBuffer({ texture: finalWaterTexture }, { buffer: waterStagingBuffer, bytesPerRow }, { width: erosionGridSize, height: erosionGridSize });
        }

        this.device.queue.submit([encoder.finish()]);

        const mapPromises = [withTimeout(this.computeStagingBuffer.mapAsync(GPUMapMode.READ), 10000)];
        if (finalWaterTexture) {
            mapPromises.push(withTimeout(waterStagingBuffer.mapAsync(GPUMapMode.READ), 10000));
        }
        await Promise.all(mapPromises);

        const erodedHeights = this._unpadBuffer(this.computeStagingBuffer.getMappedRange(), this.gridSize, this.gridSize, bytesPerRow);
        this.computeStagingBuffer.unmap();

        const waterHeights = this._unpadBuffer(finalWaterTexture ? waterStagingBuffer.getMappedRange() : null, erosionGridSize, erosionGridSize, bytesPerRow);
        if (finalWaterTexture) waterStagingBuffer.unmap();
        waterStagingBuffer.destroy();

        this.lastGeneratedHeightmap = erodedHeights;

        // After getting the new heights, calculate the total difference from the original
        let totalErosion = 0;
        let totalDeposition = 0;
        if (this.originalHeightmap) {
            const numPoints = erodedHeights.length;
            for (let i = 0; i < numPoints; i++) {
                const diff = erodedHeights[i] - this.originalHeightmap[i];
                if (diff > 0) { // Material was added
                    totalDeposition += diff;
                } else { // Material was removed
                    totalErosion -= diff; // diff is negative, so subtract to make it positive
                }
            }
            // Convert the sums to an average difference per point for a more stable metric.
            if (numPoints > 0) {
                totalErosion /= numPoints;
                totalDeposition /= numPoints;
            }
        }

        // Copy the final eroded heights back to both terrain textures to ensure consistency for the next erosion run
        const { paddedBuffer: paddedHeights, bytesPerRow: paddedBPR } = padBuffer(erodedHeights, this.gridSize, this.gridSize);
        const textureSize = { width: this.gridSize, height: this.gridSize };
        this.device.queue.writeTexture({ texture: this.heightmapTextureA }, paddedHeights, { bytesPerRow: paddedBPR }, textureSize);
        this.device.queue.writeTexture({ texture: this.heightmapTextureB }, paddedHeights, { bytesPerRow: paddedBPR }, textureSize);

        return { heights: erodedHeights, waterHeights, erosionAmount: totalErosion, depositionAmount: totalDeposition };
    }

    swapTerrainTextures() {
        [this.heightmapTextureA, this.heightmapTextureB] = [this.heightmapTextureB, this.heightmapTextureA];
    }

    calculateErosionMetrics(erodedHeights) {
        let totalErosion = 0;
        let totalDeposition = 0;
        if (this.originalHeightmap) {
            const numPoints = erodedHeights.length;
            for (let i = 0; i < numPoints; i++) {
                const diff = erodedHeights[i] - this.originalHeightmap[i];
                if (diff > 0) { // Material was added
                    totalDeposition += diff;
                } else { // Material was removed
                    totalErosion -= diff; // diff is negative, so subtract to make it positive
                }
            }
            // Check for numPoints to avoid division by zero.
            // If no points, erosion and deposition are zero.
            if (numPoints === 0) { totalErosion = 0; totalDeposition = 0; }
            else {
                totalErosion /= numPoints;
                totalDeposition /= numPoints;
            }
        }
        return { erosionAmount: totalErosion, depositionAmount: totalDeposition };
    }

    async update(params, view, needsNormalizationReset = false) {
        throw new Error("Update method must be implemented by subclasses.");
    }
}

export class UntiledHeightmapModel extends BaseModel {
    async update(params, view, needsNormalizationReset = false) {
        if (needsNormalizationReset) {
            this.shaderStrategy.resetNormalization();
        }
        view.setTiles([{x: 0, z: 0, lod: 0}]);
        const heights = await this.generateTileData(params, { origin: {x:0, y:0}, lod: 0 });
        if (heights) {
            view.updateTileMesh('0,0', heights, params);
        }
    }
}

export class TiledLODModel extends BaseModel {
    constructor(device, shaderStrategy) {
        super(device, shaderStrategy);
        this.validatedGridSize = -1;
    }

    async update(params, view, needsNormalizationReset = false) {
        // --- Tiled LOD with Full-Detail Data Generation ---
        // This model now generates full-resolution data (LOD 0) for all tiles.
        // The Level of Detail (LOD) is now used purely for display, determining
        // the mesh resolution for each tile, not the underlying data resolution.
        // This is a prerequisite for features like tiled erosion.

        // 1. Define tile coordinates and their *display* LODs.
        const tileCoords = [];
        for (let x = -1; x <= 1; x++) {
            for (let z = -1; z <= 1; z++) {
                const lod = Math.max(Math.abs(x), Math.abs(z));
                tileCoords.push({ x, z, lod });
            }
        }
        view.setTiles(tileCoords);

        // 2. All tiles have the same world size because data is generated at max detail (LOD 0).
        // The origin calculation is now a simple, uniform grid.
        const tileWorldSize = (params.gridSize - 1);

        // 3. Generate all tile data at full resolution (LOD 0).
        const tileDataList = [];
        let globalMin = Infinity, globalMax = -Infinity;

        for (const coord of tileCoords) {
            const key = `${coord.x},${coord.z}`;
            const tileParams = {
                origin: { x: coord.x * tileWorldSize, y: coord.z * tileWorldSize },
                lod: 0, // CRITICAL: Always generate data at LOD 0 for full detail.
            };
            const heights = await this.generateTileData(params, tileParams);
            if (heights) {
                tileDataList.push({ key, heights, coord });
                for (const h of heights) {
                    if (h < globalMin) globalMin = h;
                    if (h > globalMax) globalMax = h;
                }
            }
        }

        if (this.validatedGridSize !== params.gridSize) {
            this.validateTileCorners(tileDataList, params.gridSize);
            this.validatedGridSize = params.gridSize;
        }

        // 4. Create meshes. The geometry generator will subsample the full-res data
        // based on the *display* LOD of each tile.
        const range = globalMax - globalMin;
        const lodMap = new Map(tileCoords.map(c => [`${c.x},${c.z}`, c.lod]));

        for (const { key, heights, coord } of tileDataList) {
            const { x, z } = coord;
            const getNeighborLOD = (dx, dz) => lodMap.get(`${x+dx},${z+dz}`) ?? -1;

            const neighborLODs = {
                top: getNeighborLOD(0, 1),
                bottom: getNeighborLOD(0, -1),
                left: getNeighborLOD(-1, 0),
                right: getNeighborLOD(1, 0),
            };

            // The model matrix is also simple now. All tiles have the same scale.
            const modelMatrix = mat4.create();
            const scale = tileWorldSize / 2.0;
            const centerX = x * tileWorldSize + scale;
            const centerZ = z * tileWorldSize + scale;
            mat4.translate(modelMatrix, modelMatrix, [centerX, 0, centerZ]);
            mat4.scale(modelMatrix, modelMatrix, [scale, 1.0, scale]);

            const normalizedHeights = heights.map(h => Math.pow((h - globalMin) / (range + 1e-10), 1.0 / params.hurst));
            view.updateTileMesh(key, normalizedHeights, params, null, neighborLODs, modelMatrix);
        }
    }

    validateTileCorners(tileDataList, gridSize) {
        console.log(`%c--- Validating Tile Corner Heights ---`, "color: #569cd6; font-weight: bold;");
        const heightDataMap = new Map(tileDataList.map(d => [d.key, d.heights]));
        let hasErrors = false;

        for (const { key, heights } of tileDataList) {
            const [x, z] = key.split(',').map(Number);
            const bl_idx = 0, br_idx = gridSize - 1, tl_idx = (gridSize - 1) * gridSize, tr_idx = gridSize * gridSize - 1;

            const rightNeighborKey = `${x + 1},${z}`;
            if (heightDataMap.has(rightNeighborKey)) {
                const rightHeights = heightDataMap.get(rightNeighborKey);
                if (Math.abs(heights[br_idx] - rightHeights[bl_idx]) > 1e-6) {
                    console.log(`%cValidation Error: Bottom-right corner mismatch between tile ${key} and ${rightNeighborKey}`, 'color: #f44336;');
                    hasErrors = true;
                }
                if (Math.abs(heights[tr_idx] - rightHeights[tl_idx]) > 1e-6) {
                    console.log(`%cValidation Error: Top-right corner mismatch between tile ${key} and ${rightNeighborKey}`, 'color: #f44336;');
                    hasErrors = true;
                }
            }
        }

        if (!hasErrors) console.log(`%cTile corner validation passed successfully.`, "color: #34c734;");
        else console.log(`%cTile corner validation FAILED. See errors above.`, "color: #f44336; font-weight: bold;");
    }
}