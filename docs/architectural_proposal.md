# Architecture Proposal: Decoupled Simulation Server

This document outlines a plan to evolve the project from a client-side-only application into a client-server architecture. The primary goal is to decouple the WebGPU simulation engine from the browser UI and expose it via a Node.js API. This will enable programmatic control of the GPU simulation for automated testing, optimization, and batch processing.

## 1. Core Concept: Headless Browser Automation

The main technical challenge is running the browser-based WebGPU API on a server. The most robust and lowest-complexity solution is to use a headless browser automation tool like **Puppeteer**.

The workflow will be:
1.  A Node.js server (using the Express.js framework) will listen for API requests.
2.  Upon receiving a request, the server will launch a headless instance of Google Chrome using Puppeteer.
3.  The headless browser will navigate to the project's `index.html`.
4.  The server will execute JavaScript within the page's context to set parameters and run the simulation.
5.  After the simulation completes, the server will extract the resulting data (e.g., a capture JSON) from the page.
6.  The server will return this data as the API response.

This approach allows us to reuse the *exact same* validated GPU code without modification.

## 2. Implementation Steps

### Step 2.1: Server Setup

Create a new `server` directory at the project root. This will contain the Node.js application.

**`server/package.json`**:
```json
{
  "name": "fractal-sim-server",
  "version": "1.0.0",
  "description": "API server for the WebGPU fractal simulation.",
  "main": "server.js",
  "type": "module",
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "puppeteer": "^21.5.0"
  }
}
```

**`server/server.js` (Initial Draft)**:
This file will contain the Express server logic to handle API requests and orchestrate the Puppeteer instance.

```javascript
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
// import { runSimulation } from './simulation_runner.js'; // We will create this next

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = 3000;

// Serve the main fractal application's static files
app.use(express.static(path.join(__dirname, '..')));
app.use(express.json());

app.post('/api/simulate', async (req, res) => {
    console.log("Received simulation request with params:", req.body);
    // const results = await runSimulation(req.body);
    // res.json(results);
    res.json({ status: "ok", message: "Endpoint is working." });
});

app.listen(port, () => {
    console.log(`Fractal Simulation Server listening on http://localhost:${port}`);
});
```

### Step 2.2: Exposing a JavaScript API

To allow Puppeteer to control the simulation, we need to expose a simple API on the `window` object in our client-side code.

**`/js/controller.js` Modification**:
In the `init` method of the `Controller` class, we can attach a function to the `window` object.

```javascript
async init() {
    // ... existing init code ...

    // Expose a programmatic API for automation tools like Puppeteer
    window.runSimulationAPI = async (erosionParams, iterations) => {
        console.log("Programmatic simulation run triggered.");
        await this.simulationController.erodeTerrain(erosionParams, iterations);
        // In a full implementation, this would return the capture data.
        return { status: "complete" };
    };
}
```

## 3. Future Enhancements

-   **WebSocket API**: For long-running simulations, a WebSocket connection would be superior to HTTP. The server could stream progress updates and results back to the client in real-time.
-   **Task Queue**: Implement a job queue (e.g., using BullMQ) to manage simulation requests. This would allow the server to process one simulation at a time, preventing resource exhaustion and enabling management of long-running tasks.
-   **Result Caching**: The server could cache simulation results for a given set of parameters, returning a stored result instantly if the same simulation is requested again.

This phased approach provides a clear path to achieving your goal of a decoupled, programmatically accessible simulation engine with minimal initial complexity.

```

This plan provides a solid foundation for this architectural evolution. It's a significant but very rewarding step that will greatly enhance the project's capabilities.

<!--
[PROMPT_SUGGESTION]Let's implement the first step of the architecture proposal: setting up the Node.js server and exposing the JavaScript API.[/PROMPT_SUGGESTION]
[PROMPT_SUGGESTION]Let's adjust the erosion parameters in `config.json` to reduce the water's energy and encourage sediment deposition.[/PROMPT_SUGGESTION]
