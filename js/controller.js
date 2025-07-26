import mat4 from './mat4.js';
import { TiledLODModel, UntiledHeightmapModel } from './models.js';
import View from './view.js';
import { ScrollingShaderStrategy, FractalZoomShaderStrategy, ScrollAndZoomStrategy, TiledLODShaderStrategy } from './shader_strategies.js';

class Controller {
    constructor() {
        this.canvas = document.getElementById('canvas');
        this.view = new View(this.canvas);

        // UI State
        this.isUpdating = false;
        this.isEroding = false;
        this.isAnimating = false;
        this.isStepInProgress = false; // Lock for async operations
        this.wantsUpdate = false; // Flag to queue a terrain update

        // Animation Timing
        this.gameLoopId = null;
        this.lastFrameTime = 0;
        this.resizeTimeout = null;

        this.regenTimeout = null;
        this.shaderStrategies = {
            'Scrolling': new ScrollingShaderStrategy(),
            'FractalZoom': new FractalZoomShaderStrategy(),
            'Scroll & Zoom': new ScrollAndZoomStrategy(),
            'Tiled LOD': new TiledLODShaderStrategy(),
        };
        this.models = {};
        this.currentModel = null;
        this.currentShaderStrategy = null; // The model will manage its strategy
    }

    async init() {
        const gpuContext = await this.view.initWebGPU();
        if (!gpuContext) {
            const controls = document.getElementById('controls');
            if (controls) controls.style.display = 'none';
            return;
        }

        this.device = gpuContext.device;
        this.erosionPipeline = gpuContext.erosion;

        for (const strategy of Object.values(this.shaderStrategies)) {
            await strategy.createPipelines(this.device, gpuContext.computePipelineLayout);
        }

        this.models = {
            'Scrolling': new UntiledHeightmapModel(this.device, this.shaderStrategies['Scrolling']),
            'FractalZoom': new UntiledHeightmapModel(this.device, this.shaderStrategies['FractalZoom']),
            'Scroll & Zoom': new UntiledHeightmapModel(this.device, this.shaderStrategies['Scroll & Zoom']),
            'Tiled LOD': new TiledLODModel(this.device, this.shaderStrategies['Tiled LOD']),
        };

        // Set the Tiled LOD strategy as the default for testing
        this.currentModel = this.models['Tiled LOD'];

        // Populate the strategy dropdown
        const select = document.getElementById('shader-strategy-select');
        for (const name in this.shaderStrategies) {
            const option = document.createElement('option');
            option.value = name;
            option.textContent = name;
            if (this.models[name] === this.currentModel) {
                option.selected = true;
            }
            select.appendChild(option);
        }

        // Set initial canvas size from CSS and create render resources
        this.view.handleResize();

        this.setupEventListeners();
        this.gameLoop(); // Start the main loop
        await this.updateTerrain();
    }

    getParamsFromUI() {
        const controlsContainer = document.getElementById('controls');
        if (!controlsContainer) {
            // Default params for test page
            return {
                gridSize: 512,
                octaves: 8, persistence: 0.5, lacunarity: 2.0, scale: 512,
                seed: 42, heightMultiplier: 0.7, hurst: 0.6,
            };
        }

        const gridSizeSliderValue = parseInt(document.getElementById('gridSize').value, 10);
        const cycles = parseFloat(document.getElementById('cycles').value) || 1.0;
        const baseScale = Math.pow(2, gridSizeSliderValue) / cycles;
        let finalScale = baseScale;

        if (this.currentModel.shaderStrategy.regeneratesOnZoom) {
            // Adjust scale based on camera distance for fractal zoom effect
            const distance = this.view.camera.getDistance();
            // Normalize the effect around the initial camera distance
            const initialDistance = Math.hypot(...this.view.camera.initialPosition);
            const zoomFactor = distance / initialDistance;
            finalScale = baseScale / zoomFactor;
        }

        return {
            gridSize: Math.pow(2, gridSizeSliderValue),
            octaves: parseInt(document.getElementById('octaves').value, 10),
            persistence: parseFloat(document.getElementById('persistence').value),
            lacunarity: parseFloat(document.getElementById('lacunarity').value),
            scale: finalScale,
            seed: parseInt(document.getElementById('seed').value, 10),
            heightMultiplier: parseFloat(document.getElementById('heightMultiplier').value),
            hurst: parseFloat(document.getElementById('hurst').value),
        };
    }

