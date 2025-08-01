import numpy as np
import json
import argparse
import os
from scipy.ndimage import map_coordinates

# This script is a simplified Python implementation of the hydraulic erosion
# simulation pipeline. It uses the mathematical formulas documented in docs/metrics.md
# to validate the core logic of each simulation phase.

class Parameters:
    def __init__(self):
        # Default values, will be overwritten by loaded data
        self.grid_size = 16
        self.dt = 0.05
        self.height_multiplier = 0.5
        self.cell_size = 1.0
        self.damping = 0.99
        self.min_slope = 0.01
        self.density = 50000
        self.rain_amount = 0.0
        self.evap_rate = 0.0
        self.solubility = 0.01
        self.deposition_rate = 0.5
        self.capacity_factor = 4.0
        self.add_rain = False


class SimulationState:
    def __init__(self, grid_size):
        self.h = np.zeros((grid_size, grid_size), dtype=np.float32) # Terrain Height
        self.w = np.zeros((grid_size, grid_size), dtype=np.float32) # Water Depth
        self.s = np.zeros((grid_size, grid_size), dtype=np.float32) # Suspended Sediment
        self.v = np.zeros((grid_size, grid_size, 2), dtype=np.float32) # Velocity (vx, vy)

    def print_metric(self, grid_name, grid):
        print(f"  - {grid_name}: Sum={np.sum(grid):.4f}, Min={np.min(grid):.4f}, Max={np.max(grid):.4f}, Avg={np.mean(grid):.4f}")

    def get_metrics(self, grid):
        return {
            "sum": float(np.sum(grid)),
            "min": float(np.min(grid)),
            "max": float(np.max(grid)),
            "avg": float(np.mean(grid)),
        }

def run_water_pass(state, params):
    """Phase 1: Water Increment"""
    state.w += params.rain_amount
    return state

def run_flow_pass(state, params):
    """Phase 2: Flow Simulation"""
    H = state.h * params.height_multiplier + state.w # Total water surface height

    # Pad H to simulate the 'clamp-to-edge' behavior of the GPU's texture samplers.
    # This ensures the gradient calculation is accurate even at the borders.
    H_padded = np.pad(H, pad_width=1, mode='edge')

    grad_x = (H_padded[1:-1, 2:] - H_padded[1:-1, :-2]) / (2.0 * params.cell_size)
    grad_y = (H_padded[2:, 1:-1] - H_padded[:-2, 1:-1]) / (2.0 * params.cell_size)

    # Update velocity
    grad = np.stack((grad_x, grad_y), axis=-1)
    state.v -= params.dt * params.density * grad
    state.v *= params.damping
    return state

def run_erosion_pass(state, params):
    """Phase 3: Erosion"""
    velocity_mag = np.linalg.norm(state.v, axis=-1)
    capacity = np.maximum(params.min_slope, velocity_mag) * state.w * params.capacity_factor

    has_capacity = capacity > state.s
    amount_to_erode = (capacity - state.s) * params.solubility
    
    # Erode only where water has capacity, and don't erode more than available terrain
    erosion_amount = np.where(has_capacity, np.minimum(amount_to_erode, state.h), 0)

    state.h -= erosion_amount
    state.s += erosion_amount
    return state

def run_transport_pass(state, params):
    """Phase 4: Sediment Transport (Advection)"""
    grid_size = params.grid_size
    # Create coordinate grids. In numpy, the convention is (row, col) -> (y, x).
    y_coords, x_coords = np.mgrid[0:grid_size, 0:grid_size]

    # Calculate previous positions
    prev_y = y_coords - state.v[:, :, 1] * params.dt
    prev_x = x_coords - state.v[:, :, 0] * params.dt

    # `map_coordinates` requires coordinates in a (2, N) array.
    coords = np.array([prev_y.ravel(), prev_x.ravel()])

    # Perform bilinear interpolation using SciPy. This is a highly optimized
    # equivalent to the manual bilinear interpolation in the shader.
    # 'order=1' specifies bilinear. 'mode='nearest'' handles boundary conditions.
    state.w = map_coordinates(state.w, coords, order=1, mode='nearest').reshape(state.w.shape)
    state.s = map_coordinates(state.s, coords, order=1, mode='nearest').reshape(state.s.shape)

    return state

def run_deposition_pass(state, params):
    """Phase 5: Deposition"""
    velocity_mag = np.linalg.norm(state.v, axis=-1)
    capacity = np.maximum(params.min_slope, velocity_mag) * state.w * params.capacity_factor

    is_over_capacity = state.s > capacity
    amount_to_deposit = (state.s - capacity) * params.deposition_rate

    # Deposit only where water is over capacity, and don't deposit more than available sediment
    deposition_amount = np.where(is_over_capacity, np.minimum(amount_to_deposit, state.s), 0)

    state.h += deposition_amount
    state.s -= deposition_amount
    return state

