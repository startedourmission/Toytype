export { normalizeText, splitSentences } from './normalize.js';
export const EMPTY_RESULT = Object.freeze({
    tokens: [],
    score: 0,
    elapsed: 0,
});
/**
 * Shared analyzer instance. The browser/node entry points subclass this and
 * provide their own `static load()` that resolves WASM and model bytes via
 * environment-appropriate APIs (fetch vs fs).
 */
export class GaruBase {
    constructor(wasmInstance, modelSize) {
        this._wasm = wasmInstance;
        this._loaded = true;
        this._modelSize = modelSize;
    }
    /**
     * Analyze Korean text, returning morphological tokens with scores.
     *
     * When `options.topN` is greater than 1, returns an array of N-best results.
     * Otherwise returns a single AnalyzeResult.
     *
     * Note: topN > 1 is not yet fully supported and may return fewer results.
     */
    analyze(text, options) {
        if (!this._loaded) {
            throw new Error('Garu instance has been destroyed');
        }
        const topN = options?.topN ?? 1;
        if (topN > 1) {
            if (text === '') {
                return [{ ...EMPTY_RESULT, tokens: [] }];
            }
            return this._wasm.analyze_topn(text, topN);
        }
        if (text === '') {
            return { ...EMPTY_RESULT, tokens: [] };
        }
        return this._wasm.analyze(text);
    }
    /**
     * Quick tokenisation — returns an array of surface-form strings.
     */
    tokenize(text) {
        if (!this._loaded) {
            throw new Error('Garu instance has been destroyed');
        }
        if (text === '') {
            return [];
        }
        return this._wasm.tokenize(text);
    }
    /**
     * Extract nouns (NNG, NNP) from text.
     * Set `options.includeSL` to also include foreign tokens (SL) like "AI", "BM25".
     */
    nouns(text, options) {
        if (!this._loaded) {
            throw new Error('Garu instance has been destroyed');
        }
        if (text === '') {
            return [];
        }
        const result = this._wasm.analyze(text);
        const includeSL = options?.includeSL ?? false;
        return result.tokens
            .filter((t) => t.pos === 'NNG' || t.pos === 'NNP' || (includeSL && t.pos === 'SL'))
            .map((t) => t.text);
    }
    /**
     * Whether the WASM analyzer is loaded and ready.
     */
    isLoaded() {
        return this._loaded;
    }
    /**
     * Return metadata about the loaded model.
     */
    modelInfo() {
        return {
            version: this._wasm.constructor.version(),
            size: this._modelSize,
            accuracy: 0.954,
        };
    }
    /**
     * Free the WASM instance and mark this Garu as unloaded.
     */
    destroy() {
        if (this._wasm) {
            this._wasm.free();
            this._wasm = null;
        }
        this._loaded = false;
    }
}
