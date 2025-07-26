import mat4 from './mat4.js';

export default class Camera {
    constructor() {
        this.position = [0, 2, 3]; // Initial position: slightly elevated and pulled back
        this.target = [0, 0, 0];   // Point to look at (the center of the terrain)
        this.initialPosition = [...this.position]; // Store for reset
        this.up = [0, 1, 0];        // Up vector
        this.viewMatrix = mat4.create();
    }

    /**
     * Calculates and returns the view matrix for the current camera state.
     */
    getViewMatrix() {
        mat4.lookAt(this.viewMatrix, this.position, this.target, this.up);
        return this.viewMatrix;
    }

    /**
     * Orbits the camera around its target.
     * @param {number} yaw - The horizontal rotation in radians.
     * @param {number} pitch - The vertical rotation in radians.
     */
    orbit(yaw, pitch) {
        // Get the vector from the target to the current position
        const vec = [
            this.position[0] - this.target[0],
            this.position[1] - this.target[1],
            this.position[2] - this.target[2]
        ];
        const radius = Math.hypot(...vec);

        // Calculate current spherical coordinates
        let theta = Math.atan2(vec[0], vec[2]); // Horizontal angle (yaw)
        let phi = Math.acos(vec[1] / radius);   // Vertical angle (pitch)

        // Apply the deltas from mouse movement
        theta += yaw;
        phi -= pitch; // Subtract pitch to make mouse-up move camera up

        // Clamp the pitch to prevent the camera from flipping over
        phi = Math.max(0.1, Math.min(Math.PI - 0.1, phi));

        // Calculate the new Cartesian coordinates for the camera position
        this.position[0] = this.target[0] + radius * Math.sin(phi) * Math.sin(theta);
        this.position[1] = this.target[1] + radius * Math.cos(phi);
        this.position[2] = this.target[2] + radius * Math.sin(phi) * Math.cos(theta);
    }

    /**
     * Zooms the camera in or out by adjusting its distance from the target.
     * @param {number} delta - The amount to zoom. Positive values zoom in, negative values zoom out.
     */
    zoom(delta) {
        const vec = [
            this.position[0] - this.target[0],
            this.position[1] - this.target[1],
            this.position[2] - this.target[2]
        ];
        const distance = Math.hypot(...vec);
        // Clamp distance to a reasonable range to prevent clipping or being too far away
        const newDistance = Math.max(1.0, Math.min(10.0, distance - delta));

        // No change if we're at the limit and trying to go further
        if (Math.abs(newDistance - distance) < 1e-6) return;

        const direction = [vec[0] / distance, vec[1] / distance, vec[2] / distance];

        this.position[0] = this.target[0] + direction[0] * newDistance;
        this.position[1] = this.target[1] + direction[1] * newDistance;
        this.position[2] = this.target[2] + direction[2] * newDistance;
    }

    reset() {
        this.position = [...this.initialPosition];
        this.target = [0, 0, 0]; // Reset target to origin as well
    }

    /**
     * Calculates the distance from the camera's position to its target.
     */
    getDistance() {
        const vec = [
            this.position[0] - this.target[0],
            this.position[1] - this.target[1],
            this.position[2] - this.target[2]
        ];
        return Math.hypot(...vec);
    }
}