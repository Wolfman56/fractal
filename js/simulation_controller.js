import { TiledLODModel, UntiledHeightmapModel } from './models.js';
import { HydraulicErosionModel, HydraulicErosionModelDebug, SimpleErosionModel } from './erosion_models.js';
import { ScrollingShaderStrategy, FractalZoomShaderStrategy, ScrollAndZoomStrategy, PyramidShaderStrategy } from './shader_strategies.js';
import SimulationCapture from './simulation_capture.js';

/**
 * Manages the core simulation state and logic, including terrain generation and erosion.
 */
export default class SimulationController {
    constructor(device, view, uiController, config) {
        this.device = device;
        this.view = view;
        this.uiController = uiController;
        this.simulationCapture = new SimulationCapture(this.uiController);

        this.config = config;
        // Simulation State
        this.isUpdating = false;
        this.wantsUpdate = false;
        this.isEroding = false;

        // Models & Strategies
        this.shaderStrategies = {
            'Scrolling': new ScrollingShaderStrategy(),
            'FractalZoom': new FractalZoomShaderStrategy(),
            'Scroll & Zoom': new ScrollAndZoomStrategy(),
            'Pyramid': new PyramidShaderStrategy(),
        };
        this.models = {};
        this.currentModel = null;
        this.erosionModels = {};
        this.currentErosionModel = null;
        this.erosionModelDisplayNames = new Map([
            ['hydraulic', 'Hydraulic'],
            ['hydraulic-debug', 'Hydraulic (Debug)'],
            ['simple', 'Simple (Thermal)']
        ]);

        // Erosion & Capture State
        this.totalErosionIterations = 0;
        this.lastErosionAmount = -1;
        this.rainActive = false;
        this.viewMode = 'standard';

        // State for the pop-out plot window
        this.plotWindow = null;
        this.plotMetrics = [];
        window.addEventListener('message', this._handlePlotterMessage.bind(this));
    }

    async init(computePipelineLayout) {
        // Create erosion models and their pipelines
        this.erosionModels = {
            'hydraulic': new HydraulicErosionModel(this.device),
            'hydraulic-debug': new HydraulicErosionModelDebug(this.device),
            'simple': new SimpleErosionModel(this.device),
        };
        for (const model of Object.values(this.erosionModels)) {
            await model.createPipelines();
        }

        for (const strategy of Object.values(this.shaderStrategies)) {
            await strategy.createPipelines(this.device, computePipelineLayout);
        }

        for (const [name, strategy] of Object.entries(this.shaderStrategies)) {
            this.models[name] = new UntiledHeightmapModel(this.device, strategy);
        }

        this.currentModel = this.models[this.config.simulation.shaderStrategy];
        this.currentErosionModel = this.erosionModels[this.config.erosion.model];
    }

    tick(wantsUpdate, params) {
        if (wantsUpdate && !this.isUpdating) {
            this.wantsUpdate = false; // Consume the request
            this.updateTerrain(params);
        }
    }

