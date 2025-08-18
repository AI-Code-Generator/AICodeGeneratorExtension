#!/bin/bash

# Setup script for SWE-bench evaluation with VS Code extension

echo "=========================================="
echo "SWE-bench VS Code Extension Setup"
echo "=========================================="

# Check if Python is installed
if ! command -v python3 &> /dev/null; then
    echo "ERROR: Python 3 is not installed. Please install Python 3 first."
    exit 1
fi

echo "✓ Python 3 found"

# Check if pip is installed
if ! command -v pip3 &> /dev/null && ! command -v pip &> /dev/null; then
    echo "ERROR: pip is not installed. Please install pip first."
    exit 1
fi

echo "✓ pip found"

# Install required Python packages
echo "Installing required Python packages..."
pip3 install datasets huggingface_hub

# Create IPC directory
IPC_DIR="$HOME/.my-agent-ipc"
mkdir -p "$IPC_DIR"
echo "✓ Created IPC directory: $IPC_DIR"

# Check if VS Code is installed
if ! command -v code &> /dev/null; then
    echo "WARNING: VS Code 'code' command not found in PATH."
    echo "Please make sure VS Code is installed and the 'code' command is available."
else
    echo "✓ VS Code found"
fi

echo ""
echo "=========================================="
echo "Setup Instructions"
echo "=========================================="
echo ""
echo "1. Download SWE-bench repositories:"
echo "   git clone https://github.com/princeton-nlp/SWE-bench_repos.git"
echo "   # OR download pre-processed repositories from SWE-bench release"
echo ""
echo "2. Update the SWE_BENCH_REPOS_PATH in swe_bench_driver.py"
echo "   to point to your downloaded repositories"
echo ""
echo "3. Open VS Code and install your extension:"
echo "   code ."
echo "   # Then install the extension in VS Code"
echo ""
echo "4. Run the evaluation:"
echo "   python3 swe_bench_driver.py --dataset_name princeton-nlp/SWE-bench_Lite"
echo ""
echo "=========================================="
echo "Files created:"
echo "- swe_bench_driver.py (main evaluation script)"
echo "- src/service/SWEBenchAgent.ts (agent implementation)"
echo "- IPC directory: $IPC_DIR"
echo "=========================================="
