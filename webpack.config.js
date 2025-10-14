//@ts-check

'use strict';

const path = require('path');

/** @type {import('webpack').Configuration} */
const config = {
  target: 'node', // VS Code extensions run in a Node.js context
  mode: 'none', // Use 'production' when packaging

  entry: './src/extension.ts', // The entry point of your extension
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'extension.js',
    libraryTarget: 'commonjs2'
  },
  externals: {
    vscode: 'commonjs vscode', // The 'vscode' module is provided by the runtime
    // List other modules that cannot be bundled or have native dependencies
    'onnxruntime-node': 'commonjs onnxruntime-node',
    '@lancedb/lancedb': 'commonjs @lancedb/lancedb',
    'tree-sitter': 'commonjs tree-sitter',
    'tree-sitter-java': 'commonjs tree-sitter-java',
    'tree-sitter-javascript': 'commonjs tree-sitter-javascript',
    'tree-sitter-typescript': 'commonjs tree-sitter-typescript',
    sharp: 'commonjs sharp'
  },
  resolve: {
    extensions: ['.ts', '.js']
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [
          {
            loader: 'ts-loader'
          }
        ]
      }
    ]
  },
  devtool: 'nosources-source-map',
};
module.exports = config;