    async updateTerrain(params) {
        if (this.isUpdating) {
            this.wantsUpdate = true;
            return;
        }
        this.isUpdating = true;

        try {
            const confirmOverwrite = document.getElementById('confirm-overwrite')?.checked ?? true;
            if (this.totalErosionIterations > 0 && confirmOverwrite) {
                if (!window.confirm("Changing these parameters will discard the current erosion. Are you sure you want to continue?")) {
                    this.isUpdating = false;
                    this.wantsUpdate = false;
                    return;
                }
            }

            const currentGridSize = this.currentModel.gridSize;
            let needsNormalizationReset = false;

            if (params.gridSize !== currentGridSize) {
                console.log(`Grid size changed to ${params.gridSize}. Recreating resources...`);
                needsNormalizationReset = true;
                this.view.recreateRenderResources();
                for (const model of Object.values(this.models)) {
                    model.recreateResources(params.gridSize);
                    model.shaderStrategy.resetNormalization();
                }
                for (const erosionModel of Object.values(this.erosionModels)) {
                    // The erosion model now uses the same power-of-two grid size as the terrain model.
                    if (params.gridSize > 0) {
                        erosionModel.recreateResources(params.gridSize);
                    }
                }
            }

            // Parameters that define the fundamental shape of the world.
            // A change in these requires resetting the normalization range. Navigation via
            // zoom (scale) or pan (worldOffset) should not reset the normalization.
            const worldShapingParams = ['octaves', 'persistence', 'lacunarity', 'hurst', 'seed'];
            const hasWorldShapeChanged = !this.currentModel.lastGeneratedParams ||
                worldShapingParams.some(p => params[p] !== this.currentModel.lastGeneratedParams[p]);

            if (hasWorldShapeChanged) {
                needsNormalizationReset = true;
            }

            await this.currentModel.update(params, this.view, needsNormalizationReset);
            this.totalErosionIterations = 0;
            this.lastErosionAmount = -1;
            this.uiController.updateStats(0, 0, 0, this.simulationCapture.frameCount);

            this.view.drawScene(this.viewMode);
        } catch (e) {
            console.error("Error during terrain update:", e);
        } finally {
            this.isUpdating = false;
        }
    }

