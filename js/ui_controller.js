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

        // Rain mode radio buttons
        document.querySelectorAll('input[name="rain-mode"]').forEach(radio => {
            radio.addEventListener('change', (e) => this.callbacks.onRainModeChange(e.target.value));
        });

        // Debug/Capture buttons
        document.getElementById('capture-toggle')?.addEventListener('click', this.callbacks.onToggleCapture);
        document.getElementById('load-capture-a')?.addEventListener('click', this.callbacks.onDataButtonAClick);
        document.getElementById('load-capture-b')?.addEventListener('click', this.callbacks.onDataButtonBClick);
        document.getElementById('save-capture')?.addEventListener('click', this.callbacks.onSaveCapture);
        document.getElementById('share-data')?.addEventListener('click', this.callbacks.onShareData);
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
        document.getElementById('debug-view-mode-select')?.addEventListener('change', e => this.callbacks.onViewModeChange(e.target.value));
        document.getElementById('plot-metric-toggles')?.addEventListener('change', e => {
            if (e.target.type === 'checkbox') {
                const checkedBoxes = document.querySelectorAll('#plot-metric-toggles input[type="checkbox"]:checked');
                const selectedMetrics = Array.from(checkedBoxes).map(cb => cb.value);
                this.callbacks.onPlotMetricChange(selectedMetrics);
            }
        });
        document.getElementById('show-plot-window')?.addEventListener('click', this.callbacks.onShowPlotWindow);

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

        ['erosion-iterations', 'erosion-wetness', 'erosion-solubility', 'erosion-deposition', 'erosion-capacity', 'erosion-density', 'erosion-sea-level', 'verticalExaggeration'].forEach(id => {
            const slider = document.getElementById(id);
            if (slider) {
                slider.addEventListener('input', () => {
                    this.updateSliderValue(id, slider.value);
                    // The main game loop polls these values, so no special callback is needed.
                });
            }
        });

        // Directory selector
        document.getElementById('capture-directory-select')?.addEventListener('click', async () => {
            try {
                const directoryHandle = await window.showDirectoryPicker();
                this.callbacks.onCaptureDirectorySelected(directoryHandle);
            } catch (err) {
                if (err.name !== 'AbortError') console.error("Error selecting directory:", err);
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

        // Set visual slider values
        if (this.config.visuals) {
            for (const [key, value] of Object.entries(this.config.visuals)) {
                const slider = document.getElementById(key);
                if (slider) {
                    slider.value = value;
                    this.updateSliderValue(key, value);
                }
            }
        }
        // Set UI checkbox
        const confirmCheckbox = document.getElementById('confirm-overwrite');
        if (confirmCheckbox) {
            confirmCheckbox.checked = this.config.ui.confirmOverwrite;
        }

        // Set initial rain mode state from config, defaulting to 'dry'
        const initialRainMode = this.config.erosion.rainMode || 'dry';
        const rainRadio = document.querySelector(`input[name="rain-mode"][value="${initialRainMode}"]`);
        if (rainRadio) {
            rainRadio.checked = true;
        }
        
        // Set the initial color of the Erode button to match the rain mode.
        this.updateErodeButtonState(initialRainMode === 'rain');
        this.updateCaptureDirectoryDisplay(null);

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
        const erosionModelSelect = document.getElementById('erosion-model-select');
        // This logic should only apply on the main page where the model can be changed.
        if (debugSection && erosionModelSelect) {
            debugSection.style.display = selectedModel === 'hydraulic-debug' ? '' : 'none';
        }
    }

    populatePlotMetrics(captureData) {
        const container = document.getElementById('plot-metric-toggles');
        if (!container) return;

        if (this.isPlotMetricContainerEmpty()) {
            // If the container is empty, clear any placeholder text before populating.
            container.innerHTML = '';

        }

        // Don't repopulate if it's already full of controls
        if (container.children.length > 0 && container.children[0].tagName !== 'P') return;

        if (!captureData || Object.keys(captureData).length === 0) {
            container.textContent = 'No data to plot.';
            return;
        }

        const phaseInfo = {
            'pass1_': { name: 'Pass 1: Water Increment', colorClass: 'phase-1-color', metrics: {} },
            'pass2_': { name: 'Pass 2: Flow Simulation', colorClass: 'phase-2-color', metrics: {} },
            'pass3_': { name: 'Pass 3: Erosion', colorClass: 'phase-3-color', metrics: {} },
            'pass4_': { name: 'Pass 4: Sediment Transport', colorClass: 'phase-4-color', metrics: {} },
            'pass5_': { name: 'Pass 5: Deposition', colorClass: 'phase-5-color', metrics: {} },
            'pass6_': { name: 'Pass 6: Evaporation', colorClass: 'phase-6-color', metrics: {} },
        };

        const allMetricKeys = Object.keys(captureData);
        for (const fullMetricKey of allMetricKeys) {
            const [passKey, propKey] = fullMetricKey.split('.');
            for (const phasePrefix in phaseInfo) {
                if (passKey.startsWith(phasePrefix)) {
                    if (!phaseInfo[phasePrefix].metrics[passKey]) {
                        phaseInfo[phasePrefix].metrics[passKey] = [];
                    }
                    // Avoid duplicates if somehow the key appears multiple times
                    if (!phaseInfo[phasePrefix].metrics[passKey].includes(propKey)) {
                        phaseInfo[phasePrefix].metrics[passKey].push(propKey);
                    }
                    break;
                }
            }
        }

        container.innerHTML = ''; // Clear
        for (const phasePrefix in phaseInfo) {
            const phase = phaseInfo[phasePrefix];
            if (Object.keys(phase.metrics).length === 0) continue;

            const groupEl = document.createElement('div');
            groupEl.className = 'metric-phase-group';
            const titleEl = document.createElement('h4');
            titleEl.textContent = phase.name;
            titleEl.className = phase.colorClass;
            groupEl.appendChild(titleEl);

            const sortedPassKeys = Object.keys(phase.metrics).sort();
            for (const passKey of sortedPassKeys) {
                // Create a sub-heading for the metric type (e.g., "water", "terrain")
                const typeName = passKey.replace(phasePrefix, '').replace(/_/g, ' ');
                const typeTitleEl = document.createElement('h5');
                typeTitleEl.textContent = typeName;
                groupEl.appendChild(typeTitleEl);

                const togglesWrapper = document.createElement('div');
                togglesWrapper.className = 'metric-toggles-wrapper';
                for (const propKey of phase.metrics[passKey].sort()) { // e.g., 'sum', 'avg'
                    const fullMetricKey = `${passKey}.${propKey}`;
                    const toggleEl = document.createElement('div');
                    toggleEl.className = 'metric-toggle';
                    const checkbox = document.createElement('input');
                    checkbox.type = 'checkbox';
                    checkbox.id = `metric-toggle-${fullMetricKey}`;
                    checkbox.value = fullMetricKey;
                    const label = document.createElement('label');
                    label.htmlFor = checkbox.id;
                    label.textContent = propKey;
                    toggleEl.appendChild(checkbox);
                    toggleEl.appendChild(label);
                    togglesWrapper.appendChild(toggleEl);
                }
                groupEl.appendChild(togglesWrapper);
            }
            container.appendChild(groupEl);
        }

        // By default, check the first available metric to show a plot immediately.
        const firstCheckbox = container.querySelector('input[type="checkbox"]');
        if (firstCheckbox) {
            firstCheckbox.checked = true;
            this.callbacks.onPlotMetricChange([firstCheckbox.value]);
        }
    }

    isPlotMetricContainerEmpty() {
        const container = document.getElementById('plot-metric-toggles');
        return !container || container.children.length === 0 || container.children[0].tagName === 'P';
    }

    /**
     * Updates the visual state (color) of the Erode button to match the current rain mode.
     * @param {boolean} isRaining - True if the current mode is 'rain', false otherwise.
     */
    updateErodeButtonState(isRaining) {
        const button = document.getElementById('erode-terrain');
        if (!button) return;

        if (isRaining) {
            button.classList.remove('state-dry');
            button.classList.add('state-rain');
        } else {
            button.classList.remove('state-rain');
            button.classList.add('state-dry');
        }
    }

    updateCaptureButtonState(isCapturing) {
        const button = document.getElementById('capture-toggle');
        if (!button) return;

        button.dataset.capturing = String(isCapturing);
        if (isCapturing) {
            button.textContent = 'Capturing Data';
        } else {
            button.textContent = 'Start Capture';
        }
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

    toggleDataButtonState(slot, hasData) {
        const button = document.getElementById(`load-capture-${slot.toLowerCase()}`);
        if (!button) return;

        if (hasData) {
            button.textContent = `Clear Data ${slot}`;
            button.classList.add('state-clear');
        } else {
            button.textContent = `Load Data ${slot}`;
            button.classList.remove('state-clear');
        }
    }

    showShareConfirmation() {
        const button = document.getElementById('share-data');
        if (!button) return;

        const originalText = button.textContent;
        button.textContent = 'Copied!';
        button.classList.add('state-copied');
        button.disabled = true;

        setTimeout(() => {
            button.textContent = originalText;
            button.classList.remove('state-copied');
            button.disabled = false;
        }, 2000);
    }

    showSaveConfirmation() {
        const button = document.getElementById('save-capture');
        if (!button) return;

        const originalText = button.textContent;
        button.textContent = 'Saved!';
        button.classList.add('state-copied'); // Re-use existing style for feedback
        button.disabled = true;

        setTimeout(() => {
            button.textContent = originalText;
            button.classList.remove('state-copied');
            button.disabled = false;
        }, 2000);
    }

    updateCaptureDirectoryDisplay(directoryHandle) {
        const pathEl = document.getElementById('capture-directory-path');
        if (pathEl) {
            if (directoryHandle && directoryHandle.name) {
                pathEl.textContent = `Current: ${directoryHandle.name}`;
            } else {
                pathEl.textContent = 'Current: Default Downloads';
            }
        }
    }
}