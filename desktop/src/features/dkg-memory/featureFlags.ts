type DkgWebOfTrustBuildEnv = Pick<ImportMetaEnv, "VITE_BUZZ_DKG_WEB_OF_TRUST">;

/**
 * Web of Trust is an opt-in review feature. Keeping this check centralized
 * prevents a relay capability from exposing experimental UI in stable builds.
 */
export function isDkgWebOfTrustUiEnabled(
  env: DkgWebOfTrustBuildEnv = import.meta.env,
): boolean {
  const value = env.VITE_BUZZ_DKG_WEB_OF_TRUST?.trim().toLowerCase();
  return value === "1" || value === "true";
}

/** Web of Trust UI requires both build-time opt-in and relay support. */
export function shouldShowDkgWebOfTrustUi(
  trustCapabilityAvailable: boolean,
  env: DkgWebOfTrustBuildEnv = import.meta.env,
): boolean {
  return trustCapabilityAvailable && isDkgWebOfTrustUiEnabled(env);
}
