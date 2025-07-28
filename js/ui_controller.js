/**
 * Manages all DOM interactions, including event listeners for controls and updating UI elements.
 */
export default class UIController {
    /**
     * @param {object} callbacks - A map of action names to callback functions provided by the main controller.
     */
    constructor(callbacks) {
        this.callbacks = callbacks;
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
        document.getElementById('erosion-model-select')?.addEventListener('change', e => this.callbacks.onErosionModelChange(e.target.value));

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
                slider.addEventListener('input', () => this.updateSliderValue(id, slider.value));
            }
        });
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

    toggleButton(id, isToggled) {
        document.getElementById(id)?.classList.toggle('toggled-on', isToggled);
    }

    updateStats(erosion, deposition, iterations, capturedFrames) {
        const metricsContainer = document.getElementById('erosion-metrics');
        if (metricsContainer) {
            const e = (erosion * 1000).toFixed(2);
            const d = (deposition * 1000).toFixed(2);
            metricsContainer.innerHTML = `Eroded: ${e} | Deposited: ${d} (Iter: ${iterations})`;
        }
        const captureContainer = document.getElementById('capture-status');
        if (captureContainer) {
            captureContainer.innerHTML = `Frames Captured: ${capturedFrames}`;
        }
    }
}