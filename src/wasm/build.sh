#!/bin/bash

# Build script for compiling C code to WebAssembly using Emscripten
# Requires Emscripten SDK to be installed and activated

set -e  # Exit on error

echo "Building WASM module for keyframes scene detection..."

# Set up Emscripten environment
if [ -d "/tmp/emsdk" ]; then
    export EMSDK="/tmp/emsdk"
    export EM_CONFIG="$EMSDK/.emscripten"
    export EM_CACHE="$EMSDK/upstream/emscripten/cache"
    export EMSDK_NODE="$EMSDK/node/22.16.0_64bit/bin/node.exe"
    export EMSDK_PYTHON="$EMSDK/python/3.13.3_64bit/python.exe"

    # Add Python to PATH to override Windows Store alias
    export PATH="$EMSDK/python/3.13.3_64bit:$EMSDK/node/22.16.0_64bit/bin:$EMSDK/upstream/emscripten:$PATH"

    EMCC="$EMSDK/upstream/emscripten/emcc"
elif command -v emcc &> /dev/null; then
    EMCC="emcc"
else
    echo "Error: Emscripten compiler (emcc) not found!"
    echo "Please install Emscripten SDK"
    exit 1
fi

echo "Using emcc: $EMCC"
echo "Using Python: $(which python 2>/dev/null || echo 'not in PATH')"

# Output directory
OUTPUT_DIR="../../dist"
mkdir -p "$OUTPUT_DIR"

# Compile C code to WebAssembly
"$EMCC" detection.c wasm-interface.c \
  -O3 \
  -msimd128 \
  -s WASM=1 \
  -s EXPORTED_FUNCTIONS='["_MEanalysis_js","_calculate_padded_size","_pad_frame","_malloc","_free"]' \
  -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","getValue","setValue","HEAPU8"]' \
  -s MODULARIZE=1 \
  -s EXPORT_NAME='createWasmModule' \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s TOTAL_STACK=5MB \
  -s INITIAL_MEMORY=64MB \
  -s MAXIMUM_MEMORY=2GB \
  -s ASSERTIONS=0 \
  -s MALLOC='emmalloc' \
  --no-entry \
  -I. \
  -o "$OUTPUT_DIR/detection.wasm.js"

echo "WASM build complete!"
echo "Output files:"
echo "  - $OUTPUT_DIR/detection.wasm.js"
echo "  - $OUTPUT_DIR/detection.wasm"
