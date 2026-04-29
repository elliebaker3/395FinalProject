import { Expo } from "expo-server-sdk";
import admin from "firebase-admin";

const expo = new Expo();

let firebaseReady = false;
try {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    admin.initializeApp();
    firebaseReady = true;
  }
} catch (e) {
  console.warn("Firebase admin not initialized:", e.message);
}

/**
 * @param {{ expoPushToken?: string | null, fcmToken?: string | null }} device
 * @param {{ title: string, body: string, data: Record<string, string> }} payload
 */
export async function sendNudge(device, payload) {
  const errors = [];

  if (device.expoPushToken && Expo.isExpoPushToken(device.expoPushToken)) {
    const chunks = expo.chunkPushNotifications([
      {
        to: device.expoPushToken,
        sound: "default",
        title: payload.title,
        body: payload.body,
        data: payload.data,
        channelId: "default",
      },
    ]);
    for (const chunk of chunks) {
      try {
        const tickets = await expo.sendPushNotificationsAsync(chunk);
        errors.push(...tickets.filter((t) => t.status === "error").map((t) => t.message));
      } catch (e) {
        errors.push(e.message);
      }
    }
  }

  if (device.fcmToken && firebaseReady) {
    try {
      await admin.messaging().send({
        token: device.fcmToken,
        notification: { title: payload.title, body: payload.body },
        data: payload.data,
      });
    } catch (e) {
      errors.push(`fcm: ${e.message}`);
    }
  }

  return { ok: errors.length === 0, errors };
}
