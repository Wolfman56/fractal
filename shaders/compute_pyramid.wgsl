@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read_write> output: array<f32>;
// Min/max buffer is not used but required by the bind group layout
@group(0) @binding(2) var<storage, read_write> min_max_buffer: array<atomic<i32>, 2>;

struct Uniforms {
    gridSize: u32,
    // Other uniforms from the struct, not used but need to match layout
    scale: f32,
    seed: f32,
    persistence: f32,
    lacunarity: f32,
    octaves: u32,
    heightMultiplier: f32,
    hurst: f32,
    worldOffset: vec2<f32>,
    lod: u32,
    origin: vec2<f32>,
};

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let gridSize = uniforms.gridSize;
    if (global_id.x >= gridSize || global_id.y >= gridSize) {
        return;
    }

    let idx = global_id.y * gridSize + global_id.x;
    let x = f32(global_id.x);
    let y = f32(global_id.y);

    let grid_center = f32(gridSize) / 2.0;
    let pyramid_half_size = f32(gridSize) / 4.0;

    let chebyshev_dist = max(abs(x - grid_center), abs(y - grid_center));

    var height = 0.0;
    if (chebyshev_dist < pyramid_half_size) {
        height = 1.0 - (chebyshev_dist / pyramid_half_size);
    }

    output[idx] = height;
}