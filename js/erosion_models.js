import { getPaddedByteRange, padBuffer } from './utils.js';

/**
 * Base class for all erosion simulation models.
 */
export class ErosionModel {
    constructor(device) {
        this.device = device;
        this.gridSize = 0;
    }

    /**
     * Asynchronously creates the necessary compute pipelines.
     */
    async createPipelines() {
        throw new Error("Method 'createPipelines()' must be implemented by subclasses.");
    }

    /**
     * Recreates GPU resources when grid size changes.
     * @param {number} gridSize The new grid size.
     */
    recreateResources(gridSize) {
        this.gridSize = gridSize;
    }

    /**
     * Encodes the commands to run the erosion simulation for a number of iterations.
     * @param {GPUCommandEncoder} encoder The command encoder to use.
     * @param {number} iterations The number of iterations to run.
     * @param {object} params The erosion parameters from the UI.
     */
    run(encoder, iterations, params) {
        throw new Error("Method 'run()' must be implemented by subclasses.");
    }

    /**
     * Resets the internal state of the erosion model (e.g., water, sediment).
     */
    resetState() {
        // Base implementation does nothing. Can be overridden by subclasses.
    }
}

export class HydraulicErosionModel extends ErosionModel {
    constructor(device) {
        super(device);
        this.pipelines = {};
        this.uniformsBuffer = null;
        this.waterTextureA = null;
        this.waterTextureB = null;
        this.sedimentTextureA = null;
        this.sedimentTextureB = null;
        this.velocityTextureA = null;
        this.velocityTextureB = null;
        this.terrainTextureA = null; // Now owned by the erosion model
        this.terrainTextureB = null;
        this.bindGroups = null;
    }

    async createPipelines() {
        const code = await fetch('/shaders/erosion.wgsl').then(res => res.text());
        const module = this.device.createShaderModule({ code });
        const passes = ['water', 'flow', 'erosion', 'transport', 'evaporation'];
        for (const pass of passes) {
            this.pipelines[pass] = await this.device.createComputePipeline({
                layout: 'auto',
                compute: { module, entryPoint: `main_${pass}` },
            });
        }
    }

