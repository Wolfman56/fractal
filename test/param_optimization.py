import json
import os
import numpy as np
from skopt import gp_minimize
from skopt.space import Real, Integer
from skopt.utils import use_named_args

from erosion_cpu import CPUErosionModel

# --- Optimization Target ---
# Define the goal for the optimizer.
# Here, we want to erode 5% of the initial average terrain height over 100 iterations.
TARGET_EROSION_PERCENT = 5.0
NUM_ITERATIONS = 100
GRID_SIZE = 64 # Use a smaller grid for faster optimization runs

# --- Parameter Search Space ---
# Define the range for each parameter the optimizer can tweak.
# Using Real for continuous values and Integer for discrete ones.
param_space = [
    Real(0.001, 0.1, name='solubility', prior='log-uniform'),
    Real(0.01, 1.0, name='capacityFactor', prior='uniform'),
    Real(1.0, 50.0, name='density', prior='uniform'),
    Real(0.1, 0.9, name='depositionRate', prior='uniform')
]

@use_named_args(param_space)
def objective_function(**params):
    """
    This is the core of the optimizer. It takes a set of parameters,
    runs the CPU simulation, and returns a 'loss' value indicating
    how close the result was to our target. The optimizer's goal
    is to find the parameters that minimize this loss.
    """
    # 1. Initialize the CPU erosion model
    model = CPUErosionModel(GRID_SIZE)
    
    # 2. Get the initial state
    initial_avg_height = np.mean(model.state.h)
    if initial_avg_height == 0: return 1e6 # Avoid division by zero on flat terrain

    # 3. Set the simulation parameters for this run
    # We use a fixed set of base parameters and override them with the
    # values being tested by the optimizer.
    sim_params = {
        "gridSize": GRID_SIZE,
        "heightMultiplier": 64.0, # Scale height to grid size
        "rainAmount": 0.001,
        "evapRate": 0.01,
        "dt": 0.01,
        "minSlope": 0.01,
        "velocityDamping": 0.99,
        **params # Optimizer parameters override defaults
    }
    model.set_params(sim_params, add_rain=True)

    # 4. Run the simulation
    for _ in range(NUM_ITERATIONS):
        model.run_single_step()

    # 5. Evaluate the result
    final_avg_height = np.mean(model.state.h)
    total_erosion = initial_avg_height - final_avg_height
    actual_erosion_percent = (total_erosion / initial_avg_height) * 100

    # 6. Calculate the loss
    # The loss is the absolute difference between our result and our target.
    # A smaller loss is better.
    loss = abs(actual_erosion_percent - TARGET_EROSION_PERCENT)

    print(f"Testing params: sol={params['solubility']:.4f}, cap={params['capacityFactor']:.2f}, dens={params['density']:.2f}, depo={params['depositionRate']:.2f} -> Erosion: {actual_erosion_percent:.2f}%, Loss: {loss:.4f}")

    return loss

def main():
    """
    Main function to set up and run the Bayesian optimization process.
    """
    print("--- Starting Parameter Optimization ---")
    print(f"Target: Erode {TARGET_EROSION_PERCENT}% of average height in {NUM_ITERATIONS} iterations.")
    print(f"Search space defined for: {[dim.name for dim in param_space]}")
    print("-" * 40)

    # gp_minimize performs Bayesian optimization using Gaussian Processes.
    # It's efficient for expensive objective functions like our simulation.
    result = gp_minimize(
        func=objective_function,
        dimensions=param_space,
        n_calls=50,  # Number of different parameter sets to try
        random_state=42,
        n_initial_points=10 # Start with 10 random trials before optimizing
    )

    print("\n--- Optimization Complete ---")
    print(f"Best Loss: {result.fun:.4f}")

    # Extract and format the best parameters found
    best_parameters = {dim.name: val for dim, val in zip(param_space, result.x)}
    
    print("\nBest parameters found:")
    print(json.dumps(best_parameters, indent=2))

    # Save the results to a JSON file
    output_filename = "optimized_params.json"
    output_filepath = os.path.join(os.path.dirname(__file__), output_filename)

    # We create a structure that can be easily copied into the 'erosion'
    # section of the main config.json file.
    output_data = {
        "solubility": best_parameters['solubility'],
        "deposition": best_parameters['depositionRate'],
        "capacity": best_parameters['capacityFactor'],
        "density": best_parameters['density']
    }

    with open(output_filepath, 'w') as f:
        json.dump(output_data, f, indent=2)

    print(f"\nOptimized parameters saved to '{output_filepath}'")
    print("You can copy the contents of this file into the 'erosion' section of your main config.json.")

if __name__ == "__main__":
    main()