#!/usr/bin/env python3
"""
SWE-bench Driver Script for VS Code Extension

This script runs SWE-bench evaluation against your VS Code extension using
file-based communication. Make sure your VS Code extension is running and
has the SWE-bench communication feature enabled.

Usage:
    python swe_bench_driver.py --dataset_name princeton-nlp/SWE-bench_Lite --output_file predictions.jsonl
"""

import json
import os
import time
import argparse
import shutil
import subprocess
from pathlib import Path
from datasets import load_dataset

# Define the same IPC paths as in the extension
IPC_DIR = Path.home() / ".my-agent-ipc"
TASK_FILE_PATH = IPC_DIR / "ipc-task.json"
RESULT_FILE_PATH = IPC_DIR / "ipc-result.json"

# IMPORTANT: Set this path to where your SWE-bench repositories are located
SWE_BENCH_REPOS_PATH = Path("/home/dushmin/Desktop/swebench/SWE-bench")

def setup_ipc_dir():
    """Ensures the IPC directory exists and files are clean."""
    print(f"[Driver] Setting up IPC directory: {IPC_DIR}")
    IPC_DIR.mkdir(exist_ok=True)
    
    # Clean up any existing files
    if TASK_FILE_PATH.exists():
        TASK_FILE_PATH.unlink()
        print(f"[Driver] Removed existing task file")
    if RESULT_FILE_PATH.exists():
        RESULT_FILE_PATH.unlink()
        print(f"[Driver] Removed existing result file")
    
    # Create empty task file to initialize the watcher
    TASK_FILE_PATH.touch()
    print(f"[Driver] Created task file: {TASK_FILE_PATH}")

def run_agent_on_instance(instance):
    """
    Writes a task to the task file and waits for the result.
    """
    print(f"\n[Driver] Processing instance: {instance['instance_id']}")
    
    repo_path = SWE_BENCH_REPOS_PATH / instance['instance_id']
    if not repo_path.exists():
        print(f"[Driver] Repository path not found: {repo_path}")
        print(f"[Driver] Attempting to download using git...")
        try:
            # 1. Construct the original repository URL
            repo_url = f"https://github.com/{instance['repo']}.git"
            print(f"[Driver] Cloning from {repo_url}...")
            
            # 2. Clone the repository
            subprocess.run(
                ["git", "clone", repo_url, str(repo_path)],
                check=True,
                capture_output=True, # Hide noisy git output
            )
            
            # 3. Check out the specific commit
            print(f"[Driver] Checking out commit {instance['base_commit']}...")
            subprocess.run(
                ["git", "checkout", instance['base_commit']],
                check=True,
                cwd=str(repo_path), # Run this command inside the new repo folder
                capture_output=True,
            )
            
            # 4. (Optional but recommended) Remove .git to save space and avoid issues
            git_dir = repo_path / ".git"
            if git_dir.exists():
                shutil.rmtree(git_dir)

            print(f"[Driver] Successfully downloaded repository for {instance['instance_id']}")
        except subprocess.CalledProcessError as e:
            print(f"[Driver] FATAL: Failed to download repository for {instance['instance_id']}.")
            # Print stderr for more detailed git errors
            print(f"[Driver] Git Error: {e.stderr.decode('utf-8')}")
            return None
        except Exception as e:
            print(f"[Driver] An unexpected error occurred during download: {e}")
            return None
    else:
        print(f"[Driver] Found existing repository at: {repo_path}")

    # Clean up previous result file before starting
    if RESULT_FILE_PATH.exists():
        RESULT_FILE_PATH.unlink()
        print(f"[Driver] Cleaned up previous result file")
        
    TASK_FILE_TEMP_PATH = IPC_DIR / "ipc-task.json.tmp"

    task = {
        "instance_id": instance["instance_id"],
        "problem_statement": instance["problem_statement"],
        "repo_path": str(repo_path) 
    }

    print(f"[Driver] Writing task to file...")
    print(f"[Driver] Problem statement length: {len(task['problem_statement'])} characters")
    
    try:
        # 2. Write to the temporary file first
        TASK_FILE_TEMP_PATH.write_text(json.dumps(task, indent=2))
        
        # 3. Atomically rename the file to trigger the watcher reliably
        os.rename(TASK_FILE_TEMP_PATH, TASK_FILE_PATH)
    except Exception as e:
        print(f"[Driver] Error writing task file: {e}")
        return None

    # Wait for the result file to be created by the extension
    timeout_seconds = 600  # 10 minutes
    start_time = time.time()
    
    print(f"[Driver] Waiting for result (timeout: {timeout_seconds}s)...")
    
    while not RESULT_FILE_PATH.exists():
        time.sleep(1)
        elapsed = time.time() - start_time
        
        # Print progress every 30 seconds
        if int(elapsed) % 30 == 0 and elapsed > 0:
            print(f"[Driver] Still waiting... ({int(elapsed)}s elapsed)")
        
        if elapsed > timeout_seconds:
            print(f"[Driver] Timeout waiting for result for {instance['instance_id']}")
            return None

    # Give a small delay to ensure file is fully written
    time.sleep(1)

    # Read the result
    try:
        result_content = RESULT_FILE_PATH.read_text()
        result = json.loads(result_content)
        
        if 'error' in result:
            print(f"[Driver] Agent returned error: {result['error']}")
            return None
            
        print(f"[Driver] Successfully received result")
        print(f"[Driver] Patch length: {len(result.get('patch', ''))} characters")
        
        return result
        
    except (json.JSONDecodeError, FileNotFoundError) as e:
        print(f"[Driver] Error reading result for {instance['instance_id']}: {e}")
        return None

