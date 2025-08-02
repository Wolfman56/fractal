import { getPaddedByteRange, padBuffer, withTimeout } from './utils.js';

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
        const passes = ['water', 'flow', 'erosion', 'transport', 'deposition', 'evaporation'];
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

        // Buffer size is 52 bytes to hold all uniforms including cellSize.
        this.uniformsBuffer = this.device.createBuffer({ size: 52, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

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
        const createBindGroup = (layout, bindings) => this.device.createBindGroup({ layout, entries: bindings });
        const t = (binding, texture) => ({ binding, resource: texture.createView() });
        const b = (binding, buffer) => ({ binding, resource: { buffer } });

        // Set A: Corresponds to an even-numbered iteration (i % 2 === 0)
        const bg_A = {
            water:      createBindGroup(this.pipelines.water.getBindGroupLayout(0), [ b(0, this.uniformsBuffer), t(2, this.waterTextureA), t(6, this.waterTextureB) ]),
            flow:       createBindGroup(this.pipelines.flow.getBindGroupLayout(0), [ b(0, this.uniformsBuffer), t(1, this.terrainTextureA), t(2, this.waterTextureB), t(4, this.velocityTextureA), t(8, this.velocityTextureB) ]),
            erosion:    createBindGroup(this.pipelines.erosion.getBindGroupLayout(0), [ b(0, this.uniformsBuffer), t(1, this.terrainTextureA), t(2, this.waterTextureB), t(3, this.sedimentTextureA), t(4, this.velocityTextureB), t(5, this.terrainTextureB), t(7, this.sedimentTextureB) ]),
            transport:  createBindGroup(this.pipelines.transport.getBindGroupLayout(0), [ b(0, this.uniformsBuffer), t(2, this.waterTextureB), t(3, this.sedimentTextureB), t(4, this.velocityTextureB), t(6, this.waterTextureA), t(7, this.sedimentTextureA) ]),
            deposition: createBindGroup(this.pipelines.deposition.getBindGroupLayout(0), [ b(0, this.uniformsBuffer), t(1, this.terrainTextureB), t(2, this.waterTextureA), t(3, this.sedimentTextureA), t(4, this.velocityTextureB), t(5, this.terrainTextureA), t(7, this.sedimentTextureB) ]),
            evaporation:createBindGroup(this.pipelines.evaporation.getBindGroupLayout(0), [ b(0, this.uniformsBuffer), t(2, this.waterTextureA), t(6, this.waterTextureB) ]),
        };

        // Set B: Corresponds to an odd-numbered iteration (i % 2 === 1)
        const bg_B = {
            water:      createBindGroup(this.pipelines.water.getBindGroupLayout(0), [ b(0, this.uniformsBuffer), t(2, this.waterTextureB), t(6, this.waterTextureA) ]),
            flow:       createBindGroup(this.pipelines.flow.getBindGroupLayout(0), [ b(0, this.uniformsBuffer), t(1, this.terrainTextureB), t(2, this.waterTextureA), t(4, this.velocityTextureB), t(8, this.velocityTextureA) ]),
            erosion:    createBindGroup(this.pipelines.erosion.getBindGroupLayout(0), [ b(0, this.uniformsBuffer), t(1, this.terrainTextureB), t(2, this.waterTextureA), t(3, this.sedimentTextureB), t(4, this.velocityTextureA), t(5, this.terrainTextureA), t(7, this.sedimentTextureA) ]),
            transport:  createBindGroup(this.pipelines.transport.getBindGroupLayout(0), [ b(0, this.uniformsBuffer), t(2, this.waterTextureA), t(3, this.sedimentTextureA), t(4, this.velocityTextureA), t(6, this.waterTextureB), t(7, this.sedimentTextureB) ]),
            deposition: createBindGroup(this.pipelines.deposition.getBindGroupLayout(0), [ b(0, this.uniformsBuffer), t(1, this.terrainTextureA), t(2, this.waterTextureB), t(3, this.sedimentTextureB), t(4, this.velocityTextureA), t(5, this.terrainTextureB), t(7, this.sedimentTextureA) ]),
            evaporation:createBindGroup(this.pipelines.evaporation.getBindGroupLayout(0), [ b(0, this.uniformsBuffer), t(2, this.waterTextureB), t(6, this.waterTextureA) ]),
        };

        this.bindGroups = {
            even: bg_A, // Use for i = 0, 2, 4...
            odd:  bg_B, // Use for i = 1, 3, 5...
        };
    }

    resetState() {
        if (!this.waterTextureA) return; // Don't run if resources aren't created yet

        const queue = this.device.queue;
        const textureSize = { width: this.gridSize, height: this.gridSize };

        const zeroDataR32F = new Float32Array(this.gridSize * this.gridSize);
        const { paddedBuffer: paddedR32F, bytesPerRow: bytesPerRowR32F } = padBuffer(zeroDataR32F, this.gridSize, this.gridSize);
        queue.writeTexture({ texture: this.waterTextureA }, paddedR32F, { bytesPerRow: bytesPerRowR32F }, textureSize);
        queue.writeTexture({ texture: this.waterTextureB }, paddedR32F, { bytesPerRow: bytesPerRowR32F }, textureSize);
        queue.writeTexture({ texture: this.sedimentTextureA }, paddedR32F, { bytesPerRow: bytesPerRowR32F }, textureSize);
        queue.writeTexture({ texture: this.sedimentTextureB }, paddedR32F, { bytesPerRow: bytesPerRowR32F }, textureSize);

        const zeroDataRGBA32F = new Float32Array(this.gridSize * this.gridSize * 4);
        const { paddedBuffer: paddedRGBA32F, bytesPerRow: bytesPerRowRGBA32F } = padBuffer(zeroDataRGBA32F, this.gridSize, this.gridSize, 16);
        queue.writeTexture({ texture: this.velocityTextureA }, paddedRGBA32F, { bytesPerRow: bytesPerRowRGBA32F }, textureSize);
        queue.writeTexture({ texture: this.velocityTextureB }, paddedRGBA32F, { bytesPerRow: bytesPerRowRGBA32F }, textureSize);
        console.log("Hydraulic erosion state (water, sediment, velocity) has been reset.");
    }

    _prepareUniforms(params) {
        const uniformData = new Float32Array(13);
        const uniformDataU32 = new Uint32Array(uniformData.buffer);
        uniformData[0] = params.dt;
        uniformData[1] = params.density;
        uniformData[2] = params.evapRate;
        uniformData[3] = params.depositionRate;
        uniformData[4] = params.solubility;
        uniformData[5] = params.minSlope;
        uniformData[6] = params.capacityFactor;
        uniformData[7] = params.rainAmount;
        uniformData[8] = params.seaLevel;
        uniformDataU32[9] = params.gridSize;
        uniformData[10] = params.heightMultiplier;
        uniformData[11] = params.velocityDamping;
        uniformData[12] = params.cellSize;
        return uniformData;
    }

    _runPass(encoder, passName, bindGroup, workgroupCount) {
        const pass = encoder.beginComputePass({ label: `${passName} Pass` });
        pass.setPipeline(this.pipelines[passName.toLowerCase()]);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(workgroupCount, workgroupCount);
        pass.end();
    }

    run(encoder, iterations, params) {
        this.device.queue.writeBuffer(this.uniformsBuffer, 0, this._prepareUniforms(params));

        for (let i = 0; i < iterations; i++) {
            const workgroupCount = Math.ceil(this.gridSize / 16);
            const bindGroupSet = (i % 2 === 0) ? this.bindGroups.even : this.bindGroups.odd;

            if (params.addRain) {
                this._runPass(encoder, 'water', bindGroupSet.water, workgroupCount);
            } else {
                const [waterRead, waterWrite] = (i % 2 === 0) ? [this.waterTextureA, this.waterTextureB] : [this.waterTextureB, this.waterTextureA];
                encoder.copyTextureToTexture({ texture: waterRead }, { texture: waterWrite }, { width: this.gridSize, height: this.gridSize });
            }

            ['flow', 'erosion', 'transport', 'deposition', 'evaporation'].forEach(passName => {
                this._runPass(encoder, passName, bindGroupSet[passName], workgroupCount);
            });
        }
    }
}

