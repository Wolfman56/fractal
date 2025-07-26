// This shader is designed to generate a specific "tile" of the fractal
// at a given "Level of Detail" (LOD). This is the foundation for
// advanced terrain rendering systems like clipmaps.

struct Uniforms {
    gridSize: vec2<u32>,
    octaves: u32,
    persistence: f32,
    lacunarity: f32,
    hurst: f32,
    scale: f32,
    seed: u32,
    origin: vec2<i32>,
    lod: u32,               // The level of detail (0 = highest res)
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read_write> output: array<f32>;
@group(0) @binding(2) var<storage, read_write> min_max_buffer: array<atomic<i32>>;

fn fade(t: f32) -> f32 {
    return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

fn lerp(a: f32, b: f32, t: f32) -> f32 {
    return a + t * (b - a);
}

fn grad(hash: u32, x: f32, y: f32) -> f32 {
    switch (hash & 7u) {
        case 0u: { return  x + y; }
        case 1u: { return -x + y; }
        case 2u: { return  x - y; }
        case 3u: { return -x - y; }
        case 4u: { return  x; }
        case 5u: { return -x; }
        case 6u: { return  y; }
        case 7u: { return -y; }
        default: { return 0.0; }
    }
}

fn pcg(v_in: u32) -> u32 {
    var v = v_in * 747796405u + 2891336453u;
    let s = ((v >> ((v >> 28u) + 4u)) ^ v) * 277803737u;
    return (s >> 22u) ^ s;
}

fn perlin2d(p: vec2<f32>) -> f32 {
    let p_int = floor(p);
    let p_fract = fract(p);
    let p00 = vec2<i32>(p_int);
    let p10 = p00 + vec2(1, 0);
    let p01 = p00 + vec2(0, 1);
    let p11 = p00 + vec2(1, 1);
    let h00 = pcg(u32(p00.x) + pcg(u32(p00.y) + uniforms.seed));
    let h10 = pcg(u32(p10.x) + pcg(u32(p10.y) + uniforms.seed));
    let h01 = pcg(u32(p01.x) + pcg(u32(p01.y) + uniforms.seed));
    let h11 = pcg(u32(p11.x) + pcg(u32(p11.y) + uniforms.seed));
    let u = fade(p_fract.x);
    let v = fade(p_fract.y);
    let n1 = lerp(grad(h00, p_fract.x, p_fract.y), grad(h10, p_fract.x - 1.0, p_fract.y), u);
    let n2 = lerp(grad(h01, p_fract.x, p_fract.y - 1.0), grad(h11, p_fract.x - 1.0, p_fract.y - 1.0), u);
    return lerp(n1, n2, v);
}

@compute @workgroup_size(8, 8, 1)
fn main_generate(@builtin(global_invocation_id) global_id: vec3<u32>) {
    if (global_id.x >= uniforms.gridSize.x || global_id.y >= uniforms.gridSize.y) { return; }

    // Calculate the step size based on the Level of Detail.
    // LOD 0 = step 1, LOD 1 = step 2, LOD 2 = step 4, etc.
    let step = 1u << uniforms.lod;

    // This is the correct logic. The origin and local id are in the high-res
    // grid space. The entire coordinate is scaled by the LOD step to get
    // the final world position for sampling.
    let coords = (vec2<f32>(uniforms.origin) + vec2<f32>(global_id.xy)) * f32(step);

    var value: f32 = 0.0;
    var frequency: f32 = 1.0 / uniforms.scale;
    var amplitude: f32 = 1.0;
    for (var i: u32 = 0u; i < uniforms.octaves; i = i + 1u) {
        value = value + amplitude * perlin2d(coords * frequency);
        frequency = frequency * uniforms.lacunarity;
        amplitude = amplitude * uniforms.persistence;
    }
    let index = global_id.x + global_id.y * uniforms.gridSize.x;
    output[index] = value;
    let scaled_value = i32(value * 1000000.0);
    atomicMin(&min_max_buffer[0], scaled_value);
    atomicMax(&min_max_buffer[1], scaled_value);
}

// The normalization pass would be separate and run after all tiles for a frame are generated.
// For simplicity, it's omitted here but would be identical to the main_normalize function in compute.wgsl.