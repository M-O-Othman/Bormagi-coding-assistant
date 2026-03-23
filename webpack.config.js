'use strict';

const path = require('path');

/** @type {import('webpack').Configuration} */
const extensionConfig = {
  target: 'node',
  mode: 'none',
  entry: './src/extension.ts',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'extension.js',
    libraryTarget: 'commonjs2'
  },
  externals: {
    vscode: 'commonjs vscode'
  },
  resolve: {
    extensions: ['.ts', '.js'],
    extensionAlias: {
      '.js': ['.ts', '.js']
    }
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [{ loader: 'ts-loader' }]
      }
    ]
  },
  devtool: 'nosources-source-map',
  infrastructureLogging: {
    level: 'log'
  }
};

/** @type {import('webpack').Configuration} */
const mcpServersConfig = {
  target: 'node',
  mode: 'none',
  entry: {
    'filesystem-server': './src/mcp/builtin/filesystem-server.ts',
    'terminal-server': './src/mcp/builtin/terminal-server.ts',
    'git-server': './src/mcp/builtin/git-server.ts',
    'gcp-server': './src/mcp/builtin/gcp-server.ts',
    'collaboration-server': './src/mcp/builtin/collaboration-server.ts',
    'code-nav-server': './src/mcp/builtin/code-nav-server.ts'
  },
  output: {
    path: path.resolve(__dirname, 'dist', 'mcp-servers'),
    filename: '[name].js',
    libraryTarget: 'commonjs2'
  },
  resolve: {
    extensions: ['.ts', '.js'],
    extensionAlias: {
      '.js': ['.ts', '.js']
    }
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [{ loader: 'ts-loader' }]
      }
    ]
  },
  devtool: 'nosources-source-map'
};

module.exports = [extensionConfig, mcpServersConfig];
