import { withTimeout } from './utils.js';

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
        this.heightmapTextureB = null;

        // Bind Groups
        this.computeBindGroup = null;
        this.erosionBindGroupAtoB = null;
        this.erosionBindGroupBtoA = null;

        // Data state
        this.lastGeneratedHeightmap = null;
        this.lastGeneratedParams = null;
        this.erosionFrameCounter = 0;
    }

    recreateResources(gridSize, erosionPipeline) {
        this.gridSize = gridSize;

        [this.computeUniformBuffer, this.computeMinMaxBuffer, this.erosionParamsBuffer,
         this.computeOutputBuffer, this.computeStagingBuffer, this.computeMinMaxStagingBuffer, this.heightmapTextureA,
         this.heightmapTextureB].forEach(r => r?.destroy());

        this.computeUniformBuffer = this.device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        this.computeMinMaxBuffer = this.device.createBuffer({ size: 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
        this.erosionParamsBuffer = this.device.createBuffer({ size: 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        this.computeOutputBuffer = this.device.createBuffer({ size: gridSize * gridSize * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
        this.computeStagingBuffer = this.device.createBuffer({ size: this.computeOutputBuffer.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
        this.computeMinMaxStagingBuffer = this.device.createBuffer({ size: 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });

        const textureDescriptor = {
            size: [gridSize, gridSize],
            format: 'r32float',
            usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
        };
        this.heightmapTextureA = this.device.createTexture(textureDescriptor);
        this.heightmapTextureB = this.device.createTexture(textureDescriptor);

        this.computeBindGroup = this.device.createBindGroup({
            layout: this.shaderStrategy.computePipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: this.computeUniformBuffer } },
                { binding: 1, resource: { buffer: this.computeOutputBuffer } },
                { binding: 2, resource: { buffer: this.computeMinMaxBuffer } },
            ],
        });
        this.erosionBindGroupAtoB = this.device.createBindGroup({
            layout: erosionPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: this.heightmapTextureA.createView() },
                { binding: 1, resource: this.heightmapTextureB.createView() },
                { binding: 2, resource: { buffer: this.erosionParamsBuffer } },
            ],
        });
        this.erosionBindGroupBtoA = this.device.createBindGroup({
            layout: erosionPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: this.heightmapTextureB.createView() },
                { binding: 1, resource: this.heightmapTextureA.createView() },
                { binding: 2, resource: { buffer: this.erosionParamsBuffer } },
            ],
        });
    }

    async generateTileData(params, tileParams) {
        if (!this.shaderStrategy) throw new Error("Shader strategy not set in Model.");

        this.lastGeneratedParams = params;
        const uniformArrayBuffer = new ArrayBuffer(48);
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
            mapPromises.push(withTimeout(this.computeMinMaxStagingBuffer.mapAsync(GPUMapMode.READ), 1000));
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

        const heights = new Float32Array(this.computeStagingBuffer.getMappedRange()).slice();
        this.computeStagingBuffer.unmap();
        
        this.lastGeneratedHeightmap = heights;
        this.erosionFrameCounter = 0;
        this.device.queue.writeTexture({ texture: this.heightmapTextureA }, heights, { bytesPerRow: this.gridSize * 4 }, { width: this.gridSize, height: this.gridSize });

        return heights;
    }

    async runErosion(iterations, rate, erosionPipeline) {
        this.device.queue.writeBuffer(this.erosionParamsBuffer, 0, new Float32Array([rate]));
        const encoder = this.device.createCommandEncoder();
        for (let i = 0; i < iterations; i++) {
            const pass = encoder.beginComputePass();
            pass.setPipeline(erosionPipeline);
            pass.setBindGroup(0, this.erosionFrameCounter % 2 === 0 ? this.erosionBindGroupAtoB : this.erosionBindGroupBtoA);
            pass.dispatchWorkgroups(Math.ceil(this.gridSize / 16), Math.ceil(this.gridSize / 16));
            pass.end();
            this.erosionFrameCounter++;
        }

        const finalTexture = this.erosionFrameCounter % 2 === 1 ? this.heightmapTextureB : this.heightmapTextureA;
        encoder.copyTextureToBuffer({ texture: finalTexture }, { buffer: this.computeStagingBuffer, bytesPerRow: this.gridSize * 4 }, { width: this.gridSize, height: this.gridSize });
        this.device.queue.submit([encoder.finish()]);

        await withTimeout(this.computeStagingBuffer.mapAsync(GPUMapMode.READ), 10000);
        const erodedHeights = new Float32Array(this.computeStagingBuffer.getMappedRange()).slice();
        this.computeStagingBuffer.unmap();

        this.lastGeneratedHeightmap = erodedHeights;
        this.device.queue.writeTexture({ texture: this.heightmapTextureA }, erodedHeights, { bytesPerRow: this.gridSize * 4 }, { width: this.gridSize, height: this.gridSize });
        this.erosionFrameCounter = 0;

        return erodedHeights;
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
        const tileCoords = [];
        for (let x = -1; x <= 1; x++) {
            for (let z = -1; z <= 1; z++) {
                const lod = 0 //(x === -1 && z === -1) ? 0 : 1;
                tileCoords.push({ x, z, lod });
            }
        }
        view.setTiles(tileCoords);

        const lodMap = new Map(tileCoords.map(c => [`${c.x},${c.z}`, c.lod]));
        const getNeighborLOD = (x, z) => lodMap.has(`${x},${z}`) ? lodMap.get(`${x},${z}`) : -1;

        const tileDataList = [];
        let globalMin = Infinity, globalMax = -Infinity;
        const allYValues = [];

        for (const coord of tileCoords) {
            const tileParams = {
                origin: { x: coord.x * (params.gridSize - 1), y: coord.z * (params.gridSize - 1) },
                lod: coord.lod,
            };
            const heights = await this.generateTileData(params, tileParams);
            if (heights) {
                tileDataList.push({ key: `${coord.x},${coord.z}`, heights });
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

        const range = globalMax - globalMin;
        for (const tileData of tileDataList) {
            for (const h of tileData.heights) {
                allYValues.push(h * params.heightMultiplier);
            }
        }
        allYValues.sort((a, b) => a - b);
        const globalOffset = allYValues[Math.floor(allYValues.length * 0.05)] || 0;

        for (const { key, heights } of tileDataList) {
            const [x, z] = key.split(',').map(Number);
            const neighborLODs = {
                top: getNeighborLOD(x, z + 1),
                bottom: getNeighborLOD(x, z - 1),
                left: getNeighborLOD(x - 1, z),
                right: getNeighborLOD(x + 1, z),
            };
            const normalizedHeights = heights.map(h => Math.pow((h - globalMin) / (range + 1e-10), 1.0 / params.hurst));
            view.updateTileMesh(key, normalizedHeights, params, globalOffset, neighborLODs);
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