    async erodeTerrain(erosionParams, iterations) {
        if (this.isEroding) return;
        if (!(this.currentModel instanceof UntiledHeightmapModel)) {
            console.warn("Erosion is only supported for non-tiled render modes.");
            return;
        }
        if (!this.currentModel.lastGeneratedHeightmap) return;

        // Record the command if capturing is active. This is done before the
        // simulation runs to log the intended action.
        this.simulationCapture.recordCommand({
            step: this.totalErosionIterations,
            rain: this.rainActive,
            iterations: iterations,
            params: erosionParams
        });

        this.isEroding = true;
        this.wantsUpdate = false;

        // The behavior of the "Erode" button now depends on the Rain/Dry toggle.
        // If rain is active, each iteration will add water.
        const stepParams = { ...erosionParams, addRain: this.rainActive };

        try {
            if (this.simulationCapture.isCapturing && this.currentErosionModel instanceof HydraulicErosionModelDebug) {
                // In debug/capture mode, run one step at a time, respecting the addRain flag.
                // _runSingleErosionStep now correctly handles state swapping internally.
                for (let i = 0; i < iterations; i++) { // The stepParams are passed to each iteration
                    const { heights, waterHeights, erosionAmount, depositionAmount } = await this._runSingleErosionStep(stepParams);
                    this.totalErosionIterations++;
                    if (heights) {
                        this.view.updateTileMesh('0,0', heights, this.currentModel.lastGeneratedParams, waterHeights);
                        this.currentModel.lastGeneratedHeightmap = heights; // Keep CPU-side cache in sync
                        this.uiController.updateStats(erosionAmount, depositionAmount, this.totalErosionIterations, this.simulationCapture.frameCount);
                        // After each step, we must manually update uniforms and draw the scene.
                        this.view.updateGlobalParams(stepParams.seaLevel, this.viewMode);
                        this.view.drawScene(this.viewMode);
                    }
                }
                // After the debug loop, the final state is on the GPU. We need to read it back
                // to the CPU cache to ensure consistency with the standard erosion path.
                const { bytesPerRow, bufferSize } = getPaddedByteRange(this.currentModel.gridSize, this.currentModel.gridSize, 4);
                const stagingBuffer = this.device.createBuffer({ size: bufferSize, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
                const encoder = this.device.createCommandEncoder();
                encoder.copyTextureToBuffer({ texture: this.currentModel.heightmapTextureA }, { buffer: stagingBuffer, bytesPerRow }, { width: this.currentModel.gridSize, height: this.currentModel.gridSize });
                this.device.queue.submit([encoder.finish()]);
                await stagingBuffer.mapAsync(GPUMapMode.READ);
                const finalHeights = this.currentModel._unpadBuffer(stagingBuffer.getMappedRange(), this.currentModel.gridSize, this.currentModel.gridSize, bytesPerRow);
                if (finalHeights) {
                    this.currentModel.lastGeneratedHeightmap = finalHeights;
                }
            } else {
                // In batch mode, `runErosion` will receive the addRain flag from the toggle.
				const { heights, waterHeights, erosionAmount, depositionAmount } = await this.currentModel.runErosion(iterations, stepParams, this.currentErosionModel);
                this.totalErosionIterations += iterations;
                this.lastErosionAmount = erosionAmount + depositionAmount;
                if (heights) {
                    this.view.updateTileMesh('0,0', heights, this.currentModel.lastGeneratedParams, waterHeights);
                    this.uiController.updateStats(erosionAmount, depositionAmount, this.totalErosionIterations, this.simulationCapture.frameCount);
                    // If we are in a heatmap view, we must update the view's textures before drawing.
                    if (this.viewMode !== 'standard' && this.currentErosionModel instanceof HydraulicErosionModelDebug) {
                        this.view.updateFlowMapTextures(
                            this.currentErosionModel.waterTextureA,
                            this.currentErosionModel.velocityTextureA,
                            this.currentModel.heightmapTextureA,
                            this.currentErosionModel.sedimentTextureA
                        );
                    }
                    // Manually update global uniforms before drawing outside the main game loop.
                    this.view.updateGlobalParams(stepParams.seaLevel, this.viewMode);
                    this.view.drawScene(this.viewMode);
                }
            }
        } catch (e) {
            console.error("Error during erosion:", e);
        } finally {
            this.isEroding = false;
        }
    }

    /**
     * Sets the simulation's rain mode based on UI interaction.
     * This is a state setter, not an action. It does not trigger a simulation.
     * @param {string} mode - The new mode, either 'rain' or 'dry'.
     */
    setRainMode(mode) {
        this.rainActive = (mode === 'rain');
        // Update the UI to reflect the new state.
        this.uiController.updateErodeButtonState(this.rainActive);
        console.log(`Rain mode set to: ${this.rainActive}`);
    }

    toggleCapture() {
        this.simulationCapture.toggle();
        this.uiController.updateCaptureButtonState(this.simulationCapture.isCapturing);
    }

    saveCaptureData() {
        this.simulationCapture.save();
    }

    clearCaptureData() {
        if (this.simulationCapture.clear()) {
            this.uiController.updateStats(0, 0, this.totalErosionIterations, this.simulationCapture.frameCount);
            // When data is cleared, capturing stops. Update the button to reflect this.
            this.uiController.updateCaptureButtonState(this.simulationCapture.isCapturing);
            // Also send a clear message to the plot window.
            this.postMessageToPlotter('CLEAR');
        }
    }

    showPlotWindow() {
        if (this.plotWindow && !this.plotWindow.closed) {
            this.plotWindow.focus();
        } else {
            this.plotWindow = window.open('plot.html', 'SimulationPlot', 'width=800,height=600,resizable=yes,scrollbars=yes');
            // The 'PLOTTER_READY' message handler will take care of initialization.
        }
    }

    async _runSingleErosionStep(erosionParams) {
        let results;
        const isDebugStep = this.simulationCapture.isCapturing && this.currentErosionModel instanceof HydraulicErosionModelDebug;

        if (isDebugStep) {
            // --- DEBUG PATH ---
            // 1. Run the debug step. It reads from A, writes to B.
            results = await this.currentErosionModel.captureSingleStep(erosionParams, {
                read: this.currentModel.heightmapTextureA,
                write: this.currentModel.heightmapTextureB
            });

            // 2. The new terrain is in heightmapTextureB. Swap the model's textures so 'A' is now the source for the next step.
            this.currentModel.swapTerrainTextures();

            // 3. Update the view's flow map textures for potential heatmap rendering.
            // The new terrain is now in A, and the other flow maps were swapped inside captureSingleStep.
            this.view.updateFlowMapTextures(
                this.currentErosionModel.waterTextureA,
                this.currentErosionModel.velocityTextureA,
                this.currentModel.heightmapTextureA, // Pass the new, correct terrain texture
                this.currentErosionModel.sedimentTextureA
            );

            // 4. Add the detailed analysis data to our capture buffer.
            const newFrame = {
                frame: this.totalErosionIterations,
                data: results.capturedData
            };
            this.simulationCapture.addFrame(newFrame.frame, newFrame.data);

            // 5. Update the plot with the latest data
            if (this.simulationCapture.frameCount === 1) {
                // If this is the first frame, populate the dropdown
                this.uiController.populatePlotMetrics(this.simulationCapture.debugCaptureData);
            } else if (this.plotMetrics.length > 0) {
                // Send only the new frame for an efficient update.
                this.postMessageToPlotter('UPDATE', { newFrame });
            }
        } else {
            // --- STANDARD PATH ---
            // `runErosion` is self-contained. It runs 1 iteration and copies the result back to heightmapTextureA.
            // No swap is needed.
            results = await this.currentModel.runErosion(1, erosionParams, this.currentErosionModel);
        }

        // Unify the return value by always calculating metrics from the resulting heightmap.
        const metrics = this.currentModel.calculateErosionMetrics(results.heights);
        return { ...results, ...metrics }; // Combine results with metrics and return
    }

    changePlotMetric(metrics) {
        this.plotMetrics = metrics;
        this.postMessageToPlotter('CHANGE_METRIC', {
            metrics: this.plotMetrics,
            captureData: this.simulationCapture.debugCaptureData
        });
    }

    postMessageToPlotter(type, payload) {
        if (this.plotWindow && !this.plotWindow.closed) {
            this.plotWindow.postMessage({ type, payload }, window.location.origin);
        }
    }

    _handlePlotterMessage(event) {
        if (event.origin !== window.location.origin) return;
        if (event.data.type === 'PLOTTER_READY') {
            console.log("Plotter window is ready. Initializing with current data.");
            // The plot window is ready, send it the current data to initialize it.
            // This handles cases where the main page is reloaded but the plot window remains open.
            this.postMessageToPlotter('INIT', {
                metrics: this.plotMetrics,
                captureData: this.simulationCapture.debugCaptureData
            });
        }
    }

    changeShaderStrategy(name) {
        this.currentModel = this.models[name];
        this.currentModel.shaderStrategy.resetNormalization();
        console.log(`Switched to ${name} strategy.`);
        this.wantsUpdate = true;
    }

    changeErosionModel(name) {
        this.currentErosionModel = this.erosionModels[name];
        console.log(`Switched to ${name} erosion model.`);
        // When switching models, we must reset the state to ensure a clean comparison.
        if (this.currentErosionModel.resetState) {
            this.currentErosionModel.resetState();
        }

        // When switching erosion models, always reset the view mode to standard.
        // This prevents trying to render a heatmap for a model that doesn't support it.
        this.viewMode = 'standard';
        const viewModeSelect = document.getElementById('debug-view-mode-select');
        if (viewModeSelect) {
            viewModeSelect.value = 'standard';
        }

        // Reset the terrain generation normalization state. This ensures that when the
        // terrain is regenerated, it's not using stale min/max values from a previous generation.
        this.currentModel.shaderStrategy.resetNormalization();

        // And trigger a terrain update to load the original heightmap again.
        this.wantsUpdate = true;
    }

    changeViewMode(name, seaLevel) {
        this.viewMode = name;

        // When switching to the heatmap, we must ensure the view has the latest textures
        // from the erosion model to create the necessary bind group.
        if (name !== 'standard' && this.currentErosionModel instanceof HydraulicErosionModelDebug) {
            this.view.updateFlowMapTextures(
                this.currentErosionModel.waterTextureA,
                this.currentErosionModel.velocityTextureA,
                this.currentModel.heightmapTextureA,
                this.currentErosionModel.sedimentTextureA
            );
        }

        // Immediately update the global params buffer with the new view mode before drawing.
        // This prevents a race condition where the draw call would execute with stale uniform data.
        this.view.updateGlobalParams(seaLevel, this.viewMode);

        this.view.drawScene(this.viewMode);
    }
}