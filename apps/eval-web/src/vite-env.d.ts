/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_LANGFUSE_PROJECT_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
