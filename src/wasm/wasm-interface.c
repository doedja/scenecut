#include <stdlib.h>
#include <string.h>
#include <emscripten.h>
#include "detection.h"

/**
 * JavaScript-callable wrapper for MEanalysis
 *
 * This function allocates necessary structures and calls the original
 * MEanalysis function from detection.c
 *
 * @param pRefPtr Pointer to reference frame in WASM memory
 * @param pCurPtr Pointer to current frame in WASM memory
 * @param width Frame width (before padding)
 * @param height Frame height (before padding)
 * @param intraCount Number of consecutive non-scene-change frames
 * @param fcode Motion search range parameter (4 = 256 pixels)
 * @return 1 if scene change detected, 0 otherwise
 */
EMSCRIPTEN_KEEPALIVE
int MEanalysis_js(
    uint32_t pRefPtr,
    uint32_t pCurPtr,
    uint32_t width,
    uint32_t height,
    int intraCount,
    int fcode
) {
    // Cast pointers from memory addresses
    const uint8_t *pRef = (const uint8_t*)pRefPtr;
    const uint8_t *pCur = (const uint8_t*)pCurPtr;

    // Calculate macroblock parameters
    MBParam param;
    param.width = width;
    param.height = height;
    param.mb_width = (width + 15) / 16;
    param.mb_height = (height + 15) / 16;
    param.edged_width = 16 * param.mb_width + 2 * 64;  // 64 = edge_size
    param.edged_height = 16 * param.mb_height + 2 * 64;
    param.edge_size = 64;

    // Allocate macroblock array
    MACROBLOCK *pMBs = (MACROBLOCK*)malloc(param.mb_width * param.mb_height * sizeof(MACROBLOCK));
    if (!pMBs) {
        return 0;  // Allocation failed, assume no scene change
    }

    // Initialize macroblock array
    memset(pMBs, 0, param.mb_width * param.mb_height * sizeof(MACROBLOCK));

    // Call original MEanalysis
    int sceneChange = MEanalysis(
        pRef,
        pCur,
        &param,
        pMBs,
        intraCount,
        fcode
    );

    // Free allocated memory
    free(pMBs);

    return sceneChange;
}

/**
 * Helper function to calculate required buffer size for padded frame
 *
 * @param width Original frame width
 * @param height Original frame height
 * @return Required buffer size in bytes
 */
EMSCRIPTEN_KEEPALIVE
uint32_t calculate_padded_size(uint32_t width, uint32_t height) {
    uint32_t mb_width = (width + 15) / 16;
    uint32_t mb_height = (height + 15) / 16;
    uint32_t edged_width = 16 * mb_width + 2 * 64;
    uint32_t edged_height = 16 * mb_height + 2 * 64;
    return edged_width * edged_height;
}

/**
 * Helper function to pad a frame
 *
 * Pads a frame to macroblock boundaries (16x16) and adds edge padding (64 pixels)
 *
 * @param srcPtr Pointer to source frame data
 * @param dstPtr Pointer to destination (padded) buffer
 * @param width Original frame width
 * @param height Original frame height
 */
EMSCRIPTEN_KEEPALIVE
void pad_frame(
    uint32_t srcPtr,
    uint32_t dstPtr,
    uint32_t width,
    uint32_t height
) {
    const uint8_t *src = (const uint8_t*)srcPtr;
    uint8_t *dst = (uint8_t*)dstPtr;

    uint32_t mb_width = (width + 15) / 16;
    uint32_t mb_height = (height + 15) / 16;
    uint32_t edged_width = 16 * mb_width + 2 * 64;
    uint32_t edged_height = 16 * mb_height + 2 * 64;

    const int edge_size = 64;

    // Clear destination buffer
    memset(dst, 0, edged_width * edged_height);

    // Copy frame data to center of padded buffer
    for (uint32_t y = 0; y < height; y++) {
        memcpy(
            dst + (y + edge_size) * edged_width + edge_size,
            src + y * width,
            width
        );
    }

    // Pad right edge (if frame width is not multiple of 16)
    uint32_t padded_width = mb_width * 16;
    if (width < padded_width) {
        for (uint32_t y = 0; y < height; y++) {
            uint8_t edge_value = src[y * width + width - 1];
            for (uint32_t x = width; x < padded_width; x++) {
                dst[(y + edge_size) * edged_width + edge_size + x] = edge_value;
            }
        }
    }

    // Pad bottom edge (if frame height is not multiple of 16)
    uint32_t padded_height = mb_height * 16;
    if (height < padded_height) {
        for (uint32_t y = height; y < padded_height; y++) {
            memcpy(
                dst + (y + edge_size) * edged_width + edge_size,
                dst + (height - 1 + edge_size) * edged_width + edge_size,
                padded_width
            );
        }
    }

    // Pad the 64-pixel border on all sides
    // Top and bottom borders
    for (int i = 0; i < edge_size; i++) {
        // Top border
        memcpy(
            dst + i * edged_width,
            dst + edge_size * edged_width,
            edged_width
        );
        // Bottom border
        memcpy(
            dst + (edged_height - 1 - i) * edged_width,
            dst + (edged_height - 1 - edge_size) * edged_width,
            edged_width
        );
    }

    // Left and right borders
    for (uint32_t y = 0; y < edged_height; y++) {
        uint8_t left_val = dst[y * edged_width + edge_size];
        uint8_t right_val = dst[y * edged_width + edge_size + padded_width - 1];

        // Left border
        for (int i = 0; i < edge_size; i++) {
            dst[y * edged_width + i] = left_val;
        }
        // Right border
        for (int i = 0; i < edge_size; i++) {
            dst[y * edged_width + edge_size + padded_width + i] = right_val;
        }
    }
}
