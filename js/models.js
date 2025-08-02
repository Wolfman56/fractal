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
        this.lastRenderParams = null;
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

        // If the strategy has a normalization pipeline and we are normalizing,
        // manage the global min/max.
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
        const mapPromises = [withTimeout(this.computeStagingBuffer.mapAsync(GPUMapMode.READ), 10000, `Compute Staging Buffer for ${this.shaderStrategy.name}`)];
        if (this.shaderStrategy.normalizePipeline) {
            mapPromises.push(withTimeout(this.computeMinMaxStagingBuffer.mapAsync(GPUMapMode.READ), 10000, "Min/Max Staging Buffer"));
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

        const { bytesPerRow: paddedBytesPerRow, bufferSize } = getPaddedByteRange(this.gridSize, this.gridSize, 4);
        const heightData = this._unpadBuffer(this.computeStagingBuffer.getMappedRange(), this.gridSize, this.gridSize, paddedBytesPerRow);
        this.computeStagingBuffer.unmap();
        
        // The result from the GPU is either raw or normalized to [0, 1].
        // The model is responsible for any further scaling to world-space heights.
        return heightData;
    }

    async runErosion(iterations, params, erosionModel) {
        // The terrain model and erosion model now use the same power-of-two grid size.
        const erosionGridSize = erosionModel.gridSize;
        if (!erosionGridSize || erosionGridSize !== this.gridSize) {
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

        // After a batch run, we need to ensure the 'A' textures hold the final state
        // to be consistent with single-step runs. If an odd number of iterations ran,
        // the final data is in the 'B' textures, so we must copy it back to 'A'.
        const needsStateReset = iterations % 2 !== 0;
        if (needsStateReset && erosionModel.waterTextureB) { // Check if textures exist
            const textureSize = { width: erosionGridSize, height: erosionGridSize };
            // Copy B -> A for all erosion textures to reset the state for the next operation.
            encoder.copyTextureToTexture({ texture: erosionModel.waterTextureB }, { texture: erosionModel.waterTextureA }, textureSize);
            encoder.copyTextureToTexture({ texture: erosionModel.sedimentTextureB }, { texture: erosionModel.sedimentTextureA }, textureSize);
            encoder.copyTextureToTexture({ texture: erosionModel.velocityTextureB }, { texture: erosionModel.velocityTextureA }, textureSize);
            // The terrain texture is handled separately below.
        }

        // 3. Copy the result back into the main terrain texture.
        const finalErodedTexture = (iterations % 2 !== 0) ? erosionModel.terrainTextureB : erosionModel.terrainTextureA;
        encoder.copyTextureToTexture(
            { texture: finalErodedTexture },
            { texture: this.heightmapTextureA },
            { width: erosionGridSize, height: erosionGridSize }
        );

        // 4. Submit the GPU commands and then read back the final state.
        this.device.queue.submit([encoder.finish()]);

        const { heights: erodedHeights, waterHeights } = await this.readbackFinalErosionState(erosionModel);

        this.lastGeneratedHeightmap = erodedHeights;

        // After getting the new heights, calculate the total difference from the original
        const { erosionAmount, depositionAmount } = this.calculateErosionMetrics(erodedHeights);

        return { heights: erodedHeights, waterHeights, erosionAmount, depositionAmount };
    }

    swapTerrainTextures() {
        [this.heightmapTextureA, this.heightmapTextureB] = [this.heightmapTextureB, this.heightmapTextureA];
    }

    async readbackFinalErosionState(erosionModel) {
        const { bytesPerRow, bufferSize } = getPaddedByteRange(this.gridSize, this.gridSize, 4);
        const heightStagingBuffer = this.device.createBuffer({ size: bufferSize, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
        const waterStagingBuffer = this.device.createBuffer({ size: bufferSize, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    
        const encoder = this.device.createCommandEncoder();
        // The 'A' textures are always the final source of truth after a simulation step/run.
        encoder.copyTextureToBuffer({ texture: this.heightmapTextureA }, { buffer: heightStagingBuffer, bytesPerRow }, { width: this.gridSize, height: this.gridSize });
        encoder.copyTextureToBuffer({ texture: erosionModel.waterTextureA }, { buffer: waterStagingBuffer, bytesPerRow }, { width: this.gridSize, height: this.gridSize });
        this.device.queue.submit([encoder.finish()]);
    
        await Promise.all([
            withTimeout(heightStagingBuffer.mapAsync(GPUMapMode.READ), 10000, "Final Height Readback"),
            withTimeout(waterStagingBuffer.mapAsync(GPUMapMode.READ), 10000, "Final Water Readback")
        ]);
    
        const heights = this._unpadBuffer(heightStagingBuffer.getMappedRange(), this.gridSize, this.gridSize, bytesPerRow);
        heightStagingBuffer.unmap();
        heightStagingBuffer.destroy();
    
        const waterHeights = this._unpadBuffer(waterStagingBuffer.getMappedRange(), this.gridSize, this.gridSize, bytesPerRow);
        waterStagingBuffer.unmap();
        waterStagingBuffer.destroy();
    
        return { heights, waterHeights };
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
        // For untiled models, we always use the GPU normalization path.
        const normalizedHeights = await this.generateTileData(params, { origin: {x:0, y:0}, lod: 0 });
        if (normalizedHeights) {
            // The data is in [0,1]. Scale it to world-space meters.
            const worldHeights = new Float32Array(normalizedHeights.length);
            for (let i = 0; i < normalizedHeights.length; i++) {
                worldHeights[i] = normalizedHeights[i] * params.heightMultiplier;
            }

            // The worldHeights are now scaled from 0 to heightMultiplier. The render shader
            // needs to know this range to correctly apply colors based on sea level.
            this.lastRenderParams = { ...params, heightMultiplier: params.heightMultiplier, seaLevelOffset: 0 };
            this.lastGeneratedHeightmap = worldHeights;
            this.originalHeightmap = worldHeights.slice();
            this.erosionFrameCounter = 0;

            // Write the final world-space heights to the texture used by the erosion system.
            const { paddedBuffer, bytesPerRow } = padBuffer(worldHeights, this.gridSize, this.gridSize);
            this.device.queue.writeTexture(
                { texture: this.heightmapTextureA },
                paddedBuffer,
                { bytesPerRow: bytesPerRow },
                { width: this.gridSize, height: this.gridSize }
            );

            // Create a model matrix to scale the geometry to its correct physical aspect ratio.
            // The geometry from createTileGeometry is 2 units wide. We scale it to metersPerSide.
            const modelMatrix = mat4.create();
            const horizontalScale = params.metersPerSide / 2.0;
            mat4.scale(modelMatrix, modelMatrix, [horizontalScale, 1.0, horizontalScale]);

            view.updateTileMesh('0,0', worldHeights, this.lastRenderParams, null, {}, modelMatrix);
        }
    }
}