    recreateResources(gridSize) {
        super.recreateResources(gridSize);

        [this.uniformsBuffer, this.waterTextureA, this.waterTextureB, this.sedimentTextureA,
         this.sedimentTextureB, this.velocityTextureA, this.velocityTextureB, this.terrainTextureA, this.terrainTextureB].forEach(r => r?.destroy());

        // Increased size to 44 bytes to accommodate the new 'seaLevel' f32 uniform.
        this.uniformsBuffer = this.device.createBuffer({ size: 44, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

        const r32fDescriptor = {
            size: [gridSize, gridSize],
            format: 'r32float',
            usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
        };
        const rgba32fDescriptor = {
            size: [gridSize, gridSize],
            format: 'rgba32float',
            usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
        };

        this.waterTextureA = this.device.createTexture(r32fDescriptor);
        this.waterTextureB = this.device.createTexture(r32fDescriptor);
        this.sedimentTextureA = this.device.createTexture(r32fDescriptor);
        this.sedimentTextureB = this.device.createTexture(r32fDescriptor);
        this.velocityTextureA = this.device.createTexture(rgba32fDescriptor);
        this.velocityTextureB = this.device.createTexture(rgba32fDescriptor);
        this.terrainTextureA = this.device.createTexture(r32fDescriptor);
        this.terrainTextureB = this.device.createTexture(r32fDescriptor);

        this.resetState();

        // --- Pre-create Bind Groups for Performance ---
        // By creating all bind group variations upfront, we avoid object creation in the hot loop.
        const createBindGroup = (layout, bindings) => this.device.createBindGroup({ layout, entries: bindings });
        const t = (binding, texture) => ({ binding, resource: texture.createView() });
        const b = (binding, buffer) => ({ binding, resource: { buffer } });

        // Set A: Corresponds to an even-numbered iteration (i % 2 === 0)
        const bg_A = {
            water:      createBindGroup(this.pipelines.water.getBindGroupLayout(0), [ b(0, this.uniformsBuffer), t(2, this.waterTextureA), t(6, this.waterTextureB) ]),
            flow:       createBindGroup(this.pipelines.flow.getBindGroupLayout(0), [ b(0, this.uniformsBuffer), t(1, this.terrainTextureA), t(2, this.waterTextureB), t(4, this.velocityTextureA), t(8, this.velocityTextureB) ]),
            erosion:    createBindGroup(this.pipelines.erosion.getBindGroupLayout(0), [ b(0, this.uniformsBuffer), t(1, this.terrainTextureA), t(2, this.waterTextureB), t(3, this.sedimentTextureA), t(4, this.velocityTextureB), t(5, this.terrainTextureB), t(7, this.sedimentTextureB) ]),
            transport:  createBindGroup(this.pipelines.transport.getBindGroupLayout(0), [ b(0, this.uniformsBuffer), t(2, this.waterTextureB), t(3, this.sedimentTextureB), t(4, this.velocityTextureB), t(6, this.waterTextureA), t(7, this.sedimentTextureA) ]),
            evaporation:createBindGroup(this.pipelines.evaporation.getBindGroupLayout(0), [ b(0, this.uniformsBuffer), t(2, this.waterTextureA), t(6, this.waterTextureB) ]),
        };

        // Set B: Corresponds to an odd-numbered iteration (i % 2 === 1)
        // Note the swapped texture bindings (A vs B) compared to Set A.
        const bg_B = {
            water:      createBindGroup(this.pipelines.water.getBindGroupLayout(0), [ b(0, this.uniformsBuffer), t(2, this.waterTextureB), t(6, this.waterTextureA) ]),
            flow:       createBindGroup(this.pipelines.flow.getBindGroupLayout(0), [ b(0, this.uniformsBuffer), t(1, this.terrainTextureB), t(2, this.waterTextureA), t(4, this.velocityTextureB), t(8, this.velocityTextureA) ]),
            erosion:    createBindGroup(this.pipelines.erosion.getBindGroupLayout(0), [ b(0, this.uniformsBuffer), t(1, this.terrainTextureB), t(2, this.waterTextureA), t(3, this.sedimentTextureA), t(4, this.velocityTextureA), t(5, this.terrainTextureA), t(7, this.sedimentTextureB) ]),
            transport:  createBindGroup(this.pipelines.transport.getBindGroupLayout(0), [ b(0, this.uniformsBuffer), t(2, this.waterTextureA), t(3, this.sedimentTextureA), t(4, this.velocityTextureA), t(6, this.waterTextureB), t(7, this.sedimentTextureB) ]),
            evaporation:createBindGroup(this.pipelines.evaporation.getBindGroupLayout(0), [ b(0, this.uniformsBuffer), t(2, this.waterTextureB), t(6, this.waterTextureA) ]),
        };

        this.bindGroups = {
            even: bg_A, // Use for i = 0, 2, 4...
            odd:  bg_B, // Use for i = 1, 3, 5...
        };
    }

    getFinalTerrainTexture(iterations) {
        return (iterations % 2 === 0) ? this.terrainTextureA : this.terrainTextureB;
    }

    resetState() {
        if (!this.waterTextureA) return; // Don't run if resources aren't created yet

        const zeroData = new Float32Array(this.gridSize * this.gridSize);
        const { paddedBuffer, bytesPerRow } = padBuffer(zeroData, this.gridSize, this.gridSize);
        const queue = this.device.queue;
        const textureSize = { width: this.gridSize, height: this.gridSize };
        queue.writeTexture({ texture: this.waterTextureA }, paddedBuffer, { bytesPerRow }, textureSize);
        queue.writeTexture({ texture: this.waterTextureB }, paddedBuffer, { bytesPerRow }, textureSize);
        queue.writeTexture({ texture: this.sedimentTextureA }, paddedBuffer, { bytesPerRow }, textureSize);
        queue.writeTexture({ texture: this.sedimentTextureB }, paddedBuffer, { bytesPerRow }, textureSize);
        console.log("Hydraulic erosion state (water, sediment) has been reset.");
    }

    _prepareUniforms(params) {
        // Buffer now holds 11 floats (44 bytes)
        const uniformData = new Float32Array(11);
        const uniformDataU32 = new Uint32Array(uniformData.buffer);

        // --- Simulation Tuning Parameters ---
        // dt: The timestep. Larger values are faster but can be less stable.
        // density: A proxy for gravity and cell area. Higher values increase water force.
        uniformData[0] = 0.05; // dt
        uniformData[1] = 9.8;  // density (as gravity)

        // --- UI-Controlled Parameters ---
        uniformData[2] = params.evapRate;
        uniformData[3] = params.depositionRate;
        uniformData[4] = params.solubility;
        uniformData[5] = 0.01; // minSlope
        uniformData[6] = params.capacityFactor;
        uniformData[7] = params.rainAmount;
        uniformData[8] = params.seaLevel;
        uniformDataU32[9] = this.gridSize;
        this.device.queue.writeBuffer(this.uniformsBuffer, 0, uniformData);
    }

    run(encoder, iterations, params) {
        this._prepareUniforms(params);

        for (let i = 0; i < iterations; i++) {
            const workgroupCount = Math.ceil(this.gridSize / 16);
            const bindGroupSet = (i % 2 === 0) ? this.bindGroups.even : this.bindGroups.odd;

            // 1. Water increment
            let pass1 = encoder.beginComputePass();
            pass1.setPipeline(this.pipelines.water);
            pass1.setBindGroup(0, bindGroupSet.water);
            pass1.dispatchWorkgroups(workgroupCount, workgroupCount);
            pass1.end();

            // 2. Flow simulation
            let pass2 = encoder.beginComputePass();
            pass2.setPipeline(this.pipelines.flow);
            pass2.setBindGroup(0, bindGroupSet.flow);
            pass2.dispatchWorkgroups(workgroupCount, workgroupCount);
            pass2.end();

            // 3. Erosion and deposition
            let pass3 = encoder.beginComputePass();
            pass3.setPipeline(this.pipelines.erosion);
            pass3.setBindGroup(0, bindGroupSet.erosion);
            pass3.dispatchWorkgroups(workgroupCount, workgroupCount);
            pass3.end();

            // 4. Sediment transport
            let pass4 = encoder.beginComputePass();
            pass4.setPipeline(this.pipelines.transport);
            pass4.setBindGroup(0, bindGroupSet.transport);
            pass4.dispatchWorkgroups(workgroupCount, workgroupCount);
            pass4.end();

            // 5. Evaporation
            let pass5 = encoder.beginComputePass();
            pass5.setPipeline(this.pipelines.evaporation);
            pass5.setBindGroup(0, bindGroupSet.evaporation);
            pass5.dispatchWorkgroups(workgroupCount, workgroupCount);
            pass5.end();
        }
    }
}

export class HydraulicErosionModelDebug extends HydraulicErosionModel {
    /**
     * Runs a single iteration of the erosion model and captures intermediate
     * results for debugging. This is an expensive operation.
     * @param {object} params The erosion parameters from the UI.
     * @param {object} terrainTextures An object with { read, write } textures for the terrain heightmap.
     * @returns {Promise<{capturedData: object, heights: Float32Array}>}
     */
    async captureSingleStep(params, terrainTextures) {
        const { gridSize } = this;
        const { bytesPerRow: r32fBytesPerRow, bufferSize: r32fBufferSize } = getPaddedByteRange(gridSize, gridSize, 4);
        const { bytesPerRow: rgba32fBytesPerRow, bufferSize: rgba32fBufferSize } = getPaddedByteRange(gridSize, gridSize, 16);

        // Create staging buffers for all intermediate textures
        const stagingBuffers = {
            water: this.device.createBuffer({ size: r32fBufferSize, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
            velocity: this.device.createBuffer({ size: rgba32fBufferSize, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
            sedimentErosion: this.device.createBuffer({ size: r32fBufferSize, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
            terrainErosion: this.device.createBuffer({ size: r32fBufferSize, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
            waterTransport: this.device.createBuffer({ size: r32fBufferSize, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
            sedimentTransport: this.device.createBuffer({ size: r32fBufferSize, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
            waterEvaporation: this.device.createBuffer({ size: r32fBufferSize, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
            finalTerrain: this.device.createBuffer({ size: r32fBufferSize, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
        };

        const encoder = this.device.createCommandEncoder({ label: "Erosion Capture Encoder" });

        // This is a single iteration of the main run() loop, with copy commands inserted.
        this._prepareUniforms(params);
        const resources = {
            terrain: terrainTextures,
            water: { read: this.waterTextureA, write: this.waterTextureB },
            sediment: { read: this.sedimentTextureA, write: this.sedimentTextureB },
            velocity: { read: this.velocityTextureA, write: this.velocityTextureB },
        };

        const createBindGroup = (layout, bindings) => this.device.createBindGroup({ layout, entries: bindings });
        const t = (binding, texture) => ({ binding, resource: texture.createView() });
        const b = (binding, buffer) => ({ binding, resource: { buffer } });
        const workgroupCount = Math.ceil(this.gridSize / 16);

        // The 5 passes of the simulation
        // Pass 1: Water Increment
        const pass1 = encoder.beginComputePass(); pass1.setPipeline(this.pipelines.water); pass1.setBindGroup(0, createBindGroup(this.pipelines.water.getBindGroupLayout(0), [ b(0, this.uniformsBuffer), t(2, resources.water.read), t(6, resources.water.write) ])); pass1.dispatchWorkgroups(workgroupCount, workgroupCount); pass1.end();
        encoder.copyTextureToBuffer({ texture: resources.water.write }, { buffer: stagingBuffers.water, bytesPerRow: r32fBytesPerRow }, { width: gridSize, height: gridSize });

        // Pass 2: Flow Simulation
        const pass2 = encoder.beginComputePass(); pass2.setPipeline(this.pipelines.flow); pass2.setBindGroup(0, createBindGroup(this.pipelines.flow.getBindGroupLayout(0), [ b(0, this.uniformsBuffer), t(1, resources.terrain.read), t(2, resources.water.write), t(4, resources.velocity.read), t(8, resources.velocity.write) ])); pass2.dispatchWorkgroups(workgroupCount, workgroupCount); pass2.end();
        encoder.copyTextureToBuffer({ texture: resources.velocity.write }, { buffer: stagingBuffers.velocity, bytesPerRow: rgba32fBytesPerRow }, { width: gridSize, height: gridSize });

        // Pass 3: Erosion and Deposition
        const pass3 = encoder.beginComputePass(); pass3.setPipeline(this.pipelines.erosion); pass3.setBindGroup(0, createBindGroup(this.pipelines.erosion.getBindGroupLayout(0), [ b(0, this.uniformsBuffer), t(1, resources.terrain.read), t(2, resources.water.write), t(3, resources.sediment.read), t(4, resources.velocity.write), t(5, resources.terrain.write), t(7, resources.sediment.write) ])); pass3.dispatchWorkgroups(workgroupCount, workgroupCount); pass3.end();
        encoder.copyTextureToBuffer({ texture: resources.terrain.write }, { buffer: stagingBuffers.terrainErosion, bytesPerRow: r32fBytesPerRow }, { width: gridSize, height: gridSize });
        encoder.copyTextureToBuffer({ texture: resources.sediment.write }, { buffer: stagingBuffers.sedimentErosion, bytesPerRow: r32fBytesPerRow }, { width: gridSize, height: gridSize });

        // Pass 4: Sediment Transport
        const pass4 = encoder.beginComputePass(); pass4.setPipeline(this.pipelines.transport); pass4.setBindGroup(0, createBindGroup(this.pipelines.transport.getBindGroupLayout(0), [ b(0, this.uniformsBuffer), t(2, resources.water.write), t(3, resources.sediment.write), t(4, resources.velocity.write), t(6, resources.water.read), t(7, resources.sediment.read) ])); pass4.dispatchWorkgroups(workgroupCount, workgroupCount); pass4.end();
        encoder.copyTextureToBuffer({ texture: resources.water.read }, { buffer: stagingBuffers.waterTransport, bytesPerRow: r32fBytesPerRow }, { width: gridSize, height: gridSize });
        encoder.copyTextureToBuffer({ texture: resources.sediment.read }, { buffer: stagingBuffers.sedimentTransport, bytesPerRow: r32fBytesPerRow }, { width: gridSize, height: gridSize });

        // Pass 5: Evaporation
        const pass5 = encoder.beginComputePass(); pass5.setPipeline(this.pipelines.evaporation); pass5.setBindGroup(0, createBindGroup(this.pipelines.evaporation.getBindGroupLayout(0), [ b(0, this.uniformsBuffer), t(2, resources.water.read), t(6, resources.water.write) ])); pass5.dispatchWorkgroups(workgroupCount, workgroupCount); pass5.end();
        encoder.copyTextureToBuffer({ texture: resources.water.write }, { buffer: stagingBuffers.waterEvaporation, bytesPerRow: r32fBytesPerRow }, { width: gridSize, height: gridSize });

        // The final terrain is in the "write" texture after the erosion pass.
        encoder.copyTextureToBuffer({ texture: resources.terrain.write }, { buffer: stagingBuffers.finalTerrain, bytesPerRow: r32fBytesPerRow }, { width: gridSize, height: gridSize });

        this.device.queue.submit([encoder.finish()]);
        await this.device.queue.onSubmittedWorkDone();

        await Promise.all(Object.values(stagingBuffers).map(b => b.mapAsync(GPUMapMode.READ).catch(e => console.error("Buffer mapping failed", e))));

        // Get all mapped ranges once to avoid "getMappedRange overlaps" errors.
        const mappedRanges = {};
        for (const key in stagingBuffers) {
            mappedRanges[key] = stagingBuffers[key].getMappedRange();
        }

        const analyzeBuffer = (range) => {
            if (!range || range.byteLength === 0) return { sum: 'N/A', min: 'N/A', max: 'N/A', avg: 'N/A', nonZero: 'N/A' };
            const data = new Float32Array(range);
            const dataLength = data.length;
            let sum = 0, min = Infinity, max = -Infinity, nonZeroCount = 0;
            for (const v of data) { sum += v; if (v < min) min = v; if (v > max) max = v; if (Math.abs(v) > 1e-9) nonZeroCount++; }
            return { sum: sum.toFixed(4), min: min.toFixed(4), max: max.toFixed(4), avg: (sum / dataLength).toFixed(4), nonZero: `${nonZeroCount} / ${dataLength}` };
        };

        const capturedData = {
            pass1_water: analyzeBuffer(mappedRanges.water), pass2_velocity: analyzeBuffer(mappedRanges.velocity), pass3_terrain: analyzeBuffer(mappedRanges.terrainErosion), pass3_sediment: analyzeBuffer(mappedRanges.sedimentErosion), pass4_water: analyzeBuffer(mappedRanges.waterTransport), pass4_sediment: analyzeBuffer(mappedRanges.sedimentTransport), pass5_water: analyzeBuffer(mappedRanges.waterEvaporation),
        };

        const finalHeights = new Float32Array(mappedRanges.finalTerrain).slice();
        const finalWater = new Float32Array(mappedRanges.waterEvaporation).slice();

        Object.values(stagingBuffers).forEach(b => b.unmap());
        Object.values(stagingBuffers).forEach(b => b.destroy());

        // After running the debug step, we need to swap the main state textures
        // so the *next* frame starts from the correct state.
        [this.waterTextureA, this.waterTextureB] = [this.waterTextureB, this.waterTextureA];
        [this.sedimentTextureA, this.sedimentTextureB] = [this.sedimentTextureB, this.sedimentTextureA];
        [this.velocityTextureA, this.velocityTextureB] = [this.velocityTextureB, this.velocityTextureA];

        return { capturedData, heights: finalHeights, waterHeights: finalWater };
    }
}

export class SimpleErosionModel extends ErosionModel {
    constructor(device) {
        super(device);
        this.pipeline = null;
        this.uniformsBuffer = null;
        this.bindGroupAtoB = null;
        this.bindGroupBtoA = null;
    }

    async createPipelines() {
        const code = await fetch('/shaders/simpleErosion.wgsl').then(res => res.text());
        const module = this.device.createShaderModule({ code });
        this.pipeline = await this.device.createComputePipeline({
            layout: 'auto',
            compute: { module, entryPoint: 'main' },
        });
    }

    recreateResources(gridSize) {
        super.recreateResources(gridSize);
        this.uniformsBuffer?.destroy();
        this.uniformsBuffer = this.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        // Invalidate cached bind groups since resources have changed
        this.bindGroupAtoB = null;
        this.bindGroupBtoA = null;
    }

    run(encoder, iterations, params, terrainTextures) {
        // This model ignores most parameters, but we can scale one to fit.
        // We map the "Deposition" slider (0.01-1.0) to a reasonable thermal erosion rate (0.001-0.1).
        const erosionRate = params.depositionRate * 0.1;
        this.device.queue.writeBuffer(this.uniformsBuffer, 0, new Float32Array([erosionRate]));

        // Lazy-initialize and cache bind groups
        if (!this.bindGroupAtoB) {
            const bindGroupLayout = this.pipeline.getBindGroupLayout(0);
            this.bindGroupAtoB = this.device.createBindGroup({ layout: bindGroupLayout, entries: [ { binding: 0, resource: terrainTextures.read.createView() }, { binding: 1, resource: terrainTextures.write.createView() }, { binding: 2, resource: { buffer: this.uniformsBuffer } } ] });
            this.bindGroupBtoA = this.device.createBindGroup({ layout: bindGroupLayout, entries: [ { binding: 0, resource: terrainTextures.write.createView() }, { binding: 1, resource: terrainTextures.read.createView() }, { binding: 2, resource: { buffer: this.uniformsBuffer } } ] });
        }

        for (let i = 0; i < iterations; i++) {
            const pass = encoder.beginComputePass({ label: `Simple Erosion Pass ${i}` });
            pass.setPipeline(this.pipeline);
            // Use the cached bind groups
            pass.setBindGroup(0, (i % 2 === 0) ? this.bindGroupAtoB : this.bindGroupBtoA);
            pass.dispatchWorkgroups(Math.ceil(this.gridSize / 16), Math.ceil(this.gridSize / 16));
            pass.end();
        }
    }
}