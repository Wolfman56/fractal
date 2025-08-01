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
        this.debugCaptureData = [];
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
    save() {
        if (this.commandHistory.length === 0 && this.debugCaptureData.length === 0) {
            alert("No data to save.");
            return;
        }

        const baseFilename = this.config.baseFilename || 'sim_capture';
        const overwrite = this.config.overwriteSave || false;
        const filename = `${baseFilename}.json`;

        const data = {
            history: this.commandHistory,
            data: this.debugCaptureData,
        };
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
        console.log(`Capture data saved to ${filename}`);
    }

    /**
     * Clears all captured data after user confirmation.
     * @returns {boolean} - True if data was cleared, false otherwise.
     */
    clear() {
        if (this.commandHistory.length === 0 && this.debugCaptureData.length === 0) {
            return false; // Nothing to clear
        }
        if (window.confirm("Are you sure you want to clear all captured data? This cannot be undone.")) {
            this.isCapturing = false;
            this.commandHistory = [];
            this.debugCaptureData = [];
            this.frameCount = 0;
            console.log("Capture data cleared.");
            return true;
        }
        return false;
    }

    recordCommand(command) { if (!this.isCapturing) return; this.commandHistory.push(command); }
    addFrame(frame, data) { if (!this.isCapturing) return; this.debugCaptureData.push({ frame, data }); this.frameCount = this.debugCaptureData.length; }
}