    async updateTerrain() {
        if (this.isUpdating) return;
        this.isUpdating = true;

        const confirmOverwrite = document.getElementById('confirm-overwrite')?.checked ?? true;
        if (this.currentModel.erosionFrameCounter > 0 && confirmOverwrite) {
            if (!window.confirm("Changing these parameters will discard the current erosion. Are you sure you want to continue?")) {
                this.isUpdating = false; // Release the lock
                this.wantsUpdate = false; // Cancel the pending update
                return; // Abort the update
            }
        }

        const params = this.getParamsFromUI();
        const currentGridSize = this.currentModel.gridSize;

        if (params.gridSize !== currentGridSize) {
            console.log(`Grid size changed to ${params.gridSize}. Recreating resources...`);
            this.view.recreateRenderResources();
            for (const model of Object.values(this.models)) {
                model.recreateResources(params.gridSize, this.erosionPipeline);
            }
        }

        try {
            await this.currentModel.update(params, this.view);
            this.view.drawScene();
        } catch (e) {
            console.error("Error during terrain update:", e);
        } finally {
            this.isUpdating = false;
        }
    }

    async erodeTerrain() {
        if (this.isEroding) return;
        if (!(this.currentModel instanceof UntiledHeightmapModel)) {
            console.warn("Erosion is only supported for non-tiled render modes.");
            return;
        }
        if (!this.currentModel.lastGeneratedHeightmap) return;
        this.isEroding = true;
        this.wantsUpdate = false; // Cancel any pending scroll updates

        const iterations = parseInt(document.getElementById('erosion-iterations')?.value || '10', 10);
        const rate = parseFloat(document.getElementById('erosion-rate')?.value || '0.01');

        try {
            const heights = await this.currentModel.runErosion(iterations, rate, this.erosionPipeline);
            if (heights) {
                this.view.updateTileMesh('0,0', heights, this.currentModel.lastGeneratedParams);
                this.view.drawScene();
            }
        } catch (e) {
            console.error("Error during erosion:", e);
        } finally {
            this.isEroding = false;
        }
    }

    toggleAnimation() {
        this.isAnimating = !this.isAnimating;
        document.getElementById('animate-erosion')?.classList.toggle('toggled-on', this.isAnimating);
        this.lastFrameTime = 0; // Reset timer when toggling
    }

    async animate(timestamp) {
        // This is now just the logic for one animation step, called from the game loop.
        const frameInterval = 1000 / 30; // 30 FPS

        if (!this.lastFrameTime) this.lastFrameTime = timestamp;
        const elapsed = timestamp - this.lastFrameTime;

        if (elapsed < this.frameInterval) return;

        this.lastFrameTime = timestamp - (elapsed % this.frameInterval);

        if (this.isStepInProgress || this.isUpdating || this.isEroding) return;
        this.isStepInProgress = true;

        try {
            const rate = parseFloat(document.getElementById('erosion-rate')?.value || '0.01');
            const heights = await this.currentModel.runErosion(1, rate, this.erosionPipeline);
            if (heights) {
                this.view.updateTileMesh('0,0', heights, this.currentModel.lastGeneratedParams);
                this.view.drawScene();
            }
        } catch (e) {
            console.error("Error in animation frame:", e);
            this.toggleAnimation(); // Stop animation on error
        } finally {
            this.isStepInProgress = false;
        }
    }

