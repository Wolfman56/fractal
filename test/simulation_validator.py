import numpy as np
import json
import argparse
import os
from erosion_cpu import CPUErosionModel

class bcolors:
    WARNING = '\033[93m'
    ENDC = '\033[0m'

def main(input_file_path, results_directory_path):
    print("--- Initializing Simulation from Capture File ---")
    try:
        with open(input_file_path, 'r') as f:
            capture = json.load(f)
    except FileNotFoundError:
        print(f"Error: Input file not found at '{input_file_path}'")
        return
    except json.JSONDecodeError:
        print(f"Error: Could not decode JSON from '{input_file_path}'")
        return

    if 'generationParams' in capture and capture['generationParams']:
        print("Found generation parameters in capture file.")
        gen_params = capture['generationParams']
        grid_size = gen_params['gridSize']
    else:
        print(f"{bcolors.WARNING}Warning: No 'generationParams' in capture file. Using first erosion command for setup.{bcolors.ENDC}")
        gen_params = capture['history'][0]['params']
        grid_size = gen_params['gridSize']

    model = CPUErosionModel(grid_size)

    # Set params from the generation params to correctly initialize the terrain.
    model.set_params(gen_params)
    model._initialize_terrain()

    print(f"Initial State (Grid Size: {grid_size}):")
    print(f"  - Terrain Height: Sum={np.sum(model.state.h):.4f}")
    print("-" * 30)

    python_data_capture = []
    total_iterations = 0

    for command in capture['history']:
        print(f"\n>>> Executing Command: {command['iterations']} iterations, Rain={command['rain']} <<<")
        model.set_params(command['params'], command['rain'])

        for i in range(command['iterations']):
            # To correctly mimic the GPU capture, we must run each pass
            # individually and capture the metrics in between.
            data = {}

            model._run_water_pass()
            data["pass1_water"] = model.state.get_metrics(model.state.w)

            model._run_flow_pass()
            data["pass2_velocity"] = model.state.get_metrics(model.state.v)

            model._run_erosion_pass()
            data["pass3_terrain"] = model.state.get_metrics(model.state.h)
            data["pass3_sediment"] = model.state.get_metrics(model.state.s)

            model._run_transport_pass()
            data["pass4_water"] = model.state.get_metrics(model.state.w)
            data["pass4_sediment"] = model.state.get_metrics(model.state.s)

            model._run_deposition_pass()
            data["pass5_terrain"] = model.state.get_metrics(model.state.h)
            data["pass5_sediment"] = model.state.get_metrics(model.state.s)

            model._run_evaporation_pass()
            data["pass6_water"] = model.state.get_metrics(model.state.w)

            python_data_capture.append({"frame": total_iterations, "data": data})
            total_iterations += 1

    base_name = os.path.basename(input_file_path)
    name_without_ext, _ = os.path.splitext(base_name)
    output_base = 'sim_capture' if name_without_ext.startswith('sim_capture_') else name_without_ext
    output_filename = f"{output_base}_cpu.json"
    output_filepath = os.path.join(results_directory_path, output_filename)

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