import typescript from '@rollup/plugin-typescript';
import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';

export default {
  input: 'dist/index.js',
  output: [
    {
      file: 'dist/keyframes.cjs.js',
      format: 'cjs',
      sourcemap: true
    },
    {
      file: 'dist/keyframes.esm.js',
      format: 'es',
      sourcemap: true
    }
  ],
  external: ['fluent-ffmpeg', '@ffmpeg-installer/ffmpeg', 'fs', 'path', 'stream', 'events', 'worker_threads'],
  plugins: [
    resolve(),
    commonjs()
  ]
};
