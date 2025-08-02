/**
 * Manages the capture, storage, and saving of simulation data for debugging and analysis.
 */
export default class SimulationCapture {
    /**
     * @param {UIController} uiController - A reference to the UI controller for updating stats.
     * @param {object} config - The capture-specific configuration from config.json.
     */
    constructor(uiController, config = {}) {
        this.uiController = uiController;
        this.config = config;
        this.isCapturing = false;
        this.commandHistory = [];
        this.debugCaptureData = {};
        this.frameCount = 0;
    }

    /**
     * Toggles the data capture state.
     */
    toggle() {
        this.isCapturing = !this.isCapturing;
        console.log(`Data capture ${this.isCapturing ? 'enabled' : 'disabled'}.`);
    }

    /**
     * Saves the captured command history and frame-by-frame data to a JSON file.
     * The filename is determined by the configuration settings.
     */
    async save(generationParams = null) {
        if (this.commandHistory.length === 0 && this.debugCaptureData.length === 0) {
            alert("No data to save.");
            return;
        }

        const baseFilename = this.config.baseFilename || 'sim_capture';
        const filename = `${baseFilename}.json`;

        const data = {
            generationParams: generationParams,
            history: this.commandHistory,
            data: this.debugCaptureData,
        };

        const dirHandle = this.config.outputDirectoryPath;

        if (dirHandle && typeof dirHandle !== 'string') {
            // We have a directory handle, use the new File System Access API
            try {
                const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
                const writable = await fileHandle.createWritable();
                await writable.write(JSON.stringify(data, null, 2));
                await writable.close();
                console.log(`Capture data saved to ${filename} in the selected directory.`);
            } catch (e) {
                console.error("Error saving capture data with File System Access API:", e);
                alert("Could not save file to the selected directory. See console for details.");
            }
        } else {
            // Fallback to the old download method
            const jsonString = JSON.stringify(data, null, 2);
            const blob = new Blob([jsonString], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = filename;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
            console.log(`Capture data saved to default downloads folder: ${filename}`);
        }
    }

    /**
     * Clears all captured data after user confirmation.
     * @returns {boolean} - True if data was cleared, false otherwise.
     */
    clear() {
        if (this.commandHistory.length === 0 && Object.keys(this.debugCaptureData).length === 0) {
            return false; // Nothing to clear
        }
        if (window.confirm("Are you sure you want to clear all captured data? This cannot be undone.")) {
            this.isCapturing = false;
            this.commandHistory = [];
            this.debugCaptureData = {};
            this.frameCount = 0;
            console.log("Capture data cleared.");
            return true;
        }
        return false;
    }

    recordCommand(command) { if (!this.isCapturing) return; this.commandHistory.push(command); }
    addFrame(frame, data) {
        if (!this.isCapturing) return;

        for (const passKey in data) { // e.g., 'pass1_water'
            for (const metricKey in data[passKey]) { // e.g., 'sum', 'avg'
                const fullMetricKey = `${passKey}.${metricKey}`;
                if (!this.debugCaptureData[fullMetricKey]) {
                    this.debugCaptureData[fullMetricKey] = [];
                }
                this.debugCaptureData[fullMetricKey].push(data[passKey][metricKey]);
            }
        }
        this.frameCount++;
    }
}