/**
 * Manages all user input for camera control and scene navigation.
 */
export default class InputHandler {
    /**
     * @param {HTMLCanvasElement} canvas - The canvas element to attach listeners to.
     * @param {View} view - The main view object containing the camera.
     * @param {function} getAppState - A function that returns the current app state needed by the handler.
     * @param {function} onUpdateNeeded - A callback to signal that the terrain needs regeneration.
     */
    constructor(canvas, view, getAppState, onUpdateNeeded) {
        this.canvas = canvas;
        this.view = view;
        this.getAppState = getAppState;
        this.onUpdateNeeded = onUpdateNeeded;

        this.isDragging = false;
        this.prevMouseX = 0;
        this.prevMouseY = 0;

        this.initialPinchDistance = 0;
        this.isPinching = false;
        this.lastTouchX = 0;
        this.lastTouchY = 0;
    }

    setupEventListeners() {
        // Mouse controls
        this.canvas.addEventListener('mousedown', e => { this.isDragging = true; this.prevMouseX = e.clientX; this.prevMouseY = e.clientY; });
        document.addEventListener('mouseup', () => { this.isDragging = false; });
        document.addEventListener('mousemove', e => {
            if (!this.isDragging) return;
            this.view.camera.orbit((e.clientX - this.prevMouseX) * 0.005, (e.clientY - this.prevMouseY) * 0.005);
            this.prevMouseX = e.clientX;
            this.prevMouseY = e.clientY;
            this.view.drawScene();
        });
        this.canvas.addEventListener('wheel', e => {
            e.preventDefault();
            const zoomAmount = e.deltaY * 0.01;
            this.view.camera.zoom(zoomAmount);

            if (this.getAppState().currentModel.shaderStrategy.regeneratesOnZoom) {
                this.onUpdateNeeded();
            } else {
                this.view.drawScene();
            }
        }, { passive: false });

        // Keyboard controls
        window.addEventListener('keydown', (e) => {
            const currentModel = this.getAppState().currentModel;
            if (currentModel.shaderStrategy.supportsScrolling) {
                const initialDistance = Math.hypot(...this.view.camera.initialPosition);
                const zoomFactor = this.view.camera.getDistance() / initialDistance;
                const scrollAmount = 20 * zoomFactor;
                let scrolled = false;
                if (e.key === 'ArrowUp') { currentModel.shaderStrategy.scroll(0, -scrollAmount); scrolled = true; }
                if (e.key === 'ArrowDown') { currentModel.shaderStrategy.scroll(0, scrollAmount); scrolled = true; }
                if (e.key === 'ArrowLeft') { currentModel.shaderStrategy.scroll(-scrollAmount, 0); scrolled = true; }
                if (e.key === 'ArrowRight') { currentModel.shaderStrategy.scroll(scrollAmount, 0); scrolled = true; }

                if (scrolled) {
                    e.preventDefault();
                    this.onUpdateNeeded();
                }
            }
        });

        // Touch controls
        this.canvas.addEventListener('touchstart', e => {
            e.preventDefault();
            if (e.touches.length === 1) {
                this.isPinching = false;
                this.lastTouchX = e.touches[0].clientX;
                this.lastTouchY = e.touches[0].clientY;
            } else if (e.touches.length === 2) {
                this.isPinching = true;
                const dx = e.touches[0].clientX - e.touches[1].clientX;
                const dy = e.touches[0].clientY - e.touches[1].clientY;
                this.initialPinchDistance = Math.hypot(dx, dy);
            }
        }, { passive: false });

        this.canvas.addEventListener('touchmove', e => {
            e.preventDefault();
            if (this.isPinching && e.touches.length === 2) {
                const dx = e.touches[0].clientX - e.touches[1].clientX;
                const dy = e.touches[0].clientY - e.touches[1].clientY;
                const newPinchDistance = Math.hypot(dx, dy);
                const zoomAmount = (this.initialPinchDistance - newPinchDistance) * 0.02;
                this.view.camera.zoom(zoomAmount);
                this.initialPinchDistance = newPinchDistance;

                if (this.getAppState().currentModel.shaderStrategy.regeneratesOnZoom) {
                    this.onUpdateNeeded();
                } else {
                    this.view.drawScene();
                }
            } else if (!this.isPinching && e.touches.length === 1) {
                const touchX = e.touches[0].clientX;
                const touchY = e.touches[0].clientY;
                this.view.camera.orbit((touchX - this.lastTouchX) * 0.005, (touchY - this.lastTouchY) * 0.005);
                this.lastTouchX = touchX;
                this.lastTouchY = touchY;
                this.view.drawScene();
            }
        }, { passive: false });

        this.canvas.addEventListener('touchend', () => {
            this.isPinching = false;
            this.initialPinchDistance = 0;
        });
    }
}