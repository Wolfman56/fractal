struct ErosionUniforms {
    // Simulation constants
    dt: f32,
    density: f32,
    evapRate: f32,
    depositionRate: f32, // How fast sediment settles
    solubility: f32,     // How easily terrain erodes
    minSlope: f32,
    capacityFactor: f32,
    rainAmount: f32,
    gridSize: u32,
}

@group(0) @binding(0) var<uniform> uniforms: ErosionUniforms;

// Texture bindings will change per pass
@group(0) @binding(1) var terrain_in: texture_storage_2d<r32float, read>;
@group(0) @binding(2) var water_in: texture_storage_2d<r32float, read>;
@group(0) @binding(3) var sediment_in: texture_storage_2d<r32float, read>;
@group(0) @binding(4) var velocity_in: texture_storage_2d<rgba32float, read>;

@group(0) @binding(5) var terrain_out: texture_storage_2d<r32float, write>;
@group(0) @binding(6) var water_out: texture_storage_2d<r32float, write>;
@group(0) @binding(7) var sediment_out: texture_storage_2d<r32float, write>;
@group(0) @binding(8) var velocity_out: texture_storage_2d<rgba32float, write>;


fn get_height_and_water(coord: vec2<i32>) -> vec2<f32> {
    // Clamp coordinates to prevent reading out of bounds, which causes wrapping.
    // This effectively creates a "wall" at the boundary.
    let clamped_coord = clamp(coord, vec2<i32>(0), vec2<i32>(i32(uniforms.gridSize - 1u)));
    let h = textureLoad(terrain_in, vec2<u32>(clamped_coord)).r;
    let w = textureLoad(water_in, vec2<u32>(clamped_coord)).r;
    return vec2(h, w);
}

@compute @workgroup_size(16, 16, 1)
fn main_water(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x >= uniforms.gridSize || id.y >= uniforms.gridSize) {
        return;
    }
    let w_in = textureLoad(water_in, id.xy).r;
    textureStore(water_out, id.xy, vec4f(w_in + uniforms.rainAmount, 0.0, 0.0, 0.0));
}

@compute @workgroup_size(16, 16, 1)
fn main_flow(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x >= uniforms.gridSize || id.y >= uniforms.gridSize) {
        return;
    }
    let coord = vec2<i32>(id.xy);
    let center_hw = get_height_and_water(coord);
    let h_total_center = center_hw.x + center_hw.y;

    var flux = vec4f(0.0); // L, R, T, B
    let K = uniforms.dt * uniforms.density; // Density can be approximated by gravity * area

    // Left
    let left_hw = get_height_and_water(coord + vec2(-1, 0));
    var delta_h = h_total_center - (left_hw.x + left_hw.y);
    flux.x = max(0.0, flux.x + K * delta_h);

    // Right
    let right_hw = get_height_and_water(coord + vec2(1, 0));
    delta_h = h_total_center - (right_hw.x + right_hw.y);
    flux.y = max(0.0, flux.y + K * delta_h);

    // Top
    let top_hw = get_height_and_water(coord + vec2(0, 1));
    delta_h = h_total_center - (top_hw.x + top_hw.y);
    flux.z = max(0.0, flux.z + K * delta_h);

    // Bottom
    let bottom_hw = get_height_and_water(coord + vec2(0, -1));
    delta_h = h_total_center - (bottom_hw.x + bottom_hw.y);
    flux.w = max(0.0, flux.w + K * delta_h);

    let flux_sum = flux.x + flux.y + flux.z + flux.w;
    if (flux_sum > 0.0) {
        let factor = min(1.0, center_hw.y / flux_sum);
        flux = flux * factor;
    }

    textureStore(velocity_out, id.xy, flux);
}

@compute @workgroup_size(16, 16, 1)
fn main_erosion(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x >= uniforms.gridSize || id.y >= uniforms.gridSize) {
        return;
    }
    let coord = vec2<i32>(id.xy);
    let h_in = textureLoad(terrain_in, id.xy).r;
    let w_in = textureLoad(water_in, id.xy).r;
    let s_in = textureLoad(sediment_in, id.xy).r;
    let flux = textureLoad(velocity_in, id.xy);

    // Calculate terrain slope (not water surface slope) for a more stable capacity calculation.
    let h_left = textureLoad(terrain_in, vec2<u32>(clamp(coord + vec2(-1, 0), vec2<i32>(0), vec2<i32>(i32(uniforms.gridSize - 1u))))).r;
    let h_right = textureLoad(terrain_in, vec2<u32>(clamp(coord + vec2(1, 0), vec2<i32>(0), vec2<i32>(i32(uniforms.gridSize - 1u))))).r;
    let h_top = textureLoad(terrain_in, vec2<u32>(clamp(coord + vec2(0, 1), vec2<i32>(0), vec2<i32>(i32(uniforms.gridSize - 1u))))).r;
    let h_bottom = textureLoad(terrain_in, vec2<u32>(clamp(coord + vec2(0, -1), vec2<i32>(0), vec2<i32>(i32(uniforms.gridSize - 1u))))).r;

    let slope_x = h_in - (h_left + h_right) / 2.0;
    let slope_y = h_in - (h_top + h_bottom) / 2.0;
    let slope = sqrt(slope_x * slope_x + slope_y * slope_y);

    // Calculate speed based on the magnitude of the net velocity vector.
    // This is more physically accurate than the previous approximation.
    // We use the length of the 4D flux vector as a proxy for speed, which correctly
    // handles symmetrical outflow from peaks.
    let speed = length(flux);
    let capacity = max(uniforms.minSlope, slope) * speed * uniforms.capacityFactor;

    var h_out = h_in;
    var s_out = s_in;

    if (s_in > capacity) {
        // Deposition
        let amount = (s_in - capacity) * uniforms.depositionRate; // Use deposition rate
        s_out -= amount;
        h_out += amount;
    } else {
        // Erosion
        let amount = min((capacity - s_in), h_in) * uniforms.solubility; // Use solubility
        s_out += amount;
        h_out -= amount;
    }

    textureStore(terrain_out, id.xy, vec4f(h_out, 0.0, 0.0, 0.0));
    textureStore(sediment_out, id.xy, vec4f(s_out, 0.0, 0.0, 0.0));
}

