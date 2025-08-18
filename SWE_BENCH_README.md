# SWE-bench Integration for AI Code Assist VS Code Extension

This extension now supports benchmarking against SWE-bench using a file-based communication system. The extension can automatically process SWE-bench tasks and generate patches for evaluation.

## Overview

The SWE-bench integration works by:
1. Watching for task files written by a Python driver script
2. Automatically opening the relevant repository in VS Code
3. Running the AI agent to solve the problem
4. Extracting the generated code changes as a git patch
5. Writing the results back to a file for the driver script to collect

## Setup

### Prerequisites

- VS Code with this extension installed and activated
- Python 3.7+ with pip
- Git
- SWE-bench repository data

### Installation

1. **Run the setup script:**
   ```bash
   ./setup_swe_bench.sh
   ```

2. **Download SWE-bench repositories:**
   ```bash
   # Option 1: Clone the repositories (large download)
   git clone https://github.com/princeton-nlp/SWE-bench_repos.git
   
   # Option 2: Download pre-processed repositories from releases
   # Visit https://github.com/princeton-nlp/SWE-bench/releases
   ```

3. **Update the repository path:**
   Edit `swe_bench_driver.py` and update the `SWE_BENCH_REPOS_PATH` variable to point to your downloaded repositories:
   ```python
   SWE_BENCH_REPOS_PATH = Path("/path/to/your/swe-bench/repositories")
   ```

## Usage

### Running the Evaluation

1. **Start VS Code with the extension:**
   ```bash
   code .
   ```
   Make sure the extension is installed and activated. You should see "AI code assist" in the output channels.

2. **Run the evaluation script:**
   ```bash
   # Evaluate on SWE-bench Lite (recommended for testing)
   python3 swe_bench_driver.py --dataset_name princeton-nlp/SWE-bench_Lite --output_file predictions.jsonl
   
   # Evaluate on full SWE-bench (takes much longer)
   python3 swe_bench_driver.py --dataset_name princeton-nlp/SWE-bench --output_file predictions.jsonl
   ```

3. **Monitor progress:**
   - Check the Python script output for overall progress
   - Check VS Code's "AI code assist" output channel for detailed agent logs
   - The script will show success/failure for each instance

### Output

The evaluation generates a `predictions.jsonl` file with the following format:
```json
{"instance_id": "astropy__astropy-12907", "model": "ai-code-assist-vscode-extension", "prediction": "diff --git a/file.py b/file.py\n..."}
```

## File-based Communication

The system uses file-based IPC (Inter-Process Communication) through:
- **Task file:** `~/.my-agent-ipc/ipc-task.json` - Driver writes tasks here
- **Result file:** `~/.my-agent-ipc/ipc-result.json` - Extension writes results here

### Task Format
```json
{
  "instance_id": "repo__repo-123",
  "problem_statement": "Description of the bug/feature to implement...",
  "repo_path": "/path/to/repository/at/base/commit"
}
```

### Result Format
```json
{
  "instance_id": "repo__repo-123",
  "patch": "diff --git a/file.py b/file.py\n..."
}
```

## Configuration

### Agent Behavior
The SWE-bench agent automatically:
- Approves all terminal commands (no user prompts)
- Has a 10-minute timeout per instance
- Extracts git diffs automatically
- Handles errors gracefully

### Customization
You can modify the agent behavior by editing:
- `src/service/SWEBenchAgent.ts` - Main agent logic
- `src/service/AgentService.ts` - Core agent functionality
- `swe_bench_driver.py` - Driver script parameters

## Troubleshooting

### Common Issues

1. **"Repository path does not exist"**
   - Ensure SWE-bench repositories are downloaded
   - Check the `SWE_BENCH_REPOS_PATH` in `swe_bench_driver.py`

2. **"Timeout waiting for result"**
   - Check VS Code output channel for errors
   - Ensure the extension is activated
   - Try increasing timeout in the driver script

3. **"Agent returned error"**
   - Check the AI service is running and accessible
   - Verify the `config.ts` serverUrl is correct
   - Check network connectivity

4. **Empty or invalid patches**
   - The agent may not have made any changes
   - Check if the problem statement was understood correctly
   - Review agent logs in VS Code output

### Debugging

1. **Enable verbose logging:**
   - Check "AI code assist" output channel in VS Code
   - Monitor Python script output
   - Check files in `~/.my-agent-ipc/`

2. **Test manually:**
   ```bash
   # Create a test task
   echo '{"instance_id":"test","problem_statement":"Add a hello world function","repo_path":"/path/to/test/repo"}' > ~/.my-agent-ipc/ipc-task.json
   
   # Check result
   cat ~/.my-agent-ipc/ipc-result.json
   ```

## Performance Tips

1. **Use SWE-bench Lite first** - Much smaller dataset for testing
2. **Monitor memory usage** - VS Code may use significant RAM with large repositories
3. **Run in batches** - Process subsets of the dataset if needed
4. **Check timeouts** - Adjust timeout values based on your hardware

## Evaluation

To evaluate your results against SWE-bench ground truth, use the official SWE-bench evaluation tools:

```bash
# Install SWE-bench evaluation tools
pip install swe-bench

# Run evaluation
python -m swebench.harness.run_evaluation \
    --predictions_path predictions.jsonl \
    --swe_bench_tasks princeton-nlp/SWE-bench_Lite \
    --log_dir logs \
    --testbed /path/to/testbed
```

## Architecture

```
Python Driver Script  ←→  File System  ←→  VS Code Extension
     (swe_bench_driver.py)     (IPC files)      (SWEBenchAgent)
                                                       ↓
                                               AgentService
                                                       ↓
                                              VS Code Workspace
                                                       ↓
                                               Git Diff Output
```

The system is designed to be:
- **Asynchronous:** Non-blocking communication between processes
- **Robust:** Handles errors and timeouts gracefully
- **Scalable:** Can process large datasets
- **Observable:** Comprehensive logging and monitoring
