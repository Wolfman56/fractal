/**
 * A simple compute shader that generates a bowl shape.
 * Useful for debugging water pooling and flow dynamics.
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
    let pos = vec2<f32>(id.xy);
    let center = vec2<f32>(f32(u.gridSize) / 2.0, f32(u.gridSize) / 2.0);
    let dist = distance(pos, center) / (f32(u.gridSize) / 2.0);
    let height = dist * dist;
    outputBuffer[idx] = height;
}