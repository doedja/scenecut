/**
 * Minimal VSHelper.h replacement for WASM build
 * Only includes the macros needed by detection.c
 */

#ifndef VSHELPER_H
#define VSHELPER_H

#include <stdint.h>

// Min/Max macros from VapourSynth
#define VSMIN(a,b) ((a) > (b) ? (b) : (a))
#define VSMAX(a,b) ((a) < (b) ? (b) : (a))

#endif // VSHELPER_H
