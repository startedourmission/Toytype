export type POS = 'NNG' | 'NNP' | 'NNB' | 'NR' | 'NP' | 'VV' | 'VA' | 'VX' | 'VCP' | 'VCN' | 'MAG' | 'MAJ' | 'MM' | 'IC' | 'JKS' | 'JKC' | 'JKG' | 'JKO' | 'JKB' | 'JKV' | 'JKQ' | 'JX' | 'JC' | 'EP' | 'EF' | 'EC' | 'ETN' | 'ETM' | 'XPN' | 'XSN' | 'XSV' | 'XSA' | 'XR' | 'SF' | 'SP' | 'SS' | 'SE' | 'SO' | 'SW' | 'SH' | 'SL' | 'SN';
export interface Token {
    text: string;
    pos: POS;
    start: number;
    end: number;
    score?: number;
}
export interface AnalyzeResult {
    tokens: Token[];
    score: number;
    elapsed: number;
}
export { normalizeText, splitSentences } from './normalize.js';
export type { NormalizeOptions, Segment } from './normalize.js';
export interface AnalyzeOptions {
    topN?: number;
}
export interface NounsOptions {
    includeSL?: boolean;
}
export interface LoadOptions {
    modelData?: ArrayBuffer;
    modelUrl?: string;
    /** 분석 결과의 자모 형태소(ETM 'ㄴ' 등)를 U+11xx 결합 자모로 정규화.
     *  기본값 false (gold v15k 다수가 호환 자모 U+3130-318F를 사용). canonical 출력이 필요하면 true. */
    normalizeJamo?: boolean;
}
export interface ModelInfo {
    version: string;
    size: number;
    accuracy: number;
}
export declare const EMPTY_RESULT: AnalyzeResult;
/**
 * Shared analyzer instance. The browser/node entry points subclass this and
 * provide their own `static load()` that resolves WASM and model bytes via
 * environment-appropriate APIs (fetch vs fs).
 */
export declare class GaruBase {
    protected _wasm: any;
    protected _loaded: boolean;
    protected _modelSize: number;
    protected constructor(wasmInstance: any, modelSize: number);
    /**
     * Analyze Korean text, returning morphological tokens with scores.
     *
     * When `options.topN` is greater than 1, returns an array of N-best results.
     * Otherwise returns a single AnalyzeResult.
     *
     * Note: topN > 1 is not yet fully supported and may return fewer results.
     */
    analyze(text: string, options?: AnalyzeOptions): AnalyzeResult | AnalyzeResult[];
    /**
     * Quick tokenisation — returns an array of surface-form strings.
     */
    tokenize(text: string): string[];
    /**
     * Extract nouns (NNG, NNP) from text.
     * Set `options.includeSL` to also include foreign tokens (SL) like "AI", "BM25".
     */
    nouns(text: string, options?: NounsOptions): string[];
    /**
     * Whether the WASM analyzer is loaded and ready.
     */
    isLoaded(): boolean;
    /**
     * Return metadata about the loaded model.
     */
    modelInfo(): ModelInfo;
    /**
     * Free the WASM instance and mark this Garu as unloaded.
     */
    destroy(): void;
}
