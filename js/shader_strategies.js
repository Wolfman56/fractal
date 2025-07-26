/**
 * Base class (interface) for different terrain generation shader strategies.
 */
export class ShaderStrategy {
    constructor(name, path) {
        this.name = name;
        this.path = path;
        this.computePipeline = null;
        this.normalizePipeline = null;
        this.supportsScrolling = false;
        this.regeneratesOnZoom = false;
    }

    async createPipelines(device, layout) {
        const code = await fetch(this.path).then(res => res.text());
        const module = device.createShaderModule({ code });

        this.computePipeline = await device.createComputePipeline({
            layout: layout,
            compute: { module, entryPoint: 'main_generate' },
        });

        // Not all shaders have a normalize pass. Make it optional.
        try {
            this.normalizePipeline = await device.createComputePipeline({
                layout: layout,
                compute: { module, entryPoint: 'main_normalize' },
            });
        } catch (e) {
            console.warn(`Shader ${this.path} does not have a 'main_normalize' entry point. Skipping.`);
            this.normalizePipeline = null;
        }
    }

    /**
     * Fills the uniform buffer with parameters specific to this strategy.
     * @param {ArrayBuffer} uniformArrayBuffer - The ArrayBuffer for the uniform data.
     * @param {object} params - The high-level parameters from the UI/controller.
     */
    prepareUniforms(uniformArrayBuffer, params) {
        throw new Error("Method 'prepareUniforms()' must be implemented by subclasses.");
    }
}

export class ScrollingShaderStrategy extends ShaderStrategy {
    constructor() {
        super('Scrolling', 'shaders/compute-scrolling.wgsl');
        this.worldOffset = { x: 0, y: 0 };
        this.supportsScrolling = true;
    }

    prepareUniforms(uniformArrayBuffer, params) {
        const uint32View = new Uint32Array(uniformArrayBuffer);
        const float32View = new Float32Array(uniformArrayBuffer);
        uint32View[0] = params.gridSize;
        uint32View[1] = params.gridSize;
        uint32View[2] = params.octaves;
        float32View[3] = params.persistence;
        float32View[4] = params.lacunarity;
        float32View[5] = params.hurst;
        float32View[6] = params.scale;
        uint32View[7] = params.seed;
        // The scrolling shader has two extra f32s for the offset.
        // These start at byte offset 32.
        float32View[8] = this.worldOffset.x;
        float32View[9] = this.worldOffset.y;
    }

    scroll(dx, dy) {
        const newX = this.worldOffset.x + dx;
        const newY = this.worldOffset.y + dy;
        this.worldOffset.x = newX;
        this.worldOffset.y = newY;
    }
}

export class FractalZoomShaderStrategy extends ShaderStrategy {
    constructor() {
        // This strategy uses the standard compute shader. The "zoom" effect
        // is created by the Controller manipulating the 'scale' uniform.
        super('Fractal Zoom', 'shaders/compute.wgsl');
        this.regeneratesOnZoom = true;
    }

    prepareUniforms(uniformArrayBuffer, params) {
        const uint32View = new Uint32Array(uniformArrayBuffer);
        const float32View = new Float32Array(uniformArrayBuffer);
        uint32View[0] = params.gridSize;
        uint32View[1] = params.gridSize;
        uint32View[2] = params.octaves;
        float32View[3] = params.persistence;
        float32View[4] = params.lacunarity;
        float32View[5] = params.hurst;
        float32View[6] = params.scale; // The controller will adjust this value based on zoom
        uint32View[7] = params.seed;
    }
}

export class ScrollAndZoomStrategy extends ShaderStrategy {
    constructor() {
        super('Scroll & Zoom', 'shaders/compute-scrolling.wgsl');
        this.worldOffset = { x: 0, y: 0 };
        this.supportsScrolling = true;
        this.regeneratesOnZoom = true;
    }

    prepareUniforms(uniformArrayBuffer, params) {
        const uint32View = new Uint32Array(uniformArrayBuffer);
        const float32View = new Float32Array(uniformArrayBuffer);
        uint32View[0] = params.gridSize;
        uint32View[1] = params.gridSize;
        uint32View[2] = params.octaves;
        float32View[3] = params.persistence;
        float32View[4] = params.lacunarity;
        float32View[5] = params.hurst;
        float32View[6] = params.scale;
        uint32View[7] = params.seed;
        float32View[8] = this.worldOffset.x;
        float32View[9] = this.worldOffset.y;
    }

    scroll(dx, dy) {
        const newX = this.worldOffset.x + dx;
        const newY = this.worldOffset.y + dy;
        this.worldOffset.x = newX;
        this.worldOffset.y = newY;
    }
}

export class TiledLODShaderStrategy extends ShaderStrategy {
    constructor() {
        super('Tiled LOD', 'shaders/compute-tiled-lod.wgsl');
        // This strategy's behavior is more complex than the simple flags can represent.
        // The Controller will have specific logic for when this strategy is active.
    }

    // Override the base pipeline creation because this shader is special.
    // It does not have a normalization pass; that is handled on the CPU.
    async createPipelines(device, layout) {
        const code = await fetch(this.path).then(res => res.text());
        const module = device.createShaderModule({ code });

        this.computePipeline = await device.createComputePipeline({
            layout: layout,
            compute: { module, entryPoint: 'main_generate' },
        });

        // Explicitly set to null to prevent the model from trying to run a
        // non-existent normalization pass.
        this.normalizePipeline = null;
    }

    /**
     * Prepares uniforms for generating a specific tile at a specific LOD.
     * @param {ArrayBuffer} uniformArrayBuffer - The buffer to fill.
     * @param {object} params - The global terrain parameters from the UI.
     * @param {object} tileParams - The parameters for the specific tile, like { origin, lod }.
     */
    prepareUniforms(uniformArrayBuffer, params, tileParams) {
        const uint32View = new Uint32Array(uniformArrayBuffer);
        const int32View = new Int32Array(uniformArrayBuffer);
        const float32View = new Float32Array(uniformArrayBuffer);
        uint32View[0] = params.gridSize; // Tile size
        uint32View[1] = params.gridSize; // Tile size
        uint32View[2] = params.octaves;
        float32View[3] = params.persistence;
        float32View[4] = params.lacunarity;
        float32View[5] = params.hurst;
        float32View[6] = params.scale;
        uint32View[7] = params.seed;
        int32View[8] = tileParams.origin.x;
        int32View[9] = tileParams.origin.y;
        uint32View[10] = tileParams.lod;
    }
}