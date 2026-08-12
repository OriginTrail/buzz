/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Opt-in review UI; still requires the relay's dkg-trust@1 capability. */
  readonly VITE_BUZZ_DKG_WEB_OF_TRUST?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
