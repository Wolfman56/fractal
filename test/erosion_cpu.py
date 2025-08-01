import numpy as np
import json
import argparse
import os
from scipy.ndimage import map_coordinates

# This script provides a CPU-based implementation of the hydraulic erosion
# simulation pipeline. It can be run as a standalone validator or imported
# as a module by other tools (e.g., parameter optimizers).

class Parameters:
    def __init__(self):
        # Default values, will be overwritten by loaded data
        self.grid_size = 16
        self.dt = 0.05
        self.height_multiplier = 0.5
        self.damping = 0.99
        self.min_slope = 0.01
        self.density = 50000
        self.rain_amount = 0.0
        self.evap_rate = 0.0
        self.solubility = 0.01
        self.deposition_rate = 0.5
        self.capacity_factor = 4.0


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

    grad_x = (H_padded[1:-1, 2:] - H_padded[1:-1, :-2]) / 2.0
    grad_y = (H_padded[2:, 1:-1] - H_padded[:-2, 1:-1]) / 2.0

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
    state.w *= (1.0 - params.evap_rate * params.dt)
    return state

class CPUErosionModel:
    """A class that encapsulates the CPU-based hydraulic erosion simulation."""
    def __init__(self, grid_size):
        """Initializes the model with a given grid size."""
        self.params = Parameters()
        self.params.grid_size = grid_size
        self.state = SimulationState(grid_size)
        self._create_initial_terrain()

    def _create_initial_terrain(self):
        """Creates a mathematically perfect sloped plane for the initial state."""
        x_coords = np.linspace(0, 1, self.params.grid_size)
        self.state.h = np.tile(x_coords, (self.params.grid_size, 1))

    def set_params(self, params_dict, add_rain):
        """Updates the simulation parameters from a dictionary."""
        self.params.grid_size = params_dict['gridSize']
        self.params.height_multiplier = params_dict['heightMultiplier']
        self.params.density = params_dict['density']
        self.params.rain_amount = params_dict['rainAmount'] if add_rain else 0.0
        self.params.evap_rate = params_dict['evapRate']
        self.params.solubility = params_dict['solubility']
        self.params.deposition_rate = params_dict['depositionRate']
        self.params.capacity_factor = params_dict['capacityFactor']
        self.params.dt = params_dict['dt']
        self.params.min_slope = params_dict['minSlope']
        self.params.damping = params_dict['velocityDamping']

    def run_single_step(self):
        """Runs one full iteration of the 6-pass simulation and returns metrics."""
        self.state = run_water_pass(self.state, self.params)
        pass1_metrics = self.state.get_metrics(self.state.w)

        self.state = run_flow_pass(self.state, self.params)
        pass2_metrics = self.state.get_metrics(self.state.v)

        self.state = run_erosion_pass(self.state, self.params)
        pass3_terrain_metrics = self.state.get_metrics(self.state.h)
        pass3_sediment_metrics = self.state.get_metrics(self.state.s)

        self.state = run_transport_pass(self.state, self.params)
        pass4_water_metrics = self.state.get_metrics(self.state.w)
        pass4_sediment_metrics = self.state.get_metrics(self.state.s)

        self.state = run_deposition_pass(self.state, self.params)
        pass5_terrain_metrics = self.state.get_metrics(self.state.h)
        pass5_sediment_metrics = self.state.get_metrics(self.state.s)

        self.state = run_evaporation_pass(self.state, self.params)
        pass6_metrics = self.state.get_metrics(self.state.w)

        return {
            "pass1_water": pass1_metrics, "pass2_velocity": pass2_metrics,
            "pass3_terrain": pass3_terrain_metrics, "pass3_sediment": pass3_sediment_metrics,
            "pass4_water": pass4_water_metrics, "pass4_sediment": pass4_sediment_metrics,
            "pass5_terrain": pass5_terrain_metrics, "pass5_sediment": pass5_sediment_metrics,
            "pass6_water": pass6_metrics
        }

def main(input_file_path, results_directory_path):
    """Main function to run the script as a standalone validator."""
    print("--- Initializing CPU Erosion Validator ---")
    try:
        with open(input_file_path, 'r') as f:
            capture = json.load(f)
    except FileNotFoundError:
        print(f"Error: Input file not found at '{input_file_path}'")
        return

    # Assume grid size is constant from the first command's parameters
    grid_size = capture['history'][0]['params']['gridSize']
    model = CPUErosionModel(grid_size)

    print("Initial State:")
    model.state.print_metric("Terrain Height", model.state.h)
    print("-" * 30)

    python_data_capture = []
    total_iterations = 0

    for command in capture['history']:
        print(f"\n>>> Executing Command: {command['iterations']} iterations, Rain={command['rain']} <<<")
        model.set_params(command['params'], command['rain'])

        for i in range(command['iterations']):
            frame_data = model.run_single_step()
            python_data_capture.append({"frame": total_iterations, "data": frame_data})
            total_iterations += 1

    # Construct the output filename from the input path
    base_name = os.path.basename(input_file_path)
    name_without_ext, _ = os.path.splitext(base_name)
    output_filename = f"{name_without_ext}_output.json"
    output_filepath = os.path.join(results_directory_path, output_filename)

    # Ensure the output directory exists
    os.makedirs(results_directory_path, exist_ok=True)

    output_data = {"history": capture['history'], "data": python_data_capture}
    with open(output_filepath, 'w') as f:
        json.dump(output_data, f, indent=2)

    print(f"\n--- Simulation Complete ---")
    print(f"Python output saved to '{output_filepath}'")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="CPU-based Hydraulic Erosion Validator")
    parser.add_argument("input_file", help="Path to the captured data JSON file from the WebGPU app.")
    parser.add_argument("results_directory_path", help="Path to the directory to save the output JSON file.")
    args = parser.parse_args()
    main(args.input_file, args.results_directory_path)