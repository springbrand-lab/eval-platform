/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_TAKT_ORIGIN?: string;
  readonly VITE_DEV_AUTH?: string;
  readonly VITE_LANGFUSE_PROJECT_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
