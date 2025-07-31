/**
 * Hydraulic Erosion Simulation
 * Based on the paper "Fast Hydraulic Erosion Simulation and Visualization on GPU" by Mei et al.
 * This shader performs a 5-pass simulation for each iteration.
 */

struct Uniforms {
    dt: f32,
    density: f32,
    evapRate: f32,
    depositionRate: f32,
    solubility: f32,
    minSlope: f32,
    capacityFactor: f32,
    rainAmount: f32,
    seaLevel: f32,
    gridSize: u32,
    heightMultiplier: f32,
};
@group(0) @binding(0) var<uniform> u: Uniforms;

// Texture bindings are swapped between passes and iterations (ping-ponging).
// The bindings here correspond to the 'even' iteration set in erosion_models.js.
@group(0) @binding(1) var terrain_read: texture_2d<f32>;
@group(0) @binding(2) var water_read: texture_2d<f32>;
@group(0) @binding(3) var sediment_read: texture_2d<f32>;
@group(0) @binding(4) var velocity_read: texture_2d<f32>; // rgba32f

@group(0) @binding(5) var terrain_write: texture_storage_2d<r32float, write>;
@group(0) @binding(6) var water_write: texture_storage_2d<r32float, write>;
@group(0) @binding(7) var sediment_write: texture_storage_2d<r32float, write>;
@group(0) @binding(8) var velocity_write: texture_storage_2d<rgba32float, write>;


// --- Pass 1: Water Increment (Rain) ---
@compute @workgroup_size(16, 16)
fn main_water(@builtin(global_invocation_id) id: vec3<u32>) {
    let pos = vec2<i32>(id.xy);
    if (pos.x >= i32(u.gridSize) || pos.y >= i32(u.gridSize)) { return; }

    let water_in = textureLoad(water_read, pos, 0).r;
    let water_out = water_in + u.rainAmount;
    textureStore(water_write, pos, vec4f(water_out));
}


// --- Pass 2: Flow Simulation ---
@compute @workgroup_size(16, 16)
fn main_flow(@builtin(global_invocation_id) id: vec3<u32>) {
    let pos = vec2<i32>(id.xy);
    if (pos.x >= i32(u.gridSize) || pos.y >= i32(u.gridSize)) { return; }
    
    let h_c = textureLoad(terrain_read, pos, 0).r;
    let w_c = textureLoad(water_read, pos, 0).r;
    
    // Apply height multiplier to terrain and sea level to get world-space heights for flow calculation
    let world_sea_level = u.seaLevel * u.heightMultiplier;
    let H_c = max(h_c * u.heightMultiplier + w_c, world_sea_level);

    // --- Calculate outflow flux to neighbors ---
    let dims = vec2<i32>(textureDimensions(terrain_read));
    var f_l: f32;
    var f_r: f32;
    var f_t: f32;
    var f_b: f32;

    // Left neighbor
    if (pos.x > 0) {
        let h_n = textureLoad(terrain_read, pos + vec2(-1,0), 0).r;
        let w_n = textureLoad(water_read, pos + vec2(-1,0), 0).r;
        f_l = max(0.0, H_c - max(h_n * u.heightMultiplier + w_n, world_sea_level));
    } else { f_l = 0.0; }

    // Right neighbor
    if (pos.x < dims.x - 1) {
        let h_n = textureLoad(terrain_read, pos + vec2(1,0), 0).r;
        let w_n = textureLoad(water_read, pos + vec2(1,0), 0).r;
        f_r = max(0.0, H_c - max(h_n * u.heightMultiplier + w_n, world_sea_level));
    } else { f_r = 0.0; }

    // Top neighbor
    if (pos.y > 0) {
        let h_n = textureLoad(terrain_read, pos + vec2(0,-1), 0).r;
        let w_n = textureLoad(water_read, pos + vec2(0,-1), 0).r;
        f_t = max(0.0, H_c - max(h_n * u.heightMultiplier + w_n, world_sea_level));
    } else { f_t = 0.0; }

    // Bottom neighbor
    if (pos.y < dims.y - 1) {
        let h_n = textureLoad(terrain_read, pos + vec2(0,1), 0).r;
        let w_n = textureLoad(water_read, pos + vec2(0,1), 0).r;
        f_b = max(0.0, H_c - max(h_n * u.heightMultiplier + w_n, world_sea_level));
    } else { f_b = 0.0; }

    // Scale total outflow to not exceed the amount of water in the current cell
    let f_total = f_l + f_r + f_t + f_b;
    if (f_total > 0.0) {
        let scale = min(w_c * u.density, f_total) / f_total;
        f_l *= scale;
        f_r *= scale;
        f_t *= scale;
        f_b *= scale;
    }

    // Update velocity field based on net flow
    let vel_in = textureLoad(velocity_read, pos, 0).xy;
    let vel_out = vel_in + vec2(f_l - f_r, f_t - f_b);

    textureStore(velocity_write, pos, vec4f(vel_out, 0.0, 0.0));
}


