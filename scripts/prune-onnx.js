const fs = require('fs');
const path = require('path');

// Path to the ONNX runtime binaries
const onnxBinPath = path.join(__dirname, '..', 'node_modules', 'onnxruntime-node', 'bin');

// Keep only the 'cpu' directory, as it is the most general-purpose
const keepDir = 'cpu';

if (fs.existsSync(onnxBinPath)) {
  const subdirs = fs.readdirSync(onnxBinPath);
  console.log(`Pruning ONNX runtime binaries in: ${onnxBinPath}`);

  subdirs.forEach(dir => {
    if (dir !== keepDir) {
      const dirPath = path.join(onnxBinPath, dir);
      console.log(`- Removing ${dir}...`);
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
  });

  console.log(`Pruning complete. Kept only the '${keepDir}' directory.`);
} else {
  console.log('ONNX runtime binary path not found, skipping prune.');
}