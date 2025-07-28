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

        // GPU Resources for a single mesh
        this.indexFormat = 'uint16';

        this.projectionBuffer = null;
        this.depthTexture = null;

        this.tiles = new Map(); // Manages the collection of visible tiles
        this.camera = new Camera();
    }

    async initWebGPU() {
        if (!navigator.gpu) {
            alert('WebGPU is not supported in this browser.');
            return null;
        }
        const adapter = await navigator.gpu.requestAdapter();

        const requiredLimits = {};
        // The erosion shader requires up to 8 storage textures.
        // We check if the adapter supports this and request it.
        if (adapter.limits.maxStorageTexturesPerShaderStage >= 8) {
            requiredLimits.maxStorageTexturesPerShaderStage = 8;
        } else {
            // Warn the developer if the hardware is not capable.
            console.warn(`This adapter only supports ${adapter.limits.maxStorageTexturesPerShaderStage} storage textures per shader stage. The erosion simulation, which requires 8, may not work correctly.`);
        }
        this.device = await adapter.requestDevice({ requiredLimits });

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
        const [renderCode] = await Promise.all([
            fetch('/shaders/render.wgsl').then(res => res.text()),
        ]);

        const renderModule = this.device.createShaderModule({ code: renderCode });

        const computeBindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
            ],
        });
        const computePipelineLayout = this.device.createPipelineLayout({ bindGroupLayouts: [computeBindGroupLayout] });
        
        this.renderPipeline = await this.device.createRenderPipeline({
            layout: 'auto',
            vertex: {
                module: renderModule,
                entryPoint: 'vs_main',
                buffers: [
                    { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
                    { arrayStride: 12, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] },
                    { arrayStride: 12, attributes: [{ shaderLocation: 2, offset: 0, format: 'float32x3' }] },
                ],
            },
            fragment: { module: renderModule, entryPoint: 'fs_main', targets: [{ format: this.format }] },
            primitive: { topology: 'triangle-list' },
            depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
        });
        await checkShaderCompilation(this.renderPipeline, 'Render Pipeline');

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
            this.drawScene();
        }
    }

    recreateRenderResources() {
        // Destroy old resources
        [this.projectionBuffer, this.depthTexture]
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
                newTiles.set(key, new Tile(coord.x, coord.z, coord.lod, this.device, this.renderPipeline, this.projectionBuffer));
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

    updateTileMesh(key, heights, params, waterHeights = null, globalOffset = null, neighborLODs = {}) {
        const tile = this.tiles.get(key);
        if (!tile) return;

        // Use the pre-calculated global offset if provided, otherwise calculate a local one.
        // This ensures all tiles in a tiled system share the same "sea level".
        const offset = globalOffset !== null ? globalOffset : 0;

        const { positions, normals, colors, indices, yValues } = createTileGeometry(
            heights,
            params,
            waterHeights,
            neighborLODs,
            tile.lod,
            offset
        );

        // For a tiled system, we only want to set the camera target based on the central tile.
        if (tile.x === 0 && tile.z === 0) {
            let maxY = -Infinity;
            for (let i = 1; i < positions.length; i += 3) {
                if (positions[i] > maxY) maxY = positions[i];
            }
            this.camera.target = [0, maxY / 2, 0];
        }

        this.updateMeshBuffers(tile, positions, normals, colors, indices);
    }

    updateMeshBuffers(tile, positions, normals, colors, indices) {
        [tile.positionBuffer, tile.normalBuffer, tile.colorBuffer, tile.indexBuffer]
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

        tile.colorBuffer = this.device.createBuffer({
            size: Float32Array.from(colors).byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        this.device.queue.writeBuffer(tile.colorBuffer, 0, new Float32Array(colors));

        const vertexCount = positions.length / 3;
        this.indexFormat = vertexCount > 65535 ? 'uint32' : 'uint16';
        const IndexArray = this.indexFormat === 'uint32' ? Uint32Array : Uint16Array;
        tile.indexCount = indices.length;

        tile.indexBuffer = this.device.createBuffer({
            size: IndexArray.from(indices).byteLength,
            usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        });
        this.device.queue.writeBuffer(tile.indexBuffer, 0, new IndexArray(indices));
    }

    drawScene() {
        if (!this.device || !this.context || !this.renderPipeline) {
            return;
        }

        const projectionMatrix = mat4.create();
        mat4.perspective(projectionMatrix, (45 * Math.PI) / 180, this.canvas.width / this.canvas.height, 0.1, 100);
        this.device.queue.writeBuffer(this.projectionBuffer, 0, projectionMatrix);

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

        const viewMatrix = this.camera.getViewMatrix();

        for (const tile of this.tiles.values()) {
            if (!tile.indexBuffer) continue; // Skip tiles that aren't ready

            const modelViewMatrix = mat4.create();
            mat4.multiply(modelViewMatrix, viewMatrix, tile.modelMatrix);

            const normalMatrix = mat4.create();
            mat4.invert(normalMatrix, modelViewMatrix);
            mat4.transpose(normalMatrix, normalMatrix);

            this.device.queue.writeBuffer(tile.modelViewBuffer, 0, modelViewMatrix);
            this.device.queue.writeBuffer(tile.normalMatBuffer, 0, normalMatrix);

            renderPass.setPipeline(this.renderPipeline);
            renderPass.setBindGroup(0, tile.renderBindGroup);
            renderPass.setVertexBuffer(0, tile.positionBuffer);
            renderPass.setVertexBuffer(1, tile.normalBuffer);
            renderPass.setVertexBuffer(2, tile.colorBuffer);
            renderPass.setIndexBuffer(tile.indexBuffer, this.indexFormat);
            renderPass.drawIndexed(tile.indexCount);
        }

        renderPass.end();

        this.device.queue.submit([encoder.finish()]);
    }
}