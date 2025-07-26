struct VertexInput {
    @location(0) position: vec3f,
    @location(1) normal: vec3f,
    @location(2) color: vec3f,
};

struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) lighting: vec3f,
    @location(1) color: vec3f,
};

@group(0) @binding(0) var<uniform> modelViewMatrix: mat4x4f;
@group(0) @binding(1) var<uniform> projectionMatrix: mat4x4f;
@group(0) @binding(2) var<uniform> normalMatrix: mat4x4f;

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    out.position = projectionMatrix * modelViewMatrix * vec4f(in.position, 1.0);
    let ambientLight = vec3f(0.3, 0.3, 0.3);
    let directionalLightColor = vec3f(1.0, 1.0, 1.0);
    let directionalVector = normalize(vec3f(0.85, 0.8, 0.75));
    let transformedNormal = (normalMatrix * vec4f(in.normal, 0.0)).xyz;
    let directional = max(dot(transformedNormal, directionalVector), 0.0);
    var lighting = ambientLight + (directionalLightColor * directional);
    let viewDir = normalize(-(modelViewMatrix * vec4f(in.position, 1.0)).xyz);
    let halfDir = normalize(directionalVector + viewDir);
    let specular = pow(max(dot(transformedNormal, halfDir), 0.0), 32.0);
    lighting += vec3f(0.5, 0.5, 0.5) * specular;
    out.lighting = lighting;
    out.color = in.color;
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
    return vec4f(in.color * in.lighting, 1.0);
}