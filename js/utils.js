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