import { UntiledHeightmapModel } from './models.js';
import { HydraulicErosionModel, HydraulicErosionModelDebug, SimpleErosionModel } from './erosion_models.js';
import { ScrollingShaderStrategy, FractalZoomShaderStrategy, ScrollAndZoomStrategy, PyramidShaderStrategy, BowlShaderStrategy, PlaneShaderStrategy } from './shader_strategies.js';
import SimulationCapture from './simulation_capture.js'; // Now a formal module
import { getPaddedByteRange } from './utils.js';

/**
 * Manages the core simulation state and logic, including terrain generation and erosion.
 */
export default class SimulationController {
    constructor(device, view, uiController, config) {
        this.device = device;
        this.view = view;
        this.uiController = uiController;
        this.simulationCapture = new SimulationCapture(this.uiController, config.capture);

        this.config = config;
        // Simulation State
        this.isUpdating = false;
        this.wantsUpdate = false;
        this.isEroding = false;
        this.dataIsReady = false;

        // Models & Strategies
        this.shaderStrategies = {
            'Scrolling': new ScrollingShaderStrategy(),
            'FractalZoom': new FractalZoomShaderStrategy(),
            'Scroll & Zoom': new ScrollAndZoomStrategy(),
            'Pyramid': new PyramidShaderStrategy(),
            'Bowl': new BowlShaderStrategy(),
            'Plane': new PlaneShaderStrategy(),
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
        this.captureDirectory = null;

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
            this.updateTerrain(params);
        }
    }

