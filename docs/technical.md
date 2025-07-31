# Technical Documentation: WebGPU Fractal Landscape Renderer

## 1. Project Overview

This project is a real-time 3D terrain renderer built using modern web technologies. It leverages the power of the GPU via the WebGPU API to generate, modify, and render complex and realistic fractal landscapes directly in the browser.

Key features include:
- **GPU-Accelerated Fractal Noise**: Procedural terrain generation using Fractional Brownian Motion (fBm) executed entirely on the GPU for high performance.
- **Tiled Level of Detail (LOD)**: A system for rendering a grid of terrain tiles where the central tile has a higher resolution than its neighbors, with seamless stitching to prevent visual cracks.
- **Hydraulic Erosion Simulation**: A GPU-based simulation to modify the generated terrain, creating more natural-looking features like rivers and valleys.
- **Pluggable Shader Strategies**: A flexible architecture that allows for easily switching between different terrain generation and rendering behaviors (e.g., infinite scrolling, fractal zoom).
- **Interactive Camera and UI**: A user-friendly interface for manipulating terrain parameters and controlling a 3D orbit camera.

## 2. Core Technologies

- **WebGPU**: The primary API for interfacing with the GPU. Used for both compute (terrain generation, erosion) and rendering tasks.
- **JavaScript (ES Modules)**: The core language for application logic, state management, and DOM manipulation.
- **WGSL (WebGPU Shading Language)**: The language used to write the compute and render shaders that run on the GPU.
- **HTML5/CSS3**: For the user interface and application structure.

## 3. Architecture

The application is structured around a classic **Model-View-Controller (MVC)** pattern to separate concerns, making the codebase more modular and maintainable.

### `controller.js` (Controller)
- **Role**: The central hub of the application. It orchestrates the flow of data and user actions.
- **Responsibilities**:
  - Initializes the Model and View.
  - Handles all user input from the UI (sliders, buttons) and browser events (mouse, keyboard, touch, resize).
  - Gathers parameters from the UI.
  - Triggers terrain generation in the Model and passes the resulting data to the View for rendering.
  - Manages the application state (e.g., `isUpdating`, `isAnimating`).

### `view.js` (View)
- **Role**: Manages all rendering-related tasks and GPU resources.
- **Responsibilities**:
  - Initializes the WebGPU device, context, and render/depth textures.
  - Compiles WGSL shaders and creates the `GPURenderPipeline`.
  - Manages a collection of `Tile` objects, each representing a piece of the terrain mesh.
  - Receives heightmap data and uses `geometry.js` to construct the vertex/index buffers for each tile.
  - Manages the `Camera` and its view/projection matrices.
  - Executes the render pass to draw all visible tiles to the canvas.

### `models.js` (Model)
- **Role**: Manages the application's data and the logic for generating it.
- **Responsibilities**:
  - Manages GPU resources for compute tasks (uniform buffers, storage buffers, textures).
  - Interfaces with the active `ShaderStrategy` to run the appropriate compute shader for terrain generation.
  - Runs the hydraulic erosion compute shader.
  - Copies data from GPU buffers to CPU-accessible staging buffers to return results to the Controller.

## 4. Terrain Generation Pipeline

### 4.1. Fractal Noise Generation
The terrain is generated using a Fractional Brownian Motion (fBm) algorithm, which sums multiple layers (octaves) of a noise function at different frequencies and amplitudes. This process is implemented entirely in a WGSL compute shader for maximum performance.

- **Parameters**: `octaves`, `persistence`, `lacunarity`, `scale`, `seed`, `hurst`.
- **Shader Strategies (`shader_strategies.js`)**: A strategy pattern allows for different variations of the generation process:
  - `TiledLODShaderStrategy`: The most complex strategy. The compute shader accepts a world-space `origin` and `lod` to generate a specific tile. This allows different parts of the world to be generated at different resolutions.
  - `ScrollingShaderStrategy`: Accepts a 2D `worldOffset` uniform to allow for infinite scrolling across the noise field.
  - `FractalZoomShaderStrategy`: The controller dynamically adjusts the `scale` uniform based on camera distance, creating a "fractal zoom" effect where detail is regenerated as the user zooms in.

