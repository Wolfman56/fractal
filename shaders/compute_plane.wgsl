/**
 * A simple compute shader that generates a plane sloped at 45 degrees.
 * Useful for creating a predictable initial state for validation.
 */

struct Uniforms {
    gridSize: u32,
    // Other uniforms are unused but kept for struct compatibility
    scale: f32,
    seed: f32,
    persistence: f32,
    lacunarity: f32,
    octaves: u32,
    heightMultiplier: f32,
};
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read_write> outputBuffer: array<f32>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x >= u.gridSize || id.y >= u.gridSize) { return; }
    let idx = id.y * u.gridSize + id.x;
    // Create a plane sloped along the x-axis from 0.0 to 1.0.
    let height = f32(id.x) / f32(u.gridSize - 1u);
    outputBuffer[idx] = height;
}