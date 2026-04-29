import * as Google from "expo-auth-session/providers/google";
import * as WebBrowser from "expo-web-browser";
import { useEffect, useState, useCallback, useMemo } from "react";
import { Alert, Platform } from "react-native";
import {
  getAuthExpoProxyRedirectUri,
  getGoogleClientIds,
  iosGoogleOAuthRedirectUri,
  isExpoGoRuntime,
  isGoogleOAuthConfiguredForPlatform,
} from "./googleCalendarConfig";
import {
  disconnectGoogleCalendar,
  getValidAccessToken,
  hasGoogleCalendarSession,
  saveTokenResponseFromAuth,
} from "./googleCalendarTokens";
import type { TokenResponse } from "expo-auth-session";

WebBrowser.maybeCompleteAuthSession();

const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

/** Lets Google issue a refresh token for PKCE / Calendar API (requires offline when exchanging). */
const OFFLINE_ACCESS_EXTRA = { access_type: "offline" as const };

/**
 * Expo Go uses redirect URIs like exp://192.168.x.x:8081, which Google OAuth does not allow
 * on Web or iOS clients. Use the Expo Auth proxy (HTTPS) + Web client ID so redirect_uri is
 * https://auth.expo.io/@owner/slug — register that exact URL under the Google Cloud "Web client"
 * Authorized redirect URIs.
 */
function useGoogleAuthRequestConfig() {
  const { ios, android, web } = getGoogleClientIds();
  return useMemo(() => {
    const proxyRedirect = getAuthExpoProxyRedirectUri();

    if (isExpoGoRuntime() && proxyRedirect && web) {
      return {
        webClientId: web,
        iosClientId: web,
        androidClientId: web,
        redirectUri: proxyRedirect,
        scopes: [CALENDAR_SCOPE],
        extraParams: OFFLINE_ACCESS_EXTRA,
      };
    }

    if (Platform.OS === "ios" && ios) {
      const nativeRedirect = iosGoogleOAuthRedirectUri(ios);
      if (nativeRedirect) {
        return {
          webClientId: web || undefined,
          iosClientId: ios,
          androidClientId: android || undefined,
          redirectUri: nativeRedirect,
          scopes: [CALENDAR_SCOPE],
          extraParams: OFFLINE_ACCESS_EXTRA,
        };
      }
    }

    return {
      webClientId: web || undefined,
      iosClientId: ios || undefined,
      androidClientId: android || undefined,
      scopes: [CALENDAR_SCOPE],
      extraParams: OFFLINE_ACCESS_EXTRA,
    };
  }, [ios, android, web]);
}

