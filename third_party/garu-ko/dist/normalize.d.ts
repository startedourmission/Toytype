/**
 * Text normalization utilities for Garu Korean morphological analyzer.
 * Pre-processes informal/non-standard Korean text before analysis.
 */
export interface NormalizeOptions {
    /** Collapse repeated jamo (ㅋㅋㅋ→ㅋㅋ). Default: true */
    jamo?: boolean;
    /** Expand 2-char jamo abbreviations (ㄱㅅ→감사). Default: false */
    jamoAbbrev?: boolean;
    /** Normalize common dialect stems (워디→어디). Default: false */
    dialect?: boolean;
}
export declare function normalizeText(text: string, opts?: NormalizeOptions): string;
export interface Segment {
    text: string;
    /** Character offset of this segment in the original text */
    offset: number;
}
export declare function splitSentences(text: string): Segment[];
