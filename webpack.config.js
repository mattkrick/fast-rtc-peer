const path = require('path')
const CleanWebpackPlugin = require('clean-webpack-plugin')
const nodeExternals = require('webpack-node-externals');

module.exports = {
  mode: 'development',
  devtool: 'source-map',
  entry: {
    FastRTCPeer: path.join(__dirname, 'src', 'FastRTCPeer.ts')
  },
  output: {
    path: path.join(__dirname, './dist'),
    filename: '[name].js',
    libraryTarget: 'commonjs2',
    library: 'FastRTCPeer'
  },
  resolve: {
    extensions: ['.ts']
  },
  externals: [nodeExternals()],
  module: {
    rules: [
      {
        test: /\.ts$/,
        loader: 'awesome-typescript-loader'
      }
    ]
  },
  plugins: [
    new CleanWebpackPlugin([path.join(__dirname, 'dist/**/*')])
  ]
}
