/**
 * Base class for all shader strategies. Defines the interface for different
 * terrain generation behaviors.
 */
class ShaderStrategy {
    constructor() {
        this.name = 'Base';
        this.computeShaderUrl = '';
        this.computePipeline = null;
        this.normalizePipeline = null;
        this.regeneratesOnZoom = false;
        this.supportsPanning = false;

        // State for global normalization
        this.globalMin = Infinity;
        this.globalMax = -Infinity;
    }

    async createPipelines(device, layout) {
        // This method should be overridden by subclasses to create their specific pipelines.
        throw new Error("createPipelines must be implemented by subclasses.");
    }

    prepareUniforms(arrayBuffer, params, tileParams) {
        throw new Error("prepareUniforms must be implemented by subclasses.");
    }

    resetNormalization() {
        this.globalMin = Infinity;
        this.globalMax = -Infinity;
    }
}

export class ScrollingShaderStrategy extends ShaderStrategy {
    constructor() {
        super();
        this.name = 'Scrolling';
        this.computeShaderUrl = '/shaders/compute_scrolling.wgsl';
        this.supportsPanning = true;
    }

    async createPipelines(device, layout) {
        if (!this.computeShaderUrl) return;
        try {
            const response = await fetch(this.computeShaderUrl);
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const code = await response.text();
            if (code.trim().toLowerCase().startsWith('<!doctype')) throw new Error(`Received HTML instead of WGSL.`);

            const module = device.createShaderModule({ code });

            // This strategy uses a two-pass system: generate and then normalize.
            this.computePipeline = await device.createComputePipeline({ layout, compute: { module, entryPoint: 'main_generate' } });
            this.normalizePipeline = await device.createComputePipeline({ layout, compute: { module, entryPoint: 'main_normalize' } });

        } catch (e) {
            console.error(`Failed to create pipelines for strategy '${this.name}' with shader '${this.computeShaderUrl}'.`, e);
            this.computePipeline = null;
            this.normalizePipeline = null;
        }
    }

    prepareUniforms(arrayBuffer, params, tileParams) {
        const uniforms = new Float32Array(arrayBuffer);
        const uniformsU32 = new Uint32Array(arrayBuffer);
        uniformsU32[0] = params.gridSize;
        uniforms[1] = params.scale;
        uniforms[2] = params.seed;
        uniforms[3] = params.persistence;
        uniforms[4] = params.lacunarity;
        uniformsU32[5] = params.octaves;
        uniforms[6] = params.heightMultiplier;
        uniforms[7] = params.hurst;
        // worldOffset is at index 8 (vec2<f32>)
        uniforms[8] = params.worldOffset?.x ?? 0.0;
        uniforms[9] = params.worldOffset?.y ?? 0.0;
        // lod is at offset 40
        uniformsU32[10] = tileParams?.lod ?? 0;
        // origin is at offset 48 (4 bytes of padding after lod)
        uniforms[12] = tileParams?.origin?.x ?? 0.0;
        uniforms[13] = tileParams?.origin?.y ?? 0.0;
    }
}

export class FractalZoomShaderStrategy extends ShaderStrategy {
    constructor() {
        super();
        this.name = 'FractalZoom';
        this.regeneratesOnZoom = true;
        this.computeShaderUrl = '/shaders/compute_fbm.wgsl';
    }

    async createPipelines(device, layout) {
        if (!this.computeShaderUrl) return;
        try {
            const response = await fetch(this.computeShaderUrl);
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const code = await response.text();
            if (code.trim().toLowerCase().startsWith('<!doctype')) throw new Error(`Received HTML instead of WGSL.`);

            const module = device.createShaderModule({ code });

            // This strategy uses a two-pass system: generate and then normalize.
            this.computePipeline = await device.createComputePipeline({ layout, compute: { module, entryPoint: 'main_generate' } });
            this.normalizePipeline = await device.createComputePipeline({ layout, compute: { module, entryPoint: 'main_normalize' } });

        } catch (e) {
            console.error(`Failed to create pipelines for strategy '${this.name}' with shader '${this.computeShaderUrl}'.`, e);
            this.computePipeline = null;
            this.normalizePipeline = null;
        }
    }
    prepareUniforms(arrayBuffer, params, tileParams) {
        const uniforms = new Float32Array(arrayBuffer);
        const uniformsU32 = new Uint32Array(arrayBuffer);
        uniformsU32[0] = params.gridSize;
        uniforms[1] = params.scale;
        uniforms[2] = params.seed;
        uniforms[3] = params.persistence;
        uniforms[4] = params.lacunarity;
        uniformsU32[5] = params.octaves;
        uniforms[6] = params.heightMultiplier;
        uniforms[7] = params.hurst;
        // This strategy doesn't use offset, lod, or origin
    }
}

export class ScrollAndZoomStrategy extends ShaderStrategy {
    constructor() {
        super();
        this.name = 'Scroll & Zoom';
        this.regeneratesOnZoom = true;
        this.supportsPanning = true;
        this.computeShaderUrl = '/shaders/compute_scrolling.wgsl';
    }