    async updateTerrain(params) {
        if (this.isUpdating) {
            this.wantsUpdate = true;
            return;
        }
        this.isUpdating = true;
        this.wantsUpdate = false; // Consume the request now that we are starting.
        this.dataIsReady = false; // Reset the flag at the start of an update.

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

            this.dataIsReady = true; // Signal that the data is ready for the main loop to consume.
        } catch (e) {
            console.error("Error during terrain update:", e);
        } finally {
            this.isUpdating = false;
        }
    }

    _getErosionParamsFromUI() {
        const wetness = parseFloat(document.getElementById('erosion-wetness')?.value || '0.2');
        const gridSize = Math.pow(2, parseInt(document.getElementById('gridSize').value, 10));
        const { metersPerSide, dt } = this.config.world;
        const heightMultiplier = parseFloat(document.getElementById('heightMultiplier')?.value || '100.0');

        // The UI 'wetness' slider [0.01, 1.0] now directly controls the amount of rain
        // added per step, scaled to a more effective range (e.g., 0.1mm to 10mm).
        const rainAmount_per_step = wetness * 0.001;

        // The evaporation rate is also derived from wetness. We treat it as a fraction per second.
        // The shader will multiply it by dt. A wetness of 1.0 means 0 evaporation.
        const evapRate_per_s = 0.05 * (1.0 - wetness);

        return {
            // --- UI Parameters ---
            wetness: wetness,
            solubility: parseFloat(document.getElementById('erosion-solubility')?.value || '0.5'),
            depositionRate: parseFloat(document.getElementById('erosion-deposition')?.value || '0.3'),
            capacityFactor: parseFloat(document.getElementById('erosion-capacity')?.value || '0.1'),
            density: parseFloat(document.getElementById('erosion-density')?.value || '9.8'),
            seaLevel: parseFloat(document.getElementById('erosion-sea-level')?.value || '0.15'),
            gridSize: gridSize,

            // --- Derived & World Parameters ---
            rainAmount: rainAmount_per_step,
            evapRate: evapRate_per_s,
            dt: dt,
            cellSize: metersPerSide / gridSize,
            heightMultiplier: heightMultiplier,
            minSlope: 0.01,
            velocityDamping: 0.99,
        };
    }

    async erodeTerrain() {
        if (this.isEroding) return;
        if (!this.currentModel.lastGeneratedHeightmap) return;

        const iterations = parseInt(document.getElementById('erosion-iterations')?.value || '10', 10);
        const erosionParams = this._getErosionParamsFromUI();

        this.isEroding = true;
        this.wantsUpdate = false;

        const stepParams = { ...erosionParams, addRain: this.rainActive };

        try {
            const isDebugMode = this.simulationCapture.isCapturing && this.currentErosionModel instanceof HydraulicErosionModelDebug;

            if (isDebugMode) {
                // In debug/capture mode, run one step at a time to update the view and capture data.
                // We record a command for each individual step to ensure the history is replayable.
                this.simulationCapture.recordCommand({
                    step: this.totalErosionIterations,
                    rain: this.rainActive,
                    iterations: iterations, // Log the total requested iterations for context
                    params: erosionParams
                });
                for (let i = 0; i < iterations; i++) {
                    const { heights, waterHeights, erosionAmount, depositionAmount } = await this._runSingleDebugStep(stepParams);
                    this.totalErosionIterations++;
                    if (heights) {
                        this.view.updateTileMesh('0,0', heights, this.currentModel.lastGeneratedParams, waterHeights);
                        this.currentModel.lastGeneratedHeightmap = heights;
                        this.uiController.updateStats(erosionAmount, depositionAmount, this.totalErosionIterations, this.simulationCapture.frameCount);
                        this.view.updateGlobalParams(stepParams.seaLevel, this.viewMode);
                        this.view.drawScene(this.viewMode);
                    }
                }
            } else {
                // In standard mode, run all iterations in a single batch for performance.
                // Record one command for the entire batch.
                this.simulationCapture.recordCommand({
                    step: this.totalErosionIterations,
                    rain: this.rainActive,
                    iterations: iterations,
                    params: erosionParams
                });
				const { heights, waterHeights, erosionAmount, depositionAmount } = await this.currentModel.runErosion(iterations, stepParams, this.currentErosionModel);
                this.totalErosionIterations += iterations;
                this.lastErosionAmount = erosionAmount + depositionAmount;
                if (heights) {
                    this.view.updateTileMesh('0,0', heights, this.currentModel.lastGeneratedParams, waterHeights);
                    this.uiController.updateStats(erosionAmount, depositionAmount, this.totalErosionIterations, this.simulationCapture.frameCount);
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

    async saveCaptureData() {
        // Find the key/name of the current erosion model to append to the filename.
        const modelKey = Object.keys(this.erosionModels).find(key => this.erosionModels[key] === this.currentErosionModel);

        // Temporarily modify the base filename in the config before saving.
        // This allows us to change the output filename without altering the SimulationCapture class signature.
        const originalFilename = this.simulationCapture.config.baseFilename;
        if (modelKey) {
            this.simulationCapture.config.baseFilename = `${originalFilename}_${modelKey}`;
        }

        // Pass the parameters used to generate the current terrain to the save function.
        const generationParams = this.currentModel.lastGeneratedParams;
        await this.simulationCapture.save(generationParams);
        this.simulationCapture.config.baseFilename = originalFilename; // Restore for subsequent saves

        // Provide visual feedback to the user that the save is complete.
        this.uiController.showSaveConfirmation();
    }

    async setCaptureDirectory(directory) {
        if (!directory) {
            this.captureDirectory = null;
            this.simulationCapture.config.outputDirectoryPath = 'downloads';
            console.log('Capture directory reset to default (downloads).');
        }
        else {
            this.captureDirectory = directory;
            this.simulationCapture.config.outputDirectoryPath = directory;
            console.log('Capture directory set programmatically.');
        }
        this.uiController.updateCaptureDirectoryDisplay(directory);

        //save capture directory to local storage here
        //localStorage.setItem('savedDirectory', directory);
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

    /**
     * Runs a single step of the erosion simulation in debug mode, capturing detailed metrics.
     * @param {object} erosionParams - The parameters for the erosion step.
     * @returns {Promise<object>} A promise that resolves with the final heights, water heights, and metrics.
     */
    async _runSingleDebugStep(erosionParams) {
        // 1. Execute the GPU commands for one erosion step and capture the raw data.
        const captureResults = await this._executeAndCaptureDebugStep(erosionParams);

        // 2. Read back the final terrain and water state from the GPU. This must be done
        //    before we swap the textures for the next iteration.
        const { heights, waterHeights } = await this.currentModel.readbackFinalErosionState(this.currentErosionModel);

        // 3. Process the captured data, update the plot, and log it.
        this._processAndLogCapture(captureResults.capturedData);

        // 4. Swap the primary terrain textures to prepare for the next step.
        this.currentModel.swapTerrainTextures();

        // 5. Update the view with the new textures for heatmap rendering.
        this._updateViewWithNewState();

        // 6. Calculate and return the final metrics for this step.
        const metrics = this.currentModel.calculateErosionMetrics(heights);
        return { heights, waterHeights, ...metrics };
    }

    async _executeAndCaptureDebugStep(erosionParams) {
        return await this.currentErosionModel.captureSingleStep(erosionParams, {
            read: this.currentModel.heightmapTextureA,
            write: this.currentModel.heightmapTextureB
        });
    }

    _processAndLogCapture(capturedData) {
        const frameIndex = this.totalErosionIterations;
        this.simulationCapture.addFrame(frameIndex, capturedData);
        this.uiController.populatePlotMetrics(this.simulationCapture.debugCaptureData); // Repopulate on first frame
        this.postMessageToPlotter('UPDATE', { newFrame: { frame: frameIndex, data: capturedData } });
    }

    _updateViewWithNewState() {
        // The textures have been swapped, so 'A' now points to the latest data.
        // This must be done AFTER the swap so the view gets the correct textures for heatmap rendering.
        this.view.updateFlowMapTextures(
            this.currentErosionModel.waterTextureA,
            this.currentErosionModel.velocityTextureA,
            this.currentModel.heightmapTextureA, // This is now the new terrain
            this.currentErosionModel.sedimentTextureA
        );
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