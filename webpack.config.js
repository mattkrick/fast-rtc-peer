const path = require('path')

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
  externals: ['eventemitter3', 'uuid/v4'],
  module: {
    rules: [
      {
        test: /\.ts$/,
        loader: 'awesome-typescript-loader'
      }
    ]
  }
}
