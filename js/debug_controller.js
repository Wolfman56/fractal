import UIController from './ui_controller.js';

class DebugController {
    constructor() {
        this.uiController = null;
        this.captureDataA = {};
        this.captureDataB = {};
        this.filenameA = null;
        this.filenameB = null;
        this.plotMetrics = [];
    }

    init() {
        const uiCallbacks = {
            onDataButtonAClick: () => this.handleDataButtonClick('A'),
            onDataButtonBClick: () => this.handleDataButtonClick('B'),
            onPlotMetricChange: (metrics) => this.changePlotMetric(metrics),
            onShareData: () => this.sharePlotData(),
        };
        // The config is only used for initial slider values, which we don't have here.
        // Pass a minimal config object to avoid errors in the UIController.
        const minimalConfig = { ui: {}, generation: {}, erosion: {} };
        this.uiController = new UIController(uiCallbacks, minimalConfig);
        this.uiController.setupEventListeners();
        this._renderPlot(); // Initial render with placeholder
    }

    handleDataButtonClick(slot) {
        const data = (slot === 'A') ? this.captureDataA : this.captureDataB;
        if (Object.keys(data).length > 0) {
            this.clearCaptureData(slot);
        } else {
            this.loadCaptureData(slot);
        }
    }

    clearCaptureData(slot) {
        if (slot === 'A') {
            this.captureDataA = {};
            this.filenameA = null;
            document.getElementById('stat-capture-a').textContent = 0;
        } else {
            this.captureDataB = {};
            this.filenameB = null;
            document.getElementById('stat-capture-b').textContent = 0;
        }
        console.log(`Cleared data from slot ${slot}.`);
        this.uiController.toggleDataButtonState(slot, false);
        this._renderPlot();
    }

    loadCaptureData(targetSlot) {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = e => {
            const file = e.target.files[0];
            if (!file) return;
            const baseName = file.name.substring(0, file.name.lastIndexOf('.')) || file.name;

            const reader = new FileReader();
            reader.onload = (event) => {
                try {
                    const json = JSON.parse(event.target.result);
                    let data = json.data || null;

                    // Handle the format from the "Share Data" button, which uses 'plotData'.
                    // This makes loading shared files more convenient for debugging, as users
                    // might save the shared JSON and try to load it back.
                    if (!data && json.plotData) {
                        console.warn("Attempting to load a 'shared' data file. Only 'traceA' will be used if available.");
                        data = {};
                        for (const metricKey in json.plotData) {
                            // Prioritize traceA, but fall back to traceB if A isn't there.
                            const trace = json.plotData[metricKey]?.traceA || json.plotData[metricKey]?.traceB;
                            if (trace && Array.isArray(trace)) {
                                data[metricKey] = trace;
                            }
                        }
                    }
                    data = data || {}; // Ensure data is an object if it's still null.
                    const frameCount = Object.keys(data).length > 0 ? (data[Object.keys(data)[0]]?.length || 0) : 0;

                    if (targetSlot === 'A') {
                        this.captureDataA = data;
                        this.filenameA = baseName;
                        document.getElementById('stat-capture-a').textContent = frameCount;
                    } else {
                        this.captureDataB = data;
                        this.filenameB = baseName;
                        document.getElementById('stat-capture-b').textContent = frameCount;
                    }

                    console.log(`Loaded ${frameCount} frames of data into slot ${targetSlot}.`);
                    // Populate metrics based on the first available dataset.
                    const primaryData = Object.keys(this.captureDataA).length > 0 ? this.captureDataA : this.captureDataB;
                    this.uiController.populatePlotMetrics(primaryData);
                    this.uiController.toggleDataButtonState(targetSlot, true);
                    this._renderPlot(); // Render after state and UI are updated
                } catch (error) {
                    console.error("Error parsing JSON file:", error);
                    alert("Failed to load or parse the capture file.");
                }
            };
            reader.readAsText(file);
        };
        input.click();
    }

    changePlotMetric(metrics) {
        this.plotMetrics = metrics;
        this._renderPlot();
    }

    async sharePlotData() {
        if (this.plotMetrics.length === 0 || (Object.keys(this.captureDataA).length === 0 && Object.keys(this.captureDataB).length === 0)) {
            alert("No data to share. Please load data and select metrics first.");
            return;
        }

        const sharedDataObject = {
            metadata: {
                fileA: this.filenameA || 'N/A',
                fileB: this.filenameB || 'N/A',
                sharedAt: new Date().toISOString()
            },
            plotData: {}
        };

        const extractTraceForSharing = (metricKey, captureData) => {
            // The data is already in the compact format we want to share.
            return captureData[metricKey] || [];
        };

        for (const metricKey of this.plotMetrics) {
            sharedDataObject.plotData[metricKey] = {};
            if (Object.keys(this.captureDataA).length > 0) {
                sharedDataObject.plotData[metricKey].traceA = extractTraceForSharing(metricKey, this.captureDataA);
            }
            if (Object.keys(this.captureDataB).length > 0) {
                sharedDataObject.plotData[metricKey].traceB = extractTraceForSharing(metricKey, this.captureDataB);
            }
        }

        const jsonString = JSON.stringify(sharedDataObject, null, 2);

        try {
            await navigator.clipboard.writeText(jsonString);
            this.uiController.showShareConfirmation();
        } catch (err) {
            console.error('Failed to copy data to clipboard:', err);
            alert('Failed to copy data to clipboard. See console for details.');
        }
    }

