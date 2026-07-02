import { GaruBase } from './core.js';
import type { LoadOptions } from './core.js';
export type { POS, Token, AnalyzeResult, AnalyzeOptions, NounsOptions, LoadOptions, ModelInfo, NormalizeOptions, Segment, } from './core.js';
export { normalizeText, splitSentences } from './normalize.js';
/**
 * Node-targeted Garu. Resolves WASM and model bytes via `fs/promises`.
 * Browser code paths must not import this entry — use `garu-ko` directly
 * (resolves via package.json conditional exports) or import from
 * `garu-ko/browser`.
 */
export declare class Garu extends GaruBase {
    static load(options?: LoadOptions): Promise<Garu>;
}
