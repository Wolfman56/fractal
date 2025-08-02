import numpy as np
from scipy.ndimage import map_coordinates
import re

def camel_to_snake(name):
    """Converts a camelCase string to snake_case."""
    # This handles cases like 'camelCase' -> 'camel_case'
    name = re.sub(r'(.)([A-Z][a-z]+)', r'\1_\2', name)
    # This handles cases like 'MyAPI' -> 'my_api' and ensures single-word keys are handled.
    return re.sub('([a-z0-9])([A-Z])', r'\1_\2', name).lower()

class CPUErosionModel:
    """
    A Python-based implementation of the hydraulic erosion simulation pipeline.
    This class encapsulates the state and logic, making it reusable for tasks
    like validation and parameter optimization.
    """
    class Parameters:
        def __init__(self):
            self.grid_size = 16
            self.dt = 0.05
            self.height_multiplier = 0.5
            self.cell_size = 1.0 # snake_case
            self.velocity_damping = 0.99
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

        def get_metrics(self, grid):
            return {
                "sum": float(np.sum(grid)),
                "min": float(np.min(grid)),
                "max": float(np.max(grid)),
                "avg": float(np.mean(grid)),
            }

    def __init__(self, grid_size=256):
        self.grid_size = grid_size
        self.params = self.Parameters()
        self.params.grid_size = grid_size
        self.state = self.SimulationState(grid_size)

    def _initialize_terrain(self):
        # Create a mathematically perfect sloped plane from 0 to the current height_multiplier.
        # This provides a consistent, world-space initial state for validation.
        x_coords = np.linspace(0, self.params.height_multiplier, self.grid_size)
        self.state.h = np.tile(x_coords, (self.grid_size, 1))

    def set_params(self, param_dict, add_rain=False):
        for key, value in param_dict.items():
            snake_key = camel_to_snake(key)
            if not hasattr(self.params, snake_key):
                # print(f"Warning: Parameter '{key}' (as '{snake_key}') not found in CPU model, skipping.")
                continue
            setattr(self.params, snake_key, value)
        self.params.add_rain = add_rain

    def run_single_step(self):
        """Runs one full iteration of the 6 simulation passes."""
        self._run_water_pass()
        self._run_flow_pass()
        self._run_erosion_pass()
        self._run_transport_pass()
        self._run_deposition_pass()
        self._run_evaporation_pass()

    def _run_water_pass(self):
        if self.params.add_rain:
            self.state.w += self.params.rain_amount

    def _run_flow_pass(self):
        # The terrain height `self.state.h` is already in world-space meters.
        H = self.state.h + self.state.w
        H_padded = np.pad(H, pad_width=1, mode='edge')
        grad_x = (H_padded[1:-1, 2:] - H_padded[1:-1, :-2]) / (2.0 * self.params.cell_size)
        grad_y = (H_padded[2:, 1:-1] - H_padded[:-2, 1:-1]) / (2.0 * self.params.cell_size)
        grad = np.stack((grad_x, grad_y), axis=-1)
        self.state.v -= self.params.dt * self.params.density * grad
        self.state.v *= self.params.velocity_damping

    def _run_erosion_pass(self):
        velocity_mag = np.linalg.norm(self.state.v, axis=-1)
        capacity = np.maximum(self.params.min_slope, velocity_mag) * self.state.w * self.params.capacity_factor
        has_capacity = capacity > self.state.s
        amount_to_erode = (capacity - self.state.s) * self.params.solubility
        erosion_amount = np.where(has_capacity, np.minimum(amount_to_erode, self.state.h), 0)
        self.state.h -= erosion_amount
        self.state.s += erosion_amount

    def _run_transport_pass(self):
        y_coords, x_coords = np.mgrid[0:self.grid_size, 0:self.grid_size]
        prev_y = y_coords - (self.state.v[:, :, 1] * self.params.dt) / self.params.cell_size
        prev_x = x_coords - (self.state.v[:, :, 0] * self.params.dt) / self.params.cell_size
        coords = np.array([prev_y.ravel(), prev_x.ravel()])
        self.state.w = map_coordinates(self.state.w, coords, order=1, mode='nearest').reshape(self.state.w.shape)
        self.state.s = map_coordinates(self.state.s, coords, order=1, mode='nearest').reshape(self.state.s.shape)

    def _run_deposition_pass(self):
        velocity_mag = np.linalg.norm(self.state.v, axis=-1)
        capacity = np.maximum(self.params.min_slope, velocity_mag) * self.state.w * self.params.capacity_factor
        is_over_capacity = self.state.s > capacity
        amount_to_deposit = (self.state.s - capacity) * self.params.deposition_rate
        deposition_amount = np.where(is_over_capacity, np.minimum(amount_to_deposit, self.state.s), 0)
        self.state.h += deposition_amount
        self.state.s -= deposition_amount

    def _run_evaporation_pass(self):
        self.state.w *= np.maximum(0.0, (1.0 - self.params.evap_rate * self.params.dt))