### 4.2. Global Normalization (Tiled LOD)
To ensure visual consistency across multiple tiles that may have different height ranges, a two-pass system is used:
1.  **Pass 1 (Data Generation)**: The controller iterates through all required tiles, instructing the model to generate the raw, un-normalized height data for each. It keeps track of the `globalMin` and `globalMax` height values across all tiles.
2.  **Pass 2 (Normalization & Mesh Creation)**: The controller iterates through the generated data again. For each tile, it normalizes the heights using the `globalMin` and `globalMax` values before passing the data to the View to create the final mesh. This ensures that the color mapping and height scaling are consistent across the entire landscape.

A `globalOffset` is also calculated (based on a low percentile of all height values) to establish a consistent "sea level" across all tiles, preventing the entire terrain from floating or being submerged if the height data is skewed.

## 5. Geometry and Rendering

### 5.1. Geometry Generation (`geometry.js`)
The `createTileGeometry` function is responsible for converting a 1D array of height data into a renderable 3D mesh.

- **Single-Pass Optimization**: Vertex attributes (position, color, normal) are all calculated within a single `for` loop over the grid, improving data locality and performance compared to multiple separate loops.
- **Normal Calculation**: Normals are calculated using the finite difference method, sampling the heights of neighboring vertices to determine the surface gradient.

### 5.2. T-Junction Stitching
A critical feature of the LOD system is solving the "T-junction" problem, where a high-resolution mesh meets a low-resolution mesh, creating cracks. This is solved in the index-generation phase of `createTileGeometry`.

- **Logic**: The function checks if a tile needs to be stitched against a lower-LOD neighbor (`stitchTop`, `stitchBottom`, etc.).
- **Control Flow**: A chain of `if/else if` statements handles all 9 possible cases for a quad: no stitching, stitching on one of 4 edges, or stitching on one of 4 corners. Corners are checked first as they are the most specific case.
- **Fan Triangulation**: When a 2x1 (edge) or 2x2 (corner) block of high-res quads meets a low-res edge, a "fan" of triangles is generated. This fan pivots from an interior vertex of the high-res mesh out to the vertices of the low-res edge, effectively "stitching" the gap shut.
- **Quad Skipping**: The second quad in a stitched pair is skipped during iteration, as its geometry is already fully described by the fan generated for the first quad.

### 5.3. Rendering (`view.js`)
- **Tile Class**: The `Tile` class encapsulates all GPU resources for a single terrain chunk: vertex buffers, index buffer, model matrix, and the `GPUBindGroup` for its uniforms.
- **Render Pass**: The `drawScene` method initiates a render pass, sets the render pipeline, and iterates through all visible tiles. For each tile, it sets the appropriate vertex/index buffers and bind group, then issues a `drawIndexed` command.

## 6. Advanced Features

### 6.1. Hydraulic Erosion
The project includes a GPU-based hydraulic erosion simulation based on the paper "Fast Hydraulic Erosion Simulation and Visualization on GPU".

