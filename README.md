# WebGPU Fractal Landscape Renderer

![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)

A real-time 3D terrain renderer built with modern web technologies. This project leverages the power of the GPU via the WebGPU API to generate, modify, and render complex and realistic fractal landscapes directly in the browser.

**[Live Demo Here]** *(Link to your GitHub Pages deployment)*

---

## 📸 Screenshots

*(Add a screenshot or GIF of the terrain here)*

![Screenshot of the fractal terrain](./docs/screenshot.png) 

---

## ✨ Features

- **GPU-Accelerated Fractal Noise**: Procedural terrain generation using Fractional Brownian Motion (fBm) executed entirely on the GPU for high performance.
- **Tiled Level of Detail (LOD)**: A system for rendering a grid of terrain tiles where the central tile has a higher resolution than its neighbors, with seamless "stitching" to prevent visual cracks.
- **GPU Hydraulic Erosion**: A compute shader-based simulation to modify the generated terrain, creating more natural-looking features like rivers and valleys.
- **Pluggable Shader Strategies**: A flexible architecture that allows for easily switching between different terrain generation behaviors (e.g., infinite scrolling, fractal zoom).
- **Interactive Controls**: A 3D orbit camera and a UI panel for manipulating all terrain parameters in real-time.

---

## 🚀 Getting Started

To run this project locally, you need a modern web browser that supports WebGPU.

### Prerequisites

- **Google Chrome** (version 113 or later)
- **Microsoft Edge** (version 113 or later)
- **Firefox** (requires enabling `dom.webgpu.enabled` in `about:config`)

### Running Locally

Because the application loads shader files and uses ES modules, you must run it from a local web server.

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/your-username/your-repo-name.git
    cd your-repo-name
    ```

2.  **Start a local server:**
    The simplest way is to use Python's built-in HTTP server.
    ```bash
    # For Python 3
    python3 -m http.server

    # For Python 2
    python -m SimpleHTTPServer
    ```

3.  **Open in your browser:**
    Navigate to `http://localhost:8000` (or the port specified by your server).

---

## 🎮 Controls

- **Mouse**:
  - **Left-Click + Drag**: Orbit the camera around the terrain.
  - **Scroll Wheel**: Zoom in and out.
- **Touch**:
  - **One Finger Drag**: Orbit the camera.
  - **Two Finger Pinch**: Zoom in and out.
- **Keyboard**:
  - **Arrow Keys**: In "Scrolling" or "Scroll & Zoom" mode, these keys pan the view across the terrain.
- **UI Panel**:
  - Use the sliders to adjust terrain generation parameters. Changes are reflected automatically.
  - Use the "Erode" button to apply the hydraulic erosion simulation.

---

## 🏛️ Architecture

The application is structured around a Model-View-Controller (MVC) pattern to separate concerns:

- **`controller.js`**: The central hub. It handles user input, manages application state, and orchestrates the flow between the model and the view.
- **`view.js`**: Manages all WebGPU rendering tasks, including pipeline creation, resource management (buffers, textures), the camera, and executing the final render pass.
- **`models.js`**: Manages the application's data and the logic for generating it. It contains different model classes (`TiledLODModel`, `UntiledHeightmapModel`) that run compute shaders for terrain generation and erosion.
- **`geometry.js`**: Contains the logic for converting raw heightmap data into a renderable 3D mesh, including the critical T-junction stitching for the LOD system.
- **`shader_strategies.js`**: Defines a strategy pattern for different compute shader behaviors, making it easy to switch between generation modes like scrolling or fractal zooming.

---

## 📄 License

This project is open source and licensed under the **MIT License**. See the LICENSE file for details.

---

## 🙏 Acknowledgements

The hydraulic erosion simulation is based on the concepts presented in the paper "Fast Hydraulic Erosion Simulation and Visualization on GPU".