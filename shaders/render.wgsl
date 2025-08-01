// Uniforms shared across all tiles
@group(0) @binding(1) var<uniform> projection: mat4x4<f32>;
@group(0) @binding(3) var<uniform> view: mat4x4<f32>;

struct Globals {
    seaLevel: f32,
    seaLevelOffset: f32,
    heightMultiplier: f32,
    verticalExaggeration: f32,
    viewMode: u32,
};
@group(0) @binding(4) var<uniform> globals: Globals;


// Per-tile uniforms
@group(0) @binding(0) var<uniform> model: mat4x4<f32>;
@group(0) @binding(2) var<uniform> normalMatrix: mat4x4<f32>;


struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) water_depth: f32,
};

struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) world_position: vec3<f32>,
    @location(1) world_normal: vec3<f32>,
    @location(2) normalized_height: f32,
    @location(4) water_depth: f32,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;

    // Create a visually exaggerated position for rendering.
    var visual_position = input.position;
    visual_position.y *= globals.verticalExaggeration;

    // Transform the visual position to clip space for the rasterizer.
    let world_pos4_visual = model * vec4<f32>(visual_position, 1.0);
    output.clip_position = projection * view * world_pos4_visual;

    // The world position for lighting should also use the visual exaggeration.
    output.world_position = world_pos4_visual.xyz;

    // The normal is pre-calculated in world-space in geometry.js and is correct.
    // It should NOT be transformed by the normalMatrix, which is for model-space normals.
    output.world_normal = input.normal;

    // For coloring, we need to normalize the ORIGINAL, PHYSICAL height.
    // Transform the physical position to get its world-space height.
    let world_pos4_physical = model * vec4<f32>(input.position, 1.0);
    let normalized_height = (world_pos4_physical.y - globals.seaLevelOffset) / (globals.heightMultiplier + 1e-6);
    output.normalized_height = normalized_height;

    // Water depth should also be visually exaggerated for rendering.
    output.water_depth = input.water_depth * globals.verticalExaggeration;

    return output;
}

// Helper function to mix colors
fn mix(a: vec3<f32>, b: vec3<f32>, t: f32) -> vec3<f32> {
    return a * (1.0 - t) + b * t;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    let light_direction = normalize(vec3<f32>(0.5, 1.0, 0.5));
    let ambient_light = 0.2;
    let diffuse_light = max(dot(input.world_normal, light_direction), 0.0);
    let lighting = ambient_light + diffuse_light * 0.8;

    // --- Terrain Color Calculation ---
    let grass_color = vec3<f32>(0.3, 0.5, 0.2);
    let rock_color = vec3<f32>(0.4, 0.4, 0.4);
    let snow_color = vec3<f32>(0.9, 0.9, 0.95);
    let sand_color = vec3<f32>(0.8, 0.7, 0.5);
    let ocean_floor_color = vec3<f32>(0.0, 0.0, 0.5);

    var surface_color: vec3<f32>;

    if (input.normalized_height >= globals.seaLevel) {
        // --- Dry Land Coloring ---
        // Remap the height from [sea_level, 1.0] to [0.0, 1.0] to get a normalized land height.
        let land_height_norm = (input.normalized_height - globals.seaLevel) / (1.0 - globals.seaLevel + 1e-6);

        // Calculate slope (1.0 = vertical, 0.0 = flat). Since world_normal is normalized,
        // its y-component is the cosine of the angle with the world up vector.
        let slope = 1.0 - input.world_normal.y;

        // Blend from grass to rock based on slope
        let rock_blend = smoothstep(0.4, 0.7, slope);
        surface_color = mix(grass_color, rock_color, rock_blend);

        // Blend in snow at high altitudes, now relative to land height (e.g., top 35%).
        let snow_blend = smoothstep(0.65, 0.8, land_height_norm);
        surface_color = mix(surface_color, snow_color, snow_blend);

        // Blend in sand at the coastline, just above sea level (e.g., bottom 3%).
        let sand_blend = smoothstep(0.03, 0.0, land_height_norm);
        surface_color = mix(surface_color, sand_color, sand_blend);
    } else {
        // --- Underwater Coloring ---
        // Remap the height from [0.0, sea_level] to [1.0, 0.0] to get a normalized ocean depth.
        // 1.0 is the deepest part, 0.0 is the surface.
        let ocean_depth_norm = (globals.seaLevel - input.normalized_height) / (globals.seaLevel + 1e-6);
        surface_color = mix(sand_color, ocean_floor_color, smoothstep(0.0, 0.5, ocean_depth_norm));
    }

    // --- Water Overlay ---
    // If the fragment is covered by dynamic water from the erosion sim, apply a transparent tint.
    // We check against a very small threshold to make even shallow water visible.
    if (input.water_depth > 1e-4) {
        let water_tint = vec3<f32>(0.3, 0.5, 0.7); // A nice cyan tint
        let water_opacity = smoothstep(0.0, 0.01, input.water_depth); // More opaque with depth, fully opaque at 1cm
        surface_color = mix(surface_color, water_tint, water_opacity * 0.6);
    }

    let final_color = surface_color * lighting;
    return vec4<f32>(final_color, 1.0);
}