import View from './view.js';
import UIController from './ui_controller.js';
import mat4 from './mat4.js';
import InputHandler from './input_handler.js';
import SimulationController from './simulation_controller.js';

class Controller {
    constructor() {
        this.canvas = document.getElementById('canvas');
        this.view = new View(this.canvas);

        // UI State
        this.gameLoopId = null;

        this.uiController = null;
        this.inputHandler = null;
        this.simulationController = null;
        this.config = null;
        this.hasLoggedMatrices = false;
    }

    async init() {
        const response = await fetch('/config.json');
        if (!response.ok) {
            console.error("Failed to load config.json. Application cannot start.");
            alert("Error: Could not load configuration file.");
            return;
        }
        const config = await response.json();
        this.config = config;

        const gpuContext = await this.view.initWebGPU();
        if (!gpuContext) {
            const controls = document.getElementById('controls');
            if (controls) controls.style.display = 'none';
            return;
        }

        this.device = gpuContext.device;

        const uiCallbacks = {
            onRegenerate: () => {
                // A full regeneration should reset the view to its default state and clear
                // any existing normalization data to accurately reflect the new terrain.
                if (this.inputHandler) {
                    this.inputHandler.worldOffset = { ...(this.config.generation.worldOffset || { x: 0, y: 0 }) };
                }
                // Also reset the camera view, recalculating scale based on current UI params
                const params = this._getParamsFromUI();
                const visualHeight = params.metersPerSide * params.verticalExaggeration;
                this.view.camera.setWorldScale(params.metersPerSide, visualHeight);
                this.view.camera.reset();

                this.hasLoggedMatrices = false; // Reset log flag on regenerate
                this.simulationController.currentModel.shaderStrategy.resetNormalization();
                this.simulationController.wantsUpdate = true;
            },
            onErode: () => this.simulationController.erodeTerrain(),
            onRainModeChange: (mode) => this.simulationController.setRainMode(mode),
            onResetView: () => {
                // Resetting the view should return both the camera and the terrain's pan
                // position to their default states, then trigger a regeneration.
                if (this.inputHandler) {
                    this.inputHandler.worldOffset = { ...(this.config.generation.worldOffset || { x: 0, y: 0 }) };
                }
                // Update the camera's scale based on the current UI settings before resetting.
                // This ensures the camera targets the center of the *visually scaled* object.
                const params = this._getParamsFromUI();
                const visualHeight = params.metersPerSide * params.verticalExaggeration;
                this.view.camera.setWorldScale(params.metersPerSide, visualHeight);
                this.view.camera.reset();
                this.simulationController.wantsUpdate = true;
            },
            onSnapshot: () => this.takeSnapshot(),
            onToggleCapture: () => this.simulationController.toggleCapture(),
            onSaveCapture: () => this.simulationController.saveCaptureData(),
            onClearCapture: () => this.simulationController.clearCaptureData(),
            onStrategyChange: (name) => this.simulationController.changeShaderStrategy(name),
            onErosionModelChange: (name) => this.simulationController.changeErosionModel(name),
            onViewModeChange: (name) => {
                const seaLevel = parseFloat(document.getElementById('erosion-sea-level')?.value || '0.15');
                this.simulationController.changeViewMode(name, seaLevel);
            },
            onParamsChanged: () => this.simulationController.wantsUpdate = true,
            onPlotMetricChange: (metrics) => this.simulationController.changePlotMetric(metrics),
            onShowPlotWindow: () => this.simulationController.showPlotWindow(),
        };
        this.uiController = new UIController(uiCallbacks, config);

        this.simulationController = new SimulationController(this.device, this.view, this.uiController, config);
        await this.simulationController.init(gpuContext.computePipelineLayout);

        // Set the camera's scale based on the world configuration before the first render.
        // The visual height is determined by the aspect ratio slider, which makes the
        // world appear as a cube when the slider is at 1.0.
        const visualAspectRatio = this.config.visuals.verticalExaggeration;
        const visualHeight = this.config.world.metersPerSide * visualAspectRatio;
        this.view.camera.setWorldScale(this.config.world.metersPerSide, visualHeight);
        this.view.camera.reset();

        this.inputHandler = new InputHandler(this.canvas, this.view,
            () => ({ currentModel: this.simulationController.currentModel }),
            () => this.simulationController.wantsUpdate = true
        );
        // Initialize worldOffset from config
        this.inputHandler.worldOffset = { ...(config.generation.worldOffset || { x: 0, y: 0 }) };

        this.uiController.populateDropdown('shader-strategy-select', Object.keys(this.simulationController.shaderStrategies), config.simulation.shaderStrategy);
        this.uiController.populateDropdown('erosion-model-select', this.simulationController.erosionModelDisplayNames, config.erosion.model);
        this.uiController.setupEventListeners();
        this.inputHandler.setupEventListeners();

        this.view.handleResize();
        this.gameLoop(); // Start the main loop
        this.simulationController.wantsUpdate = true; // Trigger initial terrain generation
    }

