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
    velocityDamping: f32,
    cellSize: f32,
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
    let H_c = h_c * u.heightMultiplier + w_c;

    // Sample neighbors' total water surface height
    let h_l = textureLoad(terrain_read, pos + vec2(-1,0), 0).r;
    let w_l = textureLoad(water_read, pos + vec2(-1,0), 0).r;
    let H_l = h_l * u.heightMultiplier + w_l;

    let h_r = textureLoad(terrain_read, pos + vec2(1,0), 0).r;
    let w_r = textureLoad(water_read, pos + vec2(1,0), 0).r;
    let H_r = h_r * u.heightMultiplier + w_r;

    let h_t = textureLoad(terrain_read, pos + vec2(0,-1), 0).r;
    let w_t = textureLoad(water_read, pos + vec2(0,-1), 0).r;
    let H_t = h_t * u.heightMultiplier + w_t;

    let h_b = textureLoad(terrain_read, pos + vec2(0,1), 0).r;
    let w_b = textureLoad(water_read, pos + vec2(0,1), 0).r;
    let H_b = h_b * u.heightMultiplier + w_b;

    // Calculate gradient of the water surface height using central differences
    let grad_x = (H_r - H_l) / 2.0;
    let grad_y = (H_b - H_t) / 2.0;

    // Update velocity field: v_new = v_old - dt * g * grad(H)
    // We use density as a proxy for gravity 'g'. The negative sign is because water flows downhill (against the gradient).
    let vel_in = textureLoad(velocity_read, pos, 0).xy;
    var vel_out = vel_in - u.dt * u.density * vec2(grad_x, grad_y);

    // Dampen velocity to prevent instability and simulate friction
    vel_out *= u.velocityDamping;

    textureStore(velocity_write, pos, vec4f(vel_out, 0.0, 0.0));
}

fn get_capacity(v_in: vec2f, w_in: f32) -> f32 {
    // Calculate sediment capacity based on velocity, water depth, and slope.
    // A minimum slope is used to ensure some capacity even in still water.
    return max(u.minSlope, length(v_in)) * w_in * u.capacityFactor;
}


// --- Pass 3: Erosion ---
@compute @workgroup_size(16, 16)
fn main_erosion(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x >= u.gridSize || id.y >= u.gridSize) {
        return;
    }
    let tex_coords = vec2<i32>(id.xy);

    let h_in = textureLoad(terrain_read, tex_coords, 0).r;
    let w_in = textureLoad(water_read, tex_coords, 0).r;
    let s_in = textureLoad(sediment_read, tex_coords, 0).r;
    let v_in = textureLoad(velocity_read, tex_coords, 0).xy;

    // Calculate sediment capacity
    let capacity = get_capacity(v_in, w_in);

    // ERODE ONLY
    // If water has capacity, erode terrain and add to sediment
    if (capacity > s_in) {
        let amount_to_erode = (capacity - s_in) * u.depositionRate;
        // Don't erode more than the terrain height itself
        let final_erosion_amount = min(amount_to_erode, h_in);

        textureStore(terrain_write, tex_coords, vec4<f32>(h_in - final_erosion_amount, 0.0, 0.0, 0.0));
        textureStore(sediment_write, tex_coords, vec4<f32>(s_in + final_erosion_amount, 0.0, 0.0, 0.0));
    } else {
        // If no erosion, just copy the state
        textureStore(terrain_write, tex_coords, vec4<f32>(h_in, 0.0, 0.0, 0.0));
        textureStore(sediment_write, tex_coords, vec4<f32>(s_in, 0.0, 0.0, 0.0));
    }
}


