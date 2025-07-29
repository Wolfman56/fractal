export function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            reject(new Error(`Promise timed out after ${ms} ms`));
        }, ms);

        promise.then(resolve).catch(reject).finally(() => clearTimeout(timeoutId));
    });
}

export async function checkShaderCompilation(pipeline, name) {
    if (pipeline && typeof pipeline.getCompilationInfo === 'function') {
        const info = await pipeline.getCompilationInfo();
        if (info.messages.length > 0) {
            let hasErrors = false;
            console.warn(`Compilation messages for ${name}:`);
            for (const message of info.messages) {
                const logFn = message.type === 'error' ? console.error : console.warn;
                logFn(`  > [${message.type}] ${message.message} (line ${message.lineNum})`);
                if (message.type === 'error') hasErrors = true;
            }
            if (hasErrors) throw new Error(`Shader compilation failed for ${name}.`);
        }
    } else {
        console.warn(`[Debug] pipeline.getCompilationInfo() not available for '${name}'. Skipping check.`);
    }
}

/**
 * Calculates the required bytesPerRow and buffer size for texture-buffer copies,
 * respecting the 256-byte alignment rule for bytesPerRow.
 * @param {number} width The width of the texture.
 * @param {number} height The height of the texture.
 * @param {number} bytesPerPixel The number of bytes per pixel (e.g., 4 for r32float).
 * @returns {{bytesPerRow: number, bufferSize: number}}
 */
export function getPaddedByteRange(width, height, bytesPerPixel) {
    const bytesPerRow = Math.ceil(width * bytesPerPixel / 256) * 256;
    // The total buffer size must be large enough for the padded data.
    const bufferSize = bytesPerRow * height;
    return { bytesPerRow, bufferSize };
}

/**
 * Creates a new, padded buffer from a compact buffer to satisfy WebGPU's
 * 256-byte row alignment requirement for texture copies.
 * @param {Float32Array} unpaddedSource The compact source data.
 * @param {number} width The width of the texture.
 * @param {number} height The height of the texture.
 * @returns {{paddedBuffer: Uint8Array, bytesPerRow: number}}
 */
export function padBuffer(unpaddedSource, width, height) {
    const bytesPerPixel = unpaddedSource.BYTES_PER_ELEMENT;
    const { bytesPerRow, bufferSize } = getPaddedByteRange(width, height, bytesPerPixel);

    const paddedBuffer = new Uint8Array(bufferSize);
    const unpaddedRowBytes = width * bytesPerPixel;
    const srcView = new Uint8Array(unpaddedSource.buffer, unpaddedSource.byteOffset, unpaddedSource.byteLength);

    for (let y = 0; y < height; y++) {
        const srcOffset = y * unpaddedRowBytes;
        const dstOffset = y * bytesPerRow;
        paddedBuffer.set(srcView.subarray(srcOffset, srcOffset + unpaddedRowBytes), dstOffset);
    }
    return { paddedBuffer, bytesPerRow };
}