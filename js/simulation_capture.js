/**
 * Manages the lifecycle of capturing and saving simulation debug data.
 */
export default class SimulationCapture {
    constructor(uiController) {
        this.uiController = uiController;
        this.isCapturing = false;
        this.debugCaptureData = [];
        this.commandHistory = [];
    }

    /**
     * Toggles the data capture state on or off.
     */
    toggle() {
        this.isCapturing = !this.isCapturing;
        this.uiController.updateCaptureButtonState(this.isCapturing);
        console.log(`Data capture ${this.isCapturing ? 'enabled' : 'disabled'}.`);
    }

    /**
     * Saves the captured data to a JSON file.
     */
    save() {
        if (this.debugCaptureData.length === 0) {
            alert("No debug data captured.");
            return;
        }
        const saveData = {
            history: this.commandHistory,
            data: this.debugCaptureData
        };
        const dataStr = JSON.stringify(saveData, null, 2);
        const blob = new Blob([dataStr], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `erosion_capture_${Date.now()}.json`;
        link.click();
        URL.revokeObjectURL(url);
        console.log(`Saved ${this.debugCaptureData.length} frames of capture data.`);
    }

    /**
     * Clears all captured data after user confirmation.
     * @returns {boolean} - True if data was cleared, false otherwise.
     */
    clear() {
        if (this.debugCaptureData.length > 0 && window.confirm(`Are you sure you want to clear ${this.debugCaptureData.length} captured frames?`)) {
            this.commandHistory = [];
            this.debugCaptureData = [];
            this.isCapturing = false; // Clearing data also stops the capture.
            console.log("Cleared capture data. Capture stopped.");
            return true;
        }
        return false;
    }

    /**
     * Adds a new frame of captured data to the internal array.
     * @param {number} frameNumber - The current iteration/frame number.
     * @param {object} data - The captured data object for this frame.
     */
    addFrame(frameNumber, data) {
        if (!this.isCapturing || !data) return;
        this.debugCaptureData.push({ frame: frameNumber, data });
    }

    /**
     * Records a user-initiated command if capturing is active.
     * @param {object} command - The command details to record.
     */
    recordCommand(command) {
        if (!this.isCapturing) return;
        this.commandHistory.push(command);
    }

    /**
     * Gets the current number of captured frames.
     * @returns {number}
     */
    get frameCount() {
        return this.debugCaptureData.length;
    }
}