import View from './view.js';
import UIController from './ui_controller.js';
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
    }

    async init() {
        const response = await fetch('/config.json');
        if (!response.ok) {
            console.error("Failed to load config.json. Application cannot start.");
            alert("Error: Could not load configuration file.");
            return;
        }
        const config = await response.json();

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
                    this.inputHandler.worldOffset = { ...(config.generation.worldOffset || { x: 0, y: 0 }) };
                }
                this.view.camera.reset();
                this.simulationController.currentModel.shaderStrategy.resetNormalization();
                this.simulationController.wantsUpdate = true;
            },
            onErode: () => this.simulationController.erodeTerrain(this._getErosionParamsFromUI(), parseInt(document.getElementById('erosion-iterations')?.value || '10', 10)),
            onRainModeChange: (mode) => this.simulationController.setRainMode(mode),
            onResetView: () => {
                // Resetting the view should return both the camera and the terrain's pan
                // position to their default states, then trigger a regeneration.
                if (this.inputHandler) {
                    this.inputHandler.worldOffset = { ...(config.generation.worldOffset || { x: 0, y: 0 }) };
                }
                this.view.camera.reset();
                this.simulationController.wantsUpdate = true;
            },
            onRedrawScene: () => this.view.drawScene(this.simulationController.viewMode),
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
            seaLevel: parseFloat(document.getElementById('erosion-sea-level')?.value || '0.15'),
        };
    }

    _getErosionParamsFromUI() {
        const wetness = parseFloat(document.getElementById('erosion-wetness')?.value || '0.2');

        // Map the single "Wetness" value to the two underlying simulation parameters.
        // This gives the user an intuitive single control while ensuring the simulation remains stable.
        const rainAmount = 0.001 + wetness * 0.05; // Map wetness [0.01, 1.0] to rain [~0.001, 0.05]
        const evapRate = 0.8 - wetness * 0.75;   // Map wetness [0.01, 1.0] to evap [~0.8, 0.05]

        return {
            wetness: wetness, // The raw UI slider value
            rainAmount: rainAmount,
            evapRate: evapRate,
            solubility: parseFloat(document.getElementById('erosion-solubility')?.value || '0.5'),
            depositionRate: parseFloat(document.getElementById('erosion-deposition')?.value || '0.3'),
            capacityFactor: parseFloat(document.getElementById('erosion-capacity')?.value || '20'),
            seaLevel: parseFloat(document.getElementById('erosion-sea-level')?.value || '0.15'),
            // The erosion simulation needs to know the terrain's vertical scale to work correctly.
            heightMultiplier: parseFloat(document.getElementById('heightMultiplier').value),
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

        // Update global shader uniforms, like sea level, before any drawing occurs.
        this.view.updateGlobalParams(params.seaLevel, this.simulationController.viewMode);

        const wantsUpdate = this.simulationController.wantsUpdate;
        this.simulationController.wantsUpdate = false; // Consume the request

        this.simulationController.tick(wantsUpdate, params);
    }
}

const app = new Controller();
app.init();