import json
import argparse

# ANSI color codes for terminal output
class bcolors:
    HEADER = '\033[95m'
    OKBLUE = '\033[94m'
    OKCYAN = '\033[96m'
    OKGREEN = '\033[92m'
    WARNING = '\033[93m'
    FAIL = '\033[91m'
    ENDC = '\033[0m'
    BOLD = '\033[1m'
    UNDERLINE = '\033[4m'

def compare_values(gpu_val, py_val):
    """Compares two values, calculates differences, and returns a color-coded string."""
    try:
        # GPU values are strings, Python values are floats
        v_gpu = float(gpu_val)
        v_py = float(py_val)
    except (ValueError, TypeError):
        return f"{str(gpu_val):>12} | {str(py_val):>12} | {'N/A':>10} | {'N/A':>10}"

    diff = v_gpu - v_py
    rel_diff_pct = (diff / v_gpu * 100) if abs(v_gpu) > 1e-9 else 0

    color = bcolors.OKGREEN
    if abs(rel_diff_pct) > 5.0:
        color = bcolors.FAIL
    elif abs(rel_diff_pct) > 1.0:
        color = bcolors.WARNING

    return f"{color}{v_gpu:>12.4f} | {v_py:>12.4f} | {diff:>10.4f} | {rel_diff_pct:>9.2f}%{bcolors.ENDC}"

def main(gpu_filepath, py_filepath):
    try:
        with open(gpu_filepath, 'r') as f:
            gpu_capture = json.load(f)
        with open(py_filepath, 'r') as f:
            py_capture = json.load(f)
    except FileNotFoundError as e:
        print(f"{bcolors.FAIL}Error: File not found - {e.filename}{bcolors.ENDC}")
        return
    except json.JSONDecodeError as e:
        print(f"{bcolors.FAIL}Error decoding JSON: {e}{bcolors.ENDC}")
        return

    gpu_data = gpu_capture.get('data', [])
    py_data = py_capture.get('data', [])

    if len(gpu_data) != len(py_data):
        print(f"{bcolors.WARNING}Warning: Frame counts differ. GPU: {len(gpu_data)}, Python: {len(py_data)}. Comparing up to the shorter length.{bcolors.ENDC}")

    print(f"{bcolors.HEADER}{'='*80}\n{'Simulation Comparison':^80}\n{'='*80}{bcolors.ENDC}")
    print(f"{'PASS':<28} | {'METRIC':<6} | {'GPU VALUE':>12} | {'PY VALUE':>12} | {'ABSOLUTE':>10} | {'REL. DIFF':>10}")
    print(f"{'-'*80}")

    for i, (frame_gpu, frame_py) in enumerate(zip(gpu_data, py_data)):
        print(f"\n{bcolors.BOLD}{bcolors.OKBLUE}--- FRAME {i} ---{bcolors.ENDC}")
        
        gpu_pass_data = frame_gpu.get('data', {})
        py_pass_data = frame_py.get('data', {})
        
        all_pass_keys = sorted(list(set(gpu_pass_data.keys()) | set(py_pass_data.keys())))

        for pass_key in all_pass_keys:
            gpu_metrics = gpu_pass_data.get(pass_key, {})
            py_metrics = py_pass_data.get(pass_key, {})
            
            all_metric_keys = sorted(list(set(gpu_metrics.keys()) & set(py_metrics.keys())))

            for metric_key in all_metric_keys:
                # The 'nonZero' key from GPU capture is for info only, not comparison.
                if metric_key == 'nonZero':
                    continue
                
                comparison_str = compare_values(gpu_metrics[metric_key], py_metrics[metric_key])
                print(f"{pass_key:<28} | {metric_key:<6} | {comparison_str}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Compare WebGPU and Python simulation outputs.")
    parser.add_argument("gpu_file", help="Path to the captured data JSON file from the WebGPU app.")
    parser.add_argument("py_file", help="Path to the output data JSON file from the Python validator.")
    args = parser.parse_args()
    main(args.gpu_file, args.py_file)