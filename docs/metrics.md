# Hydraulic Erosion Simulation Metrics

This document serves as a "first principles" review of all parameters involved in the hydraulic erosion simulation. The goal is to define each parameter, understand its current role, and identify its real-world physical analogue. This will guide the process of re-calibrating the simulation for more realistic and predictable behavior.

## Parameter Breakdown

The following table enumerates all parameters, both user-adjustable and static, that influence the erosion simulation.

| Parameter (Variable Name) | Current Interpretation & Usage | Pipeline Phase(s) | Real-World Analogue |
| :--- | :--- | :--- | :--- |
| **`dt`** | The simulation time step. A static value that scales how much the water surface gradient affects velocity and how much velocity affects position. | `flow`, `transport`, `evaporation` | Time (e.g., seconds per iteration) |
| **`density`** | A multiplier that acts as a proxy for gravity (`g`) and fluid density in the flow calculation. A larger value increases the "force" of water flow. | `flow` | A lumped parameter representing gravitational acceleration (m/s²), fluid density (kg/m³), and cell area (m²). |
| **`rainAmount`** | The amount of water added to each cell per iteration when "Rain" mode is active. Derived from the `wetness` UI slider. | `water` | Precipitation Rate (e.g., meters of water per second) |
| **`evapRate`** | The percentage of water that evaporates from each cell per iteration. Derived from the `wetness` UI slider. | `evaporation` | Evaporation Rate (unitless percentage per time step) |
| **`solubility`** | A multiplier that controls how quickly terrain is converted into suspended sediment when the water has excess carrying capacity. | `erosion` | Material Erodibility / Soil Cohesion (unitless factor) |
| **`depositionRate`** | A multiplier that controls how quickly suspended sediment is converted back into terrain when the water is over-capacity. | `deposition` | Sediment Settling Velocity (unitless factor) |
| **`capacityFactor`** | A key multiplier that scales the overall sediment-carrying capacity of the water. It's a primary component in the `capacity = f(velocity, water_depth) * capacityFactor` equation. | `erosion`, `deposition` | A "transport efficiency" constant that relates flow energy to sediment load. |
| **`minSlope`** | A small, static constant added to the velocity magnitude when calculating sediment capacity. This prevents capacity from being zero in still water, allowing for some deposition to occur. | `erosion`, `deposition` | A minimum energy threshold required for sediment to remain suspended in water. |
| **`heightMultiplier`** | Scales the raw, normalized heightmap values (0.0-1.0) to a world-space vertical dimension. This is crucial for calculating a realistic gradient in the flow pass. | `flow` | Vertical Exaggeration / World Scale (e.g., meters per heightmap unit) |
| **`gridSize`** | The resolution of the simulation grid (e.g., 256x256). Defines the number of cells. | All | Spatial Resolution. The distance between cells would define the "cell size" (e.g., meters). |
| **Velocity Damping** | A hardcoded multiplier (`0.99`) applied to the velocity each step to simulate friction and prevent the simulation from becoming unstable. | `flow` | Fluid Friction / Viscosity |
| **`seaLevel`** | A normalized height value used by the *rendering* shader to determine where to draw water vs. land. It is not currently used in the erosion physics itself. | None (Rendering Only) | Mean Sea Level (e.g., meters) |

---

## Mathematical Model Per Phase

The following section defines the core equations for each phase of the simulation pipeline.

**Notation:**
- `h`: Terrain heightmap
- `w`: Water map
- `s`: Suspended sediment map
- `v`: 2D velocity field (`v.x`, `v.y`)
- `H`: Total water surface height (`h * heightMultiplier + w`)
- `C`: Sediment carrying capacity
- `∇H`: Gradient of the total water surface height

---

### Phase 1: Water Increment
- **Input**: `w_in`, `rainAmount`
- **Output**: `w_out`
- **Equation**: `w_out = w_in + rainAmount`

---

### Phase 2: Flow Simulation
- **Input**: `h_in`, `w_in`, `v_in`, `dt`, `density`, `heightMultiplier`
- **Output**: `v_out`
- **Equations**:
  1. `H = h_in * heightMultiplier + w_in`
  2. `∇H.x = (H_right - H_left) / 2`
  3. `∇H.y = (H_bottom - H_top) / 2`
  4. `v_new = v_in - dt * density * ∇H`
  5. `v_out = v_new * 0.99` (Velocity Damping)

---

### Phase 3: Erosion
- **Input**: `h_in`, `w_in`, `s_in`, `v_in`, `minSlope`, `capacityFactor`, `solubility`
- **Output**: `h_out`, `s_out`
- **Equations**:
  1. `C = max(minSlope, |v_in|) * w_in * capacityFactor`
  2. If `C > s_in`:
     - `amount_to_erode = (C - s_in) * solubility`
     - `h_out = h_in - amount_to_erode`
     - `s_out = s_in + amount_to_erode`

---

### Phase 4: Sediment Transport (Advection)
- **Input**: `w_in`, `s_in`, `v_in`, `dt`
- **Output**: `w_out`, `s_out`
- **Equation**: For each cell at `pos`, calculate the value by sampling the input grids at a previous position:
  - `prev_pos = pos - v_in * dt`
  - `w_out(pos) = BilinearInterpolate(w_in, prev_pos)`
  - `s_out(pos) = BilinearInterpolate(s_in, prev_pos)`

---

### Phase 5: Deposition
- **Input**: `h_in`, `w_in`, `s_in`, `v_in`, `minSlope`, `capacityFactor`, `depositionRate`
- **Output**: `h_out`, `s_out`
- **Equations**:
  1. `C = max(minSlope, |v_in|) * w_in * capacityFactor`
  2. If `s_in > C`:
     - `amount_to_deposit = (s_in - C) * depositionRate`
     - `h_out = h_in + amount_to_deposit`
     - `s_out = s_in - amount_to_deposit`

---

### Phase 6: Evaporation
- **Input**: `w_in`, `evapRate`, `dt`
- **Output**: `w_out`
- **Equation**: `w_out = w_in * (1.0 - evapRate * dt)`

---

## Simulation-Scale vs. Physical-Scale Parameters

A critical concept in this project is the distinction between physically realistic parameters and the *simulation-scale* parameters we use to achieve our artistic goals.

### The Timescale Problem

Real-world geological erosion occurs over millions of years. A physically accurate simulation using real-world values for rock solubility or rainfall rates would produce virtually no visible change in the few hundred iterations we can afford to compute in real-time.

### The Solution: Balanced Exaggeration

Our goal is not scientific accuracy, but rather the creation of visually compelling, terrain-like features in a matter of seconds. To achieve this, we intentionally use exaggerated, non-physical parameters that are balanced against each other to produce a stable and controllable result.

-   **High Solubility & Capacity**: We treat the terrain as if it were made of a much "softer" material (`solubility`) and make the water capable of carrying a much larger sediment load (`capacityFactor`). This allows for rapid carving of channels and valleys.
-   **High Iteration Count**: We run the simulation for a relatively high number of iterations (e.g., 200) in a single "Erode" action. This gives the exaggerated processes enough time to work and for the system to approach a new, stable state (equilibrium).
-   **Stable Time Step (`dt`)**: While other parameters are exaggerated, the time step `dt` is kept small. This is crucial for the *numerical stability* of the simulation. Increasing `dt` would make the simulation run "faster" in simulated time, but it would also likely cause it to "blow up" with non-physical artifacts. It is safer and more predictable to increase the rates of physical processes while keeping the time step small and stable.

In essence, we are compressing geologic time into a few seconds of computation by creating a system where the underlying physics are recognizable, but the rates at which they operate are massively accelerated in a balanced way.