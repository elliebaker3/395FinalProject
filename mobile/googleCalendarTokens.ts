import { TokenResponse, type TokenResponseConfig } from "expo-auth-session";
import * as Google from "expo-auth-session/providers/google";
import * as SecureStore from "expo-secure-store";
import { getGoogleClientIds } from "./googleCalendarConfig";

const STORAGE_KEY = "callwizard_google_token_response_v1";

export async function loadTokenResponse(): Promise<TokenResponse | null> {
  try {
    const raw = await SecureStore.getItemAsync(STORAGE_KEY);
    if (!raw) return null;
    const config = JSON.parse(raw) as TokenResponseConfig;
    if (!config?.accessToken) return null;
    return new TokenResponse(config);
  } catch {
    return null;
  }
}

export async function saveTokenResponseFromAuth(authentication: TokenResponse): Promise<void> {
  const config = authentication.getRequestConfig();
  await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(config));
}

async function persistRefreshed(tr: TokenResponse): Promise<void> {
  await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(tr.getRequestConfig()));
}

/** Returns a usable Calendar API access token, refreshing when needed. */
export async function getValidAccessToken(): Promise<string | null> {
  const { web } = getGoogleClientIds();
  if (!web) {
    // #region agent log
    fetch("http://127.0.0.1:7278/ingest/cd11b05d-92d0-48e8-834f-815effa35922", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "3cba6c" },
      body: JSON.stringify({
        sessionId: "3cba6c",
        location: "googleCalendarTokens.ts:getValidAccessToken",
        message: "exit no web client id",
        data: { hypothesisId: "C", reason: "noWebClientId" },
        timestamp: Date.now(),
        runId: "pre-fix",
      }),
    }).catch(() => {});
    // #endregion
    return null;
  }

  let tr = await loadTokenResponse();
  if (!tr) {
    // #region agent log
    fetch("http://127.0.0.1:7278/ingest/cd11b05d-92d0-48e8-834f-815effa35922", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "3cba6c" },
      body: JSON.stringify({
        sessionId: "3cba6c",
        location: "googleCalendarTokens.ts:getValidAccessToken",
        message: "exit no stored token",
        data: { hypothesisId: "C", reason: "noStoredToken" },
        timestamp: Date.now(),
        runId: "pre-fix",
      }),
    }).catch(() => {});
    // #endregion
    return null;
  }

  if (tr.shouldRefresh() && tr.refreshToken) {
    try {
      tr = await tr.refreshAsync({ clientId: web }, Google.discovery);
      await persistRefreshed(tr);
    } catch {
      // #region agent log
      fetch("http://127.0.0.1:7278/ingest/cd11b05d-92d0-48e8-834f-815effa35922", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "3cba6c" },
        body: JSON.stringify({
          sessionId: "3cba6c",
          location: "googleCalendarTokens.ts:getValidAccessToken",
          message: "refresh failed",
          data: { hypothesisId: "C", reason: "refreshFailed" },
          timestamp: Date.now(),
          runId: "pre-fix",
        }),
      }).catch(() => {});
      // #endregion
      return null;
    }
  }

  // #region agent log
  fetch("http://127.0.0.1:7278/ingest/cd11b05d-92d0-48e8-834f-815effa35922", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "3cba6c" },
    body: JSON.stringify({
      sessionId: "3cba6c",
      location: "googleCalendarTokens.ts:getValidAccessToken",
      message: "returning access token",
      data: { hypothesisId: "C", reason: "ok" },
      timestamp: Date.now(),
      runId: "pre-fix",
    }),
  }).catch(() => {});
  // #endregion
  return tr.accessToken;
}

export async function hasGoogleCalendarSession(): Promise<boolean> {
  const tr = await loadTokenResponse();
  return tr != null;
}

export async function disconnectGoogleCalendar(): Promise<void> {
  await SecureStore.deleteItemAsync(STORAGE_KEY);
}
