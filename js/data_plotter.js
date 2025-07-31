/**
 * Manages the real-time plotting of simulation data using Plotly.js.
 */
export default class DataPlotter {
    constructor(containerId) {
        this.containerId = containerId;
        this.plotElement = document.getElementById(containerId);
        this.currentMetrics = [];
        this.isInitialized = false;
        this.phaseColors = {
            'pass1_': '#569cd6', // Blue
            'pass2_': '#4ec9b0', // Teal
            'pass3_': '#ce9178', // Orange
            'pass4_': '#c586c0', // Purple
            'pass5_': '#9cdcfe', // Light Blue
        };
    }

    /**
     * Initializes the Plotly chart with a given metric and data.
     * @param {Array<string>} metrics - The keys for the data to plot (e.g., ['pass1_water.sum']).
     * @param {Array<object>} captureData - The full array of captured simulation data.
     */
    initialize(metrics, captureData) {
        if (!this.plotElement) {
            console.error(`Plot container with ID '${this.containerId}' not found.`);
            return;
        }
        this.isInitialized = true;
        // Defer to changeMetric to handle the actual plot creation.
        this.changeMetric(metrics, captureData);
    }

    /**
     * Updates the plot with new data for the currently selected metric.
     * This is an efficient update that only appends the new data point.
     * @param {object} newFrame - The new data frame object { frame: number, data: object }.
     */
    update(newFrame) {
        if (!this.isInitialized || !this.currentMetrics || this.currentMetrics.length === 0 || !newFrame) return;

        const x_update = [];
        const y_update = [];
        const trace_indices = [];

        this.currentMetrics.forEach((metric, i) => {
            const [pass, property] = metric.split('.');
            if (newFrame.data && newFrame.data[pass] && newFrame.data[pass][property] !== undefined) {
                x_update.push([newFrame.frame]);
                y_update.push([parseFloat(newFrame.data[pass][property])]);
                trace_indices.push(i);
            }
        });

        if (trace_indices.length > 0) {
            Plotly.extendTraces(this.containerId, { x: x_update, y: y_update }, trace_indices);
        }
    }

    /**
     * Changes the metric being plotted and redraws the chart.
     * @param {Array<string>} newMetrics - The new array of metric keys.
     * @param {Array<object>} captureData - The full array of captured simulation data.
     */
    changeMetric(newMetrics, captureData) {
        this.currentMetrics = newMetrics || [];

        if (!this.isInitialized) return;

        if (this.currentMetrics.length === 0) {
            this.clear();
            return;
        }

        const traces = [];
        const layout = this._buildLayout(this.currentMetrics);

        this.currentMetrics.forEach((metric, i) => {
            const color = this._getPhaseColor(metric);
            const { x, y, name } = this._extractTrace(metric, captureData);
            traces.push({
                x,
                y,
                name,
                yaxis: i === 0 ? 'y' : `y${i + 1}`,
                xaxis: 'x1',
                type: 'scatter',
                mode: 'lines+markers',
                line: { color: color }
            });
        });

        // Use react to redraw everything, including layout and data.
        Plotly.react(this.containerId, traces, layout, {
            responsive: true,
            displaylogo: false
        });
    }

    /**
     * Clears all data from the plot, showing an empty chart.
     */
    clear() {
        if (!this.isInitialized) return;
        Plotly.react(this.containerId, [], {
            title: 'No metrics selected or no data captured.',
            paper_bgcolor: '#2a2a2a',
            plot_bgcolor: '#1a1a1a',
            font: { color: '#e0e0e0' }
        });
    }

    _buildLayout(metrics) {
        const layout = {
            title: 'Simulation Data Over Time',
            // Use 'coupled' pattern to share the X-axis across all vertical subplots.
            // This is the correct way to create stacked, synchronized time-series charts.
            grid: { rows: metrics.length, columns: 1, pattern: 'coupled', roworder: 'top to bottom' },
            showlegend: false,
            margin: { l: 60, r: 20, b: 40, t: 40, pad: 5 },
            paper_bgcolor: '#2a2a2a',
            plot_bgcolor: '#1a1a1a',
            font: { color: '#e0e0e0' },
            xaxis: { title: 'Simulation Step' } // Define properties for the shared x-axis.
        };

        metrics.forEach((metric, i) => {
            const yAxisName = i === 0 ? 'yaxis' : `yaxis${i + 1}`;
            const color = this._getPhaseColor(metric);
            layout[yAxisName] = { title: { text: metric, font: { size: 10, color: color } }, autorange: true };
        });

        return layout;
    }

    _getPhaseColor(metricKey) {
        for (const prefix in this.phaseColors) {
            if (metricKey.startsWith(prefix)) {
                return this.phaseColors[prefix];
            }
        }
        return '#e0e0e0'; // Default color
    }

    _extractTrace(metric, captureData) {
        const x = [];
        const y = [];
        const [pass, property] = metric.split('.');

        if (captureData) {
            for (const frame of captureData) {
                if (frame.data && frame.data[pass] && frame.data[pass][property] !== undefined) {
                    x.push(frame.frame);
                    y.push(parseFloat(frame.data[pass][property]));
                }
            }
        }
        return { x, y, name: metric };
    }
}