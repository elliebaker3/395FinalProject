import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { StatusBar } from "expo-status-bar";

// ── Types ──────────────────────────────────────────────────────────────────

type Screen = "loading" | "login" | "signup" | "setup" | "app";
type Tab = "home" | "settings";

interface User {
  id: string;
  display_name: string;
  phone_e164: string;
}

interface Contact {
  id: string;
  name: string;
  phone_e164: string;
  frequency_days: number;
  last_nudged_at: string | null;
}

// ── Notifications ──────────────────────────────────────────────────────────

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

// ── Helpers ────────────────────────────────────────────────────────────────

function getApiBase(): string {
  const extra = Constants.expoConfig?.extra as { apiBaseUrl?: string } | undefined;
  return extra?.apiBaseUrl ?? "http://localhost:3001";
}

function openDialer(phone: string) {
  const cleaned = phone.replace(/\s/g, "");
  Linking.openURL(`tel:${cleaned}`).catch(() =>
    Alert.alert("Could not open dialer", cleaned)
  );
}

function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (raw.startsWith("+")) return "+" + digits;
  if (digits.length === 10) return "+1" + digits;
  return "+" + digits;
}

const STORAGE_KEY = "callwizard_user";

// ── API ────────────────────────────────────────────────────────────────────

function fetchWithTimeout(input: RequestInfo, init?: RequestInit, ms = 8000): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  return fetch(input, { ...init, signal: controller.signal }).finally(() =>
    clearTimeout(id)
  );
}

