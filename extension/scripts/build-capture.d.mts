/** Types for build-capture.mjs, so the frontend's freshness test can import it. */
export declare const SOURCE_DIR: string;
export declare const OUT_DIR: string;
export declare const sourceFiles: () => string[];
export declare const buildCapture: (options?: { check?: boolean }) => string[];
