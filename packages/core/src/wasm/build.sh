#!/bin/bash

# Build script for compiling C code to WebAssembly using Emscripten
# Requires Emscripten SDK to be installed and activated

set -e  # Exit on error

echo "Building WASM module for keyframes scene detection..."

# Set up Emscripten environment
if [ -d "/tmp/emsdk" ]; then
    # Linux/macOS CI environment
    export EMSDK="/tmp/emsdk"
    export EM_CONFIG="$EMSDK/.emscripten"
    export EM_CACHE="$EMSDK/upstream/emscripten/cache"

    # On Linux, use system Python (no need for emsdk's Python)
    if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" ]]; then
        # Windows/Cygwin - use .exe extensions
        export EMSDK_NODE="$EMSDK/node/22.16.0_64bit/bin/node.exe"
        export EMSDK_PYTHON="$EMSDK/python/3.13.3_64bit/python.exe"
        export PATH="$EMSDK/python/3.13.3_64bit:$EMSDK/node/22.16.0_64bit/bin:$EMSDK/upstream/emscripten:$PATH"
    else
        # Linux/macOS - no .exe extensions, use system Python
        export PATH="$EMSDK/upstream/emscripten:$PATH"
    fi

    if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" ]]; then
        EMCC="$EMSDK/upstream/emscripten/emcc.bat"
    else
        EMCC="$EMSDK/upstream/emscripten/emcc"
    fi
elif command -v emcc &> /dev/null; then
    EMCC="emcc"
else
    echo "Error: Emscripten compiler (emcc) not found!"
    echo "Please install Emscripten SDK"
    exit 1
fi

echo "Using emcc: $EMCC"
echo "Using Python: $(which python 2>/dev/null || echo 'not in PATH')"

# Output directory — core's dist (consumed by node + web packages)
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
OUTPUT_DIR="$SCRIPT_DIR/../../dist"
mkdir -p "$OUTPUT_DIR"
cd "$SCRIPT_DIR"

# Compile C code to WebAssembly
"$EMCC" detection.c wasm-interface.c \
  -O3 \
  -msimd128 \
  -s WASM=1 \
  -s EXPORTED_FUNCTIONS='["_MEanalysis_js","_calculate_padded_size","_pad_frame","_allocate_mb_array","_free_mb_array","_malloc","_free"]' \
  -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","getValue","setValue","HEAPU8"]' \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s EXPORT_NAME='createWasmModule' \
  -s ENVIRONMENT='web,worker,node' \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s TOTAL_STACK=5MB \
  -s INITIAL_MEMORY=64MB \
  -s MAXIMUM_MEMORY=2GB \
  -s ASSERTIONS=0 \
  -s MALLOC='emmalloc' \
  --no-entry \
  -I. \
  -o "$OUTPUT_DIR/detection.js"

# Emscripten emits `detection.js` (glue) + `detection.wasm` (binary) from -o detection.js.
# Rename the glue to `detection.wasm.js` so the public import paths stay stable
# (and internal locateFile still finds `detection.wasm` next to it).
mv "$OUTPUT_DIR/detection.js" "$OUTPUT_DIR/detection.wasm.js"
# Old runs may have left behind detection.wasm.wasm — clean it up.
rm -f "$OUTPUT_DIR/detection.wasm.wasm"

echo "WASM build complete!"
echo "Output files:"
echo "  - $OUTPUT_DIR/detection.wasm.js  (ES-module glue)"
echo "  - $OUTPUT_DIR/detection.wasm     (binary)"