def validate_setup():
    """Validate that the setup is correct before running."""
    print("[Driver] Validating setup...")
    
    if not SWE_BENCH_REPOS_PATH.exists():
        print(f"[Driver] SWE-bench repositories path does not exist: {SWE_BENCH_REPOS_PATH}")
        print("[Driver] Will download repositories as needed")
    else:
        print(f"[Driver] SWE-bench repositories found at: {SWE_BENCH_REPOS_PATH}")
    
    print("[Driver] Setup validation passed")
    return True

def main(args):
    """Main function to run SWE-bench evaluation."""
    print("=" * 60)
    print("SWE-bench VS Code Extension Driver")
    print("=" * 60)
    
    if not validate_setup():
        return 1
    
    setup_ipc_dir()
    
    print(f"[Driver] Loading dataset: {args.dataset_name}")
    try:
        dataset = load_dataset(args.dataset_name, split="test")
        print(f"[Driver] Loaded {len(dataset)} instances")
    except Exception as e:
        print(f"[Driver] Error loading dataset: {e}")
        return 1

    # Create output directory if it doesn't exist
    output_path = Path(args.output_file)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    successful_predictions = 0
    total_instances = len(dataset)
    
    print(f"[Driver] Starting evaluation of {total_instances} instances...")
    print(f"[Driver] Results will be written to: {args.output_file}")
    print("")
    
    with open(args.output_file, "w") as f:
        for i, instance in enumerate(dataset):
            print(f"[Driver] Progress: {i+1}/{total_instances}")
            
            result = run_agent_on_instance(instance)
            
            if result and result.get("patch"):
                prediction = {
                    "instance_id": result["instance_id"],
                    "model": "ai-code-assist-vscode-extension",
                    "prediction": result["patch"]
                }
                f.write(json.dumps(prediction) + "\n")
                f.flush()  # Ensure data is written immediately
                successful_predictions += 1
                print(f"[Driver] ✓ Successfully processed {result['instance_id']}")
            else:
                print(f"[Driver] ✗ Failed to get a valid patch for {instance['instance_id']}")
            
            # Add a small delay between instances
            time.sleep(2)
    
    print("\n" + "=" * 60)
    print("SWE-bench Evaluation Complete")
    print("=" * 60)
    print(f"Total instances: {total_instances}")
    print(f"Successful predictions: {successful_predictions}")
    print(f"Success rate: {successful_predictions/total_instances*100:.1f}%")
    print(f"Results saved to: {args.output_file}")
    
    return 0

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Run SWE-bench evaluation with VS Code extension")
    parser.add_argument("--dataset_name", type=str, default="princeton-nlp/SWE-bench_Lite",
                       help="Name of the SWE-bench dataset to use")
    parser.add_argument("--output_file", type=str, default="predictions.jsonl",
                       help="Output file for predictions")
    parser.add_argument("--repos_path", type=str, default=None,
                       help="Path to SWE-bench repositories (overrides default)")
    
    args = parser.parse_args()
    
    # Override repos path if provided
    if args.repos_path:
        SWE_BENCH_REPOS_PATH = Path(args.repos_path)
    
    exit_code = main(args)
    exit(exit_code)
