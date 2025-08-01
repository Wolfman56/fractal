import mat4 from './mat4.js';
import { checkShaderCompilation } from './utils.js';
import Camera from './camera.js';
import Tile from './tile.js';
import { createTileGeometry } from './geometry.js';

export default class View {
    constructor(canvas) {
        this.canvas = canvas;
        this.device = null;
        this.context = null;
        this.format = null;

        // Pipelines
        this.renderPipeline = null;
        this.flowRenderPipeline = null;

        // GPU Resources for a single mesh
        this.indexFormat = 'uint16';

        this.projectionBuffer = null;
        this.viewBuffer = null;
        this.globalParamsBuffer = null;
        this.depthTexture = null;

        // Resources for the flow heatmap view
        this.flowRenderBindGroup = null;
        this.linearSampler = null;
        this.nearestSampler = null;

        this.tiles = new Map(); // Manages the collection of visible tiles
        this.camera = new Camera();
    }

    async initWebGPU() {
        if (!navigator.gpu) {
            alert('WebGPU is not supported in this browser.');
            return null;
        }
        const adapter = await navigator.gpu.requestAdapter();

        const requiredFeatures = [];
        // The flow heatmap uses linear filtering on an rgba32float texture. This requires
        // the 'float32-filterable' feature, which is optional. We must request it.
        if (adapter.features.has('float32-filterable')) {
            requiredFeatures.push('float32-filterable');
        } else {
            console.error("CRITICAL: Adapter does not support 'float32-filterable'. The Flow Heatmap view will not function.");
        }

        const requiredLimits = {};
        // The erosion shader requires up to 8 storage textures.
        // We check if the adapter supports this and request it.
        if (adapter.limits.maxStorageTexturesPerShaderStage >= 8) {
            requiredLimits.maxStorageTexturesPerShaderStage = 8;
        } else {
            // Warn the developer if the hardware is not capable.
            console.warn(`This adapter only supports ${adapter.limits.maxStorageTexturesPerShaderStage} storage textures per shader stage. The erosion simulation, which requires 8, may not work correctly.`);
        }
        this.device = await adapter.requestDevice({ requiredFeatures, requiredLimits });

        this.device.lost.then(info => console.error(`WebGPU device was lost: ${info.message}`));
        this.device.addEventListener('uncapturederror', (event) => console.error('A WebGPU uncaptured error occurred:', event.error));

        this.context = this.canvas.getContext('webgpu');
        this.format = navigator.gpu.getPreferredCanvasFormat();
        this.context.configure({
            device: this.device,
            format: this.format,
            preserveDrawingBuffer: true,
        });

        // Fetch and create all pipelines
        console.log("Loading shader files...");
        const [renderCode, flowRenderCode] = await Promise.all([
            fetch('/shaders/render.wgsl').then(res => res.text()),
            fetch('/shaders/flow_render.wgsl').then(res => res.text()),
        ]);
        const flowRenderModule = this.device.createShaderModule({ code: flowRenderCode });

        const renderModule = this.device.createShaderModule({ code: renderCode });

        const computeBindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
            ],
        });
        const computePipelineLayout = this.device.createPipelineLayout({ bindGroupLayouts: [computeBindGroupLayout] });
        
        // Explicitly define the bind group layout for the standard render shader's uniforms (@group(0)).
        // This layout is shared between the standard render pipeline and the flow heatmap pipeline,
        // which is a requirement. A layout created implicitly with 'auto' cannot be reused.
        const renderBindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                { // modelMatrix
                    binding: 0,
                    visibility: GPUShaderStage.VERTEX,
                    buffer: { type: 'uniform' }
                },
                { // projectionMatrix
                    binding: 1,
                    visibility: GPUShaderStage.VERTEX,
                    buffer: { type: 'uniform' }
                },
                { // normalMatrix
                    binding: 2,
                    visibility: GPUShaderStage.VERTEX,
                    buffer: { type: 'uniform' }
                },
                { // viewMatrix
                    binding: 3,
                    visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                    buffer: { type: 'uniform' }
                },
                { // globals (seaLevel)
                    binding: 4,
                    visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                    buffer: { type: 'uniform' }
                }
            ]
        });

        this.renderPipeline = await this.device.createRenderPipeline({
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [renderBindGroupLayout] }),
            vertex: {
                module: renderModule,
                entryPoint: 'vs_main',
                buffers: [
                    { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
                    { arrayStride: 12, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] },
                    { arrayStride: 4, attributes: [{ shaderLocation: 2, offset: 0, format: 'float32' }] }, // water_depth
                ],
            },
            fragment: { module: renderModule, entryPoint: 'fs_main', targets: [{ format: this.format }] },
            primitive: { topology: 'triangle-list' },
            depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
        });
        await checkShaderCompilation(this.renderPipeline, 'Render Pipeline');

        // Explicitly define the bind group layout for the flow heatmap shader's second group (@group(1)).
        // This is necessary because we are using a mix of filterable (float) and non-filterable
        // textures, and the 'auto' layout can infer the wrong sample types.
        const flowRenderBindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                { // water_texture (r32float)
                    binding: 0,
                    visibility: GPUShaderStage.FRAGMENT,
                    texture: { sampleType: 'unfilterable-float' }
                },
                { // velocity_texture (rgba32float)
                    binding: 1,
                    visibility: GPUShaderStage.FRAGMENT,
                    texture: { sampleType: 'float' } // 'float' is filterable
                },
                { // terrain_texture (r32float)
                    binding: 2,
                    visibility: GPUShaderStage.FRAGMENT,
                    texture: { sampleType: 'unfilterable-float' }
                },
                { // linear_sampler
                    binding: 3,
                    visibility: GPUShaderStage.FRAGMENT,
                    sampler: { type: 'filtering' }
                },
                { // nearest_sampler
                    binding: 4,
                    visibility: GPUShaderStage.FRAGMENT,
                    sampler: { type: 'non-filtering' }
                },
                { // sediment_texture (r32float)
                    binding: 5,
                    visibility: GPUShaderStage.FRAGMENT,
                    texture: { sampleType: 'unfilterable-float' }
                }
            ]
        });

        this.flowRenderPipeline = await this.device.createRenderPipeline({
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [renderBindGroupLayout, flowRenderBindGroupLayout] }),
            vertex: {
                module: flowRenderModule,
                entryPoint: 'vs_main',
                buffers: [ // Only the position buffer is needed
                    { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] }
                ],
            },
            fragment: {
                module: flowRenderModule,
                entryPoint: 'fs_main',
                targets: [{ format: this.format }],
            },
            primitive: { topology: 'triangle-list' },
            depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
        });
        await checkShaderCompilation(this.flowRenderPipeline, 'Flow Render Pipeline');

        this.linearSampler = this.device.createSampler({
            magFilter: 'linear',
            minFilter: 'linear',
        });

        this.nearestSampler = this.device.createSampler({
            magFilter: 'nearest',
            minFilter: 'nearest',
        });

        return {
            device: this.device,
            computePipelineLayout: computePipelineLayout,
        };
    }

    handleResize() {
        const newWidth = this.canvas.clientWidth;
        const newHeight = this.canvas.clientHeight;

        // Check if the size has actually changed to avoid unnecessary work
        if (this.canvas.width !== newWidth || this.canvas.height !== newHeight) {
            this.canvas.width = newWidth;
            this.canvas.height = newHeight;

            this.recreateRenderResources();
            this.drawScene('standard');
        }
    }

    recreateRenderResources() {
        // Destroy old resources
        [this.projectionBuffer, this.viewBuffer, this.globalParamsBuffer, this.depthTexture]
            .forEach(r => r?.destroy());

        // Since the projectionBuffer was destroyed, any existing tiles have bind groups
        // that now point to an invalid resource. We must destroy them so they can be
        // recreated with the new projectionBuffer.
        for (const tile of this.tiles.values()) {
            tile.destroy();
        }
        this.tiles.clear();

        // Create Buffers
        this.projectionBuffer = this.device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        this.viewBuffer = this.device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        this.globalParamsBuffer = this.device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }); // Increased size for new uniforms

        // Create Textures
        this.depthTexture = this.device.createTexture({
            size: [this.canvas.width, this.canvas.height],
            format: 'depth24plus',
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });

    }

    /**
     * Manages the set of visible tiles. Creates new ones and removes old ones.
     * @param {Array<object>} tileCoords - An array of {x, z} coordinates for visible tiles.
     */
    setTiles(tileCoords) {
        const newTiles = new Map();
        const newKeys = new Set();

        for (const coord of tileCoords) {
            const key = `${coord.x},${coord.z}`;
            newKeys.add(key);
            if (this.tiles.has(key)) {
                newTiles.set(key, this.tiles.get(key));
            } else {
                newTiles.set(key, new Tile(coord.x, coord.z, coord.lod, this.device, this.renderPipeline, this.projectionBuffer, this.viewBuffer, this.globalParamsBuffer));
            }
        }

        // Destroy tiles that are no longer in view
        for (const [key, tile] of this.tiles.entries()) {
            if (!newKeys.has(key)) {
                tile.destroy();
            }
        }
        this.tiles = newTiles;
    }

    updateTileMesh(key, worldHeights, params, waterHeights = null, neighborLODs = {}, modelMatrix = null) {
        const tile = this.tiles.get(key);
        if (!tile) return;

        const { positions, normals, indices, waterDepths } = createTileGeometry(worldHeights, params, waterHeights);

        if (modelMatrix) {
            tile.modelMatrix = modelMatrix;
        }

        this.updateMeshBuffers(tile, positions, normals, indices, waterDepths);
    }

    updateMeshBuffers(tile, positions, normals, indices, waterDepths) {
        [tile.positionBuffer, tile.normalBuffer, tile.indexBuffer, tile.waterDepthBuffer]
            .forEach(b => b?.destroy()); // Destroy old buffers for this tile

        tile.positionBuffer = this.device.createBuffer({
            size: Float32Array.from(positions).byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        this.device.queue.writeBuffer(tile.positionBuffer, 0, new Float32Array(positions));

        tile.normalBuffer = this.device.createBuffer({
            size: Float32Array.from(normals).byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        this.device.queue.writeBuffer(tile.normalBuffer, 0, new Float32Array(normals));

        tile.waterDepthBuffer = this.device.createBuffer({
            size: Float32Array.from(waterDepths).byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        this.device.queue.writeBuffer(tile.waterDepthBuffer, 0, new Float32Array(waterDepths));

        const vertexCount = positions.length / 3;
        this.indexFormat = vertexCount > 65535 ? 'uint32' : 'uint16';
        const IndexArray = this.indexFormat === 'uint32' ? Uint32Array : Uint16Array;

        // The indexCount for drawing must be the original, unpadded length.
        tile.indexCount = indices.length;

        // The size of a buffer and the data written to it must be a multiple of 4 bytes.
        // If we're using uint16 (2 bytes) and have an odd number of indices, the byte length
        // will not be a multiple of 4. We must pad the data to meet this requirement.
        let indexData = new IndexArray(indices);
        if (indexData.byteLength % 4 !== 0) {
            const paddedData = new IndexArray(indices.length + 1);
            paddedData.set(indices);
            // The extra element is 0 by default, which is fine as it won't be drawn.
            indexData = paddedData;
        }

        tile.indexBuffer = this.device.createBuffer({
            size: indexData.byteLength, // Now guaranteed to be a multiple of 4
            usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        });
        this.device.queue.writeBuffer(tile.indexBuffer, 0, indexData);
    }

    updateGlobalParams(seaLevel, viewMode = 'standard', renderParams = null, verticalExaggeration = 1.0) {
        if (this.globalParamsBuffer) {
            const seaLevelOffset = renderParams?.seaLevelOffset ?? 0.0;
            const heightMultiplier = renderParams?.heightMultiplier ?? 1.0;

            const viewModeMap = {
                'standard': 0,
                'water-depth': 1,
                'water-velocity': 2,
                'sediment': 3
            };
            const viewModeIndex = viewModeMap[viewMode] ?? 0;

            // The buffer expects a layout that matches the `Globals` struct in the shader.
            const uniformData = new ArrayBuffer(32); // 32 bytes for alignment
            const floatView = new Float32Array(uniformData);
            const uintView = new Uint32Array(uniformData);

            floatView[0] = seaLevel;
            floatView[1] = seaLevelOffset;
            floatView[2] = heightMultiplier;
            floatView[3] = verticalExaggeration;
            uintView[4] = viewModeIndex; // At byte offset 16
            this.device.queue.writeBuffer(this.globalParamsBuffer, 0, uniformData);
        }
    }

    updateFlowMapTextures(waterTexture, velocityTexture, terrainTexture, sedimentTexture) {
        if (!this.flowRenderPipeline || !waterTexture || !velocityTexture || !terrainTexture || !sedimentTexture) return;

        // This bind group is created on-demand and points to the latest textures from the simulation.
        // It uses a different layout (@group(1)) than the main render pass to avoid conflicts.
        this.flowRenderBindGroup = this.device.createBindGroup({
            layout: this.flowRenderPipeline.getBindGroupLayout(1),
            entries: [
                { binding: 0, resource: waterTexture.createView() },
                { binding: 1, resource: velocityTexture.createView() },
                { binding: 2, resource: terrainTexture.createView() },
                { binding: 3, resource: this.linearSampler },
                { binding: 4, resource: this.nearestSampler },
                { binding: 5, resource: sedimentTexture.createView() },
            ],
        });
    }

    drawScene(viewMode = 'standard') {
        if (!this.device || !this.context) {
            return;
        }

        const activePipeline = viewMode !== 'standard' ? this.flowRenderPipeline : this.renderPipeline;
        if (!activePipeline) return;

        // If we're in heatmap mode but don't have the data yet, don't draw.
        if (viewMode !== 'standard' && !this.flowRenderBindGroup) return;

        const projectionMatrix = mat4.create();
        // The near and far clipping planes must be scaled with the world size to avoid clipping issues.
        // We can derive them from the camera's zoom limits, which are already world-scaled.
        const nearPlane = this.camera.minZoom * 0.1;
        const farPlane = this.camera.maxZoom * 2.0;
        mat4.perspective(projectionMatrix, (45 * Math.PI) / 180, this.canvas.width / this.canvas.height, nearPlane, farPlane);
        this.device.queue.writeBuffer(this.projectionBuffer, 0, projectionMatrix);

        const viewMatrix = this.camera.getViewMatrix();
        this.device.queue.writeBuffer(this.viewBuffer, 0, viewMatrix);

        const encoder = this.device.createCommandEncoder();
        const textureView = this.context.getCurrentTexture().createView();
        const renderPass = encoder.beginRenderPass({
            colorAttachments: [{
                view: textureView,
                clearValue: { r: 0.1, g: 0.1, b: 0.11, a: 1.0 },
                loadOp: 'clear',
                storeOp: 'store',
            }],
            depthStencilAttachment: {
                view: this.depthTexture.createView(),
                depthClearValue: 1.0,
                depthLoadOp: 'clear',
                depthStoreOp: 'store',
            },
        });

        for (const tile of this.tiles.values()) {
            if (!tile.indexBuffer) continue; // Skip tiles that aren't ready

            const normalMatrix = mat4.create();
            mat4.invert(normalMatrix, tile.modelMatrix);
            mat4.transpose(normalMatrix, normalMatrix);

            this.device.queue.writeBuffer(tile.modelBuffer, 0, tile.modelMatrix);
            this.device.queue.writeBuffer(tile.normalMatBuffer, 0, normalMatrix);

            renderPass.setPipeline(activePipeline);
            if (viewMode !== 'standard') {
                renderPass.setBindGroup(0, tile.renderBindGroup); // Per-tile matrices
                renderPass.setBindGroup(1, this.flowRenderBindGroup); // Global flow textures
                renderPass.setVertexBuffer(0, tile.positionBuffer); // Only need position
            } else {
                renderPass.setBindGroup(0, tile.renderBindGroup);
                renderPass.setVertexBuffer(0, tile.positionBuffer);
                renderPass.setVertexBuffer(1, tile.normalBuffer);
                renderPass.setVertexBuffer(2, tile.waterDepthBuffer);
            }
            renderPass.setIndexBuffer(tile.indexBuffer, this.indexFormat);
            renderPass.drawIndexed(tile.indexCount);
        }

        renderPass.end();

        this.device.queue.submit([encoder.finish()]);
    }
}