def run_evaporation_pass(state, params):
    """Phase 6: Evaporation"""
    state.w *= np.maximum(0.0, (1.0 - params.evap_rate * params.dt))
    return state

def main(input_file_path, results_directory_path):
    print("--- Initializing Simulation ---")
    try:
        with open(input_file_path, 'r') as f:
            capture = json.load(f)
    except FileNotFoundError:
        print(f"Error: Input file not found at '{input_file_path}'")
        return
    except json.JSONDecodeError:
        print(f"Error: Could not decode JSON from '{input_file_path}'")
        return

    # Assume grid size is constant from the first command's parameters
    grid_size = capture['history'][0]['params']['gridSize']
    state = SimulationState(grid_size)

    # Create a mathematically perfect sloped plane from 0 to 256 meters.
    # This provides a consistent, world-space initial state for validation.
    x_coords = np.linspace(0, 256, grid_size)
    state.h = np.tile(x_coords, (grid_size, 1))

    print("Initial State:")
    state.print_metric("Terrain Height", state.h)
    print("-" * 30)

    python_data_capture = []
    total_iterations = 0

    for command in capture['history']:
        print(f"\n>>> Executing Command: {command['iterations']} iterations, Rain={command['rain']} <<<")
        params = Parameters()
        params.grid_size = command['params']['gridSize']
        params.height_multiplier = command['params']['heightMultiplier']
        params.density = command['params']['density']
        params.rain_amount = command['params']['rainAmount'] if command['rain'] else 0.0
        params.evap_rate = command['params']['evapRate']
        params.solubility = command['params']['solubility']
        params.deposition_rate = command['params']['depositionRate']
        params.capacity_factor = command['params']['capacityFactor']
        params.dt = command['params']['dt']
        params.min_slope = command['params']['minSlope']
        params.cell_size = command['params']['cellSize']
        params.damping = command['params']['velocityDamping']

        for i in range(command['iterations']):
            # --- Run one full iteration ---
            state = run_water_pass(state, params)
            pass1_metrics = state.get_metrics(state.w)

            state = run_flow_pass(state, params)
            pass2_metrics = state.get_metrics(state.v) # Sum components to match GPU debug output

            state = run_erosion_pass(state, params)
            pass3_terrain_metrics = state.get_metrics(state.h)
            pass3_sediment_metrics = state.get_metrics(state.s)

            state = run_transport_pass(state, params)
            pass4_water_metrics = state.get_metrics(state.w)
            pass4_sediment_metrics = state.get_metrics(state.s)

            state = run_deposition_pass(state, params)
            pass5_terrain_metrics = state.get_metrics(state.h)
            pass5_sediment_metrics = state.get_metrics(state.s)

            state = run_evaporation_pass(state, params)
            pass6_metrics = state.get_metrics(state.w)

            python_data_capture.append({
                "frame": total_iterations,
                "data": {
                    "pass1_water": pass1_metrics, "pass2_velocity": pass2_metrics,
                    "pass3_terrain": pass3_terrain_metrics, "pass3_sediment": pass3_sediment_metrics,
                    "pass4_water": pass4_water_metrics, "pass4_sediment": pass4_sediment_metrics,
                    "pass5_terrain": pass5_terrain_metrics, "pass5_sediment": pass5_sediment_metrics,
                    "pass6_water": pass6_metrics
                }
            })
            total_iterations += 1

    # Construct the output filename from the input path
    base_name = os.path.basename(input_file_path)
    name_without_ext, _ = os.path.splitext(base_name)

    # The input filename might be 'sim_capture_hydraulic-debug'. We want the output to be 'sim_capture_cpu.json'.
    # We find the base part of the filename before any model suffix.
    output_base = 'sim_capture' if name_without_ext.startswith('sim_capture_') else name_without_ext
    output_filename = f"{output_base}_cpu.json"
    output_filepath = os.path.join(results_directory_path, output_filename)

    # Ensure the output directory exists
    os.makedirs(results_directory_path, exist_ok=True)

    output_data = {"history": capture['history'], "data": python_data_capture}
    with open(output_filepath, 'w') as f:
        json.dump(output_data, f, indent=2)

    print(f"\n--- Simulation Complete ---")
    print(f"Python output saved to '{output_filepath}'")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Python Hydraulic Erosion Validator")
    parser.add_argument("input_file", help="Path to the captured data JSON file from the WebGPU app.")
    parser.add_argument("results_directory_path", help="Path to the directory to save the output JSON file.")
    args = parser.parse_args()
    main(args.input_file, args.results_directory_path)