// Helper function for the transport pass. Must be at module scope.
fn get_sediment_in(current_coord: vec2<i32>, offset: vec2<i32>, flux_in: f32) -> f32 {
    let neighbor_coord = current_coord + offset;
    // It can access the module-scope texture bindings
    let w_neighbor = textureLoad(water_in, vec2<u32>(clamp(neighbor_coord, vec2<i32>(0), vec2<i32>(i32(uniforms.gridSize - 1u))))).r;
    if (w_neighbor > 0.0001) {
        let s_neighbor = textureLoad(sediment_in, vec2<u32>(clamp(neighbor_coord, vec2<i32>(0), vec2<i32>(i32(uniforms.gridSize - 1u))))).r;
        // Calculate sediment transported based on the ratio of incoming flux to the neighbor's total water.
        return s_neighbor * (flux_in / w_neighbor);
    }
    return 0.0;
}

@compute @workgroup_size(16, 16, 1)
fn main_transport(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x >= uniforms.gridSize || id.y >= uniforms.gridSize) {
        return;
    }
    let coord = vec2<i32>(id.xy);

    // --- Load central cell data ---
    let flux_center = textureLoad(velocity_in, id.xy);
    let w_center = textureLoad(water_in, id.xy).r;
    let s_center = textureLoad(sediment_in, id.xy).r;

    // --- Calculate total water inflow and outflow ---
    var flux_in_l = 0.0;
    if (coord.x > 0) { // Check left boundary
        flux_in_l = textureLoad(velocity_in, vec2<u32>(coord + vec2(-1, 0))).y;
    }
    var flux_in_r = 0.0;
    if (coord.x < i32(uniforms.gridSize - 1u)) { // Check right boundary
        flux_in_r = textureLoad(velocity_in, vec2<u32>(coord + vec2(1, 0))).x;
    }
    var flux_in_t = 0.0;
    if (coord.y < i32(uniforms.gridSize - 1u)) { // Check top boundary
        flux_in_t = textureLoad(velocity_in, vec2<u32>(coord + vec2(0, 1))).w;
    }
    var flux_in_b = 0.0;
    if (coord.y > 0) { // Check bottom boundary
        flux_in_b = textureLoad(velocity_in, vec2<u32>(coord + vec2(0, -1))).z;
    }

    let flux_out_total = flux_center.x + flux_center.y + flux_center.z + flux_center.w;
    let flux_in_total = flux_in_l + flux_in_r + flux_in_t + flux_in_b;

    // --- Update water level based on flow conservation ---
    // The flux values from the 'flow' pass already have dt baked in, so we don't multiply again.
    let w_new = w_center + (flux_in_total - flux_out_total);

    // --- Update sediment level based on transport ---
    // Calculate sediment outflow from this cell.
    var s_out_total = 0.0;
    if (w_center > 0.0001) {
        // Amount of sediment leaving is proportional to the amount of water leaving.
        // Clamp to prevent numerical instability (can't lose more sediment than you have).
        s_out_total = s_center * min(1.0, flux_out_total / w_center);
    }

    // Calculate sediment inflow from neighbors.
    let s_in_l = get_sediment_in(coord, vec2(-1, 0), flux_in_l);
    let s_in_r = get_sediment_in(coord, vec2(1, 0), flux_in_r);
    let s_in_t = get_sediment_in(coord, vec2(0, 1), flux_in_t);
    let s_in_b = get_sediment_in(coord, vec2(0, -1), flux_in_b);
    let s_in_total = s_in_l + s_in_r + s_in_t + s_in_b;

    let s_new = s_center - s_out_total + s_in_total;
    
    textureStore(water_out, id.xy, vec4f(max(0.0, w_new), 0.0, 0.0, 0.0));
    textureStore(sediment_out, id.xy, vec4f(max(0.0, s_new), 0.0, 0.0, 0.0));
}

@compute @workgroup_size(16, 16, 1)
fn main_evaporation(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x >= uniforms.gridSize || id.y >= uniforms.gridSize) {
        return;
    }
    let w_in = textureLoad(water_in, id.xy).r;
    let w_new = w_in * (1.0 - uniforms.evapRate);
    textureStore(water_out, id.xy, vec4f(w_new, 0.0, 0.0, 0.0));
}
