/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Opt-in review UI; still requires the relay's dkg-trust@1 capability. */
  readonly VITE_BUZZ_DKG_WEB_OF_TRUST?: string;
  /** Optional release page used by distribution flavors requiring manual updates. */
  readonly VITE_BUZZ_RELEASES_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
