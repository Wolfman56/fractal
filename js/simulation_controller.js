import { TiledLODModel, UntiledHeightmapModel } from './models.js';
import { HydraulicErosionModel, HydraulicErosionModelDebug, SimpleErosionModel } from './erosion_models.js';
import { ScrollingShaderStrategy, FractalZoomShaderStrategy, ScrollAndZoomStrategy, TiledLODShaderStrategy } from './shader_strategies.js';
import SimulationCapture from './simulation_capture.js';

/**
 * Manages the core simulation state and logic, including terrain generation and erosion.
 */
export default class SimulationController {
    constructor(device, view, uiController) {
        this.device = device;
        this.view = view;
        this.uiController = uiController;
        this.simulationCapture = new SimulationCapture(this.uiController);

        // Simulation State
        this.isUpdating = false;
        this.wantsUpdate = false;
        this.isEroding = false;

        // Models & Strategies
        this.shaderStrategies = {
            'Scrolling': new ScrollingShaderStrategy(),
            'FractalZoom': new FractalZoomShaderStrategy(),
            'Scroll & Zoom': new ScrollAndZoomStrategy(),
            'Tiled LOD': new TiledLODShaderStrategy(),
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
        this.currentErosionModel = this.erosionModels['hydraulic'];

        for (const strategy of Object.values(this.shaderStrategies)) {
            await strategy.createPipelines(this.device, computePipelineLayout);
        }

        this.models = {
            'Scrolling': new UntiledHeightmapModel(this.device, this.shaderStrategies['Scrolling']),
            'FractalZoom': new UntiledHeightmapModel(this.device, this.shaderStrategies['FractalZoom']),
            'Scroll & Zoom': new UntiledHeightmapModel(this.device, this.shaderStrategies['Scroll & Zoom']),
            'Tiled LOD': new TiledLODModel(this.device, this.shaderStrategies['Tiled LOD']),
        };

        // For the main page, default to Tiled LOD. For the test page, default to a strategy that supports erosion.
        const isTestPage = !document.getElementById('shader-strategy-select');
        if (isTestPage) {
            this.currentModel = this.models['Scroll & Zoom'];
            console.log("Test page detected. Defaulting to 'Scroll & Zoom' strategy.");
        } else {
            this.currentModel = this.models['Tiled LOD'];
        }
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
            if (this.currentModel.erosionFrameCounter > 0 && confirmOverwrite) {
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
                    erosionModel.recreateResources(params.gridSize, {
                        heightmapTextureA: this.currentModel.heightmapTextureA,
                        heightmapTextureB: this.currentModel.heightmapTextureB,
                    });
                }
            }

            const fundamentalParams = ['octaves', 'persistence', 'lacunarity', 'hurst', 'seed'];
            const hasChanged = !this.currentModel.lastGeneratedParams ||
                fundamentalParams.some(p => params[p] !== this.currentModel.lastGeneratedParams[p]);

            if (hasChanged) {
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

        if (this.currentErosionModel.resetState) {
            this.currentErosionModel.resetState();
        }

        this.isEroding = true;
        this.wantsUpdate = false;

        try {
            if (this.simulationCapture.isCapturing && this.currentErosionModel instanceof HydraulicErosionModelDebug) {
                for (let i = 0; i < iterations; i++) {
                    const { heights, erosionAmount, depositionAmount } = await this._runSingleErosionStep(erosionParams);
                    this.currentModel.swapTerrainTextures();
                    this.totalErosionIterations++;
                    if (heights) {
                        this.view.updateTileMesh('0,0', heights, this.currentModel.lastGeneratedParams);
                        this.uiController.updateStats(erosionAmount, depositionAmount, this.totalErosionIterations, this.simulationCapture.frameCount);
                        this.view.drawScene();
                    }
                }
            } else {
                const { heights, erosionAmount, depositionAmount } = await this.currentModel.runErosion(iterations, erosionParams, this.currentErosionModel);
                this.totalErosionIterations += iterations;
                this.lastErosionAmount = erosionAmount + depositionAmount;
                if (heights) {
                    this.view.updateTileMesh('0,0', heights, this.currentModel.lastGeneratedParams);
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
        if (this.simulationCapture.isCapturing && this.currentErosionModel instanceof HydraulicErosionModel) {
            // If capturing, run the debug step which returns more data.
            const debugResults = await this.currentErosionModel.debugStep(erosionParams, {
                read: this.currentModel.heightmapTextureA,
                write: this.currentModel.heightmapTextureB
            });

            this.simulationCapture.addFrame(this.totalErosionIterations, debugResults.capturedData);

            // After any single step, we must "commit" the result back to the GPU texture that was written to.
            this.device.queue.writeTexture({ texture: this.currentModel.heightmapTextureB }, debugResults.heights, { bytesPerRow: this.currentModel.gridSize * 4 }, { width: this.currentModel.gridSize, height: this.currentModel.gridSize });

            // Manually calculate metrics from the returned heights.
            const metrics = this.currentModel.calculateErosionMetrics(debugResults.heights);
            return { ...metrics, heights: debugResults.heights };
        }

        // If not capturing, just run a normal single iteration.
        const results = await this.currentModel.runErosion(1, erosionParams, this.currentErosionModel);
        // The runErosion method already commits the data to the GPU, so we don't need to do it again here.
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
    }
}