    gameLoop(timestamp) {
        this.gameLoopId = requestAnimationFrame(this.gameLoop.bind(this));

        // Handle terrain updates if requested and not already busy
        if (this.wantsUpdate && !this.isUpdating) {
            this.wantsUpdate = false; // Consume the request
            this.updateTerrain();
        }

        // Handle erosion animation if active
        if (this.isAnimating) {
            this.animate(timestamp);
        }
    }

    onWindowResize() {
        // Debounce the resize event to avoid excessive re-rendering and resource creation
        if (this.resizeTimeout) {
            clearTimeout(this.resizeTimeout);
        }
        this.resizeTimeout = setTimeout(() => {
            console.log("Window resized, updating canvas...");
            this.view.handleResize();
        }, 250); // 250ms debounce
    }

    setupEventListeners() {
        document.getElementById('regenerate')?.addEventListener('click', () => this.updateTerrain());
        document.getElementById('erode-terrain')?.addEventListener('click', () => this.erodeTerrain());
        document.getElementById('animate-erosion')?.addEventListener('click', () => this.toggleAnimation());
        document.getElementById('snapshot-button')?.addEventListener('click', async () => {
            this.view.drawScene();
            await this.view.device.queue.onSubmittedWorkDone();
            const link = document.createElement('a');
            link.href = this.canvas.toDataURL('image/png');
            link.download = `fractal_snapshot_${Date.now()}.png`;
            link.click();
        });
        document.getElementById('drawer-toggle')?.addEventListener('click', () => {
            const controls = document.getElementById('controls');
            controls?.classList.toggle('open');
        });
        document.getElementById('shader-strategy-select')?.addEventListener('change', (e) => {
            const selectedName = e.target.value;
            this.currentModel = this.models[selectedName];
            this.currentShaderStrategy = this.shaderStrategies[selectedName]; // Keep for scrolling/zoom logic
            console.log(`Switched to ${selectedName} strategy.`);
            this.updateTerrain();
        });
        document.getElementById('reset-view')?.addEventListener('click', () => {
            this.view.camera.reset();
            if (!this.isAnimating) this.view.drawScene();
        });

        // Sliders that should trigger a terrain regeneration
        const regenSliderIds = ['gridSize', 'octaves', 'persistence', 'lacunarity', 'cycles', 'seed', 'heightMultiplier', 'hurst'];

        regenSliderIds.forEach(id => {
            const slider = document.getElementById(id);
            if (slider) {
                slider.addEventListener('input', () => {
                    // Update the text label immediately
                    const valueSpan = document.getElementById(`${id}-value`);
                    if (id === 'gridSize') {
                        valueSpan.textContent = `${Math.pow(2, slider.value)} (2^${slider.value})`;
                    } else {
                        valueSpan.textContent = slider.value;
                    }

                    // Debounce the actual terrain update
                    if (this.regenTimeout) clearTimeout(this.regenTimeout);
                    this.regenTimeout = setTimeout(() => {
                        console.log(`UI parameter '${id}' changed, queueing terrain update...`);
                        this.wantsUpdate = true;
                    }, 500);
                });
            }
        });

        // Sliders that do NOT trigger regeneration (e.g., erosion controls)
        ['erosion-iterations', 'erosion-rate'].forEach(id => {
            const slider = document.getElementById(id);
            if (slider) {
                slider.addEventListener('input', () => {
                    const valueSpan = document.getElementById(`${id}-value`);
                    valueSpan.textContent = slider.value;
                });
            }
        });

        // Add keyboard controls for scrolling
        window.addEventListener('keydown', (e) => {
            if (this.currentModel.shaderStrategy.supportsScrolling) {
                // Make scroll speed relative to the current zoom level for a natural feel.
                const initialDistance = Math.hypot(...this.view.camera.initialPosition);
                const zoomFactor = this.view.camera.getDistance() / initialDistance;
                const scrollAmount = 20 * zoomFactor;
                let scrolled = false;
                if (e.key === 'ArrowUp') { this.currentShaderStrategy.scroll(0, -scrollAmount); scrolled = true; }
                if (e.key === 'ArrowDown') { this.currentShaderStrategy.scroll(0, scrollAmount); scrolled = true; }
                if (e.key === 'ArrowLeft') { this.currentShaderStrategy.scroll(-scrollAmount, 0); scrolled = true; }
                if (e.key === 'ArrowRight') { this.currentShaderStrategy.scroll(scrollAmount, 0); scrolled = true; }

                if (scrolled) {
                    e.preventDefault();
                    this.wantsUpdate = true;
                }
            }
        });

        window.addEventListener('resize', () => this.onWindowResize());

        // Mouse controls
        let isDragging = false;
        let prevMouseX = 0, prevMouseY = 0;
        this.canvas.addEventListener('mousedown', e => { isDragging = true; prevMouseX = e.clientX; prevMouseY = e.clientY; });
        document.addEventListener('mouseup', () => { isDragging = false; });
        document.addEventListener('mousemove', e => {
            if (!isDragging) return;
            this.view.camera.orbit((e.clientX - prevMouseX) * 0.005, (e.clientY - prevMouseY) * 0.005);
            prevMouseX = e.clientX;
            prevMouseY = e.clientY;
            if (!this.isAnimating) this.view.drawScene();
        });
        this.canvas.addEventListener('wheel', e => {
            e.preventDefault();
            const zoomAmount = e.deltaY * 0.01;
            this.view.camera.zoom(zoomAmount);

            if (this.currentModel.shaderStrategy.regeneratesOnZoom) {
                this.wantsUpdate = true;
            } else {
                // For other strategies, just redraw the scene
                if (!this.isAnimating) this.view.drawScene();
            }
        });

        // Touch controls for orbit and pinch-to-zoom
        let initialPinchDistance = 0;
        let isPinching = false;
        let lastTouchX = 0;
        let lastTouchY = 0;

        this.canvas.addEventListener('touchstart', e => {
            e.preventDefault();
            if (e.touches.length === 1) {
                // Start of a drag/orbit
                isPinching = false;
                lastTouchX = e.touches[0].clientX;
                lastTouchY = e.touches[0].clientY;
            } else if (e.touches.length === 2) {
                // Start of a pinch/zoom
                isPinching = true;
                const dx = e.touches[0].clientX - e.touches[1].clientX;
                const dy = e.touches[0].clientY - e.touches[1].clientY;
                initialPinchDistance = Math.hypot(dx, dy);
            }
        }, { passive: false });

        this.canvas.addEventListener('touchmove', e => {
            e.preventDefault();
            if (isPinching && e.touches.length === 2) {
                // Handle pinch/zoom
                const dx = e.touches[0].clientX - e.touches[1].clientX;
                const dy = e.touches[0].clientY - e.touches[1].clientY;
                const newPinchDistance = Math.hypot(dx, dy);
                const zoomAmount = (initialPinchDistance - newPinchDistance) * 0.02; // Scale factor for sensitivity
                this.view.camera.zoom(zoomAmount);
                initialPinchDistance = newPinchDistance; // Update for continuous zoom

                if (this.currentModel.shaderStrategy.regeneratesOnZoom) {
                    this.wantsUpdate = true;
                } else {
                    if (!this.isAnimating) this.view.drawScene();
                }
            } else if (!isPinching && e.touches.length === 1) {
                // Handle drag/orbit
                const touchX = e.touches[0].clientX;
                const touchY = e.touches[0].clientY;
                this.view.camera.orbit((touchX - lastTouchX) * 0.005, (touchY - lastTouchY) * 0.005);
                lastTouchX = touchX;
                lastTouchY = touchY;
                if (!this.isAnimating) this.view.drawScene();
            }
        }, { passive: false });

        this.canvas.addEventListener('touchend', e => {
            // Reset states when touches end
            isPinching = false;
            initialPinchDistance = 0;
        });
    }
}

const app = new Controller();
app.init();