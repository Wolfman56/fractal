import mat4 from './mat4.js';

export default class Camera {
    constructor() {
        this.position = [0, 2, 3]; // Default initial position for a small world
        this.target = [0, 0, 0];
        this.up = [0, 1, 0];
        this.viewMatrix = mat4.create();

        // Initialize with default values for a small world
        this.initialPosition = [...this.position];
        this.initialTarget = [...this.target];
        this.minZoom = 1.0;
        this.maxZoom = 10.0;
        this._lastWorldSize = -1; // To track changes in world scale
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
     * @param {number} deltaFactor - The factor to zoom by. Positive values zoom in, negative values zoom out.
     */
    zoom(deltaFactor) {
        const vec = [
            this.position[0] - this.target[0],
            this.position[1] - this.target[1],
            this.position[2] - this.target[2]
        ];
        const distance = Math.hypot(...vec);
        // The new distance is scaled by the delta factor.
        const newDistance = Math.max(this.minZoom, Math.min(this.maxZoom, distance * (1 - deltaFactor)));

        // No change if we're at the limit and trying to go further
        if (Math.abs(newDistance - distance) < 1e-6) return;

        const direction = [vec[0] / distance, vec[1] / distance, vec[2] / distance];

        this.position[0] = this.target[0] + direction[0] * newDistance;
        this.position[1] = this.target[1] + direction[1] * newDistance;
        this.position[2] = this.target[2] + direction[2] * newDistance;
    }

    reset() {
        this.position = [...this.initialPosition];
        this.target = [...this.initialTarget];
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

    /**
     * Adjusts the camera's initial position and zoom limits based on the world's physical size.
     * This should be called when the world scale changes to ensure the camera starts at a reasonable distance.
     * @param {number} worldSize - The physical size (e.g., in meters) of the world's width/depth.
     * @param {number} heightScale - A hint for the world's vertical scale.
     */
    setWorldScale(worldSize, heightScale = 10.0) {
        if (this._lastWorldSize === worldSize) return; // No change needed
        this._lastWorldSize = worldSize;

        // To frame the object correctly, we need to calculate the camera's distance
        // based on the field of view and the object's size.
        const fovy = (45 * Math.PI) / 180; // Assuming the standard 45-degree FOV from view.js
        const objectHeight = heightScale;
        const objectWidth = worldSize;

        // Calculate the distance required to fit the object's height in the view.
        const distForHeight = (objectHeight / 2) / Math.tan(fovy / 2);
        // We add half the object's depth to the distance to ensure the front face is not clipped.
        const distance = (distForHeight + (objectWidth / 2)) * 1.15;

        // Define an initial viewing angle (e.g., 30 degrees down from horizontal) for a better overview.
        const initialPitchAngle = 30 * (Math.PI / 180);
        const phi = (Math.PI / 2) - initialPitchAngle; // Convert to spherical coordinate phi (angle from Y-up)

        this.initialTarget = [0, objectHeight * 0.3, 0]; // Aim towards the lower-middle of the object
        this.initialPosition = [
            this.initialTarget[0],
            this.initialTarget[1] + distance * Math.cos(phi),
            this.initialTarget[2] + distance * Math.sin(phi)
        ];

        this.minZoom = worldSize * 0.1;
        this.maxZoom = worldSize * 3.0;
    }
}