    async createPipelines(device, layout) {
        if (!this.computeShaderUrl) return;
        try {
            const response = await fetch(this.computeShaderUrl);
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const code = await response.text();
            if (code.trim().toLowerCase().startsWith('<!doctype')) throw new Error(`Received HTML instead of WGSL.`);

            const module = device.createShaderModule({ code });

            // This strategy uses a two-pass system: generate and then normalize.
            this.computePipeline = await device.createComputePipeline({ layout, compute: { module, entryPoint: 'main_generate' } });
            this.normalizePipeline = await device.createComputePipeline({ layout, compute: { module, entryPoint: 'main_normalize' } });

        } catch (e) {
            console.error(`Failed to create pipelines for strategy '${this.name}' with shader '${this.computeShaderUrl}'.`, e);
            this.computePipeline = null;
            this.normalizePipeline = null;
        }
    }
    prepareUniforms(arrayBuffer, params, tileParams) {
        const uniforms = new Float32Array(arrayBuffer);
        const uniformsU32 = new Uint32Array(arrayBuffer);
        uniformsU32[0] = params.gridSize;
        uniforms[1] = params.scale;
        uniforms[2] = params.seed;
        uniforms[3] = params.persistence;
        uniforms[4] = params.lacunarity;
        uniformsU32[5] = params.octaves;
        uniforms[6] = params.heightMultiplier;
        uniforms[7] = params.hurst;
        // The worldOffset is at index 8 (vec2<f32>)
        uniforms[8] = params.worldOffset?.x ?? 0.0;
        uniforms[9] = params.worldOffset?.y ?? 0.0;
    }
}

/**
 * A strategy that generates a static pyramid shape.
 * Useful for debugging lighting, erosion, and water rendering.
 */
export class PyramidShaderStrategy extends ShaderStrategy {
    constructor() {
        super();
        this.name = 'Pyramid';
        this.regeneratesOnZoom = false; // It's a static shape
        this.computeShaderUrl = '/shaders/compute_pyramid.wgsl';
    }

    async createPipelines(device, layout) {
        if (!this.computeShaderUrl) return;
        try {
            const response = await fetch(this.computeShaderUrl);
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const code = await response.text();
            if (code.trim().toLowerCase().startsWith('<!doctype')) throw new Error(`Received HTML instead of WGSL.`);

            const module = device.createShaderModule({ code });
            // This strategy uses a single-pass system with a 'main' entry point.
            this.computePipeline = await device.createComputePipeline({ layout, compute: { module, entryPoint: 'main' } });
        } catch (e) {
            console.error(`Failed to create pipelines for strategy '${this.name}' with shader '${this.computeShaderUrl}'.`, e);
            this.computePipeline = null;
        }
    }

    prepareUniforms(arrayBuffer, params, tileParams) {
        const uniforms = new Float32Array(arrayBuffer);
        const uniformsU32 = new Uint32Array(arrayBuffer);
        uniformsU32[0] = params.gridSize;
        // The rest of the uniforms are not used by the pyramid shader,
        // but we fill them to match the struct for consistency.
        uniforms[1] = params.scale;
        uniforms[2] = params.seed;
        uniforms[3] = params.persistence;
        uniforms[4] = params.lacunarity;
        uniformsU32[5] = params.octaves;
        uniforms[6] = params.heightMultiplier;
        uniforms[7] = params.hurst;
        // No offset for this strategy
        uniforms[8] = 0.0;
        uniforms[9] = 0.0;
        // lod is at offset 40
        uniformsU32[10] = tileParams?.lod ?? 0;
        // origin is at offset 48 (4 bytes of padding after lod)
        uniforms[12] = tileParams?.origin?.x ?? 0.0;
        uniforms[13] = tileParams?.origin?.y ?? 0.0;
    }
}

/**
 * A strategy that generates a static bowl shape.
 * Useful for debugging water pooling and flow dynamics.
 */
export class BowlShaderStrategy extends ShaderStrategy {
    constructor() {
        super();
        this.name = 'Bowl';
        this.regeneratesOnZoom = false;
        this.computeShaderUrl = '/shaders/compute_bowl.wgsl';
    }

    async createPipelines(device, layout) {
        if (!this.computeShaderUrl) return;
        try {
            const response = await fetch(this.computeShaderUrl);
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const code = await response.text();
            if (code.trim().toLowerCase().startsWith('<!doctype')) throw new Error(`Received HTML instead of WGSL.`);

            const module = device.createShaderModule({ code });
            // This strategy uses a single-pass system with a 'main' entry point.
            this.computePipeline = await device.createComputePipeline({ layout, compute: { module, entryPoint: 'main' } });
        } catch (e) {
            console.error(`Failed to create pipelines for strategy '${this.name}' with shader '${this.computeShaderUrl}'.`, e);
            this.computePipeline = null;
        }
    }

    prepareUniforms(arrayBuffer, params, tileParams) {
        const uniformsU32 = new Uint32Array(arrayBuffer);
        uniformsU32[0] = params.gridSize;
        // The rest of the uniforms are not used by the bowl shader,
        // but we must provide a value to satisfy the struct layout.
    }
}

/**
 * A strategy that generates a static 45-degree plane.
 * Useful for creating a predictable initial state for validation.
 */
export class PlaneShaderStrategy extends ShaderStrategy {
    constructor() {
        super();
        this.name = 'Plane';
        this.regeneratesOnZoom = false;
        this.computeShaderUrl = '/shaders/compute_plane.wgsl';
    }

    async createPipelines(device, layout) {
        if (!this.computeShaderUrl) return;
        try {
            const response = await fetch(this.computeShaderUrl);
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const code = await response.text();
            if (code.trim().toLowerCase().startsWith('<!doctype')) throw new Error(`Received HTML instead of WGSL.`);

            const module = device.createShaderModule({ code });
            this.computePipeline = await device.createComputePipeline({ layout, compute: { module, entryPoint: 'main' } });
        } catch (e) {
            console.error(`Failed to create pipelines for strategy '${this.name}' with shader '${this.computeShaderUrl}'.`, e);
            this.computePipeline = null;
        }
    }

    prepareUniforms(arrayBuffer, params, tileParams) {
        const uniformsU32 = new Uint32Array(arrayBuffer);
        uniformsU32[0] = params.gridSize;
    }
}