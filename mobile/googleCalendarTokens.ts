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
  if (!web) return null;

  let tr = await loadTokenResponse();
  if (!tr) return null;

  if (tr.shouldRefresh() && tr.refreshToken) {
    try {
      tr = await tr.refreshAsync({ clientId: web }, Google.discovery);
      await persistRefreshed(tr);
    } catch {
      return null;
    }
  }

  return tr.accessToken;
}

export async function hasGoogleCalendarSession(): Promise<boolean> {
  const tr = await loadTokenResponse();
  return tr != null;
}

export async function disconnectGoogleCalendar(): Promise<void> {
  await SecureStore.deleteItemAsync(STORAGE_KEY);
}