// --- Pass 4: Sediment Transport (Advection) ---
@compute @workgroup_size(16, 16)
fn main_transport(@builtin(global_invocation_id) id: vec3<u32>) {
    let pos = vec2<i32>(id.xy);
    if (pos.x >= i32(u.gridSize) || pos.y >= i32(u.gridSize)) { return; }

    let v = textureLoad(velocity_read, pos, 0).xy;
    // Find where the water/sediment came from by looking backwards along the velocity vector.
    let prev_pos_f = vec2f(pos) - v * u.dt;

    // Bilinear interpolation for smoother and more accurate advection
    let p0 = floor(prev_pos_f);
    let f = fract(prev_pos_f);

    let dims = vec2<i32>(textureDimensions(water_read));
    let i_p0 = clamp(vec2<i32>(p0), vec2<i32>(0), dims - vec2<i32>(1));
    let i_p1 = clamp(vec2<i32>(p0 + vec2(1.0, 0.0)), vec2<i32>(0), dims - vec2<i32>(1));
    let i_p2 = clamp(vec2<i32>(p0 + vec2(0.0, 1.0)), vec2<i32>(0), dims - vec2<i32>(1));
    let i_p3 = clamp(vec2<i32>(p0 + vec2(1.0, 1.0)), vec2<i32>(0), dims - vec2<i32>(1));

    // Sample sediment and water from the four neighboring cells
    let s0 = textureLoad(sediment_read, i_p0, 0).r; let w0 = textureLoad(water_read, i_p0, 0).r;
    let s1 = textureLoad(sediment_read, i_p1, 0).r; let w1 = textureLoad(water_read, i_p1, 0).r;
    let s2 = textureLoad(sediment_read, i_p2, 0).r; let w2 = textureLoad(water_read, i_p2, 0).r;
    let s3 = textureLoad(sediment_read, i_p3, 0).r; let w3 = textureLoad(water_read, i_p3, 0).r;

    // Interpolate horizontally, then vertically
    let s_out = mix(mix(s0, s1, f.x), mix(s2, s3, f.x), f.y);
    let w_out = mix(mix(w0, w1, f.x), mix(w2, w3, f.x), f.y);

    textureStore(sediment_write, pos, vec4f(s_out));
    textureStore(water_write, pos, vec4f(w_out));
}


// --- Pass 5: Deposition ---
@compute @workgroup_size(16, 16)
fn main_deposition(@builtin(global_invocation_id) id: vec3<u32>) {
    if (id.x >= u.gridSize || id.y >= u.gridSize) {
        return;
    }
    let tex_coords = vec2<i32>(id.xy);

    let h_in = textureLoad(terrain_read, tex_coords, 0).r;
    let w_in = textureLoad(water_read, tex_coords, 0).r;
    let s_in = textureLoad(sediment_read, tex_coords, 0).r;
    let v_in = textureLoad(velocity_read, tex_coords, 0).xy;

    // Calculate sediment capacity
    let capacity = get_capacity(v_in, w_in);

    // DEPOSIT ONLY
    // If sediment is over capacity, deposit it onto the terrain
    if (s_in > capacity) {
        let amount_to_deposit = (s_in - capacity) * u.depositionRate;
        // Don't deposit more sediment than is available
        let final_deposit_amount = min(amount_to_deposit, s_in);

        textureStore(terrain_write, tex_coords, vec4<f32>(h_in + final_deposit_amount, 0.0, 0.0, 0.0));
        textureStore(sediment_write, tex_coords, vec4<f32>(s_in - final_deposit_amount, 0.0, 0.0, 0.0));
    } else {
        // If no deposition, just copy the state
        textureStore(terrain_write, tex_coords, vec4<f32>(h_in, 0.0, 0.0, 0.0));
        textureStore(sediment_write, tex_coords, vec4<f32>(s_in, 0.0, 0.0, 0.0));
    }
}


// --- Pass 6: Evaporation ---
@compute @workgroup_size(16, 16)
fn main_evaporation(@builtin(global_invocation_id) id: vec3<u32>) {
    let pos = vec2<i32>(id.xy);
    if (pos.x >= i32(u.gridSize) || pos.y >= i32(u.gridSize)) { return; }

    let w_in = textureLoad(water_read, pos, 0).r;
    let w_out = w_in * (1.0 - u.evapRate * u.dt);
    textureStore(water_write, pos, vec4f(w_out));
}