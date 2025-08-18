#!/usr/bin/env python3
"""
Test script for SWE-bench VS Code Extension integration

This script creates a simple test task to verify that the file-based
communication system is working correctly.
"""

import json
import time
from pathlib import Path

# Define the same IPC paths as in the extension
IPC_DIR = Path.home() / ".my-agent-ipc"
TASK_FILE_PATH = IPC_DIR / "ipc-task.json"
RESULT_FILE_PATH = IPC_DIR / "ipc-result.json"

def setup_test():
    """Set up the test environment."""
    print("[Test] Setting up test environment...")
    
    # Ensure the IPC directory exists
    IPC_DIR.mkdir(exist_ok=True)
    
    # Clean up any existing files
    if TASK_FILE_PATH.exists():
        TASK_FILE_PATH.unlink()
    if RESULT_FILE_PATH.exists():
        RESULT_FILE_PATH.unlink()
    
    # Create empty task file
    TASK_FILE_PATH.touch()
    print(f"[Test] Created IPC directory: {IPC_DIR}")

def run_test():
    """Run a simple test task."""
    print("[Test] Running integration test...")
    
    # Get current working directory as test repo
    test_repo_path = str(Path.cwd())
    
    # Create a test task
    test_task = {
        "instance_id": "test-integration-001",
        "problem_statement": "Create a simple test function that returns 'Hello, SWE-bench!' in a new file called test_hello.py",
        "repo_path": test_repo_path
    }
    
    print(f"[Test] Writing test task...")
    print(f"[Test] Repo path: {test_repo_path}")
    print(f"[Test] Problem: {test_task['problem_statement']}")
    
    # Write the task
    TASK_FILE_PATH.write_text(json.dumps(test_task, indent=2))
    
    # Wait for result
    print("[Test] Waiting for result (timeout: 120s)...")
    timeout_seconds = 120
    start_time = time.time()
    
    while not RESULT_FILE_PATH.exists():
        time.sleep(1)
        elapsed = time.time() - start_time
        
        if int(elapsed) % 10 == 0 and elapsed > 0:
            print(f"[Test] Still waiting... ({int(elapsed)}s elapsed)")
        
        if elapsed > timeout_seconds:
            print("[Test] ❌ TIMEOUT: No result received")
            print("[Test] Make sure:")
            print("  1. VS Code is running")
            print("  2. The AI Code Assist extension is installed and activated")
            print("  3. Check the 'AI code assist' output channel in VS Code")
            return False
    
    # Read and display result
    try:
        result_content = RESULT_FILE_PATH.read_text()
        result = json.loads(result_content)
        
        print(f"[Test] ✅ SUCCESS: Received result!")
        print(f"[Test] Instance ID: {result.get('instance_id', 'N/A')}")
        
        if 'error' in result:
            print(f"[Test] ⚠️  Agent returned error: {result['error']}")
            return False
        
        patch = result.get('patch', '')
        print(f"[Test] Patch length: {len(patch)} characters")
        
        if patch:
            print("[Test] ✅ Patch generated successfully!")
            print("[Test] First 200 characters of patch:")
            print("=" * 50)
            print(patch[:200] + ("..." if len(patch) > 200 else ""))
            print("=" * 50)
        else:
            print("[Test] ⚠️  No patch generated")
        
        return True
        
    except (json.JSONDecodeError, FileNotFoundError) as e:
        print(f"[Test] ❌ ERROR: Could not read result: {e}")
        return False

def cleanup():
    """Clean up test files."""
    print("[Test] Cleaning up...")
    if TASK_FILE_PATH.exists():
        TASK_FILE_PATH.unlink()
    if RESULT_FILE_PATH.exists():
        RESULT_FILE_PATH.unlink()

def main():
    """Main test function."""
    print("=" * 60)
    print("SWE-bench VS Code Extension Integration Test")
    print("=" * 60)
    
    try:
        setup_test()
        success = run_test()
        
        if success:
            print("\n[Test] 🎉 Integration test completed successfully!")
            print("[Test] Your extension is ready for SWE-bench evaluation.")
        else:
            print("\n[Test] ❌ Integration test failed.")
            print("[Test] Please check the troubleshooting section in SWE_BENCH_README.md")
            
    except KeyboardInterrupt:
        print("\n[Test] Test interrupted by user.")
    except Exception as e:
        print(f"\n[Test] Unexpected error: {e}")
    finally:
        cleanup()
    
    print("\n" + "=" * 60)

if __name__ == "__main__":
    main()
