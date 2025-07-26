struct Params {
    width: u32,
    height: u32,
    octaves: u32,
    persistence: f32,
    lacunarity: f32,
    hurst: f32,
    scale: f32,
    seed: u32,
    offset: vec2<f32>, // New: The world-space offset for the view window
};

@group(0) @binding(0) var<uniform> params: Params;
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
    let p10 = p00 + vec2<i32>(1, 0);
    let p01 = p00 + vec2<i32>(0, 1);
    let p11 = p00 + vec2<i32>(1, 1);
    let h00 = pcg(u32(p00.x) + pcg(u32(p00.y) + params.seed));
    let h10 = pcg(u32(p10.x) + pcg(u32(p10.y) + params.seed));
    let h01 = pcg(u32(p01.x) + pcg(u32(p01.y) + params.seed));
    let h11 = pcg(u32(p11.x) + pcg(u32(p11.y) + params.seed));
    let u = fade(p_fract.x);
    let v = fade(p_fract.y);
    let n1 = lerp(grad(h00, p_fract.x, p_fract.y), grad(h10, p_fract.x - 1.0, p_fract.y), u);
    let n2 = lerp(grad(h01, p_fract.x, p_fract.y - 1.0), grad(h11, p_fract.x - 1.0, p_fract.y - 1.0), u);
    return lerp(n1, n2, v);
}

@compute @workgroup_size(8, 8, 1)
fn main_generate(@builtin(global_invocation_id) global_id: vec3<u32>) {
    if (global_id.x >= params.width || global_id.y >= params.height) {
        return;
    }
    // The only change is here: we add the offset to the grid coordinates.
    let coords = vec2<f32>(f32(global_id.x), f32(global_id.y)) + params.offset;
    var value: f32 = 0.0;
    var frequency: f32 = 1.0 / params.scale;
    var amplitude: f32 = 1.0;
    for (var i: u32 = 0u; i < params.octaves; i = i + 1u) {
        value = value + amplitude * perlin2d(coords * frequency);
        frequency = frequency * params.lacunarity;
        amplitude = amplitude * params.persistence;
    }
    let index = global_id.x + global_id.y * params.width;
    output[index] = value;
    let scaled_value = i32(value * 1000000.0);
    atomicMin(&min_max_buffer[0], scaled_value);
    atomicMax(&min_max_buffer[1], scaled_value);
}

@compute @workgroup_size(8, 8, 1)
fn main_normalize(@builtin(global_invocation_id) global_id: vec3<u32>) {
    if (global_id.x >= params.width || global_id.y >= params.height) {
        return;
    }
    let min_val = f32(atomicLoad(&min_max_buffer[0])) / 1000000.0;
    let max_val = f32(atomicLoad(&min_max_buffer[1])) / 1000000.0;
    let index = global_id.x + global_id.y * params.width;
    let raw_value = output[index];
    let range = max_val - min_val;
    let normalized_value = (raw_value - min_val) / (range + 1e-10);
    let final_value = pow(normalized_value, 1.0 / params.hurst);
    let final_index = global_id.x + global_id.y * params.width;
    output[final_index] = clamp(final_value, 0.0, 1.0);
}