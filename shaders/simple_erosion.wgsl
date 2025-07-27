@group(0) @binding(0) var source_map: texture_storage_2d<r32float, read>;
@group(0) @binding(1) var dest_map: texture_storage_2d<r32float, write>;

struct ErosionParams {
    erosionRate: f32,
}

@group(0) @binding(2) var<uniform> params: ErosionParams;

@compute @workgroup_size(16, 16, 1) // Adjust workgroup size for optimal performance
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let coord_u = global_id.xy;
    let textureSize = textureDimensions(source_map);

    // Ensure within bounds
    if (coord_u.x >= textureSize.x || coord_u.y >= textureSize.y) {
        return;
    }

    // Use signed integers for coordinate math to prevent underflow on edges.
    let coord_i = vec2<i32>(coord_u);
    let currentHeight = textureLoad(source_map, coord_u).r;

    var minNeighborHeight = currentHeight;

    let neighbors = array<vec2<i32>, 4>(
        vec2<i32>(0, 1), vec2<i32>(0, -1), vec2<i32>(1, 0), vec2<i32>(-1, 0)
    );

    for (var i = 0; i < 4; i = i + 1) {
        let neighborCoord = coord_i + neighbors[i];

        // Check bounds using signed integers
        if (neighborCoord.x >= 0 && neighborCoord.x < i32(textureSize.x) &&
            neighborCoord.y >= 0 && neighborCoord.y < i32(textureSize.y)) {
            minNeighborHeight = min(minNeighborHeight, textureLoad(source_map, vec2<u32>(neighborCoord)).r);
        }
    }

    let heightDifference = currentHeight - minNeighborHeight;
    let erosionAmount = heightDifference * params.erosionRate;

    let newHeight = currentHeight - erosionAmount; 
    textureStore(dest_map, coord_u, vec4f(newHeight, 0.0, 0.0, 0.0));
}