    _renderPlot() {
        const plotContainer = document.getElementById('plot-container');
        if (!plotContainer) return;

        if (this.plotMetrics.length === 0 || (Object.keys(this.captureDataA).length === 0 && Object.keys(this.captureDataB).length === 0)) {
            plotContainer.innerHTML = `
                <div class="placeholder-container" style="display: flex; flex-direction: column; justify-content: center; align-items: center; height: 100%; text-align: center;">
                    <h1>Data Visualizer</h1>
                    <p>Load a capture file and select metrics to begin.</p>
                </div>`;
            return;
        }
        
        const traces = [];
        const phaseColors = {
            'pass1_': '#569cd6', 'pass2_': '#4ec9b0', 'pass3_': '#ce9178',
            'pass4_': '#c586c0', 'pass5_': '#9cdcfe', 'pass6_': '#d4d4d4',
        };

        const layout = {
            grid: { rows: this.plotMetrics.length, columns: 1, pattern: 'coupled' },
            plot_bgcolor: '#1a1a1a',
            paper_bgcolor: '#1a1a1a',
            font: { color: '#e0e0e0' },
            margin: { l: 80, r: 20, b: 50, t: 50, pad: 4 },
            showlegend: true,
            legend: {
                orientation: 'h',
                yanchor: 'bottom',
                y: 1.01,
                xanchor: 'right',
                x: 1
            },
            xaxis: {
                title: 'Simulation Step',
                gridcolor: '#444',
            }
        };

        const extractTrace = (metricKey, captureData) => {
            const y = captureData[metricKey] || [];
            const x = y.map((_, i) => i); // Infer X values from array index
            return { x, y };
        };

        this.plotMetrics.forEach((metricKey, index) => {
            const yAxisNum = index + 1;
            // Plotly's first axis is 'y', the second is 'y2', etc.
            const yAxisID = yAxisNum === 1 ? 'y' : `y${yAxisNum}`;
            const yAxisLayoutKey = yAxisNum === 1 ? 'yaxis' : `yaxis${yAxisNum}`;

            const [passKey, propKey] = metricKey.split('.');
            const color = this._getPhaseColor(passKey);

            if (Object.keys(this.captureDataA).length > 0) {
                const { x, y } = extractTrace(metricKey, this.captureDataA);
                const nameA = this.filenameA || 'Data A';
                traces.push({ x, y, type: 'scatter', mode: 'lines', name: nameA, legendgroup: 'A', showlegend: yAxisNum === 1, yaxis: yAxisID, line: { color: color } });
            }

            if (Object.keys(this.captureDataB).length > 0) {
                const { x, y } = extractTrace(metricKey, this.captureDataB);
                const colorB = this._modifyColor(color, 0.4); // Lighten color for better contrast on dark background
                const nameB = this.filenameB || 'Data B';
                traces.push({ x, y, type: 'scatter', mode: 'lines', name: nameB, legendgroup: 'B', showlegend: yAxisNum === 1, yaxis: yAxisID, line: { color: colorB, dash: 'dot' } });
            }

            layout[yAxisLayoutKey] = { title: { text: metricKey, font: { size: 12, color: color } }, gridcolor: '#444', zerolinecolor: '#666' };
        });

        Plotly.newPlot(plotContainer, traces, layout, { responsive: true });
    }

    _getPhaseColor(passKey) {
        const phaseColors = {
            'pass1_': '#569cd6', 'pass2_': '#4ec9b0', 'pass3_': '#ce9178',
            'pass4_': '#c586c0', 'pass5_': '#9cdcfe', 'pass6_': '#d4d4d4',
        };
        for (const prefix in phaseColors) {
            if (passKey.startsWith(prefix)) return phaseColors[prefix];
        }
        return '#e0e0e0';
    }

    _modifyColor(hex, percent) {
        const p = Math.max(-1, Math.min(1, percent));
        let r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
        const amount = Math.floor(255 * p);
        r = Math.max(0, Math.min(255, r + amount));
        g = Math.max(0, Math.min(255, g + amount));
        b = Math.max(0, Math.min(255, b + amount));
        const toHex = (c) => ('0' + c.toString(16)).slice(-2);
        return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
    }
}

const app = new DebugController();
app.init();