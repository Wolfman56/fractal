/**
 * Manages all DOM interactions, including event listeners for controls and updating UI elements.
 */
export default class UIController {
    /**
     * @param {object} callbacks - A map of action names to callback functions provided by the main controller.
     */
    constructor(callbacks, config) {
        this.callbacks = callbacks;
        this.config = config;
        this.regenTimeout = null;
    }

    setupEventListeners() {
        // Main action buttons
        document.getElementById('regenerate')?.addEventListener('click', this.callbacks.onRegenerate);
        document.getElementById('erode-terrain')?.addEventListener('click', this.callbacks.onErode);
        document.getElementById('reset-view')?.addEventListener('click', this.callbacks.onResetView);
        document.getElementById('snapshot-button')?.addEventListener('click', this.callbacks.onSnapshot);

        // Debug/Capture buttons
        document.getElementById('capture-toggle')?.addEventListener('click', this.callbacks.onToggleCapture);
        document.getElementById('save-capture')?.addEventListener('click', this.callbacks.onSaveCapture);
        document.getElementById('clear-capture')?.addEventListener('click', this.callbacks.onClearCapture);

        // Drawer
        document.getElementById('drawer-toggle')?.addEventListener('click', () => {
            document.getElementById('controls')?.classList.toggle('open');
        });

        // Selects
        document.getElementById('shader-strategy-select')?.addEventListener('change', e => this.callbacks.onStrategyChange(e.target.value));
        document.getElementById('erosion-model-select')?.addEventListener('change', e => {
            this.callbacks.onErosionModelChange(e.target.value);
            this.toggleDebugSection(e.target.value);
        });

        // Sliders that trigger regeneration
        const regenSliderIds = ['gridSize', 'octaves', 'persistence', 'lacunarity', 'cycles', 'seed', 'heightMultiplier', 'hurst'];
        regenSliderIds.forEach(id => {
            const slider = document.getElementById(id);
            if (slider) {
                slider.addEventListener('input', () => {
                    this.updateSliderValue(id, slider.value);
                    if (this.regenTimeout) clearTimeout(this.regenTimeout);
                    this.regenTimeout = setTimeout(() => {
                        console.log(`UI parameter '${id}' changed, queueing terrain update...`);
                        this.callbacks.onParamsChanged();
                    }, 500);
                });
            }
        });

        // Sliders that do not trigger regeneration
        ['erosion-iterations', 'erosion-wetness', 'erosion-solubility', 'erosion-deposition', 'erosion-capacity', 'erosion-sea-level'].forEach(id => {
            const slider = document.getElementById(id);
            if (slider) {
                slider.addEventListener('input', () => {
                    this.updateSliderValue(id, slider.value);
                    // The sea-level slider is special: it only triggers a redraw, not a full terrain regeneration.
                    // This is because the render shader uses the seaLevel uniform to color the terrain.
                    if (id === 'erosion-sea-level' && this.callbacks.onRedrawScene) {
                        this.callbacks.onRedrawScene();
                    }
                });
            }
        });

        // Apply initial state from config and set up initial UI state
        this.applyConfig();
    }

    /**
     * Sets the initial state of all UI controls based on the loaded configuration.
     */
    applyConfig() {
        if (!this.config) return;

        // Set generation slider values
        for (const [key, value] of Object.entries(this.config.generation)) {
            const sliderId = key === 'gridSizeExp' ? 'gridSize' : key;
            const slider = document.getElementById(sliderId);
            if (slider) {
                slider.value = value;
                this.updateSliderValue(sliderId, value);
            }
        }

        // Set erosion slider values
        for (const [key, value] of Object.entries(this.config.erosion)) {
            if (key === 'model') continue; // Skip the model name, it's for the dropdown
            // Convert camelCase config key (e.g., "seaLevel") to kebab-case for the HTML ID ("sea-level").
            const kebabCaseKey = key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
            const sliderId = `erosion-${kebabCaseKey}`;
            const slider = document.getElementById(sliderId);
            if (slider) {
                slider.value = value;
                this.updateSliderValue(sliderId, value);
            }
        }

        // Set UI checkbox
        const confirmCheckbox = document.getElementById('confirm-overwrite');
        if (confirmCheckbox) {
            confirmCheckbox.checked = this.config.ui.confirmOverwrite;
        }

        // Set initial state for debug section visibility based on the configured erosion model
        this.toggleDebugSection(this.config.erosion.model);
    }

    populateDropdown(id, options, selectedValue) {
        const select = document.getElementById(id);
        if (!select) return;

        // Clear existing options to prevent duplicates on hot-reloads or re-initialization.
        select.innerHTML = '';

        // The 'options' can be an array of strings or a Map of [value, displayText].
        const optionsSource = (options instanceof Map) ? options.entries() : options.map(o => [o, o]);

        for (const [value, text] of optionsSource) {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = text;
            if (value === selectedValue) {
                option.selected = true;
            }
            select.appendChild(option);
        }
    }

    updateSliderValue(id, value) {
        const valueSpan = document.getElementById(`${id}-value`);
        if (!valueSpan) return;
        if (id === 'gridSize') {
            valueSpan.textContent = `${Math.pow(2, value)} (2^${value})`;
        } else {
            valueSpan.textContent = value;
        }
    }

    toggleDebugSection(selectedModel) {
        const debugSection = document.getElementById('debug-section');
        if (debugSection) {
            debugSection.style.display = selectedModel === 'hydraulic-debug' ? '' : 'none';
        }
    }

    toggleButton(id, isToggled) {
        document.getElementById(id)?.classList.toggle('toggled-on', isToggled);
    }

    updateStats(erosion, deposition, iterations, capturedFrames) {
        const erosionEl = document.getElementById('stat-erosion');
        const depositionEl = document.getElementById('stat-deposition');
        const iterationsEl = document.getElementById('stat-iterations');
        const captureEl = document.getElementById('stat-capture');

        if (erosionEl) erosionEl.textContent = (erosion * 1000).toFixed(2);
        if (depositionEl) depositionEl.textContent = (deposition * 1000).toFixed(2);
        if (iterationsEl) iterationsEl.textContent = iterations;
        if (captureEl) captureEl.textContent = capturedFrames;
    }
}