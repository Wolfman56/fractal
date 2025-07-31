struct GlobalParams {
    seaLevel: f32,
    viewMode: u32, // 0:standard, 1:depth, 2:velocity, 3:sediment
};

@group(0) @binding(0) var<uniform> modelViewMatrix: mat4x4<f32>;
@group(0) @binding(1) var<uniform> projectionMatrix: mat4x4<f32>;
@group(0) @binding(4) var<uniform> globals: GlobalParams;

@group(1) @binding(0) var water_texture: texture_2d<f32>;
@group(1) @binding(1) var velocity_texture: texture_2d<f32>;
@group(1) @binding(2) var terrain_texture: texture_2d<f32>;
@group(1) @binding(3) var linear_sampler: sampler;
@group(1) @binding(4) var nearest_sampler: sampler;
@group(1) @binding(5) var sediment_texture: texture_2d<f32>;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(
    @location(0) position: vec3<f32>,
) -> VertexOutput {
    var output: VertexOutput;
    // The input position is already in model space, from -1 to 1.
    // We just need to transform it by the view and projection matrices.
    output.position = projectionMatrix * modelViewMatrix * vec4<f32>(position, 1.0);

    // Generate UV coordinates from the vertex position.
    // The mesh spans from -1 to 1, so we map this to a 0 to 1 UV range.
    output.uv = position.xz * 0.5 + 0.5;

    return output;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    // Sample all necessary textures
    let terrain_height_norm = textureSample(terrain_texture, nearest_sampler, in.uv).r;
    let water_depth = textureSample(water_texture, nearest_sampler, in.uv).r;
    let velocity = textureSample(velocity_texture, linear_sampler, in.uv).xy;
    let sediment = textureSample(sediment_texture, nearest_sampler, in.uv).r;

    // For all heatmap modes, if there's no water, just show the grayscale terrain height.
    if (water_depth < 0.001) {
        let terrain_color = (terrain_height_norm - globals.seaLevel) * 2.0;
        return vec4<f32>(terrain_color, terrain_color, terrain_color, 1.0);
    }

    // --- View Mode Logic ---
    // viewMode: 1=depth, 2=velocity, 3=sediment
    if (globals.viewMode == 1u) { // Water Depth
        let shallow_color = vec3<f32>(0.5, 0.8, 1.0); // Light cyan
        let deep_color = vec3<f32>(0.1, 0.3, 0.8);    // Dark blue
        // The smoothstep range is narrowed to make the gradient more sensitive to small changes in depth.
        let color = mix(shallow_color, deep_color, smoothstep(0.0, 0.02, water_depth));
        return vec4<f32>(color, 1.0);

    } else if (globals.viewMode == 2u) { // Water Velocity
        // Map velocity direction to color (X -> Red, Y -> Green).
        let speed = length(velocity);
        let direction = velocity / (speed + 1e-6); // Avoid division by zero
        // Map direction [-1, 1] to color [0, 1]
        let dir_color = vec3<f32>(direction.x * 0.5 + 0.5, direction.y * 0.5 + 0.5, 0.0);
        // Use speed to control the intensity, but add a base visibility so slow-moving water is not black.
        let intensity = smoothstep(0.0, 0.4, speed);
        let final_color = dir_color * (0.1 + 0.9 * intensity);
        return vec4<f32>(final_color, 1.0);

    } else if (globals.viewMode == 3u) { // Sediment Amount
        // Visualize sediment as a yellow/brown heatmap.
        let low_sediment_color = vec3<f32>(0.2, 0.2, 0.0);  // Dark brown for low sediment
        let high_sediment_color = vec3<f32>(1.0, 0.8, 0.2); // Bright yellow for high sediment
        let color = mix(low_sediment_color, high_sediment_color, smoothstep(0.0, 0.05, sediment));
        return vec4<f32>(color, 1.0);
    }

    // Fallback: should not be reached if viewMode is set correctly.
    return vec4<f32>(1.0, 0.0, 1.0, 1.0); // Magenta for error
}