- **Implementation**: The simulation is performed in a compute shader (`erosion.wgsl`).
- **Ping-Pong Textures**: It uses two `r32float` textures (`heightmapTextureA`, `heightmapTextureB`) to iteratively update the heightmap. In each iteration, it reads from one texture and writes the eroded result to the other, swapping roles in the next iteration. This is a standard and efficient technique for iterative GPU algorithms.
- **State**: The `Model` manages the erosion state, including the current textures and an erosion frame counter. The simulation can be run for a set number of iterations or animated frame-by-frame.
- **Simulation Flow**: The simulation relies on sophisticated multi-pass processing using WebGPU compute kernels. It is implemented as a sequence of five distinct compute shader passes that are executed for each iteration. The system supports two modes: a highly efficient **Standard Flow** for real-time interaction, and a **Debug Flow** for detailed analysis.

  - **State Management and Flow Differences**: The Standard and Debug flows, while executing the same core simulation passes, have a critical difference in their state management contracts, which impacts how the `SimulationController` interacts with them:
    - **Standard Flow (`HydraulicErosionModel`)**: This model is optimized for performance and simplicity of use. Its `runErosion` method is a self-contained operation. It takes the current terrain texture as input, runs the requested number of iterations internally (ping-ponging between its private textures), and importantly, copies the final eroded terrain **back into the original input texture**. This means the controller can treat it as a "black box" and does not need to manage texture swaps after the operation is complete.
    - **Debug Flow (`HydraulicErosionModelDebug`)**: This model is designed for introspection and single-stepping. Its `captureSingleStep` method performs exactly one iteration, reading from an input texture (e.g., `textureA`) and writing the result to a separate output texture (`textureB`). It **does not** copy the result back. This design requires the `SimulationController` to be an active participant in state management. After each step, the controller must explicitly swap its primary textures so that the output of the last step (`textureB`) becomes the input for the next. This contract is essential for allowing the system to capture and visualize the state after each discrete pass.

  - **Pipeline Steps**: Each simulation iteration involves the following passes, which use a "ping-pong" texture technique to pass state between them:
    1.  **Water Increment**: Adds a specified amount of water (`rainAmount`) to the water map. This pass is only run when "Rain" mode is active.
    2.  **Flow Simulation**: Calculates a 2D velocity field for the water based on the height gradient between adjacent cells.
    3.  **Erosion**: Calculates how much sediment the water can carry and erodes the terrain accordingly, adding the eroded material to a suspended sediment texture.
    4.  **Sediment Transport**: Moves the water and its suspended sediment to neighboring cells based on the velocity field calculated in Pass 2.
    5.  **Deposition**: After transport, this pass calculates the water's new sediment capacity. If the water is carrying more sediment than it can support, it deposits the excess onto the terrain.
    6.  **Evaporation**: Reduces the water level in every cell by a small amount (`evapRate`).

  - **User Control**: The UI provides an intuitive, stateful system for controlling the erosion simulation. The core controls are the **Erode Button**, the **Iterations Slider**, and the **Rain/Dry Radio Buttons**.
    - **Rain/Dry Radio Buttons**: This control sets the persistent mode for the simulation. It does not trigger any action itself, but determines the behavior of the "Erode" button.
      - **Dry**: When selected, any simulation run will process only the existing water on the terrain. No new water is added.
      - **Rain**: When selected, every iteration of the simulation will begin with the *Water Increment* pass, effectively simulating continuous rainfall.
    - **Erode Button & Iterations Slider**: These controls work together to execute the simulation.
      - The **Iterations Slider** sets the number of full simulation cycles that will be executed when the "Erode" button is pressed.
      - The **Erode Button** is the primary action trigger. It runs the simulation for the specified number of iterations, adhering to the mode set by the Rain/Dry radio buttons. For immediate visual feedback, the button's color changes to blue when in "Rain" mode and brown when in "Dry" mode.

  - **Debug Controls**: When the "Hydraulic (Debug)" model is selected, a special debug UI is enabled, offering powerful tools for introspection and analysis.
    - **View Mode Dropdown**: This control switches the main renderer to display a live heatmap of different data textures from the simulation, which is invaluable for visualizing the simulation's internal state.
      - `Standard`: The default photorealistic terrain view.
      - `Water Depth`: Visualizes the amount of water in each cell.
      - `Water Velocity`: Visualizes the magnitude of the 2D water flow vector.
      - `Sediment Amount`: Visualizes the amount of suspended sediment being carried by the water.
    - **Data Capture Controls**: These buttons manage a frame-by-frame capture of the simulation's internal state for offline analysis.
      - **Start/Stop Capture Button**: Toggles the data capture mode. When active, every single simulation step triggers an expensive process where all intermediate textures from the 6-pass pipeline are copied from the GPU to the CPU and analyzed.
      - **Save Capture Button**: Takes all captured frame data and serializes it into a JSON format. The resulting file contains a `data` array with the per-step metrics and a `history` array that logs every user command (Erode button clicks) along with the full set of simulation parameters for that command, ensuring full reproducibility.
      - **Clear Capture Button**: Discards all captured data and command history from memory.
    - **Data Plotting**: A sophisticated, interactive plotting tool is available for real-time analysis of captured data.
      - **Pop-out Window**: The plot is launched in a separate browser window, allowing it to be resized and positioned independently of the main application for easier analysis on multi-monitor setups.
      - **Metric Selection UI**: Instead of a simple list, metrics are selected via a series of toggle buttons. These toggles are grouped first by their simulation **Phase** (e.g., "Pass 3: Erosion") and then by **Type** (e.g., "terrain", "sediment"), providing a highly intuitive way to find and select related data points.
      - **Color-Coded Feedback**: Each simulation phase is assigned a unique color. This color is used for the phase title in the selection UI and is also applied to the corresponding subplot title and data trace in the plot window, creating a strong visual link between the controls and the output.
      - **Stacked Subplots**: Multiple metrics can be selected and are displayed in a stacked subplot layout. Each metric gets its own chart, but they all share a common X-axis (Simulation Step), making it easy to correlate events between different data series.