export class HydraulicErosionModelDebug extends HydraulicErosionModel {
    constructor(device) {
        super(device);
        this.isStateA = true;
        this.texturesA = null;
        this.texturesB = null;
    }

    recreateResources(gridSize) {
        super.recreateResources(gridSize); // This calls resetState()
        this.isStateA = true;
        this.texturesA = {
            water: this.waterTextureA, sediment: this.sedimentTextureA, velocity: this.velocityTextureA
        };
        this.texturesB = {
            water: this.waterTextureB, sediment: this.sedimentTextureB, velocity: this.velocityTextureB
        };
    }

    async capturePassData(encoder, texture, name) {
        const format = texture.format;
        const bytesPerPixel = format.includes('rgba') ? 16 : 4;
        const { bytesPerRow, bufferSize } = getPaddedByteRange(this.gridSize, this.gridSize, bytesPerPixel);
        const stagingBuffer = this.device.createBuffer({ size: bufferSize, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
        
        encoder.copyTextureToBuffer({ texture }, { buffer: stagingBuffer, bytesPerRow }, { width: this.gridSize, height: this.gridSize });
        
        return {
            buffer: stagingBuffer,
            name: name,
            analyze: () => {
                const mappedRange = stagingBuffer.getMappedRange();
                const data = new Float32Array(mappedRange);
                let sum = 0.0, min = Infinity, max = -Infinity;
                 for (let i = 0; i < data.length; i++) {
                     const v = data[i];
                     sum += v;
                     if (v < min) min = v;
                     if (v > max) max = v;
                 }
                const avg = sum / data.length;
                const result = {};
                result[name] = { sum, min, max, avg };
                return result;
            }
        };
    }

    async captureSingleStep(params, externalTerrainTextures) {
        const encoder = this.device.createCommandEncoder({ label: "Erosion Capture Encoder" });
        this.device.queue.writeBuffer(this.uniformsBuffer, 0, this._prepareUniforms(params));

        const readSet = this.isStateA ? this.texturesA : this.texturesB;
        const writeSet = this.isStateA ? this.texturesB : this.texturesA;
        const terrainRead = this.isStateA ? externalTerrainTextures.read : externalTerrainTextures.write;
        const terrainWrite = this.isStateA ? externalTerrainTextures.write : externalTerrainTextures.read;

        const captureTasks = [];

        this.runWater(encoder, params, readSet.water, writeSet.water);
        captureTasks.push(await this.capturePassData(encoder, writeSet.water, 'pass1_water'));

        this.runFlow(encoder, params, writeSet.water, terrainRead, readSet.velocity, writeSet.velocity);
        captureTasks.push(await this.capturePassData(encoder, writeSet.velocity, 'pass2_velocity'));

        this.runErosion(encoder, params, terrainRead, writeSet.water, readSet.sediment, writeSet.velocity, terrainWrite, writeSet.sediment);
        captureTasks.push(await this.capturePassData(encoder, terrainWrite, 'pass3_terrain'));
        captureTasks.push(await this.capturePassData(encoder, writeSet.sediment, 'pass3_sediment'));

        this.runTransport(encoder, params, writeSet.water, writeSet.sediment, writeSet.velocity, readSet.water, readSet.sediment);
        captureTasks.push(await this.capturePassData(encoder, readSet.water, 'pass4_water'));
        captureTasks.push(await this.capturePassData(encoder, readSet.sediment, 'pass4_sediment'));

        this.runDeposition(encoder, params, terrainWrite, readSet.water, readSet.sediment, writeSet.velocity, terrainRead, writeSet.sediment);
        captureTasks.push(await this.capturePassData(encoder, terrainRead, 'pass5_terrain'));
        captureTasks.push(await this.capturePassData(encoder, writeSet.sediment, 'pass5_sediment'));

        this.runEvaporation(encoder, params, readSet.water, writeSet.water);
        captureTasks.push(await this.capturePassData(encoder, writeSet.water, 'pass6_water'));

        this.device.queue.submit([encoder.finish()]);
        await this.device.queue.onSubmittedWorkDone();

        await Promise.all(captureTasks.map(task => task.buffer.mapAsync(GPUMapMode.READ)));

        const capturedData = {};
        for (const task of captureTasks) {
            Object.assign(capturedData, task.analyze());
            task.buffer.unmap();
            task.buffer.destroy();
        }

        this.isStateA = !this.isStateA;

        return { capturedData, heights: null, waterHeights: null };
    }

    _runPass(encoder, passName, entries) {
        const pass = encoder.beginComputePass({ label: `${passName} Pass` });
        const pipeline = this.pipelines[passName.toLowerCase()];
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, this.device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: this.uniformsBuffer } },
                ...entries
            ]
        }));
        pass.dispatchWorkgroups(Math.ceil(this.gridSize / 16), Math.ceil(this.gridSize / 16));
        pass.end();
    }

    runWater(encoder, params, waterIn, waterOut) {
        if (params.addRain) {
            this._runPass(encoder, 'Water', [
                { binding: 2, resource: waterIn.createView() },
                { binding: 6, resource: waterOut.createView() },
            ]);
        } else {
            encoder.copyTextureToTexture({ texture: waterIn }, { texture: waterOut }, { width: this.gridSize, height: this.gridSize });
        }
    }

    runFlow(encoder, params, waterIn, terrainIn, velocityIn, velocityOut) {
        this._runPass(encoder, 'Flow', [
            { binding: 1, resource: terrainIn.createView() },
            { binding: 2, resource: waterIn.createView() },
            { binding: 4, resource: velocityIn.createView() },
            { binding: 8, resource: velocityOut.createView() },
        ]);
    }

    runErosion(encoder, params, terrainIn, waterIn, sedimentIn, velocityIn, terrainOut, sedimentOut) {
        this._runPass(encoder, 'Erosion', [
            { binding: 1, resource: terrainIn.createView() }, { binding: 2, resource: waterIn.createView() },
            { binding: 3, resource: sedimentIn.createView() }, { binding: 4, resource: velocityIn.createView() },
            { binding: 5, resource: terrainOut.createView() }, { binding: 7, resource: sedimentOut.createView() },
        ]);
    }

    runTransport(encoder, params, waterIn, sedimentIn, velocityIn, waterOut, sedimentOut) {
        this._runPass(encoder, 'Transport', [
            { binding: 2, resource: waterIn.createView() }, { binding: 3, resource: sedimentIn.createView() },
            { binding: 4, resource: velocityIn.createView() }, { binding: 6, resource: waterOut.createView() },
            { binding: 7, resource: sedimentOut.createView() },
        ]);
    }

    runDeposition(encoder, params, terrainIn, waterIn, sedimentIn, velocityIn, terrainOut, sedimentOut) {
        this._runPass(encoder, 'Deposition', [
            { binding: 1, resource: terrainIn.createView() }, { binding: 2, resource: waterIn.createView() },
            { binding: 3, resource: sedimentIn.createView() }, { binding: 4, resource: velocityIn.createView() },
            { binding: 5, resource: terrainOut.createView() }, { binding: 7, resource: sedimentOut.createView() },
        ]);
    }

    runEvaporation(encoder, params, waterIn, waterOut) {
        this._runPass(encoder, 'Evaporation', [
            { binding: 2, resource: waterIn.createView() },
            { binding: 6, resource: waterOut.createView() },
        ]);
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
        this.bindGroupAtoB = null;
        this.bindGroupBtoA = null;
    }

    run(encoder, iterations, params, terrainTextures) {
        const erosionRate = params.depositionRate * 0.1;
        this.device.queue.writeBuffer(this.uniformsBuffer, 0, new Float32Array([erosionRate]));

        if (!this.bindGroupAtoB) {
            const bindGroupLayout = this.pipeline.getBindGroupLayout(0);
            this.bindGroupAtoB = this.device.createBindGroup({ layout: bindGroupLayout, entries: [ { binding: 0, resource: terrainTextures.read.createView() }, { binding: 1, resource: terrainTextures.write.createView() }, { binding: 2, resource: { buffer: this.uniformsBuffer } } ] });
            this.bindGroupBtoA = this.device.createBindGroup({ layout: bindGroupLayout, entries: [ { binding: 0, resource: terrainTextures.write.createView() }, { binding: 1, resource: terrainTextures.read.createView() }, { binding: 2, resource: { buffer: this.uniformsBuffer } } ] });
        }

        for (let i = 0; i < iterations; i++) {
            const pass = encoder.beginComputePass({ label: `Simple Erosion Pass ${i}` });
            pass.setPipeline(this.pipeline);
            pass.setBindGroup(0, (i % 2 === 0) ? this.bindGroupAtoB : this.bindGroupBtoA);
            pass.dispatchWorkgroups(Math.ceil(this.gridSize / 16), Math.ceil(this.gridSize / 16));
            pass.end();
        }
    }
}