async function apiUpsertUser(displayName: string, phoneE164: string): Promise<User> {
  const res = await fetchWithTimeout(`${getApiBase()}/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ displayName, phoneE164 }),
  });
  if (!res.ok) throw new Error(`Server error: ${res.status}`);
  return res.json();
}

async function apiFetchContacts(userId: string): Promise<Contact[]> {
  const res = await fetchWithTimeout(`${getApiBase()}/users/${userId}/contacts`);
  if (!res.ok) throw new Error(`Server error: ${res.status}`);
  return res.json();
}

// ── Root ───────────────────────────────────────────────────────────────────

export default function App() {
  const [screen, setScreen] = useState<Screen>("loading");
  const [user, setUser] = useState<User | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("home");

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((raw) => {
      if (raw) {
        try {
          setUser(JSON.parse(raw));
          setScreen("app");
          return;
        } catch {}
      }
      setScreen("login");
    });
  }, []);

  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data as { contactPhone?: string };
      if (data?.contactPhone) openDialer(data.contactPhone);
    });
    return () => sub.remove();
  }, []);

  async function handleLogin(displayName: string, phoneE164: string) {
    const u = await apiUpsertUser(displayName, phoneE164);
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(u));
    setUser(u);
    setScreen("app");
  }

  async function handleSignup(displayName: string, phoneE164: string) {
    const u = await apiUpsertUser(displayName, phoneE164);
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(u));
    setUser(u);
    setScreen("setup");
  }

  async function handleLogout() {
    await AsyncStorage.removeItem(STORAGE_KEY);
    setUser(null);
    setActiveTab("home");
    setScreen("login");
  }

  if (screen === "loading") {
    return (
      <View style={styles.center}>
        <StatusBar style="dark" />
        <ActivityIndicator size="large" color={PURPLE} />
      </View>
    );
  }

  if (screen === "login") {
    return <LoginScreen onLogin={handleLogin} onSignUp={() => setScreen("signup")} />;
  }

  if (screen === "signup") {
    return <SignUpScreen onSignUp={handleSignup} onBack={() => setScreen("login")} />;
  }

  if (screen === "setup" && user) {
    return <AvailabilitySetupScreen user={user} onDone={() => setScreen("app")} />;
  }

  return (
    <View style={styles.root}>
      <StatusBar style="dark" />
      {activeTab === "home" && user && <HomeScreen user={user} />}
      {activeTab === "settings" && user && (
        <SettingsScreen user={user} onLogout={handleLogout} />
      )}
      <TabBar activeTab={activeTab} onTabChange={setActiveTab} />
    </View>
  );
}

// ── Login Screen ───────────────────────────────────────────────────────────

function LoginScreen({
  onLogin,
  onSignUp,
}: {
  onLogin: (name: string, phone: string) => Promise<void>;
  onSignUp: () => void;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit() {
    if (!name.trim()) { Alert.alert("Enter your name."); return; }
    if (!phone.trim()) { Alert.alert("Enter your phone number."); return; }
    setLoading(true);
    try {
      await onLogin(name.trim(), normalizePhone(phone.trim()));
    } catch (e: unknown) {
      Alert.alert("Login failed", e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={styles.authContainer}>
      <StatusBar style="dark" />
      <Text style={styles.appTitle}>CallWizard</Text>
      <Text style={styles.appSubtitle}>Stay connected with the people who matter</Text>
      <Text style={styles.fieldLabel}>Name</Text>
      <TextInput
        style={styles.input}
        value={name}
        onChangeText={setName}
        placeholder="Your name"
        autoCapitalize="words"
        returnKeyType="next"
      />
      <Text style={styles.fieldLabel}>Phone Number</Text>
      <TextInput
        style={styles.input}
        value={phone}
        onChangeText={setPhone}
        placeholder="+1 555 000 0000"
        keyboardType="phone-pad"
        autoCapitalize="none"
        returnKeyType="done"
        onSubmitEditing={submit}
      />
      <Pressable
        style={[styles.primaryBtn, loading && styles.btnDisabled]}
        onPress={submit}
        disabled={loading}
      >
        <Text style={styles.primaryBtnText}>{loading ? "Logging in…" : "Log In"}</Text>
      </Pressable>
      <Pressable onPress={onSignUp} style={styles.linkWrapper}>
        <Text style={styles.linkText}>
          Don't have an account?{" "}
          <Text style={styles.linkBold}>Sign Up</Text>
        </Text>
      </Pressable>
    </View>
  );
}

// ── Sign Up Screen ─────────────────────────────────────────────────────────

function SignUpScreen({
  onSignUp,
  onBack,
}: {
  onSignUp: (name: string, phone: string) => Promise<void>;
  onBack: () => void;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit() {
    if (!name.trim()) { Alert.alert("Enter your name."); return; }
    if (!phone.trim()) { Alert.alert("Enter your phone number."); return; }
    setLoading(true);
    try {
      await onSignUp(name.trim(), normalizePhone(phone.trim()));
    } catch (e: unknown) {
      Alert.alert("Sign up failed", e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={styles.authContainer}>
      <StatusBar style="dark" />
      <Text style={styles.appTitle}>Create Account</Text>
      <Text style={styles.appSubtitle}>Join CallWizard to stay in touch</Text>
      <Text style={styles.fieldLabel}>Name</Text>
      <TextInput
        style={styles.input}
        value={name}
        onChangeText={setName}
        placeholder="Your name"
        autoCapitalize="words"
        returnKeyType="next"
      />
      <Text style={styles.fieldLabel}>Phone Number</Text>
      <TextInput
        style={styles.input}
        value={phone}
        onChangeText={setPhone}
        placeholder="+1 555 000 0000"
        keyboardType="phone-pad"
        autoCapitalize="none"
        returnKeyType="done"
        onSubmitEditing={submit}
      />
      <Pressable
        style={[styles.primaryBtn, loading && styles.btnDisabled]}
        onPress={submit}
        disabled={loading}
      >
        <Text style={styles.primaryBtnText}>{loading ? "Creating account…" : "Sign Up"}</Text>
      </Pressable>
      <Pressable onPress={onBack} style={styles.linkWrapper}>
        <Text style={styles.linkText}>
          Already have an account?{" "}
          <Text style={styles.linkBold}>Log In</Text>
        </Text>
      </Pressable>
    </View>
  );
}

// ── Home Screen ────────────────────────────────────────────────────────────

function HomeScreen({ user }: { user: User }) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetchContacts(user.id)
      .then(setContacts)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [user.id]);

  const recentlyCalledContact = contacts
    .filter((c) => c.last_nudged_at !== null)
    .sort(
      (a, b) =>
        new Date(b.last_nudged_at!).getTime() - new Date(a.last_nudged_at!).getTime()
    )[0] ?? null;

  const recommendedContact =
    contacts.length > 0
      ? contacts
          .map((c) => {
            const lastMs = c.last_nudged_at
              ? new Date(c.last_nudged_at).getTime()
              : 0;
            const overdueRatio = (Date.now() - lastMs) / (c.frequency_days * 86_400_000);
            return { contact: c, overdueRatio };
          })
          .sort((a, b) => b.overdueRatio - a.overdueRatio)[0].contact
      : null;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.screenContent}>
      <Text style={styles.greeting}>Hello, {user.display_name}</Text>

      <Text style={styles.sectionTitle}>Last Called</Text>
      {loading ? (
        <ActivityIndicator color={PURPLE} style={styles.loader} />
      ) : recentlyCalledContact ? (
        <ContactCard contact={recentlyCalledContact} callLabel="Call Again" />
      ) : (
        <EmptyCard message="No calls logged yet" />
      )}

      <Text style={styles.sectionTitle}>Time to Reach Out</Text>
      {loading ? (
        <ActivityIndicator color={PURPLE} style={styles.loader} />
      ) : recommendedContact ? (
        <ContactCard contact={recommendedContact} callLabel="Call Now" highlight />
      ) : (
        <EmptyCard message="No contacts added yet" />
      )}
    </ScrollView>
  );
}

function ContactCard({
  contact,
  callLabel,
  highlight = false,
}: {
  contact: Contact;
  callLabel: string;
  highlight?: boolean;
}) {
  return (
    <View style={[styles.card, highlight && styles.cardHighlight]}>
      <Text style={styles.cardName}>{contact.name}</Text>
      <Text style={styles.cardPhone}>{contact.phone_e164}</Text>
      <Pressable style={styles.callBtn} onPress={() => openDialer(contact.phone_e164)}>
        <Text style={styles.callBtnText}>Call {callLabel}</Text>
      </Pressable>
    </View>
  );
}

function EmptyCard({ message }: { message: string }) {
  return (
    <View style={styles.card}>
      <Text style={styles.emptyText}>{message}</Text>
    </View>
  );
}

// ── Availability Setup Screen (post-signup) ────────────────────────────────

function AvailabilitySetupScreen({ user, onDone }: { user: User; onDone: () => void }) {
  const [timezone, setTimezone] = useState("UTC");
  const [windows, setWindows] = useState<DayWindow[]>(DEFAULT_WINDOWS);
  const [saving, setSaving] = useState(false);

  function updateWindow(dow: number, patch: Partial<DayWindow>) {
    setWindows((prev) => prev.map((w, i) => (i === dow ? { ...w, ...patch } : w)));
  }

  async function save() {
    setSaving(true);
    try {
      const availability = windows
        .map((w, dow) =>
          w.enabled ? { day_of_week: dow, start_time: w.start_time, end_time: w.end_time } : null
        )
        .filter(Boolean);
      await fetchWithTimeout(`${getApiBase()}/users/${user.id}/preferences`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timezone, availability }),
      });
    } catch {
      // non-fatal — user can update in Settings later
    } finally {
      setSaving(false);
      onDone();
    }
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.screenContent}>
      <StatusBar style="dark" />
      <Text style={styles.greeting}>When are you free to call?</Text>
      <Text style={styles.availHint}>
        We'll only send you nudges during these times. You can change this anytime in
        Settings.
      </Text>

      <View style={styles.card}>
        <Text style={styles.settingsLabel}>TIMEZONE</Text>
        <TextInput
          style={[styles.input, styles.timezoneInput]}
          value={timezone}
          onChangeText={setTimezone}
          placeholder="e.g. America/New_York"
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Text style={styles.settingsLabel}>AVAILABLE DAYS & TIMES</Text>
        {DAYS.map((label, dow) => (
          <View key={dow} style={styles.dayRow}>
            <Pressable
              style={[styles.dayToggle, windows[dow].enabled && styles.dayToggleOn]}
              onPress={() => updateWindow(dow, { enabled: !windows[dow].enabled })}
            >
              <Text style={[styles.dayToggleText, windows[dow].enabled && styles.dayToggleTextOn]}>
                {label}
              </Text>
            </Pressable>
            {windows[dow].enabled ? (
              <View style={styles.timeRange}>
                <TextInput
                  style={styles.timeInput}
                  value={windows[dow].start_time}
                  onChangeText={(v) => updateWindow(dow, { start_time: v })}
                  placeholder="09:00"
                  keyboardType="numbers-and-punctuation"
                  maxLength={5}
                />
                <Text style={styles.timeSep}>–</Text>
                <TextInput
                  style={styles.timeInput}
                  value={windows[dow].end_time}
                  onChangeText={(v) => updateWindow(dow, { end_time: v })}
                  placeholder="17:00"
                  keyboardType="numbers-and-punctuation"
                  maxLength={5}
                />
              </View>
            ) : (
              <Text style={styles.dayOff}>Off</Text>
            )}
          </View>
        ))}
      </View>

      <Pressable
        style={[styles.primaryBtn, saving && styles.btnDisabled]}
        onPress={save}
        disabled={saving}
      >
        <Text style={styles.primaryBtnText}>{saving ? "Saving…" : "Get Started"}</Text>
      </Pressable>
      <Pressable style={styles.linkWrapper} onPress={onDone}>
        <Text style={styles.linkText}>Skip for now</Text>
      </Pressable>
    </ScrollView>
  );
}

// ── Settings Screen ────────────────────────────────────────────────────────

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface DayWindow {
  enabled: boolean;
  start_time: string;
  end_time: string;
}

const DEFAULT_WINDOWS: DayWindow[] = DAYS.map(() => ({
  enabled: false,
  start_time: "09:00",
  end_time: "17:00",
}));

function SettingsScreen({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [timezone, setTimezone] = useState("UTC");
  const [windows, setWindows] = useState<DayWindow[]>(DEFAULT_WINDOWS);
  const [saving, setSaving] = useState(false);
  const [loadingPrefs, setLoadingPrefs] = useState(true);

  useEffect(() => {
    fetchWithTimeout(`${getApiBase()}/users/${user.id}/preferences`)
      .then((r) => r.json())
      .then((data) => {
        if (data.timezone) setTimezone(data.timezone);
        if (Array.isArray(data.availability)) {
          const next = DEFAULT_WINDOWS.map((def, dow) => {
            const match = data.availability.find(
              (w: { day_of_week: number }) => w.day_of_week === dow
            );
            return match
              ? { enabled: true, start_time: match.start_time, end_time: match.end_time }
              : def;
          });
          setWindows(next);
        }
      })
      .catch(() => {})
      .finally(() => setLoadingPrefs(false));
  }, [user.id]);

  function updateWindow(dow: number, patch: Partial<DayWindow>) {
    setWindows((prev) =>
      prev.map((w, i) => (i === dow ? { ...w, ...patch } : w))
    );
  }

  async function savePreferences() {
    setSaving(true);
    try {
      const availability = windows
        .map((w, dow) =>
          w.enabled ? { day_of_week: dow, start_time: w.start_time, end_time: w.end_time } : null
        )
        .filter(Boolean);

      const res = await fetchWithTimeout(`${getApiBase()}/users/${user.id}/preferences`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timezone, availability }),
      });
      if (!res.ok) throw new Error(`Server error: ${res.status}`);
      Alert.alert("Saved", "Your preferences have been updated.");
    } catch (e: unknown) {
      Alert.alert("Error", e instanceof Error ? e.message : "Could not save preferences.");
    } finally {
      setSaving(false);
    }
  }

  function confirmLogout() {
    Alert.alert("Log Out", "Are you sure you want to log out?", [
      { text: "Cancel", style: "cancel" },
      { text: "Log Out", style: "destructive", onPress: onLogout },
    ]);
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.screenContent}>
      <Text style={styles.greeting}>Settings</Text>

      <View style={styles.card}>
        <Text style={styles.settingsLabel}>NAME</Text>
        <Text style={styles.settingsValue}>{user.display_name}</Text>
        <Text style={styles.settingsLabel}>PHONE</Text>
        <Text style={styles.settingsValue}>{user.phone_e164}</Text>
      </View>

      <Text style={styles.sectionTitle}>Calling Availability</Text>
      <Text style={styles.availHint}>
        Nudges are only sent during the times you mark as available. Leave all days off to
        receive nudges at any time.
      </Text>

      {loadingPrefs ? (
        <ActivityIndicator color={PURPLE} style={styles.loader} />
      ) : (
        <View style={styles.card}>
          <Text style={styles.settingsLabel}>TIMEZONE</Text>
          <TextInput
            style={[styles.input, styles.timezoneInput]}
            value={timezone}
            onChangeText={setTimezone}
            placeholder="e.g. America/New_York"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Text style={styles.settingsLabel}>AVAILABLE DAYS & TIMES</Text>
          {DAYS.map((label, dow) => (
            <View key={dow} style={styles.dayRow}>
              <Pressable
                style={[styles.dayToggle, windows[dow].enabled && styles.dayToggleOn]}
                onPress={() => updateWindow(dow, { enabled: !windows[dow].enabled })}
              >
                <Text
                  style={[
                    styles.dayToggleText,
                    windows[dow].enabled && styles.dayToggleTextOn,
                  ]}
                >
                  {label}
                </Text>
              </Pressable>
              {windows[dow].enabled ? (
                <View style={styles.timeRange}>
                  <TextInput
                    style={styles.timeInput}
                    value={windows[dow].start_time}
                    onChangeText={(v) => updateWindow(dow, { start_time: v })}
                    placeholder="09:00"
                    keyboardType="numbers-and-punctuation"
                    maxLength={5}
                  />
                  <Text style={styles.timeSep}>–</Text>
                  <TextInput
                    style={styles.timeInput}
                    value={windows[dow].end_time}
                    onChangeText={(v) => updateWindow(dow, { end_time: v })}
                    placeholder="17:00"
                    keyboardType="numbers-and-punctuation"
                    maxLength={5}
                  />
                </View>
              ) : (
                <Text style={styles.dayOff}>Off</Text>
              )}
            </View>
          ))}
          <Pressable
            style={[styles.primaryBtn, saving && styles.btnDisabled]}
            onPress={savePreferences}
            disabled={saving}
          >
            <Text style={styles.primaryBtnText}>
              {saving ? "Saving…" : "Save Preferences"}
            </Text>
          </Pressable>
        </View>
      )}

      <Pressable style={styles.logoutBtn} onPress={confirmLogout}>
        <Text style={styles.logoutBtnText}>Log Out</Text>
      </Pressable>
    </ScrollView>
  );
}

// ── Tab Bar ────────────────────────────────────────────────────────────────

function TabBar({
  activeTab,
  onTabChange,
}: {
  activeTab: Tab;
  onTabChange: (tab: Tab) => void;
}) {
  return (
    <View style={styles.tabBar}>
      <Pressable style={styles.tabItem} onPress={() => onTabChange("home")}>
        <Text style={styles.tabIcon}>{activeTab === "home" ? "⬤" : "○"}</Text>
        <Text style={[styles.tabLabel, activeTab === "home" && styles.tabLabelActive]}>
          Home
        </Text>
      </Pressable>
      <Pressable style={styles.tabItem} onPress={() => onTabChange("settings")}>
        <Text style={styles.tabIcon}>{activeTab === "settings" ? "⬤" : "○"}</Text>
        <Text
          style={[styles.tabLabel, activeTab === "settings" && styles.tabLabelActive]}
        >
          Settings
        </Text>
      </Pressable>
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────

const PURPLE = "#7c3aed";

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#f6f7fb" },
  center: { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: "#f6f7fb" },

  // Auth
  authContainer: {
    flex: 1,
    paddingTop: Platform.OS === "ios" ? 80 : 48,
    paddingHorizontal: 28,
    backgroundColor: "#f6f7fb",
  },
  appTitle: { fontSize: 32, fontWeight: "700", color: PURPLE, marginBottom: 8 },
  appSubtitle: { fontSize: 15, color: "#555", marginBottom: 32 },
  fieldLabel: { fontSize: 13, color: "#444", marginBottom: 4, marginTop: 16 },
  input: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 10,
    padding: 14,
    backgroundColor: "#fff",
    fontSize: 16,
  },
  primaryBtn: {
    backgroundColor: PURPLE,
    borderRadius: 10,
    padding: 16,
    alignItems: "center",
    marginTop: 28,
  },
  btnDisabled: { opacity: 0.6 },
  primaryBtnText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  linkWrapper: { marginTop: 20, alignItems: "center" },
  linkText: { color: "#666", fontSize: 14 },
  linkBold: { color: PURPLE, fontWeight: "600" },

  // App screens
  screen: { flex: 1, backgroundColor: "#f6f7fb" },
  screenContent: { padding: 20, paddingBottom: 48 },
  greeting: {
    fontSize: 24,
    fontWeight: "700",
    marginBottom: 8,
    marginTop: Platform.OS === "ios" ? 52 : 24,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: "600",
    color: "#999",
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: 10,
    marginTop: 24,
  },
  loader: { marginVertical: 12 },
  card: {
    backgroundColor: "#fff",
    borderRadius: 14,
    padding: 18,
    shadowColor: "#000",
    shadowOpacity: 0.06,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  cardHighlight: { borderWidth: 2, borderColor: PURPLE },
  cardName: { fontSize: 18, fontWeight: "600", marginBottom: 4 },
  cardPhone: { fontSize: 14, color: "#666", marginBottom: 14 },
  callBtn: {
    backgroundColor: PURPLE,
    borderRadius: 8,
    padding: 12,
    alignItems: "center",
  },
  callBtnText: { color: "#fff", fontWeight: "600", fontSize: 15 },
  emptyText: { color: "#aaa", fontSize: 14 },

  // Settings
  settingsLabel: { fontSize: 11, color: "#aaa", letterSpacing: 0.8, marginTop: 14, marginBottom: 2 },
  settingsValue: { fontSize: 16, fontWeight: "500", color: "#222" },
  availHint: { fontSize: 13, color: "#888", marginBottom: 12, lineHeight: 18 },
  timezoneInput: { marginTop: 4, marginBottom: 4 },
  dayRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: "#f0f0f0",
  },
  dayToggle: {
    width: 48,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: "#f0f0f0",
    alignItems: "center",
    marginRight: 12,
  },
  dayToggleOn: { backgroundColor: PURPLE },
  dayToggleText: { fontSize: 13, fontWeight: "600", color: "#aaa" },
  dayToggleTextOn: { color: "#fff" },
  timeRange: { flexDirection: "row", alignItems: "center", flex: 1 },
  timeInput: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: 14,
    width: 64,
    textAlign: "center",
    backgroundColor: "#fff",
  },
  timeSep: { marginHorizontal: 8, color: "#aaa", fontSize: 14 },
  dayOff: { fontSize: 13, color: "#ccc", marginLeft: 4 },
  logoutBtn: {
    marginTop: 32,
    borderWidth: 1.5,
    borderColor: "#e53e3e",
    borderRadius: 10,
    padding: 16,
    alignItems: "center",
  },
  logoutBtnText: { color: "#e53e3e", fontWeight: "600", fontSize: 16 },

  // Tab bar
  tabBar: {
    flexDirection: "row",
    backgroundColor: "#fff",
    borderTopWidth: 1,
    borderTopColor: "#eee",
    paddingBottom: Platform.OS === "ios" ? 28 : 8,
    paddingTop: 10,
  },
  tabItem: { flex: 1, alignItems: "center" },
  tabIcon: { fontSize: 10, color: "#ccc", marginBottom: 2 },
  tabLabel: { fontSize: 12, color: "#aaa" },
  tabLabelActive: { color: PURPLE, fontWeight: "600" },
});
