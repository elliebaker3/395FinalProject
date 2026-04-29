// Load Google OAuth client IDs from the environment (e.g. EAS: eas secret:create, or: GOOGLE_WEB_CLIENT_ID=... npx expo start)
// Expo loads mobile/.env into process.env for this file — prefer EXPO_PUBLIC_* so IDs are embedded without shell exports.
// Use conda env with Node: conda run -n 395final npx expo start
const appJson = require("./app.json");

function googleIosUrlSchemes(iosClientId) {
  const s = (iosClientId || "").trim();
  if (!s.endsWith(".apps.googleusercontent.com")) return [];
  const prefix = s.replace(/\.apps\.googleusercontent\.com$/i, "");
  if (!prefix) return [];
  return [`com.googleusercontent.apps.${prefix}`];
}

const googleIosClientId =
  process.env.GOOGLE_IOS_CLIENT_ID ||
  process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID ||
  "";
const googleWebClientId =
  process.env.GOOGLE_WEB_CLIENT_ID ||
  process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ||
  "";

const iosUrlSchemes = googleIosUrlSchemes(googleIosClientId);
const existingUrlTypes = appJson.expo.ios?.infoPlist?.CFBundleURLTypes;
const mergedUrlTypes = Array.isArray(existingUrlTypes)
  ? [...existingUrlTypes]
  : [];
if (iosUrlSchemes.length) {
  mergedUrlTypes.push({ CFBundleURLSchemes: iosUrlSchemes });
}

module.exports = {
  expo: {
    ...appJson.expo,
    ios: {
      ...appJson.expo.ios,
      infoPlist: {
        ...(appJson.expo.ios?.infoPlist || {}),
        ...(mergedUrlTypes.length ? { CFBundleURLTypes: mergedUrlTypes } : {}),
      },
    },
    extra: {
      ...(appJson.expo.extra || {}),
      googleIosClientId,
      googleAndroidClientId: process.env.GOOGLE_ANDROID_CLIENT_ID || "",
      googleWebClientId,
      expoAuthProxyRedirect:
        process.env.EXPO_AUTH_PROXY_REDIRECT ||
        appJson.expo.extra?.expoAuthProxyRedirect ||
        undefined,
    },
  },
};
