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
     * @param {object} terrainTextures An object with { read, write } textures for the terrain heightmap.
     */
    run(encoder, iterations, params, terrainTextures) {
        throw new Error("Method 'run()' must be implemented by subclasses.");
    }

    /**
     * Resets the internal state of the erosion model (e.g., water, sediment).
     */
    resetState() {
        // Base implementation does nothing. Can be overridden by subclasses.
    }

    /**
     * Runs a single iteration of the erosion model and logs intermediate
     * results to the console for debugging.
     * @param {object} params The erosion parameters from the UI.
     * @param {object} terrainTextures An object with { read, write } textures for the terrain heightmap.
     */
    async debugStep(params, terrainTextures) {
        console.log(`Debug step not implemented for ${this.constructor.name}`);
        return Promise.resolve();
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
        this.velocityTexture = null;
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
         this.sedimentTextureB, this.velocityTexture].forEach(r => r?.destroy());

        // Increased size to 40 bytes to accommodate the new 'solubility' f32 uniform.
        this.uniformsBuffer = this.device.createBuffer({ size: 40, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

        const r32fDescriptor = {
            size: [gridSize, gridSize],
            format: 'r32float',
            usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
        };
        const rgba32fDescriptor = {
            size: [gridSize, gridSize],
            format: 'rgba32float',
            usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
        };

        this.waterTextureA = this.device.createTexture(r32fDescriptor);
        this.waterTextureB = this.device.createTexture(r32fDescriptor);
        this.sedimentTextureA = this.device.createTexture(r32fDescriptor);
        this.sedimentTextureB = this.device.createTexture(r32fDescriptor);
        this.velocityTexture = this.device.createTexture(rgba32fDescriptor);

        this.resetState();
    }

    resetState() {
        if (!this.waterTextureA) return; // Don't run if resources aren't created yet

        const zeroData = new Float32Array(this.gridSize * this.gridSize).fill(0);
        const queue = this.device.queue;
        const bytesPerRow = this.gridSize * 4;
        const textureSize = { width: this.gridSize, height: this.gridSize };
        queue.writeTexture({ texture: this.waterTextureA }, zeroData, { bytesPerRow }, textureSize);
        queue.writeTexture({ texture: this.waterTextureB }, zeroData, { bytesPerRow }, textureSize);
        queue.writeTexture({ texture: this.sedimentTextureA }, zeroData, { bytesPerRow }, textureSize);
        queue.writeTexture({ texture: this.sedimentTextureB }, zeroData, { bytesPerRow }, textureSize);
        console.log("Hydraulic erosion state (water, sediment) has been reset.");
    }

    _prepareUniforms(params) {
        // Buffer now holds 10 floats (40 bytes)
        const uniformData = new Float32Array(10);
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
        uniformDataU32[8] = this.gridSize;
        this.device.queue.writeBuffer(this.uniformsBuffer, 0, uniformData);
    }

    run(encoder, iterations, params, terrainTextures) {
        this._prepareUniforms(params);
        let resources = {
            terrain: terrainTextures,
            water: { read: this.waterTextureA, write: this.waterTextureB },
            sediment: { read: this.sedimentTextureA, write: this.sedimentTextureB },
            velocity: this.velocityTexture,
        };

        const createBindGroup = (layout, bindings) => this.device.createBindGroup({ layout, entries: bindings });
        const t = (binding, texture) => ({ binding, resource: texture.createView() });
        const b = (binding, buffer) => ({ binding, resource: { buffer } });

        for (let i = 0; i < iterations; i++) {
            const workgroupCount = Math.ceil(this.gridSize / 16);
            
            // Note: Bind groups are created per-iteration for simplicity. For higher performance,
            // they could be pre-created and swapped, but this is more complex to manage.

            // 1. Water increment
            let pass1 = encoder.beginComputePass();
            pass1.setPipeline(this.pipelines.water);
            pass1.setBindGroup(0, createBindGroup(this.pipelines.water.getBindGroupLayout(0), [ b(0, this.uniformsBuffer), t(2, resources.water.read), t(6, resources.water.write) ]));
            pass1.dispatchWorkgroups(workgroupCount, workgroupCount);
            pass1.end();

            // 2. Flow simulation
            let pass2 = encoder.beginComputePass();
            pass2.setPipeline(this.pipelines.flow);
            pass2.setBindGroup(0, createBindGroup(this.pipelines.flow.getBindGroupLayout(0), [ b(0, this.uniformsBuffer), t(1, resources.terrain.read), t(2, resources.water.write), t(8, resources.velocity) ]));
            pass2.dispatchWorkgroups(workgroupCount, workgroupCount);
            pass2.end();

            // 3. Erosion and deposition
            let pass3 = encoder.beginComputePass();
            pass3.setPipeline(this.pipelines.erosion);
            pass3.setBindGroup(0, createBindGroup(this.pipelines.erosion.getBindGroupLayout(0), [ b(0, this.uniformsBuffer), t(1, resources.terrain.read), t(2, resources.water.write), t(3, resources.sediment.read), t(4, resources.velocity), t(5, resources.terrain.write), t(7, resources.sediment.write) ]));
            pass3.dispatchWorkgroups(workgroupCount, workgroupCount);
            pass3.end();

            // 4. Sediment transport
            let pass4 = encoder.beginComputePass();
            pass4.setPipeline(this.pipelines.transport);
            pass4.setBindGroup(0, createBindGroup(this.pipelines.transport.getBindGroupLayout(0), [ b(0, this.uniformsBuffer), t(2, resources.water.write), t(3, resources.sediment.write), t(4, resources.velocity), t(6, resources.water.read), t(7, resources.sediment.read) ]));
            pass4.dispatchWorkgroups(workgroupCount, workgroupCount);
            pass4.end();

            // 5. Evaporation
            let pass5 = encoder.beginComputePass();
            pass5.setPipeline(this.pipelines.evaporation);
            pass5.setBindGroup(0, createBindGroup(this.pipelines.evaporation.getBindGroupLayout(0), [ b(0, this.uniformsBuffer), t(2, resources.water.read), t(6, resources.water.write) ]));
            pass5.dispatchWorkgroups(workgroupCount, workgroupCount);
            pass5.end();

            // Swap all ping-pong buffers for the next iteration
            [resources.terrain.read, resources.terrain.write] = [resources.terrain.write, resources.terrain.read];
            [resources.water.read, resources.water.write] = [resources.water.write, resources.water.read];
        }
    }

    async debugStep(params, terrainTextures) {
        const gridSize = this.gridSize;
        const stagingBufferSizeBytes = gridSize * gridSize * 4; // for r32float
        const velocityStagingBufferSizeBytes = gridSize * gridSize * 16; // for rgba32float

        // Create staging buffers for all intermediate textures
        const waterStaging = this.device.createBuffer({ size: stagingBufferSizeBytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
        const velocityStaging = this.device.createBuffer({ size: velocityStagingBufferSizeBytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
        const sedimentErosionStaging = this.device.createBuffer({ size: stagingBufferSizeBytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
        const terrainErosionStaging = this.device.createBuffer({ size: stagingBufferSizeBytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
        const waterTransportStaging = this.device.createBuffer({ size: stagingBufferSizeBytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
        const sedimentTransportStaging = this.device.createBuffer({ size: stagingBufferSizeBytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
        const waterEvaporationStaging = this.device.createBuffer({ size: stagingBufferSizeBytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });

        const encoder = this.device.createCommandEncoder({ label: "Erosion Debug Encoder" });

        // --- Run the simulation step-by-step, copying results ---
        this._prepareUniforms(params);
        let resources = {
            terrain: terrainTextures,
            water: { read: this.waterTextureA, write: this.waterTextureB },
            sediment: { read: this.sedimentTextureA, write: this.sedimentTextureB },
            velocity: this.velocityTexture,
        };

        const createBindGroup = (layout, bindings) => this.device.createBindGroup({ layout, entries: bindings });
        const t = (binding, texture) => ({ binding, resource: texture.createView() });
        const b = (binding, buffer) => ({ binding, resource: { buffer } });
        const workgroupCount = Math.ceil(this.gridSize / 16);

        // Pass 1: Water
        let pass1 = encoder.beginComputePass({label: "Debug Water Pass"});
        pass1.setPipeline(this.pipelines.water);
        pass1.setBindGroup(0, createBindGroup(this.pipelines.water.getBindGroupLayout(0), [ b(0, this.uniformsBuffer), t(2, resources.water.read), t(6, resources.water.write) ]));
        pass1.dispatchWorkgroups(workgroupCount, workgroupCount);
        pass1.end();
        encoder.copyTextureToBuffer({ texture: resources.water.write }, { buffer: waterStaging, bytesPerRow: gridSize * 4 }, { width: gridSize, height: gridSize });

        // Pass 2: Flow
        let pass2 = encoder.beginComputePass({label: "Debug Flow Pass"});
        pass2.setPipeline(this.pipelines.flow);
        pass2.setBindGroup(0, createBindGroup(this.pipelines.flow.getBindGroupLayout(0), [ b(0, this.uniformsBuffer), t(1, resources.terrain.read), t(2, resources.water.write), t(8, resources.velocity) ]));
        pass2.dispatchWorkgroups(workgroupCount, workgroupCount);
        pass2.end();
        encoder.copyTextureToBuffer({ texture: resources.velocity }, { buffer: velocityStaging, bytesPerRow: gridSize * 16 }, { width: gridSize, height: gridSize });

        // Pass 3: Erosion
        let pass3 = encoder.beginComputePass({label: "Debug Erosion Pass"});
        pass3.setPipeline(this.pipelines.erosion);
        pass3.setBindGroup(0, createBindGroup(this.pipelines.erosion.getBindGroupLayout(0), [ b(0, this.uniformsBuffer), t(1, resources.terrain.read), t(2, resources.water.write), t(3, resources.sediment.read), t(4, resources.velocity), t(5, resources.terrain.write), t(7, resources.sediment.write) ]));
        pass3.dispatchWorkgroups(workgroupCount, workgroupCount);
        pass3.end();
        encoder.copyTextureToBuffer({ texture: resources.terrain.write }, { buffer: terrainErosionStaging, bytesPerRow: gridSize * 4 }, { width: gridSize, height: gridSize });
        encoder.copyTextureToBuffer({ texture: resources.sediment.write }, { buffer: sedimentErosionStaging, bytesPerRow: gridSize * 4 }, { width: gridSize, height: gridSize });

        // Pass 4: Transport
        let pass4 = encoder.beginComputePass({label: "Debug Transport Pass"});
        pass4.setPipeline(this.pipelines.transport);
        pass4.setBindGroup(0, createBindGroup(this.pipelines.transport.getBindGroupLayout(0), [ b(0, this.uniformsBuffer), t(2, resources.water.write), t(3, resources.sediment.write), t(4, resources.velocity), t(6, resources.water.read), t(7, resources.sediment.read) ]));
        pass4.dispatchWorkgroups(workgroupCount, workgroupCount);
        pass4.end();
        encoder.copyTextureToBuffer({ texture: resources.water.read }, { buffer: waterTransportStaging, bytesPerRow: gridSize * 4 }, { width: gridSize, height: gridSize });
        encoder.copyTextureToBuffer({ texture: resources.sediment.read }, { buffer: sedimentTransportStaging, bytesPerRow: gridSize * 4 }, { width: gridSize, height: gridSize });

        // Pass 5: Evaporation
        let pass5 = encoder.beginComputePass({label: "Debug Evaporation Pass"});
        pass5.setPipeline(this.pipelines.evaporation);
        pass5.setBindGroup(0, createBindGroup(this.pipelines.evaporation.getBindGroupLayout(0), [ b(0, this.uniformsBuffer), t(2, resources.water.read), t(6, resources.water.write) ]));
        pass5.dispatchWorkgroups(workgroupCount, workgroupCount);
        pass5.end();
        encoder.copyTextureToBuffer({ texture: resources.water.write }, { buffer: waterEvaporationStaging, bytesPerRow: gridSize * 4 }, { width: gridSize, height: gridSize });

        // Submit and wait
        this.device.queue.submit([encoder.finish()]);
        await this.device.queue.onSubmittedWorkDone();

        // Map all buffers
        const mapPromises = [
            waterStaging.mapAsync(GPUMapMode.READ), velocityStaging.mapAsync(GPUMapMode.READ),
            terrainErosionStaging.mapAsync(GPUMapMode.READ), sedimentErosionStaging.mapAsync(GPUMapMode.READ),
            waterTransportStaging.mapAsync(GPUMapMode.READ), sedimentTransportStaging.mapAsync(GPUMapMode.READ),
            waterEvaporationStaging.mapAsync(GPUMapMode.READ),
        ];
        await Promise.all(mapPromises);

        // Helper to analyze a buffer
        const analyzeBuffer = (buffer) => {
            const data = new Float32Array(buffer.getMappedRange());
            let sum = 0, min = Infinity, max = -Infinity, nonZeroCount = 0;
            for (const v of data) { sum += v; if (v < min) min = v; if (v > max) max = v; if (Math.abs(v) > 1e-9) nonZeroCount++; }
            buffer.unmap();
            return { sum: sum.toFixed(4), min: min.toFixed(4), max: max.toFixed(4), avg: (sum / data.length).toFixed(4), nonZero: `${nonZeroCount} / ${data.length}` };
        };

        const capturedData = {
            pass1_water: analyzeBuffer(waterStaging),
            pass2_velocity: analyzeBuffer(velocityStaging),
            pass3_terrain: analyzeBuffer(terrainErosionStaging),
            pass3_sediment: analyzeBuffer(sedimentErosionStaging),
            pass4_water: analyzeBuffer(waterTransportStaging),
            pass4_sediment: analyzeBuffer(sedimentTransportStaging),
            pass5_water: analyzeBuffer(waterEvaporationStaging),
        };

        // Cleanup
        waterStaging.destroy(); velocityStaging.destroy(); terrainErosionStaging.destroy(); sedimentErosionStaging.destroy(); waterTransportStaging.destroy(); sedimentTransportStaging.destroy(); waterEvaporationStaging.destroy();

        return capturedData;
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
        this.uniformsBuffer = this.device.createBuffer({ size: 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
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