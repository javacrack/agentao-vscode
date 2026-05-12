const path = require("path");

/** @type {import("webpack").Configuration} */
const extensionConfig = {
  target: "node",
  mode: "none",
  entry: "./src/extension.ts",
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: "ts-loader",
        exclude: /node_modules/,
      },
    ],
  },
  resolve: {
    extensions: [".ts", ".js"],
  },
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "extension.js",
    libraryTarget: "commonjs2",
    devtoolModuleFilenameTemplate: "../[resource-path]",
  },
  externals: {
    vscode: "commonjs vscode",
  },
  devtool: "nosources-source-map",
};

/** @type {import("webpack").Configuration} */
const webviewConfig = {
  target: "web",
  mode: "none",
  entry: "./src/chat/webview/chat.ts",
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: "ts-loader",
        exclude: /node_modules/,
      },
    ],
  },
  resolve: {
    extensions: [".ts", ".js"],
  },
  output: {
    path: path.resolve(__dirname, "dist", "webview"),
    filename: "chat.js",
    devtoolModuleFilenameTemplate: "../[resource-path]",
  },
  devtool: "nosources-source-map",
  optimization: {
    usedExports: true,
  },
  performance: {
    maxAssetSize: 1500000,
    maxEntrypointSize: 1500000,
  },
};

module.exports = [extensionConfig, webviewConfig];
