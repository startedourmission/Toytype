import { GaruBase } from './core.js';
import type { LoadOptions } from './core.js';
export type { POS, Token, AnalyzeResult, AnalyzeOptions, NounsOptions, LoadOptions, ModelInfo, NormalizeOptions, Segment, } from './core.js';
export { normalizeText, splitSentences } from './normalize.js';
/**
 * Browser-targeted Garu. Resolves WASM and model assets via `fetch` and
 * `new URL(..., import.meta.url)`. Has no Node-only imports (`fs/promises`,
 * `url`, `path`), so bundlers (Vite, Webpack, Rollup) emit a clean
 * browser-only chunk.
 */
export declare class Garu extends GaruBase {
    static load(options?: LoadOptions): Promise<Garu>;
}
