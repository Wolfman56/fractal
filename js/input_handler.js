/**
 * Handles all user input, including mouse/touch for camera control and keyboard for scrolling.
 */
export default class InputHandler {
    constructor(canvas, view, getState, onUpdate) {
        this.canvas = canvas;
        this.view = view;
        this.getState = getState;
        this.onUpdate = onUpdate;

        // Camera interaction state
        this.isDragging = false;
        this.lastMouseX = 0;
        this.lastMouseY = 0;

        // Scrolling state
        this.worldOffset = { x: 0, y: 0 };
        this.keys = new Set();
        this.scrollSpeed = 10;

        // Touch state
        this.lastPinchDist = 0;
    }

    setupEventListeners() {
        // Mouse events for camera
        this.canvas.addEventListener('mousedown', this.handleMouseDown.bind(this));
        this.canvas.addEventListener('mouseup', this.handleMouseUp.bind(this));
        this.canvas.addEventListener('mousemove', this.handleMouseMove.bind(this));
        this.canvas.addEventListener('wheel', this.handleWheel.bind(this));

        // Touch events for camera. { passive: false } is important to allow preventDefault().
        this.canvas.addEventListener('touchstart', this.handleTouchStart.bind(this), { passive: false });
        this.canvas.addEventListener('touchend', this.handleTouchEnd.bind(this), { passive: false });
        this.canvas.addEventListener('touchmove', this.handleTouchMove.bind(this), { passive: false });

        // Keyboard events for scrolling
        window.addEventListener('keydown', this.handleKeyDown.bind(this));
        window.addEventListener('keyup', this.handleKeyUp.bind(this));
    }

    handleMouseDown(e) {
        if (e.button === 0) { // Left mouse button
            this.isDragging = true;
            this.lastMouseX = e.clientX;
            this.lastMouseY = e.clientY;
        }
    }

    handleMouseUp(e) {
        if (e.button === 0) {
            this.isDragging = false;
        }
    }

    handleMouseMove(e) {
        if (this.isDragging) {
            const dx = e.clientX - this.lastMouseX;
            const dy = e.clientY - this.lastMouseY;
            // Scale down mouse orbit sensitivity. The values are small as they are treated as radians.
            this.view.camera.orbit(dx * 0.005, dy * 0.005);
            this.lastMouseX = e.clientX;
            this.lastMouseY = e.clientY;
            this.view.drawScene();
        }
    }

    handleWheel(e) {
        e.preventDefault();
        const { currentModel } = this.getState();
        // Scale down wheel zoom sensitivity.
        this.view.camera.zoom(e.deltaY * 0.01);
        if (currentModel?.shaderStrategy.regeneratesOnZoom) {
            this.onUpdate();
        } else {
            this.view.drawScene();
        }
    }

    handleTouchStart(e) {
        e.preventDefault();
        if (e.touches.length === 1) {
            this.isDragging = true;
            this.lastMouseX = e.touches[0].clientX;
            this.lastMouseY = e.touches[0].clientY;
        } else if (e.touches.length === 2) {
            this.isDragging = false; // Stop orbiting when pinching
            this.lastPinchDist = this.getPinchDist(e);
        }
    }

    handleTouchEnd(e) {
        this.isDragging = false;
        this.lastPinchDist = 0;
    }

    handleTouchMove(e) {
        e.preventDefault();
        if (this.isDragging && e.touches.length === 1) {
            const dx = e.touches[0].clientX - this.lastMouseX;
            const dy = e.touches[0].clientY - this.lastMouseY;
            // Scale down touch orbit sensitivity
            this.view.camera.orbit(dx * 0.01, dy * 0.01);
            this.lastMouseX = e.touches[0].clientX;
            this.lastMouseY = e.touches[0].clientY;
            this.view.drawScene();
        } else if (e.touches.length === 2 && this.lastPinchDist > 0) {
            const newPinchDist = this.getPinchDist(e);
            const delta = this.lastPinchDist - newPinchDist;

            // Scale down pinch-to-zoom sensitivity
            this.view.camera.zoom(delta * 0.02);

            this.lastPinchDist = newPinchDist;

            const { currentModel } = this.getState();
            if (currentModel?.shaderStrategy.regeneratesOnZoom) {
                this.onUpdate();
            } else {
                this.view.drawScene();
            }
        }
    }

    handleKeyDown(e) {
        if (e.key.startsWith('Arrow')) {
            e.preventDefault();
            this.keys.add(e.key);
            this.handleScrolling();
        }

        // Camera dolly controls (move forward/backward without regenerating terrain)
        const dollySpeed = 0.2; // A constant for how much to move per key press
        if (e.key === 'r') {
            e.preventDefault();
            this.view.camera.zoom(dollySpeed); // zoom() with positive delta moves closer
            this.view.drawScene();
        } else if (e.key === 'f') {
            e.preventDefault();
            this.view.camera.zoom(-dollySpeed); // zoom() with negative delta moves away
            this.view.drawScene();
        }
    }

    handleKeyUp(e) {
        if (e.key.startsWith('Arrow')) {
            this.keys.delete(e.key);
        }
    }

    handleScrolling() {
        const { currentModel } = this.getState();
        // Only allow panning for strategies that explicitly support it.
        if (!currentModel || !currentModel.shaderStrategy.supportsPanning) {
            return;
        }

        let scrolled = false;
        if (this.keys.has('ArrowUp')) { this.worldOffset.y += this.scrollSpeed; scrolled = true; }
        if (this.keys.has('ArrowDown')) { this.worldOffset.y -= this.scrollSpeed; scrolled = true; }
        if (this.keys.has('ArrowLeft')) { this.worldOffset.x -= this.scrollSpeed; scrolled = true; }
        if (this.keys.has('ArrowRight')) { this.worldOffset.x += this.scrollSpeed; scrolled = true; }

        if (scrolled) {
            this.onUpdate();
        }
    }

    getPinchDist(e) {
        const t1 = e.touches[0];
        const t2 = e.touches[1];
        const dx = t1.clientX - t2.clientX;
        const dy = t1.clientY - t2.clientY;
        return Math.hypot(dx, dy);
    }
}