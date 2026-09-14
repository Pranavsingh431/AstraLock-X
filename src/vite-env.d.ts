/// <reference types="vite/client" />

/** Application version, injected at build time from package.json. */
declare const __APP_VERSION__: string;
declare const __SOURCE_COMMIT__: string | null;
declare const __SOURCE_TREE_MODIFIED__: boolean | null;
