import Constants, { AppOwnership, ExecutionEnvironment } from "expo-constants";
import { Platform } from "react-native";

/** Strip BOM/quotes from .env paste mistakes (common cause of invalid_client). */
function sanitizeGoogleClientId(raw: string): string {
  let s = raw.trim().replace(/^\uFEFF/, "");
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

export function getGoogleClientIds() {
  const extra = Constants.expoConfig?.extra as
    | {
        googleIosClientId?: string;
        googleAndroidClientId?: string;
        googleWebClientId?: string;
        expoAuthProxyRedirect?: string;
      }
    | undefined;
  return {
    ios: sanitizeGoogleClientId(extra?.googleIosClientId ?? ""),
    android: sanitizeGoogleClientId(extra?.googleAndroidClientId ?? ""),
    web: sanitizeGoogleClientId(extra?.googleWebClientId ?? ""),
  };
}

/**
 * Development / standalone iOS builds use native OAuth (custom URL scheme).
 * The iOS field must be a Google "iOS" OAuth client. Reusing the Web client ID
 * here makes Google show invalid_client (Web clients cannot use custom-scheme redirects).
 */
export function isGoogleNativeIosWebClientIdCollision(): boolean {
  if (Platform.OS !== "ios" || isExpoGoRuntime()) return false;
  const { ios, web } = getGoogleClientIds();
  return Boolean(ios && web && ios === web);
}

/** User-facing hint when Connect is disabled due to misconfiguration. */
export function getGoogleOAuthSetupHint(): string | undefined {
  if (Platform.OS === "android") return undefined;
  const { ios, web } = getGoogleClientIds();
  if (!web) return undefined;
  if (Platform.OS === "ios" && !isExpoGoRuntime()) {
    if (!ios) {
      return "Dev / standalone iOS: add EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID (iOS application OAuth client from Google Cloud), then rebuild.";
    }
    if (ios === web) {
      return "Dev / standalone iOS: use two different OAuth clients — Web client ID for tokens, and a separate iOS client ID (Google Cloud → iOS). Do not paste the Web ID into the iOS field.";
    }
  }
  return undefined;
}

/** Expo Go: SDK may not always report StoreClient; appOwnership is reliable. */
export function isExpoGoRuntime(): boolean {
  return (
    Constants.executionEnvironment === ExecutionEnvironment.StoreClient ||
    Constants.appOwnership === AppOwnership.Expo
  );
}

/**
 * HTTPS redirect for Expo’s auth proxy. Set `expo.expoAuthProxyRedirect` in app.json when needed,
 * or rely on `owner` + `slug` from app config.
 */
export function getAuthExpoProxyRedirectUri(): string | null {
  const extra = Constants.expoConfig?.extra as { expoAuthProxyRedirect?: string } | undefined;
  const explicit = extra?.expoAuthProxyRedirect?.trim();
  const owner = Constants.expoConfig?.owner;
  const slug = Constants.expoConfig?.slug;
  const raw =
    explicit ||
    (owner && slug ? `https://auth.expo.io/@${owner}/${slug}` : "");
  if (!raw) return null;
  try {
    const u = new URL(raw);
    u.hash = "";
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
      u.pathname = u.pathname.replace(/\/+$/, "");
    }
    return u.toString();
  } catch {
    return raw;
  }
}

/**
 * Google iOS OAuth clients use a reversed client-id URL scheme as redirect (development / standalone builds).
 * Must match CFBundleURLSchemes added in app.config.js from the same iOS client ID.
 */
export function iosGoogleOAuthRedirectUri(iosClientId: string): string | null {
  const s = iosClientId.trim();
  if (!s.endsWith(".apps.googleusercontent.com")) return null;
  const prefix = s.slice(0, -".apps.googleusercontent.com".length);
  if (!prefix) return null;
  return `com.googleusercontent.apps.${prefix}:/oauthredirect`;
}

/**
 * True when this build can run Google OAuth for Calendar on the current platform.
 * Android is disabled until an Android OAuth client and native SHA-1 setup are added.
 * In Expo Go on iOS, only GOOGLE_WEB_CLIENT_ID is required (proxy + Web client); iOS native client is for dev builds.
 */
export function isGoogleOAuthConfiguredForPlatform(): boolean {
  if (Platform.OS === "android") return false;
  const { ios, web } = getGoogleClientIds();
  if (!web) return false;
  if (Platform.OS === "ios") {
    if (isExpoGoRuntime()) return Boolean(web);
    return Boolean(ios) && !isGoogleNativeIosWebClientIdCollision();
  }
  return Boolean(web);
}
