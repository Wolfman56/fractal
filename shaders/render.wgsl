struct VertexInput {
    @location(0) position: vec3f,
    @location(1) normal: vec3f,
    @location(2) normalized_height: f32,
    @location(3) is_water: f32,
    @location(4) water_depth: f32,
};

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) lighting: vec3f,
    @location(1) world_position: vec3f,
    @location(2) world_normal: vec3f,
    @location(3) normalized_height: f32,
    @location(4) is_water: f32,
    @location(5) water_depth: f32,
};

@group(0) @binding(0) var<uniform> modelViewMatrix: mat4x4f;
@group(0) @binding(1) var<uniform> projectionMatrix: mat4x4f;
@group(0) @binding(2) var<uniform> normalMatrix: mat4x4f;
@group(0) @binding(3) var<uniform> viewMatrix: mat4x4f;
@group(0) @binding(4) var<uniform> global_params: vec4f; // .x = seaLevel

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    let world_pos_4 = modelViewMatrix * vec4f(in.position, 1.0);
    out.position = projectionMatrix * world_pos_4;
    out.world_position = world_pos_4.xyz;

    let ambientLight = vec3f(0.3, 0.3, 0.3);
    let directionalLightColor = vec3f(1.0, 1.0, 1.0);
    let directionalVector_world = normalize(vec3f(0.85, 0.8, 0.75));
    // Transform the world-space light direction into view-space for consistent calculations.
    let directionalVector_view = (viewMatrix * vec4f(directionalVector_world, 0.0)).xyz;

    // The normalMatrix transforms normals into view-space.
    out.world_normal = normalize((normalMatrix * vec4f(in.normal, 0.0)).xyz);
    let directional = max(dot(out.world_normal, directionalVector_view), 0.0);
    var lighting = ambientLight + (directionalLightColor * directional);

    let viewDir = normalize(-world_pos_4.xyz);
    let halfDir = normalize(directionalVector_view + viewDir);
    let specular = pow(max(dot(out.world_normal, halfDir), 0.0), 32.0);
    lighting += vec3f(0.5, 0.5, 0.5) * specular;
    out.lighting = lighting;
    out.normalized_height = in.normalized_height;
    out.is_water = in.is_water;
    out.water_depth = in.water_depth;
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
    let sea_level = global_params.x;

    // --- Terrain Color Calculation ---
    let grass_color = vec3f(0.3, 0.5, 0.2);
    let rock_color = vec3f(0.4, 0.4, 0.4);
    let snow_color = vec3f(0.9, 0.9, 0.95);
    let sand_color = vec3f(0.8, 0.7, 0.5);
    let ocean_floor_color = vec3f(0.0, 0.0, 0.5);

    var surface_color: vec3f;

    if (in.normalized_height >= sea_level) {
        // --- Dry Land Coloring ---
        // Remap the height from [sea_level, 1.0] to [0.0, 1.0] to get a normalized land height.
        let land_height_norm = (in.normalized_height - sea_level) / (1.0 - sea_level + 1e-6);

        // Calculate slope (1.0 = vertical, 0.0 = flat)
        let world_up_in_view_space = (viewMatrix * vec4f(0.0, 1.0, 0.0, 0.0)).xyz;
        let slope = 1.0 - dot(in.world_normal, world_up_in_view_space);

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
        let ocean_depth_norm = (sea_level - in.normalized_height) / (sea_level + 1e-6);
        surface_color = mix(sand_color, ocean_floor_color, smoothstep(0.0, 0.5, ocean_depth_norm));
    }

    // --- Water Overlay ---
    // If the fragment is covered by dynamic or sea-level water, apply a transparent tint.
    if (in.is_water > 0.5) {
        let shallow_color = vec3f(0.0, 0.0, 0.8);
        let deep_color = vec3f(0.0, 0.0, 0.3);
        let depth_blend = smoothstep(0.0, 0.2, in.water_depth);
        let water_tint = mix(shallow_color, deep_color, depth_blend);

        // The opacity determines how much the water tint affects the underlying surface color.
        let water_opacity = mix(0.45, 0.95, depth_blend);
        surface_color = mix(surface_color, water_tint, water_opacity);
    }

    // Finally, apply lighting to the calculated surface color.
    let final_color = surface_color * in.lighting;

    return vec4f(final_color, 1.0);
}