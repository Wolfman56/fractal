import DataPlotter from './data_plotter.js';

const plotter = new DataPlotter('plot-container');

window.addEventListener('message', event => {
    // Basic security: only accept messages from the same origin
    if (event.origin !== window.location.origin) {
        console.warn(`Message from untrusted origin '${event.origin}' was ignored.`);
        return;
    }

    const { type, payload } = event.data;

    switch (type) {
        case 'INIT':
            plotter.initialize(payload.metrics, payload.captureData); // Draws with full history
            break;
        case 'UPDATE':
            plotter.update(payload.newFrame); // Appends only the new frame
            break;
        case 'CHANGE_METRIC':
            plotter.changeMetric(payload.metrics, payload.captureData);
            break;
        case 'CLEAR':
            plotter.clear();
            break;
    }
});

// Notify the main window that the plot window is ready to receive data.
// This is crucial for re-establishing connection if the main page is reloaded.
if (window.opener) {
    window.opener.postMessage({ type: 'PLOTTER_READY' }, window.location.origin);
}