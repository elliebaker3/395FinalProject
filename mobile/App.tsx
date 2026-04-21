import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Button,
  Linking,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { StatusBar } from "expo-status-bar";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

function getApiBase(): string {
  const fromExtra = (Constants.expoConfig?.extra as { apiBaseUrl?: string } | undefined)
    ?.apiBaseUrl;
  return fromExtra ?? "http://localhost:3001";
}

function openDialer(e164OrRaw: string) {
  const cleaned = e164OrRaw.replace(/\s/g, "");
  const url = `tel:${cleaned}`;
  Linking.openURL(url).catch(() => {
    Alert.alert("Could not open dialer", url);
  });
}

export default function App() {
  const [userId, setUserId] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [contactName, setContactName] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const responseListener = useRef<Notifications.Subscription | null>(null);

  const pushLog = (line: string) =>
    setLog((prev) => [`${new Date().toISOString()} ${line}`, ...prev].slice(0, 12));

  useEffect(() => {
    (async () => {
      const { status } = await Notifications.requestPermissionsAsync();
      pushLog(`notification permission: ${status}`);
    })();

    responseListener.current = Notifications.addNotificationResponseReceivedListener(
      (response) => {
        const data = response.notification.request.content.data as {
          contactPhone?: string;
        };
        const phone = data?.contactPhone;
        pushLog(`notification tapped; payload phone=${phone ?? "(none)"}`);
        if (phone) openDialer(phone);
      }
    );

    return () => {
      responseListener.current?.remove();
    };
  }, []);

  async function registerPushToken() {
    if (!userId.trim()) {
      Alert.alert("Set user ID first (from server after signup).");
      return;
    }
    const projectId =
      Constants.expoConfig?.extra?.eas?.projectId ??
      Constants.easConfig?.projectId;
    if (!projectId) {
      Alert.alert(
        "Expo project ID missing",
        "Run `eas init` or set extra.eas.projectId in app.json for push in dev builds."
      );
      return;
    }
    const token = await Notifications.getExpoPushTokenAsync({ projectId });
    pushLog(`expo push token: ${token.data.slice(0, 24)}…`);
    const res = await fetch(`${getApiBase()}/users/${userId}/device-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expoPushToken: token.data }),
    });
    pushLog(`register token: HTTP ${res.status}`);
  }

  async function createUser() {
    const res = await fetch(`${getApiBase()}/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        displayName: "Me",
        phoneE164: "+10000000000",
      }),
    });
    const body = await res.json().catch(() => ({}));
    pushLog(`create user: HTTP ${res.status}`);
    if (body?.id) setUserId(String(body.id));
  }

  async function addContact() {
    if (!userId.trim()) {
      Alert.alert("Create a user first.");
      return;
    }
    const res = await fetch(`${getApiBase()}/users/${userId}/contacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: contactName || "Contact",
        phoneE164: contactPhone,
        frequencyDays: 7,
      }),
    });
    pushLog(`add contact: HTTP ${res.status}`);
  }

  async function testDialer() {
    if (!contactPhone.trim()) {
      Alert.alert("Enter a contact phone (E.164 e.g. +15551234567).");
      return;
    }
    openDialer(contactPhone);
  }

  return (
    <View style={styles.container}>
      <StatusBar style="auto" />
      <Text style={styles.title}>CallWizard (scaffold)</Text>
      <Text style={styles.hint}>
        Flow: server sends push → you tap → dialer opens with peer number. API: {getApiBase()}
      </Text>
      <Text style={styles.label}>User ID (UUID from server)</Text>
      <TextInput
        style={styles.input}
        value={userId}
        onChangeText={setUserId}
        placeholder="paste after Create user"
        autoCapitalize="none"
      />
      <View style={styles.row}>
        <Button title="Create user (demo)" onPress={createUser} />
        <Button title="Register push token" onPress={registerPushToken} />
      </View>
      <Text style={styles.label}>Contact</Text>
      <TextInput
        style={styles.input}
        value={contactName}
        onChangeText={setContactName}
        placeholder="Name"
      />
      <TextInput
        style={styles.input}
        value={contactPhone}
        onChangeText={setContactPhone}
        placeholder="Phone E.164 e.g. +15551234567"
        keyboardType="phone-pad"
      />
      <View style={styles.row}>
        <Button title="Add contact" onPress={addContact} />
        <Button title="Open dialer (test)" onPress={testDialer} />
      </View>
      <Text style={styles.label}>Log</Text>
      {log.map((line) => (
        <Text key={line} style={styles.logLine}>
          {line}
        </Text>
      ))}
      <Text style={styles.footer}>
        {Platform.OS} · Set app.json extra.apiBaseUrl to your machine LAN IP for device testing.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingTop: 56,
    paddingHorizontal: 16,
    backgroundColor: "#f6f7fb",
  },
  title: { fontSize: 22, fontWeight: "600", marginBottom: 8 },
  hint: { fontSize: 13, color: "#444", marginBottom: 16 },
  label: { fontSize: 12, color: "#666", marginTop: 8 },
  input: {
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 8,
    padding: 10,
    marginTop: 4,
    backgroundColor: "#fff",
  },
  row: { flexDirection: "row", justifyContent: "space-between", marginTop: 12 },
  logLine: { fontSize: 11, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
  footer: { marginTop: 16, fontSize: 11, color: "#888" },
});
