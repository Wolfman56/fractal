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

            this.view.drawScene();
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

        this.isEroding = true;
        this.wantsUpdate = false;

        try {
            if (this.simulationCapture.isCapturing && this.currentErosionModel instanceof HydraulicErosionModelDebug) {
                for (let i = 0; i < iterations; i++) {
                    const { heights, waterHeights, erosionAmount, depositionAmount } = await this._runSingleErosionStep(erosionParams);
                    this.currentModel.swapTerrainTextures();
                    this.totalErosionIterations++;
                    if (heights) {
                        this.view.updateTileMesh('0,0', heights, this.currentModel.lastGeneratedParams, waterHeights);
                        this.uiController.updateStats(erosionAmount, depositionAmount, this.totalErosionIterations, this.simulationCapture.frameCount);
                        this.view.drawScene();
                    }
                }
            } else {
                const { heights, waterHeights, erosionAmount, depositionAmount } = await this.currentModel.runErosion(iterations, erosionParams, this.currentErosionModel);
                this.totalErosionIterations += iterations;
                this.lastErosionAmount = erosionAmount + depositionAmount;
                if (heights) {
                    this.view.updateTileMesh('0,0', heights, this.currentModel.lastGeneratedParams, waterHeights);
                    this.uiController.updateStats(erosionAmount, depositionAmount, this.totalErosionIterations, this.simulationCapture.frameCount);
                    this.view.drawScene();
                }
            }
        } catch (e) {
            console.error("Error during erosion:", e);
        } finally {
            this.isEroding = false;
        }
    }

    toggleCapture() {
        this.simulationCapture.toggle();
    }

    saveCaptureData() {
        this.simulationCapture.save();
    }

    clearCaptureData() {
        if (this.simulationCapture.clear()) {
            this.uiController.updateStats(0, 0, this.totalErosionIterations, this.simulationCapture.frameCount);
        }
    }

    async _runSingleErosionStep(erosionParams) {
        let results;
        if (this.simulationCapture.isCapturing && this.currentErosionModel instanceof HydraulicErosionModelDebug) {
            // If capturing, run the debug step which returns more data.
            results = await this.currentErosionModel.captureSingleStep(erosionParams, {
                read: this.currentModel.heightmapTextureA,
                write: this.currentModel.heightmapTextureB
            });
            this.simulationCapture.addFrame(this.totalErosionIterations, results.capturedData);
        } else {
            // If not capturing, or not using the debug model, run a normal single iteration.
            results = await this.currentModel.runErosion(1, erosionParams, this.currentErosionModel);
        }

        const metrics = this.currentModel.calculateErosionMetrics(results.heights);
        return results;
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

        // Reset the terrain generation normalization state. This ensures that when the
        // terrain is regenerated, it's not using stale min/max values from a previous generation.
        this.currentModel.shaderStrategy.resetNormalization();

        // And trigger a terrain update to load the original heightmap again.
        this.wantsUpdate = true;
    }
}