    _getParamsFromUI() {
        const gridSizeSlider = document.getElementById('gridSize');
        const worldOffset = this.inputHandler.worldOffset || { x: 0, y: 0 };
        // The gridSizeSlider check is now redundant as the config ensures UI is present.

        const gridSizeSliderValue = parseInt(gridSizeSlider.value, 10);
        const cycles = parseFloat(document.getElementById('cycles').value) || 1.0;
        const baseScale = Math.pow(2, gridSizeSliderValue) / cycles;
        let finalScale = baseScale;

        if (this.simulationController?.currentModel?.shaderStrategy.regeneratesOnZoom) {
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
            worldOffset: worldOffset,
            metersPerSide: this.config.world.metersPerSide,
            seaLevel: parseFloat(document.getElementById('erosion-sea-level')?.value || '0.15'),
            verticalExaggeration: parseFloat(document.getElementById('verticalExaggeration')?.value || '1.0'),
        };
    }

    takeSnapshot() {
        // First, ensure the scene is drawn with the latest data.
        this.view.drawScene();

        // Wait for the GPU to finish its work.
        this.view.device.queue.onSubmittedWorkDone().then(() => {
            // By wrapping the toDataURL call in requestAnimationFrame, we give the
            // browser a chance to composite the newly rendered frame before we try to capture it.
            // This helps avoid race conditions that can result in a blank image.
            requestAnimationFrame(() => {
                const link = document.createElement('a');
                link.href = this.canvas.toDataURL('image/png');
                link.download = `fractal_snapshot_${Date.now()}.png`;
                link.click();
            });
        });
    }

    gameLoop(timestamp) {
        this.gameLoopId = requestAnimationFrame(this.gameLoop.bind(this));

        // Get latest UI parameters for this frame.
        const params = this._getParamsFromUI();

        const wantsUpdate = this.simulationController.wantsUpdate;

        // This runs the model update if needed
        this.simulationController.tick(wantsUpdate, params);

        // If a terrain update is in progress, it will handle its own drawing
        // once complete. We should not draw here to avoid using inconsistent state.
        if (this.simulationController.isUpdating) {
            return;
        }

        const lastRenderParams = this.simulationController.currentModel.lastRenderParams;

        // The actual dynamic range of the terrain in meters.
        const actualHeightRange = lastRenderParams?.heightMultiplier ?? params.heightMultiplier;

        let finalVerticalExaggeration = params.verticalExaggeration;

        // To achieve a "unit cube" view where 1.0 on the slider means the visual height
        // matches the world width, we apply an aspect ratio correction.
        if (actualHeightRange > 1e-6) {
            const aspectRatioCorrection = params.metersPerSide / actualHeightRange;
            finalVerticalExaggeration = aspectRatioCorrection * params.verticalExaggeration;
        }

        // --- DEBUG LOGGING ---
        // On the first frame after a terrain update completes, log all transform matrices and extents.
        if (this.simulationController.dataIsReady && !this.hasLoggedMatrices) {
            const pMatrix = mat4.create();
            const nearPlane = this.view.camera.minZoom * 0.1;
            const farPlane = this.view.camera.maxZoom * 2.0;
            mat4.perspective(pMatrix, (45 * Math.PI) / 180, this.view.canvas.width / this.view.canvas.height, nearPlane, farPlane);

            const vMatrix = this.view.camera.getViewMatrix();
            const firstTile = this.view.tiles.values().next().value;
            const mMatrix = firstTile ? firstTile.modelMatrix : mat4.create();

            const maxPhysicalY = (lastRenderParams?.seaLevelOffset ?? 0) + (lastRenderParams?.heightMultiplier ?? params.heightMultiplier);
            const maxVisualY = maxPhysicalY * finalVerticalExaggeration;

            console.groupCollapsed("--- First Frame Render Debug ---");
            console.log("Projection Matrix (P):", pMatrix);
            console.log("View Matrix (V):", vMatrix);
            console.log("Model Matrix (M):", mMatrix);
            console.log("Max Visual Geometry Extent (World Space):", { x: params.metersPerSide / 2.0, y: maxVisualY, z: params.metersPerSide / 2.0 });
            console.log("Calculation Details:", { physicalHeightRange: actualHeightRange, uiExaggeration: params.verticalExaggeration, finalExaggerationToShader: finalVerticalExaggeration });
            console.groupEnd();

            this.hasLoggedMatrices = true;
            this.simulationController.dataIsReady = false; // Consume the flag
        }
        // --- END DEBUG LOGGING ---

        // This updates uniforms and draws the scene every frame
        this.view.updateGlobalParams(params.seaLevel, this.simulationController.viewMode, lastRenderParams, finalVerticalExaggeration);
        this.view.drawScene(this.simulationController.viewMode);
    }
}

const app = new Controller();
app.init();