export function useGoogleCalendarAuth(options?: { userId?: string; apiBase?: string }) {
  const authConfig = useGoogleAuthRequestConfig();
  const [request, response, promptAsync] = Google.useAuthRequest(authConfig);

  const [connected, setConnected] = useState(false);

  const refreshConnected = useCallback(async () => {
    setConnected(await hasGoogleCalendarSession());
  }, []);

  useEffect(() => {
    void refreshConnected();
  }, [refreshConnected]);

  useEffect(() => {
    async function onSuccess() {
      if (response?.type !== "success" || !response.authentication) return;
      await saveTokenResponseFromAuth(response.authentication);
      await syncTokenToBackend(response.authentication);
      setConnected(true);
    }
    void onSuccess();
  }, [response]);

  const canConnect = isGoogleOAuthConfiguredForPlatform();

  async function syncTokenToBackend(auth: TokenResponse): Promise<void> {
    if (!options?.userId || !options?.apiBase) return;
    const cfg = auth.getRequestConfig();
    await fetch(`${options.apiBase}/users/${options.userId}/google-calendar-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        refreshToken: cfg.refreshToken ?? null,
        accessToken: cfg.accessToken ?? null,
        expiresIn: cfg.expiresIn ?? null,
        scope: cfg.scope ?? null,
      }),
    }).catch(() => {});
  }

  async function connect(): Promise<{ ok: boolean; message?: string }> {
    if (!canConnect || !request) {
      return {
        ok: false,
        message:
          isExpoGoRuntime()
            ? "Google Calendar is not configured. For Expo Go set GOOGLE_WEB_CLIENT_ID (Web application OAuth client) and restart Metro. Add https://auth.expo.io/@OWNER/SLUG to that Web client’s Authorized redirect URIs (see app.json owner/slug or extra.expoAuthProxyRedirect)."
            : "Google Calendar is not configured. Set GOOGLE_WEB_CLIENT_ID and GOOGLE_IOS_CLIENT_ID in the environment and rebuild. On a dev client, the iOS ID must be an iOS OAuth client type — not the same string as the Web client ID.",
      };
    }

    const ids = getGoogleClientIds();
    if (isExpoGoRuntime() && !ids.web) {
      Alert.alert(
        "Missing Web Client ID",
        "The app did not load a Google Web client ID. Create mobile/.env with:\n\nEXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID=your-id.apps.googleusercontent.com\n\nRestart with a clean cache: npx expo start -c"
      );
      return { ok: false, message: "Missing GOOGLE_WEB_CLIENT_ID in app config." };
    }

    if (__DEV__) {
      try {
        const authUrl = await request.makeAuthUrlAsync(Google.discovery);
        const u = new URL(authUrl);
        console.log(
          "[Google OAuth]",
          "client_id=",
          u.searchParams.get("client_id"),
          "redirect_uri=",
          u.searchParams.get("redirect_uri")
        );
      } catch {
        /* ignore */
      }
    }

    // Ephemeral Safari sessions block cookies; Expo’s auth.expo.io proxy needs a normal session
    // to finish PKCE + redirect. Default is false — set explicitly for clarity on iOS.
    const result = await promptAsync({
      showInRecents: Platform.OS === "ios",
      preferEphemeralSession: false,
    });
    if (result.type === "success") {
      const auth = result.authentication as TokenResponse | null | undefined;
      if (auth) {
        await saveTokenResponseFromAuth(auth);
        await syncTokenToBackend(auth);
        setConnected(true);
        Alert.alert("Google", "Google Calendar Authentication succeeded");
        return { ok: true };
      }

      // In some flows auth code exchange finishes asynchronously after promptAsync resolves.
      // Treat it as success if we can actually read a usable Calendar API token.
      let token: string | null = null;
      for (let i = 0; i < 6 && !token; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        token = await getValidAccessToken();
        if (!token) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
      if (token) {
        setConnected(true);
        Alert.alert("Google", "Google Calendar Authentication succeeded");
        return { ok: true, message: "Google Calendar Authentication succeeded" };
      }

      Alert.alert(
        "Google sign-in did not finish",
        isExpoGoRuntime()
          ? "The browser returned without tokens. The Expo auth proxy (auth.expo.io) often fails after Google with a blank “Something went wrong” page — Expo’s service can’t complete the session reliably.\n\nUse a development build so OAuth uses your app’s URL scheme instead of the proxy:\n\n1) Set EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID and EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID (separate Web + iOS OAuth clients in Google Cloud).\n\n2) From the mobile folder run: npx expo run:ios\n\n3) Connect Google again in that build."
          : "Token exchange did not return credentials. Try Connect again, or check Metro logs for errors after the redirect."
      );
      return { ok: false, message: "OAuth succeeded but no token response." };
    }
    if (result.type === "error") {
      const msg = result.error?.message ?? "Google sign-in failed.";
      const params =
        "params" in result && result.params && typeof result.params === "object"
          ? (result.params as Record<string, string | undefined>)
          : undefined;
      const errCode =
        result.error && typeof result.error === "object" && "code" in result.error
          ? String((result.error as { code?: string }).code ?? "")
          : "";
      const oauthErr = (params?.error ?? errCode).toLowerCase();
      const combined = `${oauthErr} ${msg}`.toLowerCase();

      const proxyUri = getAuthExpoProxyRedirectUri();

      if (
        oauthErr === "redirect_uri_mismatch" ||
        combined.includes("redirect_uri_mismatch")
      ) {
        Alert.alert(
          "Google OAuth (redirect_uri_mismatch)",
          isExpoGoRuntime()
            ? `Google rejected the redirect URI after you picked an account.\n\nFix in Google Cloud Console → APIs & Services → Credentials:\n\n1) Open the OAuth 2.0 Client IDs entry whose Client ID matches EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID (Web application type — not iOS).\n\n2) Authorized redirect URIs — add this EXACT string (copy/paste):\n${proxyUri ?? "https://auth.expo.io/@efbaker/callwizard"}\n\n3) Authorized JavaScript origins — add:\nhttps://auth.expo.io\n\n4) Save, wait a minute, retry.\n\nIf the redirect URI is only registered on your iOS/Android client but not on this Web client, you will see this error.`
            : `Native iOS build: add the native redirect (com.googleusercontent.apps…:/oauthredirect) to the iOS OAuth client in Google Cloud, not auth.expo.io — unless you intentionally use the Expo proxy in this build.`
        );
      } else if (oauthErr === "access_denied" || combined.includes("access_denied")) {
        Alert.alert(
          "Google OAuth (access denied)",
          "If your OAuth consent screen is in Testing mode, add your Google account under Test users. Also confirm sensitive scopes (Calendar) are allowed for your project."
        );
      } else if (
        typeof msg === "string" &&
        (msg.includes("invalid_client") || msg.includes("401"))
      ) {
        Alert.alert(
          "Google OAuth (invalid_client)",
          isExpoGoRuntime()
            ? "Common fixes:\n\n1) Use a Web application OAuth client ID (not iOS-only) in EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID inside mobile/.env\n\n2) In Google Cloud → Web client → Authorized redirect URIs, add exactly:\nhttps://auth.expo.io/@efbaker/callwizard\n\n3) Authorized JavaScript origins:\nhttps://auth.expo.io\n\n4) Restart Metro: npx expo start -c\n\nIf it still fails, Google often blocks Expo Go — run a dev build instead:\nnpx expo run:ios"
            : "Dev / standalone build: Web and iOS OAuth clients must be different credentials in Google Cloud. Do not paste your Web client ID into GOOGLE_IOS_CLIENT_ID — create an iOS application OAuth client and use that for the iOS field. Rebuild after fixing .env. Check Metro logs for [Google OAuth] client_id and redirect_uri."
        );
      }
      return { ok: false, message: msg };
    }
    if (
      (result.type === "dismiss" || result.type === "cancel") &&
      isExpoGoRuntime()
    ) {
      return {
        ok: false,
        message:
          'If auth.expo.io showed "Something went wrong", the Expo proxy failed to finish sign-in. Run npx expo run:ios with EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID + EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID (dev build avoids the proxy).',
      };
    }
    return { ok: false, message: "Sign-in was cancelled." };
  }

  async function disconnect(): Promise<void> {
    await disconnectGoogleCalendar();
    setConnected(false);
  }

  return {
    request,
    response,
    connected,
    canConnect,
    connect,
    disconnect,
    refreshConnected,
  };
}