// --- Pass 3: Erosion and Deposition ---
@compute @workgroup_size(16, 16)
fn main_erosion(@builtin(global_invocation_id) id: vec3<u32>) {
    let pos = vec2<i32>(id.xy);
    if (pos.x >= i32(u.gridSize) || pos.y >= i32(u.gridSize)) { return; }

    let h = textureLoad(terrain_read, pos, 0).r;
    let w = textureLoad(water_read, pos, 0).r;
    let s = textureLoad(sediment_read, pos, 0).r;
    let v = textureLoad(velocity_read, pos, 0).xy;
    let v_mag = length(v);

    // Calculate sediment capacity and the difference from the current sediment level
    let C = max(u.minSlope, v_mag) * w * u.capacityFactor;
    let s_diff = C - s;

    var h_out = h;
    var s_out = s;

    if (h > u.seaLevel) {
        // Only allow erosion if the terrain is above sea level
        // This prevents the seabed from being eroded.
        // Deposition can still occur to form beaches and shelves.

        // Erosion/deposition logic
        if (s_diff > 0.0) { // Erosion: water has capacity to carry more sediment
            let amount = min(s_diff, h) * u.solubility * u.dt;
            h_out -= amount;
            s_out += amount;
        } else { // Deposition: water is carrying too much sediment
            let amount = -s_diff * u.depositionRate * u.dt;
            h_out += amount;
            s_out -= amount;
        }
    } else {
        // If we're below sea level, we can only deposit sediment
        let amount = -min(s_diff, 0.0) * u.depositionRate * u.dt;
        h_out += amount;
        s_out -= amount;
    }

    textureStore(terrain_write, pos, vec4f(h_out));
    textureStore(sediment_write, pos, vec4f(s_out));
}


// --- Pass 4: Sediment Transport (Advection) ---
@compute @workgroup_size(16, 16)
fn main_transport(@builtin(global_invocation_id) id: vec3<u32>) {
    let pos = vec2<i32>(id.xy);
    if (pos.x >= i32(u.gridSize) || pos.y >= i32(u.gridSize)) { return; }

    let v = textureLoad(velocity_read, pos, 0).xy;
    // Find where the water/sediment came from by looking backwards along the velocity vector
    let prev_pos_f = vec2f(pos) - v * u.dt;
    let prev_pos_i = vec2<i32>(round(prev_pos_f));

    // Clamp coordinates to be within bounds for safe reading
    let dims = vec2<i32>(textureDimensions(water_read));
    let clamped_prev_pos = clamp(prev_pos_i, vec2<i32>(0), dims - vec2<i32>(1));

    let s_in = textureLoad(sediment_read, clamped_prev_pos, 0).r;
    let w_in = textureLoad(water_read, clamped_prev_pos, 0).r;

    textureStore(sediment_write, pos, vec4f(s_in));
    textureStore(water_write, pos, vec4f(w_in));
}


// --- Pass 5: Evaporation ---
@compute @workgroup_size(16, 16)
fn main_evaporation(@builtin(global_invocation_id) id: vec3<u32>) {
    let pos = vec2<i32>(id.xy);
    if (pos.x >= i32(u.gridSize) || pos.y >= i32(u.gridSize)) { return; }

    let w_in = textureLoad(water_read, pos, 0).r;
    let w_out = w_in * (1.0 - u.evapRate * u.dt);
    textureStore(water_write, pos, vec4f(w_out));
}