## 7. Code Structure
```
/
├── assets/ # Static assets like icons
├── css/ # CSS stylesheets
├── docs/ # Project documentation
├── js/ # All JavaScript modules 
│ ├── controller.js # Main application logic (Controller)
│ ├── view.js # Rendering and WebGPU management (View)
│ ├── models.js # Data generation and erosion (Model)
│ ├── geometry.js # Procedural mesh and LOD stitching logic
│ ├── shader_strategies.js# Pluggable compute shader behaviors
│ ├── camera.js # 3D orbit camera logic
│ ├── tile.js # Class representing a single terrain tile
│ ├── mat4.js # 4x4 matrix math library
│ └── utils.js # Helper functions
├── shaders/ # WGSL shader files
│ ├── render.wgsl # Vertex and Fragment shaders for rendering
│ ├── erosion.wgsl # Compute shader for hydraulic erosion
│ └── compute-.wgsl # Various compute shaders for terrain generation +
├── test/ # HTML-based test runners
├── index.html # Main application entry point 
├── LICENSE 
└── README.md
"""

## 8. Potential Future Improvements

- **Dynamic Quadtree LOD**: Replace the static 3x3 grid with a dynamic quadtree structure. This would allow for a much larger world where tiles are subdivided and loaded/unloaded based on camera proximity, providing a more scalable and efficient LOD system.
- **Geometry Caching**: The index buffer for a stitched tile depends only on which of its four neighbors are at a lower LOD. There are only 16 possible combinations. These index buffers could be pre-calculated and cached, eliminating the complex `if/else` logic from the hot path of geometry creation.
- **Advanced Rendering**: Implement more advanced graphical features like dynamic shadows (shadow mapping), atmospheric scattering for realistic skies, and procedural texturing based on slope and height. +- Non-Destructive Modifier Pipeline: Refactor the terrain generation into a non-destructive pipeline or "modifier stack". This would allow changes to base noise parameters without discarding subsequent modifications like erosion. A potential pipeline would be:
- Base Noise Generation
- Hydraulic Erosion Pass
- Normalization
- View-Dependent Modification (LOD Stitching)
- **Full Hydrological Cycle**: Instead of a simple "rain and evaporate" model, implement a closed system where evaporated water accumulates in a global "atmosphere" and is then precipitated back onto the terrain, potentially influenced by orographic lift (mountains creating rain shadows).