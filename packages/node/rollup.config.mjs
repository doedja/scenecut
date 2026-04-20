import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';

const external = [
  'fluent-ffmpeg',
  '@ffmpeg-installer/ffmpeg',
  '@ffprobe-installer/ffprobe',
  'fs', 'path', 'stream', 'events', 'worker_threads', 'module', 'url', 'os'
];

export default [
  // Main library — CJS + ESM
  {
    input: 'dist/index.js',
    output: [
      { file: 'dist/scenecut.cjs.js', format: 'cjs', sourcemap: true },
      { file: 'dist/scenecut.esm.js', format: 'es', sourcemap: true }
    ],
    external,
    plugins: [resolve(), commonjs()]
  },
  // Motion worker — ESM only (Node worker_threads can consume ESM)
  {
    input: 'dist/motion-worker.js',
    output: {
      file: 'dist/motion-worker.mjs',
      format: 'es',
      sourcemap: true
    },
    external,
    plugins: [resolve(), commonjs()]
  }
];
