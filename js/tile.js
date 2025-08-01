import mat4 from './mat4.js';

/**
 * A helper class to encapsulate the mesh data and transform for a single terrain tile.
 */
export default class Tile {
    constructor(x, z, lod, device, renderPipeline, projectionBuffer, viewBuffer, globalParamsBuffer) {
        this.x = x; // World position in tile units
        this.z = z;
        this.lod = lod;
        this.modelMatrix = mat4.create();
        // The scale of our mesh is 2x2 units (from -1 to 1), so we multiply the tile position by 2.
        mat4.translate(this.modelMatrix, this.modelMatrix, [x * 2, 0, z * 2]);

        // GPU buffers for this tile's mesh
        this.positionBuffer = null;
        this.normalBuffer = null;
        this.waterDepthBuffer = null;
        this.indexBuffer = null;
        this.indexCount = 0;

        // Per-tile uniform buffers and bind group
        this.modelBuffer = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        this.normalMatBuffer = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        this.renderBindGroup = device.createBindGroup({
            layout: renderPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: this.modelBuffer } },
                { binding: 1, resource: { buffer: projectionBuffer } }, // Shared projection
                { binding: 2, resource: { buffer: this.normalMatBuffer } },
                { binding: 3, resource: { buffer: viewBuffer } }, // Shared view
                { binding: 4, resource: { buffer: globalParamsBuffer } }, // Global params
            ],
        });
    }

    destroy() {
        // Clean up GPU resources when the tile is no longer needed.
        [this.positionBuffer, this.normalBuffer, this.waterDepthBuffer, this.indexBuffer,
         this.modelBuffer, this.normalMatBuffer].forEach(b => b?.destroy());
    }
}