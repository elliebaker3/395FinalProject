import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  Keyboard,
  Linking,
  Modal,
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
import * as Contacts from "expo-contacts";
import * as Notifications from "expo-notifications";
import { StatusBar } from "expo-status-bar";
import { Ionicons } from "@expo/vector-icons";

// ── Types ──────────────────────────────────────────────────────────────────

type Screen = "loading" | "login" | "signup" | "setup" | "app";
type Tab = "home" | "schedule" | "settings";

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
    Alert.alert("Could not open dialer", formatPhoneDisplay(cleaned))
  );
}

function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (raw.startsWith("+")) return "+" + digits;
  if (digits.length === 10) return "+1" + digits;
  return "+" + digits;
}

function formatUsPhoneInput(raw: string): string {
  if (!raw) return "";
  if (raw === "+") return "+";

  const digits = raw.replace(/\D/g, "");
  const startsWithPlus = raw.trimStart().startsWith("+");

  // Keep country-code editing flexible (e.g. "+", "+4", "+44", "+358")
  // until the user starts entering a local number.
  if (startsWithPlus && !raw.includes(" ") && !raw.includes("-") && digits.length <= 3) {
    return `+${digits}`;
  }

  let country = "1";
  let localDigits = digits;
  if (startsWithPlus && digits.length > 0) {
    country = digits[0];
    localDigits = digits.slice(1);
  } else if (digits.startsWith("1")) {
    localDigits = digits.slice(1);
  }

  const local = localDigits.slice(0, 10);
  let formatted = `+${country}`;
  if (local.length > 0) formatted += ` ${local.slice(0, 3)}`;
  if (local.length >= 4) formatted += `-${local.slice(3, 6)}`;
  if (local.length >= 7) formatted += `-${local.slice(6, 10)}`;
  return formatted;
}

function formatPhoneDisplay(raw: string): string {
  const normalized = normalizePhone(raw);
  const digits = normalized.replace(/\D/g, "");
  const usDigits = digits.length === 11 && digits.startsWith("1")
    ? digits.slice(1)
    : digits.length === 10
      ? digits
      : "";
  if (usDigits.length !== 10) return normalized;
  return `+1 ${usDigits.slice(0, 3)}-${usDigits.slice(3, 6)}-${usDigits.slice(6, 10)}`;
}

function isCompletePhone(raw: string): boolean {
  const normalized = normalizePhone(raw);
  const digits = normalized.replace(/\D/g, "");
  return normalized.startsWith("+") && digits.length >= 8 && digits.length <= 15;
}

const STORAGE_KEY = "callwizard_user";
const STORAGE_TIMEZONE_KEY = "callwizard_timezone";

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

async function registerPushToken(userId: string) {
  try {
    const { status: existing } = await Notifications.getPermissionsAsync();
    const { status } =
      existing === "granted"
        ? { status: existing }
        : await Notifications.requestPermissionsAsync();
    if (status !== "granted") {
      console.log("PUSH: permission denied");
      return;
    }
    console.log("PUSH: permission granted");

    const projectId =
      (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)
        ?.eas?.projectId;
    if (!projectId) {
      console.log("PUSH: no projectId in app.json");
      return;
    }
    console.log("PUSH: projectId =", projectId);

    const { data: expoPushToken } = await Notifications.getExpoPushTokenAsync({ projectId });
    console.log("PUSH: token =", expoPushToken);

    const res = await fetchWithTimeout(`${getApiBase()}/users/${userId}/device-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expoPushToken }),
    });
    console.log("PUSH: token saved, server status =", res.status);
  } catch (e) {
    console.log("PUSH: registration failed —", e instanceof Error ? e.message : e);
  }
}

// ── Root ───────────────────────────────────────────────────────────────────

export default function App() {
  const [screen, setScreen] = useState<Screen>("loading");
  const [user, setUser] = useState<User | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("home");
  const [persistedTimezone, setPersistedTimezone] = useState("UTC");
  const userRef = useRef<User | null>(null);
  userRef.current = user;

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
    AsyncStorage.getItem(STORAGE_TIMEZONE_KEY)
      .then((savedTz) => {
        if (savedTz) setPersistedTimezone(savedTz);
      })
      .catch(() => {});
  }, []);

  const updatePersistedTimezone = useCallback((next: string) => {
    setPersistedTimezone(next);
    AsyncStorage.setItem(STORAGE_TIMEZONE_KEY, next).catch(() => {});
  }, []);

  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data as {
        contactPhone?: string;
        contactId?: string;
      };
      if (!data?.contactPhone) return;
      const u = userRef.current;
      if (u && data.contactId) {
        fetchWithTimeout(
          `${getApiBase()}/users/${u.id}/contacts/${data.contactId}/called`,
          { method: "POST" }
        ).catch(() => {});
      }
      openDialer(data.contactPhone);
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (!user) return;
    console.log("USER ID:", user.id);
    registerPushToken(user.id);
  }, [user?.id]);

  async function handleLogin(displayName: string, phoneE164: string) {
    const u = await apiUpsertUser(displayName, phoneE164);
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(u));
    setUser(u);
    await Contacts.requestPermissionsAsync();
    setScreen("app");
  }

  async function handleSignup(displayName: string, phoneE164: string) {
    const u = await apiUpsertUser(displayName, phoneE164);
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(u));
    setUser(u);
    setScreen("setup");
  }

  const [contactSelectVisible, setContactSelectVisible] = useState(false);
  const [contactSelectCallback, setContactSelectCallback] = useState<(() => void) | null>(null);

  function showContactSelect(onComplete: () => void) {
    setContactSelectCallback(() => onComplete);
    setContactSelectVisible(true);
  }

  function hideContactSelect(added: number) {
    setContactSelectVisible(false);
    if (added > 0) {
      Alert.alert("Contacts synced", `${added} new contact${added !== 1 ? "s" : ""} added.`);
    }
    contactSelectCallback?.();
    setContactSelectCallback(null);
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
    return (
      <AvailabilitySetupScreen
        user={user}
        initialTimezone={persistedTimezone}
        onTimezoneChange={updatePersistedTimezone}
        onDone={async () => {
          await Contacts.requestPermissionsAsync();
          setScreen("app");
        }}
      />
    );
  }

  return (
    <View style={styles.root}>
      <StatusBar style="dark" />
      {activeTab === "home" && user && (
        <HomeScreen user={user} onSyncContacts={() => showContactSelect(() => {})} />
      )}
      {activeTab === "schedule" && user && <ScheduleScreen user={user} />}
      {activeTab === "settings" && user && (
        <SettingsScreen
          user={user}
          initialTimezone={persistedTimezone}
          onTimezoneChange={updatePersistedTimezone}
          onLogout={handleLogout}
          onSyncContacts={() => showContactSelect(() => {})}
        />
      )}
      <TabBar activeTab={activeTab} onTabChange={setActiveTab} />
      {contactSelectVisible && user && (
        <ContactSelectScreen
          userId={user.id}
          onDone={hideContactSelect}
          onCancel={() => {
            setContactSelectVisible(false);
            contactSelectCallback?.();
            setContactSelectCallback(null);
          }}
        />
      )}
    </View>
  );
}

// ── Contact Select Screen (overlay) ───────────────────────────────────────

interface PhoneContact {
  name: string;
  phoneE164: string;
}

function ContactSelectScreen({
  userId,
  onDone,
  onCancel,
}: {
  userId: string;
  onDone: (added: number) => void;
  onCancel: () => void;
}) {
  const [allContacts, setAllContacts] = useState<PhoneContact[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [permDenied, setPermDenied] = useState(false);
  const [showManualAdd, setShowManualAdd] = useState(false);
  const [manualName, setManualName] = useState("");
  const [manualPhone, setManualPhone] = useState("");
  const [addingManual, setAddingManual] = useState(false);

  useEffect(() => {
    (async () => {
      const { status } = await Contacts.requestPermissionsAsync();
      if (status !== "granted") { setPermDenied(true); setLoading(false); return; }
      const { data } = await Contacts.getContactsAsync({
        fields: [Contacts.Fields.Name, Contacts.Fields.PhoneNumbers],
      });
      const normalized: PhoneContact[] = data
        .filter((c) => c.name && c.phoneNumbers?.length)
        .map((c) => ({
          name: c.name!,
          phoneE164: normalizePhone(c.phoneNumbers![0].number ?? ""),
        }))
        .filter((c) => c.phoneE164.length >= 8)
        .sort((a, b) => a.name.localeCompare(b.name));
      setAllContacts(normalized);
      setLoading(false);
    })();
  }, []);

  const filtered = allContacts.filter((c) =>
    c.name.toLowerCase().includes(search.toLowerCase())
  );

  function toggle(phoneE164: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(phoneE164) ? next.delete(phoneE164) : next.add(phoneE164);
      return next;
    });
  }

  function selectAll() {
    setSelected(new Set(allContacts.map((c) => c.phoneE164)));
  }

  function deselectAll() {
    setSelected(new Set());
  }

  async function syncSelected() {
    if (selected.size === 0) { Alert.alert("Select at least one contact."); return; }
    setSyncing(true);
    try {
      const toSync = allContacts.filter((c) => selected.has(c.phoneE164));
      const res = await fetchWithTimeout(
        `${getApiBase()}/users/${userId}/contacts/bulk`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contacts: toSync }),
        }
      );
      if (!res.ok) throw new Error(`Server error: ${res.status}`);
      const result = await res.json();
      onDone(result.added as number);
    } catch {
      Alert.alert("Sync failed", "Could not sync contacts. Please try again.");
      setSyncing(false);
    }
  }

  async function addManualContact() {
    if (!manualName.trim()) { Alert.alert("Enter a name."); return; }
    if (!manualPhone.trim()) { Alert.alert("Enter a phone number."); return; }
    setAddingManual(true);
    try {
      const res = await fetchWithTimeout(`${getApiBase()}/users/${userId}/contacts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: manualName.trim(),
          phoneE164: normalizePhone(manualPhone.trim()),
          frequencyDays: 7,
        }),
      });
      if (!res.ok) throw new Error(`Server error: ${res.status}`);
      setManualName("");
      setManualPhone("");
      setShowManualAdd(false);
      onDone(1);
    } catch (e: unknown) {
      Alert.alert("Error", e instanceof Error ? e.message : "Could not add contact.");
    } finally {
      setAddingManual(false);
    }
  }

  return (
    <View style={styles.overlay}>
      <StatusBar style="dark" />
      <View style={styles.overlayHeader}>
        <Text style={styles.overlayTitle}>Select Contacts to Sync</Text>
        <Pressable onPress={onCancel}>
          <Text style={styles.overlayClose}>✕</Text>
        </Pressable>
      </View>

      {loading ? (
        <ActivityIndicator color={PURPLE} style={{ marginTop: 40 }} />
      ) : permDenied ? (
        <ScrollView style={styles.overlayList} contentContainerStyle={{ padding: 20 }}>
          <Text style={[styles.emptyText, { marginBottom: 20 }]}>
            Contacts permission denied. Enable it in your phone Settings to browse phone contacts.
          </Text>
          <Text style={styles.sectionTitle}>Add contact manually</Text>
          <Pressable
            style={styles.manualAddToggle}
            onPress={() => setShowManualAdd((v) => !v)}
          >
            <Text style={styles.manualAddToggleText}>
              {showManualAdd ? "− Cancel" : "+ Add contact manually"}
            </Text>
          </Pressable>
          {showManualAdd && (
            <View style={styles.manualAddForm}>
              <TextInput
                style={styles.input}
                value={manualName}
                onChangeText={setManualName}
                placeholder="Name"
                autoCapitalize="words"
              />
              <TextInput
                style={[styles.input, { marginTop: 8 }]}
                value={manualPhone}
                onChangeText={setManualPhone}
                placeholder="+1 555-000-0000"
                keyboardType="phone-pad"
                autoCapitalize="none"
              />
              <Pressable
                style={[styles.primaryBtn, { marginTop: 10 }, addingManual && styles.btnDisabled]}
                onPress={addManualContact}
                disabled={addingManual}
              >
                <Text style={styles.primaryBtnText}>
                  {addingManual ? "Adding…" : "Add Contact"}
                </Text>
              </Pressable>
            </View>
          )}
          <Pressable style={[styles.outlineBtn, { marginTop: 20 }]} onPress={onCancel}>
            <Text style={styles.outlineBtnText}>Close</Text>
          </Pressable>
        </ScrollView>
      ) : (
        <>
          <View style={styles.overlayBody}>
            <TextInput
              style={styles.contactSearch}
              value={search}
              onChangeText={setSearch}
              placeholder="Search by name…"
              autoCapitalize="none"
              clearButtonMode="while-editing"
            />
            <View style={styles.selectAllRow}>
              <Text style={styles.selectedCount}>
                {selected.size} of {allContacts.length} selected
              </Text>
              <View style={{ flexDirection: "row", gap: 10 }}>
                <Pressable onPress={selectAll}>
                  <Text style={styles.selectAllBtn}>All</Text>
                </Pressable>
                <Pressable onPress={deselectAll}>
                  <Text style={styles.selectAllBtn}>None</Text>
                </Pressable>
              </View>
            </View>
          </View>

          <ScrollView style={styles.overlayList}>
            {filtered.map((c) => {
              const checked = selected.has(c.phoneE164);
              return (
                <Pressable
                  key={c.phoneE164}
                  style={styles.selectRow}
                  onPress={() => toggle(c.phoneE164)}
                >
                  <View style={[styles.checkbox, checked && styles.checkboxChecked]}>
                    {checked && <Text style={styles.checkmark}>✓</Text>}
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.contactListName}>{c.name}</Text>
                    <Text style={styles.contactListPhone}>{formatPhoneDisplay(c.phoneE164)}</Text>
                  </View>
                </Pressable>
              );
            })}
            {filtered.length === 0 && (
              <Text style={[styles.emptyText, { padding: 20 }]}>No contacts found</Text>
            )}
          </ScrollView>

          <View style={styles.overlayManualSection}>
            <Pressable
              style={styles.manualAddToggle}
              onPress={() => setShowManualAdd((v) => !v)}
            >
              <Text style={styles.manualAddToggleText}>
                {showManualAdd ? "− Cancel manual add" : "+ Add contact manually"}
              </Text>
            </Pressable>
            {showManualAdd && (
              <View style={styles.manualAddForm}>
                <TextInput
                  style={styles.input}
                  value={manualName}
                  onChangeText={setManualName}
                  placeholder="Name"
                  autoCapitalize="words"
                />
                <TextInput
                  style={[styles.input, { marginTop: 8 }]}
                  value={manualPhone}
                  onChangeText={setManualPhone}
                  placeholder="+1 555-000-0000"
                  keyboardType="phone-pad"
                  autoCapitalize="none"
                />
                <Pressable
                  style={[styles.primaryBtn, { marginTop: 10 }, addingManual && styles.btnDisabled]}
                  onPress={addManualContact}
                  disabled={addingManual}
                >
                  <Text style={styles.primaryBtnText}>
                    {addingManual ? "Adding…" : "Add Contact"}
                  </Text>
                </Pressable>
              </View>
            )}
          </View>

          <View style={styles.overlayFooter}>
            <Pressable
              style={[
                styles.primaryBtn,
                {
                  flex: 1,
                  marginRight: 8,
                  marginTop: 0,
                  backgroundColor: "#fff",
                  borderWidth: 1.5,
                  borderColor: PURPLE,
                },
              ]}
              onPress={onCancel}
            >
              <Text style={[styles.primaryBtnText, { color: PURPLE }]}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[styles.primaryBtn, { flex: 1, marginTop: 0 }, syncing && styles.btnDisabled]}
              onPress={syncSelected}
              disabled={syncing}
            >
              <Text style={styles.primaryBtnText}>
                {syncing ? "Syncing…" : `Add ${selected.size} Contact${selected.size !== 1 ? "s" : ""}`}
              </Text>
            </Pressable>
          </View>
        </>
      )}
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
  const [phone, setPhone] = useState("+1");
  const [loading, setLoading] = useState(false);

  async function submit() {
    if (!name.trim()) { Alert.alert("Enter your name."); return; }
    if (!isCompletePhone(phone)) { Alert.alert("Enter a valid phone number."); return; }
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
      <Text style={[styles.appSubtitle, styles.appSubtitleItalic]}>
        Stay connected with the people who matter
      </Text>
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
        onChangeText={(text) => setPhone(formatUsPhoneInput(text))}
        placeholder="+1 555-000-0000"
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
  const [phone, setPhone] = useState("+1");
  const [loading, setLoading] = useState(false);

  async function submit() {
    if (!name.trim()) { Alert.alert("Enter your name."); return; }
    if (!isCompletePhone(phone)) { Alert.alert("Enter a valid phone number."); return; }
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
        onChangeText={(text) => setPhone(formatUsPhoneInput(text))}
        placeholder="+1 555-000-0000"
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

function HomeScreen({
  user,
  onSyncContacts,
}: {
  user: User;
  onSyncContacts: () => void;
}) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetchContacts(user.id)
      .then(setContacts)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [user.id]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        apiFetchContacts(user.id).then(setContacts).catch(() => {});
      }
    });
    return () => sub.remove();
  }, [user.id]);

  function handleCall(contactId: string, phone: string) {
    // Update UI immediately — don't wait for the server
    const now = new Date().toISOString();
    setContacts((prev) =>
      prev.map((c) => (c.id === contactId ? { ...c, last_nudged_at: now } : c))
    );
    // Sync to server in background
    fetchWithTimeout(
      `${getApiBase()}/users/${user.id}/contacts/${contactId}/called`,
      { method: "POST" },
      30000
    ).catch(() => {});
    openDialer(phone);
  }

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
        <ContactCard
          contact={recentlyCalledContact}
          callLabel="Call Again"
          onCall={handleCall}
        />
      ) : (
        <EmptyCard message="No calls logged yet" />
      )}

      <Text style={styles.sectionTitle}>Time to Reach Out</Text>
      {loading ? (
        <ActivityIndicator color={PURPLE} style={styles.loader} />
      ) : recommendedContact ? (
        <ContactCard
          contact={recommendedContact}
          callLabel="Call Now"
          highlight
          onCall={handleCall}
        />
      ) : contacts.length === 0 ? (
        <AddContactsPromptCard onSyncContacts={onSyncContacts} />
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
  onCall,
}: {
  contact: Contact;
  callLabel: string;
  highlight?: boolean;
  onCall: (contactId: string, phone: string) => void;
}) {
  return (
    <View style={[styles.card, highlight && styles.cardHighlight]}>
      <Text style={styles.cardName}>{contact.name}</Text>
      <Text style={styles.cardPhone}>{formatPhoneDisplay(contact.phone_e164)}</Text>
      <Pressable style={styles.callBtn} onPress={() => onCall(contact.id, contact.phone_e164)}>
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

function AddContactsPromptCard({ onSyncContacts }: { onSyncContacts: () => void }) {
  return (
    <View style={styles.card}>
      <Text style={styles.emptyText}>
        Add contacts to start getting personalized reach-out suggestions.
      </Text>
      <Pressable style={styles.homeAddContactsBtn} onPress={onSyncContacts}>
        <Text style={styles.homeAddContactsBtnText}>Add Contacts</Text>
      </Pressable>
    </View>
  );
}

// ── Schedule Screen ────────────────────────────────────────────────────────

type Recurrence = "weekly" | "biweekly" | "monthly";

interface CallSchedule {
  id: string;
  contact_id: string;
  contact_name: string;
  contact_phone: string;
  recurrence: Recurrence;
  day_of_week: number | null;
  day_of_month: number | null;
  scheduled_time: string;
}

interface ContactDetail {
  contact: Contact & { notes?: string | null };
  schedules: Array<{
    id: string;
    contact_id: string;
    recurrence: Recurrence;
    day_of_week: number | null;
    day_of_month: number | null;
    scheduled_time: string;
  }>;
  call_history: Array<{ type: string; at: string }>;
}

const RECURRENCE_LABELS: Record<Recurrence, string> = {
  weekly: "Weekly",
  biweekly: "Biweekly",
  monthly: "Monthly",
};

function fmt12h(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const hour = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, "0")} ${ampm}`;
}

function parseTime12h(hhmm: string): { hour: number; minute: string; ampm: "AM" | "PM" } {
  const [rawHour, rawMinute] = hhmm.split(":");
  const hour24 = Number(rawHour);
  const minute = String(Number(rawMinute ?? "0")).padStart(2, "0");
  const ampm: "AM" | "PM" = hour24 >= 12 ? "PM" : "AM";
  const hour = hour24 % 12 || 12;
  return { hour, minute, ampm };
}

function to24hTime(hour12: number, minute: string, ampm: "AM" | "PM"): string {
  let hour24 = hour12 % 12;
  if (ampm === "PM") hour24 += 12;
  return `${String(hour24).padStart(2, "0")}:${minute}`;
}

function roundMinuteToFive(minute: string): string {
  const n = Number(minute);
  if (Number.isNaN(n)) return "00";
  const rounded = Math.round(n / 5) * 5;
  return String(Math.min(55, Math.max(0, rounded))).padStart(2, "0");
}

const TIMEZONE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "Pacific/Honolulu", label: "Honolulu (HST) - Pacific/Honolulu" },
  { value: "America/Anchorage", label: "Anchorage (AKST) - America/Anchorage" },
  { value: "America/Los_Angeles", label: "Los Angeles (PT) - America/Los_Angeles" },
  { value: "America/Denver", label: "Denver (MT) - America/Denver" },
  { value: "America/Chicago", label: "Chicago (CT) - America/Chicago" },
  { value: "America/New_York", label: "New York (ET) - America/New_York" },
  { value: "America/Halifax", label: "Halifax (AT) - America/Halifax" },
  { value: "America/Sao_Paulo", label: "Sao Paulo - America/Sao_Paulo" },
  { value: "Atlantic/Reykjavik", label: "Reykjavik (GMT) - Atlantic/Reykjavik" },
  { value: "Europe/London", label: "London - Europe/London" },
  { value: "Europe/Paris", label: "Paris - Europe/Paris" },
  { value: "Europe/Berlin", label: "Berlin - Europe/Berlin" },
  { value: "Europe/Athens", label: "Athens - Europe/Athens" },
  { value: "Asia/Dubai", label: "Dubai - Asia/Dubai" },
  { value: "Asia/Karachi", label: "Karachi - Asia/Karachi" },
  { value: "Asia/Kolkata", label: "Mumbai/Delhi - Asia/Kolkata" },
  { value: "Asia/Bangkok", label: "Bangkok - Asia/Bangkok" },
  { value: "Asia/Singapore", label: "Singapore - Asia/Singapore" },
  { value: "Asia/Hong_Kong", label: "Hong Kong - Asia/Hong_Kong" },
  { value: "Asia/Tokyo", label: "Tokyo - Asia/Tokyo" },
  { value: "Australia/Sydney", label: "Sydney - Australia/Sydney" },
  { value: "Pacific/Auckland", label: "Auckland - Pacific/Auckland" },
].sort((a, b) => a.label.localeCompare(b.label));

function TimezoneDropdown({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = TIMEZONE_OPTIONS.find((tz) => tz.value === value);
  const selectedLabel = selected ? selected.label : value || "Select a timezone";
  const deviceTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const deviceMatch = TIMEZONE_OPTIONS.find((tz) => tz.value === deviceTimezone);
  const deviceLabel = deviceMatch
    ? `Auto-detect: ${deviceMatch.label}`
    : `Auto-detect: ${deviceTimezone}`;

  return (
    <View style={styles.timezoneWrap}>
      <Pressable style={styles.timezoneButton} onPress={() => setOpen((v) => !v)}>
        <Text style={value ? styles.timezoneButtonText : styles.timezonePlaceholder}>
          {selectedLabel}
        </Text>
        <Text style={styles.timezoneChevron}>{open ? "▴" : "▾"}</Text>
      </Pressable>
      {open && (
        <View style={styles.timezoneMenu}>
          <ScrollView style={styles.timezoneMenuScroll} nestedScrollEnabled>
            <Pressable
              style={[styles.timezoneOption, styles.timezoneAutoOption]}
              onPress={() => {
                onChange(deviceTimezone);
                setOpen(false);
              }}
            >
              <Text style={styles.timezoneAutoOptionText}>{deviceLabel}</Text>
            </Pressable>
            {TIMEZONE_OPTIONS.map((tz) => (
              <Pressable
                key={tz.value}
                style={[styles.timezoneOption, value === tz.value && styles.timezoneOptionActive]}
                onPress={() => {
                  onChange(tz.value);
                  setOpen(false);
                }}
              >
                <Text
                  style={[
                    styles.timezoneOptionText,
                    value === tz.value && styles.timezoneOptionTextActive,
                  ]}
                >
                  {tz.label}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      )}
    </View>
  );
}

function TimePickerModal({
  visible,
  title,
  hour,
  minute,
  ampm,
  onHourChange,
  onMinuteChange,
  onAmPmChange,
  onCancel,
  onConfirm,
}: {
  visible: boolean;
  title: string;
  hour: number;
  minute: string;
  ampm: "AM" | "PM";
  onHourChange: (hour: number) => void;
  onMinuteChange: (minute: string) => void;
  onAmPmChange: (ampm: "AM" | "PM") => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const hourRef = useRef<ScrollView | null>(null);
  const minuteRef = useRef<ScrollView | null>(null);
  const ampmRef = useRef<ScrollView | null>(null);
  const minuteOptions = Array.from({ length: 12 }, (_, i) => String(i * 5).padStart(2, "0"));

  function clampIndex(index: number, max: number): number {
    return Math.max(0, Math.min(max, index));
  }

  function snapIndexFromOffset(offsetY: number, maxIndex: number): number {
    return clampIndex(Math.round(offsetY / TIME_PICKER_ROW_HEIGHT), maxIndex);
  }

  function snapHour(offsetY: number) {
    const idx = snapIndexFromOffset(offsetY, 11);
    onHourChange(idx + 1);
    hourRef.current?.scrollTo({ y: idx * TIME_PICKER_ROW_HEIGHT, animated: true });
  }

  function snapMinute(offsetY: number) {
    const idx = snapIndexFromOffset(offsetY, minuteOptions.length - 1);
    onMinuteChange(minuteOptions[idx]);
    minuteRef.current?.scrollTo({ y: idx * TIME_PICKER_ROW_HEIGHT, animated: true });
  }

  function snapAmPm(offsetY: number) {
    const idx = snapIndexFromOffset(offsetY, 1);
    const next = idx === 0 ? "AM" : "PM";
    onAmPmChange(next);
    ampmRef.current?.scrollTo({ y: idx * TIME_PICKER_ROW_HEIGHT, animated: true });
  }

  useEffect(() => {
    if (!visible) return;
    const minuteIdx = Math.max(0, minuteOptions.indexOf(minute));
    const ampmIdx = ampm === "AM" ? 0 : 1;
    const id = setTimeout(() => {
      hourRef.current?.scrollTo({ y: (hour - 1) * TIME_PICKER_ROW_HEIGHT, animated: false });
      minuteRef.current?.scrollTo({ y: minuteIdx * TIME_PICKER_ROW_HEIGHT, animated: false });
      ampmRef.current?.scrollTo({ y: ampmIdx * TIME_PICKER_ROW_HEIGHT, animated: false });
    }, 0);
    return () => clearTimeout(id);
  }, [visible, hour, minute, ampm]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <View style={styles.timePickerBackdrop}>
        <View style={styles.timePickerCard}>
          <Text style={styles.timePickerTitle}>{title}</Text>
          <View style={styles.timePickerWheel}>
            <View style={styles.timePickerSelectionBar} pointerEvents="none" />
            <View style={styles.timePickerColumns}>
            <ScrollView
              ref={hourRef}
              style={styles.timePickerCol}
              contentContainerStyle={styles.timePickerColContent}
              showsVerticalScrollIndicator={false}
              snapToInterval={TIME_PICKER_ROW_HEIGHT}
              decelerationRate="normal"
              bounces={false}
              onMomentumScrollEnd={(e) => snapHour(e.nativeEvent.contentOffset.y)}
            >
              {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((h) => (
                <Pressable
                  key={`h-${h}`}
                  style={[styles.timePickerItem, hour === h && styles.timePickerItemActive]}
                  onPress={() => onHourChange(h)}
                >
                  <Text style={[styles.timePickerItemText, hour === h && styles.timePickerItemTextActive]}>
                    {h}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
            <ScrollView
              ref={minuteRef}
              style={styles.timePickerCol}
              contentContainerStyle={styles.timePickerColContent}
              showsVerticalScrollIndicator={false}
              snapToInterval={TIME_PICKER_ROW_HEIGHT}
              decelerationRate="normal"
              bounces={false}
              onMomentumScrollEnd={(e) => snapMinute(e.nativeEvent.contentOffset.y)}
            >
              {minuteOptions.map((m) => (
                <Pressable
                  key={`m-${m}`}
                  style={[styles.timePickerItem, minute === m && styles.timePickerItemActive]}
                  onPress={() => onMinuteChange(m)}
                >
                  <Text style={[styles.timePickerItemText, minute === m && styles.timePickerItemTextActive]}>
                    {m}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
            <ScrollView
              ref={ampmRef}
              style={[styles.timePickerCol, styles.timePickerColLast]}
              contentContainerStyle={styles.timePickerColContent}
              showsVerticalScrollIndicator={false}
              snapToInterval={TIME_PICKER_ROW_HEIGHT}
              decelerationRate="normal"
              bounces={false}
              onMomentumScrollEnd={(e) => snapAmPm(e.nativeEvent.contentOffset.y)}
            >
              {(["AM", "PM"] as const).map((v) => (
                <Pressable
                  key={`a-${v}`}
                  style={[styles.timePickerItem, ampm === v && styles.timePickerItemActive]}
                  onPress={() => onAmPmChange(v)}
                >
                  <Text style={[styles.timePickerItemText, ampm === v && styles.timePickerItemTextActive]}>
                    {v}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
            </View>
          </View>
          <View style={styles.timePickerActions}>
            <Pressable style={[styles.outlineBtn, { flex: 1, marginRight: 8 }]} onPress={onCancel}>
              <Text style={styles.outlineBtnText}>Cancel</Text>
            </Pressable>
            <Pressable style={[styles.primaryBtn, { flex: 1, marginTop: 0 }]} onPress={onConfirm}>
              <Text style={styles.primaryBtnText}>Set Time</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function scheduleLabel(s: CallSchedule): string {
  const time = fmt12h(s.scheduled_time);
  if (s.recurrence === "monthly") return `Monthly · day ${s.day_of_month} · ${time}`;
  const day = DAYS[s.day_of_week ?? 0];
  const freq = s.recurrence === "biweekly" ? "Every 2 weeks" : "Weekly";
  return `${freq} · ${day} · ${time}`;
}

function ScheduleScreen({ user }: { user: User }) {
  const [schedules, setSchedules] = useState<CallSchedule[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [activeContactId, setActiveContactId] = useState<string | null>(null);
  const [contactDetail, setContactDetail] = useState<ContactDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [notesDraft, setNotesDraft] = useState("");
  const [notesSaving, setNotesSaving] = useState(false);
  const [notesLastSavedValue, setNotesLastSavedValue] = useState("");
  const [notesLastSavedAt, setNotesLastSavedAt] = useState<string | null>(null);
  const [editingScheduleId, setEditingScheduleId] = useState<string | null>(null);
  const notesAutosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // form state
  const [selContactId, setSelContactId] = useState("");
  const [recurrence, setRecurrence] = useState<Recurrence>("weekly");
  const [dayOfWeek, setDayOfWeek] = useState(1); // Monday default
  const [dayOfMonth, setDayOfMonth] = useState("1");
  const [schedTime, setSchedTime] = useState("18:00");
  const [saving, setSaving] = useState(false);
  const [showContactList, setShowContactList] = useState(false);
  const [contactSearch, setContactSearch] = useState("");
  const [showManualAdd, setShowManualAdd] = useState(false);
  const [manualName, setManualName] = useState("");
  const [manualPhone, setManualPhone] = useState("");
  const [addingManual, setAddingManual] = useState(false);
  const [pickerVisible, setPickerVisible] = useState(false);
  const [pickerHour, setPickerHour] = useState<number>(6);
  const [pickerMinute, setPickerMinute] = useState<string>("00");
  const [pickerAmPm, setPickerAmPm] = useState<"AM" | "PM">("PM");

  async function refreshSchedulesAndContacts() {
    const [s, c] = await Promise.all([
      fetchWithTimeout(`${getApiBase()}/users/${user.id}/schedules`).then((r) => r.json()),
      fetchWithTimeout(`${getApiBase()}/users/${user.id}/contacts`).then((r) => r.json()),
    ]);
    setSchedules(Array.isArray(s) ? s : []);
    setContacts(Array.isArray(c) ? c : []);
  }

  async function loadContactDetail(contactId: string) {
    const res = await fetchWithTimeout(`${getApiBase()}/users/${user.id}/contacts/${contactId}`);
    if (!res.ok) throw new Error(`Server error: ${res.status}`);
    const detail = (await res.json()) as ContactDetail;
    const initialNotes = detail.contact.notes ?? "";
    setContactDetail(detail);
    setNotesDraft(initialNotes);
    setNotesLastSavedValue(initialNotes);
    setNotesLastSavedAt(null);
    if (notesAutosaveTimerRef.current) {
      clearTimeout(notesAutosaveTimerRef.current);
      notesAutosaveTimerRef.current = null;
    }
  }

  useEffect(() => {
    Promise.all([
      refreshSchedulesAndContacts(),
    ])
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [user.id]);

  function resetScheduleForm() {
    setRecurrence("weekly");
    setDayOfWeek(1);
    setDayOfMonth("1");
    setSchedTime("18:00");
    setShowContactList(false);
    setContactSearch("");
    setEditingScheduleId(null);
  }

  async function submitSchedule() {
    if (!selContactId) { Alert.alert("Select a contact."); return; }
    if (!schedTime.match(/^\d{1,2}:\d{2}$/)) { Alert.alert("Enter time as HH:MM."); return; }
    if (recurrence === "monthly") {
      const dom = parseInt(dayOfMonth);
      if (isNaN(dom) || dom < 1 || dom > 31) { Alert.alert("Enter a valid day of month (1–31)."); return; }
    }
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        contactId: selContactId,
        recurrence,
        scheduledTime: schedTime,
      };
      if (recurrence !== "monthly") body.dayOfWeek = dayOfWeek;
      else body.dayOfMonth = parseInt(dayOfMonth);

      const isEditing = Boolean(editingScheduleId);
      const path = isEditing
        ? `${getApiBase()}/users/${user.id}/schedules/${editingScheduleId}`
        : `${getApiBase()}/users/${user.id}/schedules`;
      const res = await fetchWithTimeout(path, {
        method: isEditing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Server error: ${res.status}`);

      await refreshSchedulesAndContacts();
      if (activeContactId) {
        await loadContactDetail(activeContactId);
      }
      setShowForm(false);
      setSelContactId("");
      resetScheduleForm();
    } catch (e: unknown) {
      Alert.alert("Error", e instanceof Error ? e.message : "Could not save schedule.");
    } finally {
      setSaving(false);
    }
  }

  function openScheduleTimePicker() {
    const parsed = parseTime12h(schedTime);
    setPickerHour(parsed.hour);
    setPickerMinute(roundMinuteToFive(parsed.minute));
    setPickerAmPm(parsed.ampm);
    setPickerVisible(true);
  }

  function saveScheduledTime() {
    setSchedTime(to24hTime(pickerHour, pickerMinute, pickerAmPm));
    setPickerVisible(false);
  }

  async function deleteSchedule(id: string) {
    try {
      await fetchWithTimeout(`${getApiBase()}/users/${user.id}/schedules/${id}`, {
        method: "DELETE",
      });
      setSchedules((prev) => prev.filter((s) => s.id !== id));
      if (activeContactId) await loadContactDetail(activeContactId);
    } catch {
      Alert.alert("Error", "Could not delete schedule.");
    }
  }

  async function addManualContact() {
    if (!manualName.trim()) { Alert.alert("Enter a name."); return; }
    if (!manualPhone.trim()) { Alert.alert("Enter a phone number."); return; }
    setAddingManual(true);
    try {
      const res = await fetchWithTimeout(`${getApiBase()}/users/${user.id}/contacts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: manualName.trim(),
          phoneE164: normalizePhone(manualPhone.trim()),
          frequencyDays: 7,
        }),
      });
      if (!res.ok) throw new Error(`Server error: ${res.status}`);
      const newContact = await res.json();
      setContacts((prev) => [...prev, { ...newContact, last_nudged_at: null }]);
      setSelContactId(newContact.id);
      setShowContactList(false);
      setShowManualAdd(false);
      setManualName("");
      setManualPhone("");
      await refreshSchedulesAndContacts();
      if (activeContactId) await loadContactDetail(activeContactId);
    } catch (e: unknown) {
      Alert.alert("Error", e instanceof Error ? e.message : "Could not add contact.");
    } finally {
      setAddingManual(false);
    }
  }

  async function openContactDetail(contactId: string) {
    setActiveContactId(contactId);
    setSelContactId(contactId);
    setDetailLoading(true);
    setShowForm(false);
    setEditingScheduleId(null);
    try {
      await loadContactDetail(contactId);
    } catch {
      Alert.alert("Error", "Could not load contact details.");
      setActiveContactId(null);
    } finally {
      setDetailLoading(false);
    }
  }

  function startEditSchedule(s: CallSchedule) {
    setSelContactId(s.contact_id);
    setRecurrence(s.recurrence);
    setDayOfWeek(s.day_of_week ?? 1);
    setDayOfMonth(String(s.day_of_month ?? 1));
    setSchedTime(s.scheduled_time);
    setEditingScheduleId(s.id);
    setShowForm(true);
  }

  function startAddScheduleForContact(contactId: string) {
    setSelContactId(contactId);
    setEditingScheduleId(null);
    setRecurrence("weekly");
    setDayOfWeek(1);
    setDayOfMonth("1");
    setSchedTime("18:00");
    setShowForm(true);
  }

  async function saveContactNotes(nextNotes: string, contactId: string) {
    setNotesSaving(true);
    try {
      const res = await fetchWithTimeout(`${getApiBase()}/users/${user.id}/contacts/${contactId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes: nextNotes }),
      });
      if (!res.ok) throw new Error(`Server error: ${res.status}`);
      setNotesLastSavedValue(nextNotes);
      setNotesLastSavedAt(new Date().toISOString());
      setContactDetail((prev) =>
        prev
          ? { ...prev, contact: { ...prev.contact, notes: nextNotes } }
          : prev
      );
    } catch (e: unknown) {
      Alert.alert("Error", e instanceof Error ? e.message : "Could not save notes.");
    } finally {
      setNotesSaving(false);
    }
  }

  useEffect(() => {
    return () => {
      if (notesAutosaveTimerRef.current) {
        clearTimeout(notesAutosaveTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!activeContactId || !contactDetail) return;
    if (notesDraft === notesLastSavedValue) return;

    if (notesAutosaveTimerRef.current) {
      clearTimeout(notesAutosaveTimerRef.current);
    }
    notesAutosaveTimerRef.current = setTimeout(() => {
      void saveContactNotes(notesDraft, activeContactId);
    }, 800);
  }, [activeContactId, contactDetail, notesDraft, notesLastSavedValue]);

  const selectedContact = contacts.find((c) => c.id === selContactId);
  const detailSchedules = schedules.filter((s) => s.contact_id === activeContactId);
  const currentDetailContact = contactDetail?.contact ?? contacts.find((c) => c.id === activeContactId);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.screenContent}>
      <Text style={styles.greeting}>
        {activeContactId ? currentDetailContact?.name ?? "Contact Details" : "Scheduled Calls"}
      </Text>

      {activeContactId ? (
        <Pressable
          style={[styles.outlineBtn, { marginTop: 8 }]}
          onPress={() => {
            setActiveContactId(null);
            setContactDetail(null);
            setShowForm(false);
            setEditingScheduleId(null);
          }}
        >
          <Text style={styles.outlineBtnText}>Back to all schedules</Text>
        </Pressable>
      ) : null}

      {loading ? (
        <ActivityIndicator color={PURPLE} style={styles.loader} />
      ) : activeContactId ? (
        detailLoading ? (
          <ActivityIndicator color={PURPLE} style={styles.loader} />
        ) : (
          <>
            <View style={styles.card}>
              <Text style={styles.cardName}>{currentDetailContact?.name ?? "Unknown contact"}</Text>
              <Text style={styles.cardPhone}>
                {currentDetailContact?.phone_e164
                  ? formatPhoneDisplay(currentDetailContact.phone_e164)
                  : "No phone number"}
              </Text>
            </View>

            <Text style={styles.sectionTitle}>Past Call History</Text>
            <View style={styles.card}>
              {contactDetail?.call_history?.length ? (
                contactDetail.call_history.map((item, idx) => (
                  <Text key={`${item.at}-${idx}`} style={styles.scheduleDetail}>
                    {item.type === "called" ? "Called" : "Event"} · {new Date(item.at).toLocaleString()}
                  </Text>
                ))
              ) : (
                <Text style={styles.emptyText}>No call history yet.</Text>
              )}
            </View>

            <Text style={styles.sectionTitle}>Notes</Text>
            <View style={styles.card}>
              <TextInput
                style={[styles.input, { minHeight: 100, textAlignVertical: "top" }]}
                multiline
                value={notesDraft}
                onChangeText={setNotesDraft}
                placeholder="Add notes for this contact..."
                returnKeyType="done"
                blurOnSubmit
                onSubmitEditing={() => Keyboard.dismiss()}
              />
              {notesSaving ? (
                <Text style={styles.notesMetaText}>Saving...</Text>
              ) : notesLastSavedAt ? (
                <Text style={styles.notesMetaText}>
                  Last Saved at{" "}
                  {new Date(notesLastSavedAt).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </Text>
              ) : null}
            </View>

            <Text style={styles.sectionTitle}>Scheduled Calls</Text>
            {detailSchedules.length === 0 && !showForm ? (
              <View style={styles.card}>
                <Text style={styles.emptyText}>No schedules for this contact yet.</Text>
              </View>
            ) : (
              detailSchedules.map((s) => (
                <Pressable key={s.id} style={styles.scheduleRow} onPress={() => startEditSchedule(s)}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.cardName}>{scheduleLabel(s)}</Text>
                  </View>
                  <Pressable
                    style={[styles.outlineBtn, { marginTop: 0, marginRight: 8, paddingVertical: 8, paddingHorizontal: 12 }]}
                    onPress={() => startEditSchedule(s)}
                  >
                    <Text style={styles.outlineBtnText}>Edit</Text>
                  </Pressable>
                  <Pressable
                    style={styles.deleteBtn}
                    onPress={() =>
                      Alert.alert("Delete Schedule", "Remove this scheduled call?", [
                        { text: "Cancel", style: "cancel" },
                        { text: "Delete", style: "destructive", onPress: () => deleteSchedule(s.id) },
                      ])
                    }
                  >
                    <Text style={styles.deleteBtnText}>✕</Text>
                  </Pressable>
                </Pressable>
              ))
            )}
          </>
        )
      ) : schedules.length === 0 && !showForm ? (
        <View style={styles.card}>
          <Text style={styles.emptyText}>No scheduled calls yet</Text>
        </View>
      ) : (
        schedules.map((s) => (
          <Pressable key={s.id} style={styles.scheduleRow} onPress={() => openContactDetail(s.contact_id)}>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardName}>{s.contact_name}</Text>
              <Text style={styles.scheduleDetail}>{scheduleLabel(s)}</Text>
            </View>
            <Pressable
              style={[styles.outlineBtn, { marginTop: 0, marginRight: 8, paddingVertical: 8, paddingHorizontal: 12 }]}
              onPress={() => openContactDetail(s.contact_id)}
            >
              <Text style={styles.outlineBtnText}>Edit</Text>
            </Pressable>
            <Pressable
              style={styles.deleteBtn}
              onPress={() =>
                Alert.alert("Delete Schedule", `Remove reminder to call ${s.contact_name}?`, [
                  { text: "Cancel", style: "cancel" },
                  { text: "Delete", style: "destructive", onPress: () => deleteSchedule(s.id) },
                ])
              }
            >
              <Text style={styles.deleteBtnText}>✕</Text>
            </Pressable>
          </Pressable>
        ))
      )}

      {showForm ? (
        <View style={[styles.card, { marginTop: 16 }]}>
          <Text style={styles.sectionTitle}>
            {editingScheduleId ? "Edit Scheduled Call" : "New Scheduled Call"}
          </Text>

          {/* Contact picker */}
          <Text style={styles.settingsLabel}>CONTACT</Text>
          {activeContactId ? (
            <View style={styles.pickerBtn}>
              <Text style={styles.pickerBtnText}>{selectedContact?.name ?? "Selected contact"}</Text>
            </View>
          ) : (
            <>
              <Pressable
                style={styles.pickerBtn}
                onPress={() => setShowContactList((v) => !v)}
              >
                <Text style={selectedContact ? styles.pickerBtnText : styles.pickerBtnPlaceholder}>
                  {selectedContact ? selectedContact.name : "Select a contact…"}
                </Text>
              </Pressable>
              {showContactList && (
                <View style={styles.contactList}>
                  <TextInput
                    style={styles.contactSearch}
                    value={contactSearch}
                    onChangeText={setContactSearch}
                    placeholder="Search by name…"
                    autoCapitalize="none"
                    clearButtonMode="while-editing"
                  />
                  {contacts
                    .filter((c) =>
                      c.name.toLowerCase().includes(contactSearch.toLowerCase())
                    )
                    .map((c) => (
                      <Pressable
                        key={c.id}
                        style={styles.contactListItem}
                        onPress={() => {
                          setSelContactId(c.id);
                          setShowContactList(false);
                          setContactSearch("");
                        }}
                      >
                        <Text style={styles.contactListName}>{c.name}</Text>
                        <Text style={styles.contactListPhone}>{formatPhoneDisplay(c.phone_e164)}</Text>
                      </Pressable>
                    ))}
                  <Pressable
                    style={styles.manualAddToggle}
                    onPress={() => setShowManualAdd((v) => !v)}
                  >
                    <Text style={styles.manualAddToggleText}>
                      {showManualAdd ? "− Cancel manual add" : "+ Add contact manually"}
                    </Text>
                  </Pressable>
                  {showManualAdd && (
                    <View style={styles.manualAddForm}>
                      <TextInput
                        style={styles.input}
                        value={manualName}
                        onChangeText={setManualName}
                        placeholder="Name"
                        autoCapitalize="words"
                      />
                      <TextInput
                        style={[styles.input, { marginTop: 8 }]}
                        value={manualPhone}
                        onChangeText={setManualPhone}
                        placeholder="+1 555-000-0000"
                        keyboardType="phone-pad"
                        autoCapitalize="none"
                      />
                      <Pressable
                        style={[styles.primaryBtn, { marginTop: 10 }, addingManual && styles.btnDisabled]}
                        onPress={addManualContact}
                        disabled={addingManual}
                      >
                        <Text style={styles.primaryBtnText}>
                          {addingManual ? "Adding…" : "Add Contact"}
                        </Text>
                      </Pressable>
                    </View>
                  )}
                </View>
              )}
            </>
          )}

          {/* Recurrence */}
          <Text style={styles.settingsLabel}>RECURRENCE</Text>
          <View style={styles.segmentRow}>
            {(["weekly", "biweekly", "monthly"] as Recurrence[]).map((r) => (
              <Pressable
                key={r}
                style={[styles.segmentBtn, recurrence === r && styles.segmentBtnActive]}
                onPress={() => setRecurrence(r)}
              >
                <Text style={[styles.segmentBtnText, recurrence === r && styles.segmentBtnTextActive]}>
                  {RECURRENCE_LABELS[r]}
                </Text>
              </Pressable>
            ))}
          </View>

          {/* Day picker */}
          {recurrence !== "monthly" ? (
            <>
              <Text style={styles.settingsLabel}>DAY OF WEEK</Text>
              <View style={styles.dayPickerRow}>
                {DAYS.map((label, i) => (
                  <Pressable
                    key={i}
                    style={[styles.dayChip, dayOfWeek === i && styles.dayChipActive]}
                    onPress={() => setDayOfWeek(i)}
                  >
                    <Text style={[styles.dayChipText, dayOfWeek === i && styles.dayChipTextActive]}>
                      {label}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </>
          ) : (
            <>
              <Text style={styles.settingsLabel}>DAY OF MONTH (1–31)</Text>
              <TextInput
                style={[styles.input, { marginTop: 4 }]}
                value={dayOfMonth}
                onChangeText={setDayOfMonth}
                keyboardType="number-pad"
                maxLength={2}
                placeholder="15"
              />
            </>
          )}

          {/* Time */}
          <Text style={styles.settingsLabel}>TIME</Text>
          <Pressable style={[styles.input, styles.timeField]} onPress={openScheduleTimePicker}>
            <Text style={styles.timeFieldText}>{fmt12h(schedTime)}</Text>
          </Pressable>

          <View style={{ flexDirection: "row", marginTop: 12 }}>
            <Pressable
              style={[styles.outlineBtn, { flex: 1, marginRight: 8 }]}
              onPress={() => {
                setShowForm(false);
                setEditingScheduleId(null);
              }}
            >
              <Text style={styles.outlineBtnText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[styles.primaryBtn, { flex: 1, marginTop: 0 }, saving && styles.btnDisabled]}
              onPress={submitSchedule}
              disabled={saving}
            >
              <Text style={styles.primaryBtnText}>
                {saving ? "Saving…" : editingScheduleId ? "Save Changes" : "Add Schedule"}
              </Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <Pressable
          style={[styles.primaryBtn, { marginTop: 16 }]}
          onPress={() => {
            if (activeContactId) {
              startAddScheduleForContact(activeContactId);
            } else {
              setShowForm(true);
              setEditingScheduleId(null);
            }
          }}
        >
          <Text style={styles.primaryBtnText}>+ Add Scheduled Call</Text>
        </Pressable>
      )}

      <TimePickerModal
        visible={pickerVisible}
        title="Choose schedule time"
        hour={pickerHour}
        minute={pickerMinute}
        ampm={pickerAmPm}
        onHourChange={setPickerHour}
        onMinuteChange={setPickerMinute}
        onAmPmChange={setPickerAmPm}
        onCancel={() => setPickerVisible(false)}
        onConfirm={saveScheduledTime}
      />
    </ScrollView>
  );
}

// ── Availability Setup Screen (post-signup) ────────────────────────────────

function AvailabilitySetupScreen({
  user,
  initialTimezone,
  onTimezoneChange,
  onDone,
}: {
  user: User;
  initialTimezone: string;
  onTimezoneChange: (next: string) => void;
  onDone: () => void;
}) {
  const [timezone, setTimezone] = useState(initialTimezone || "UTC");
  const [windows, setWindows] = useState<DayWindow[]>(DEFAULT_WINDOWS);
  const [saving, setSaving] = useState(false);
  const [pickerVisible, setPickerVisible] = useState(false);
  const [pickerDow, setPickerDow] = useState<number | null>(null);
  const [pickerField, setPickerField] = useState<"start_time" | "end_time">("start_time");
  const [pickerHour, setPickerHour] = useState<number>(9);
  const [pickerMinute, setPickerMinute] = useState<string>("00");
  const [pickerAmPm, setPickerAmPm] = useState<"AM" | "PM">("AM");

  useEffect(() => {
    if (initialTimezone) setTimezone(initialTimezone);
  }, [initialTimezone]);

  function updateWindow(dow: number, patch: Partial<DayWindow>) {
    setWindows((prev) => prev.map((w, i) => (i === dow ? { ...w, ...patch } : w)));
  }

  function openTimePicker(dow: number, field: "start_time" | "end_time") {
    const current = windows[dow][field];
    const parsed = parseTime12h(current);
    setPickerDow(dow);
    setPickerField(field);
    setPickerHour(parsed.hour);
    setPickerMinute(roundMinuteToFive(parsed.minute));
    setPickerAmPm(parsed.ampm);
    setPickerVisible(true);
  }

  function savePickedTime() {
    if (pickerDow === null) return;
    const next = to24hTime(pickerHour, pickerMinute, pickerAmPm);
    updateWindow(pickerDow, { [pickerField]: next });
    setPickerVisible(false);
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
      onTimezoneChange(timezone);
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
        <TimezoneDropdown
          value={timezone}
          onChange={(next) => {
            setTimezone(next);
            onTimezoneChange(next);
          }}
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
                <Pressable
                  style={styles.timeInput}
                  onPress={() => openTimePicker(dow, "start_time")}
                >
                  <Text style={styles.timeInputText}>{fmt12h(windows[dow].start_time)}</Text>
                </Pressable>
                <Text style={styles.timeSep}>–</Text>
                <Pressable
                  style={styles.timeInput}
                  onPress={() => openTimePicker(dow, "end_time")}
                >
                  <Text style={styles.timeInputText}>{fmt12h(windows[dow].end_time)}</Text>
                </Pressable>
              </View>
            ) : (
              <Text style={styles.dayOff}>Off</Text>
            )}
          </View>
        ))}
      </View>

      <TimePickerModal
        visible={pickerVisible}
        title={pickerField === "start_time" ? "Choose start time" : "Choose end time"}
        hour={pickerHour}
        minute={pickerMinute}
        ampm={pickerAmPm}
        onHourChange={setPickerHour}
        onMinuteChange={setPickerMinute}
        onAmPmChange={setPickerAmPm}
        onCancel={() => setPickerVisible(false)}
        onConfirm={savePickedTime}
      />

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

function SettingsScreen({
  user,
  initialTimezone,
  onTimezoneChange,
  onLogout,
  onSyncContacts,
}: {
  user: User;
  initialTimezone: string;
  onTimezoneChange: (next: string) => void;
  onLogout: () => void;
  onSyncContacts: () => void;
}) {
  const [timezone, setTimezone] = useState(initialTimezone || "UTC");
  const [windows, setWindows] = useState<DayWindow[]>(DEFAULT_WINDOWS);
  const [saving, setSaving] = useState(false);
  const [loadingPrefs, setLoadingPrefs] = useState(true);
  const [pickerVisible, setPickerVisible] = useState(false);
  const [pickerDow, setPickerDow] = useState<number | null>(null);
  const [pickerField, setPickerField] = useState<"start_time" | "end_time">("start_time");
  const [pickerHour, setPickerHour] = useState<number>(9);
  const [pickerMinute, setPickerMinute] = useState<string>("00");
  const [pickerAmPm, setPickerAmPm] = useState<"AM" | "PM">("AM");

  useEffect(() => {
    if (initialTimezone) setTimezone(initialTimezone);
  }, [initialTimezone]);

  useEffect(() => {
    fetchWithTimeout(`${getApiBase()}/users/${user.id}/preferences`)
      .then((r) => r.json())
      .then((data) => {
        // Only hydrate from server when app-level timezone has not been
        // explicitly set by the user in this session.
        if (data.timezone && (!initialTimezone || initialTimezone === "UTC")) {
          setTimezone(data.timezone);
          onTimezoneChange(data.timezone);
        }
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
  }, [user.id, initialTimezone]);

  function updateWindow(dow: number, patch: Partial<DayWindow>) {
    setWindows((prev) =>
      prev.map((w, i) => (i === dow ? { ...w, ...patch } : w))
    );
  }

  function openTimePicker(dow: number, field: "start_time" | "end_time") {
    const current = windows[dow][field];
    const parsed = parseTime12h(current);
    setPickerDow(dow);
    setPickerField(field);
    setPickerHour(parsed.hour);
    setPickerMinute(roundMinuteToFive(parsed.minute));
    setPickerAmPm(parsed.ampm);
    setPickerVisible(true);
  }

  function savePickedTime() {
    if (pickerDow === null) return;
    const next = to24hTime(pickerHour, pickerMinute, pickerAmPm);
    updateWindow(pickerDow, { [pickerField]: next });
    setPickerVisible(false);
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
      onTimezoneChange(timezone);
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
        <Text style={styles.settingsValue}>{formatPhoneDisplay(user.phone_e164)}</Text>
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
          <TimezoneDropdown
            value={timezone}
            onChange={(next) => {
              setTimezone(next);
              onTimezoneChange(next);
            }}
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
                  <Pressable
                    style={styles.timeInput}
                    onPress={() => openTimePicker(dow, "start_time")}
                  >
                    <Text style={styles.timeInputText}>{fmt12h(windows[dow].start_time)}</Text>
                  </Pressable>
                  <Text style={styles.timeSep}>–</Text>
                  <Pressable
                    style={styles.timeInput}
                    onPress={() => openTimePicker(dow, "end_time")}
                  >
                    <Text style={styles.timeInputText}>{fmt12h(windows[dow].end_time)}</Text>
                  </Pressable>
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

      <TimePickerModal
        visible={pickerVisible}
        title={pickerField === "start_time" ? "Choose start time" : "Choose end time"}
        hour={pickerHour}
        minute={pickerMinute}
        ampm={pickerAmPm}
        onHourChange={setPickerHour}
        onMinuteChange={setPickerMinute}
        onAmPmChange={setPickerAmPm}
        onCancel={() => setPickerVisible(false)}
        onConfirm={savePickedTime}
      />

      <Pressable style={styles.syncBtn} onPress={onSyncContacts}>
        <Text style={styles.syncBtnText}>Add Contacts</Text>
      </Pressable>

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
  const tabs: { key: Tab; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
    { key: "home", label: "Home", icon: "home-outline" },
    { key: "schedule", label: "Schedule", icon: "clipboard-outline" },
    { key: "settings", label: "Settings", icon: "settings-outline" },
  ];
  return (
    <View style={styles.tabBar}>
      {tabs.map(({ key, label, icon }) => (
        <Pressable key={key} style={styles.tabItem} onPress={() => onTabChange(key)}>
          <Ionicons
            name={icon}
            size={18}
            style={[styles.tabIcon, activeTab === key && styles.tabIconActive]}
          />
          <Text style={[styles.tabLabel, activeTab === key && styles.tabLabelActive]}>
            {label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────

const PURPLE = "#7c3aed";
const TIME_PICKER_ROW_HEIGHT = 42;
const TIME_PICKER_WHEEL_HEIGHT = 200;
const TIME_PICKER_CENTER_TOP = (TIME_PICKER_WHEEL_HEIGHT - TIME_PICKER_ROW_HEIGHT) / 2;

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
  appTitle: { fontSize: 32, fontWeight: "700", color: PURPLE, marginBottom: 8, textAlign: "center" },
  appSubtitle: { fontSize: 15, color: "#555", marginBottom: 32, textAlign: "center" },
  appSubtitleItalic: { fontStyle: "italic" },
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
  homeAddContactsBtn: {
    marginTop: 14,
    borderWidth: 1.5,
    borderColor: PURPLE,
    borderRadius: 10,
    padding: 14,
    alignItems: "center",
  },
  homeAddContactsBtnText: { color: PURPLE, fontWeight: "600", fontSize: 15 },

  // Schedule
  scheduleRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fff",
    borderRadius: 14,
    padding: 16,
    marginBottom: 10,
    shadowColor: "#000",
    shadowOpacity: 0.05,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  scheduleDetail: { fontSize: 13, color: "#888", marginTop: 2 },
  deleteBtn: { padding: 8 },
  deleteBtnText: { fontSize: 16, color: "#e53e3e" },
  pickerBtn: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 10,
    padding: 14,
    backgroundColor: "#fff",
    marginTop: 4,
    marginBottom: 4,
  },
  pickerBtnText: { fontSize: 16, color: "#222" },
  pickerBtnPlaceholder: { fontSize: 16, color: "#aaa" },
  contactList: {
    borderWidth: 1,
    borderColor: "#eee",
    borderRadius: 10,
    backgroundColor: "#fff",
    marginBottom: 8,
  },
  contactListItem: { padding: 14, borderBottomWidth: 1, borderBottomColor: "#f0f0f0" },
  contactListName: { fontSize: 15, fontWeight: "600" },
  contactListPhone: { fontSize: 13, color: "#888", marginTop: 2 },
  segmentRow: { flexDirection: "row", marginTop: 6, marginBottom: 4 },
  segmentBtn: {
    flex: 1,
    paddingVertical: 8,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#ddd",
    backgroundColor: "#f7f7f7",
  },
  segmentBtnActive: { backgroundColor: PURPLE, borderColor: PURPLE },
  segmentBtnText: { fontSize: 13, color: "#666" },
  segmentBtnTextActive: { color: "#fff", fontWeight: "600" },
  dayPickerRow: { flexDirection: "row", flexWrap: "wrap", marginTop: 6, gap: 6 },
  dayChip: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "#ddd",
    backgroundColor: "#f7f7f7",
  },
  dayChipActive: { backgroundColor: PURPLE, borderColor: PURPLE },
  dayChipText: { fontSize: 13, color: "#666" },
  dayChipTextActive: { color: "#fff", fontWeight: "600" },
  notesMetaText: { marginTop: 10, fontSize: 12, color: "#888" },
  outlineBtn: {
    borderWidth: 1.5,
    borderColor: PURPLE,
    borderRadius: 10,
    padding: 14,
    alignItems: "center",
  },
  outlineBtnText: { color: PURPLE, fontWeight: "600", fontSize: 15 },

  // Settings
  settingsLabel: { fontSize: 11, color: "#aaa", letterSpacing: 0.8, marginTop: 14, marginBottom: 2 },
  settingsValue: { fontSize: 16, fontWeight: "500", color: "#222" },
  availHint: { fontSize: 13, color: "#888", marginBottom: 12, lineHeight: 18 },
  timezoneInput: { marginTop: 4, marginBottom: 4 },
  timezoneWrap: { marginTop: 4, marginBottom: 4, zIndex: 50 },
  timezoneButton: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 10,
    backgroundColor: "#fff",
    paddingHorizontal: 12,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
  },
  timezoneButtonText: { flex: 1, color: "#222", fontSize: 14 },
  timezonePlaceholder: { flex: 1, color: "#999", fontSize: 14 },
  timezoneChevron: { color: "#777", fontSize: 12, marginLeft: 8 },
  timezoneMenu: {
    borderWidth: 1,
    borderColor: "#e5e7eb",
    borderRadius: 10,
    backgroundColor: "#fff",
    marginTop: 6,
    overflow: "hidden",
    maxHeight: 220,
  },
  timezoneMenuScroll: { maxHeight: 220 },
  timezoneOption: { paddingVertical: 10, paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: "#f1f5f9" },
  timezoneOptionActive: { backgroundColor: "#f5f3ff" },
  timezoneOptionText: { fontSize: 13, color: "#374151" },
  timezoneOptionTextActive: { color: PURPLE, fontWeight: "600" },
  timezoneAutoOption: { backgroundColor: "#faf5ff" },
  timezoneAutoOptionText: { fontSize: 13, color: PURPLE, fontWeight: "600" },
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
    width: 96,
    textAlign: "center",
    backgroundColor: "#fff",
  },
  timeInputText: { fontSize: 14, color: "#222", textAlign: "center" },
  timeField: { marginTop: 4, justifyContent: "center" },
  timeFieldText: { fontSize: 16, color: "#222" },
  timeSep: { marginHorizontal: 8, color: "#aaa", fontSize: 14 },
  dayOff: { fontSize: 13, color: "#ccc", marginLeft: 4 },
  timePickerBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.35)",
    justifyContent: "flex-end",
  },
  timePickerCard: {
    backgroundColor: "#fff",
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 24,
  },
  timePickerTitle: { fontSize: 16, fontWeight: "700", color: "#222", marginBottom: 12 },
  timePickerWheel: { position: "relative", height: TIME_PICKER_WHEEL_HEIGHT },
  timePickerSelectionBar: {
    position: "absolute",
    left: 2,
    right: 2,
    top: TIME_PICKER_CENTER_TOP,
    height: TIME_PICKER_ROW_HEIGHT,
    backgroundColor: "rgba(124, 58, 237, 0.14)",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "rgba(124, 58, 237, 0.35)",
    zIndex: 1,
  },
  timePickerColumns: { flexDirection: "row", height: TIME_PICKER_WHEEL_HEIGHT },
  timePickerCol: { flex: 1, height: TIME_PICKER_WHEEL_HEIGHT, marginRight: 8 },
  timePickerColLast: { marginRight: 0 },
  timePickerColContent: { paddingVertical: TIME_PICKER_CENTER_TOP },
  timePickerItem: {
    height: TIME_PICKER_ROW_HEIGHT,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
    marginBottom: 0,
    backgroundColor: "transparent",
  },
  timePickerItemActive: { backgroundColor: "transparent" },
  timePickerItemText: { fontSize: 16, color: "#444" },
  timePickerItemTextActive: { color: PURPLE, fontWeight: "700" },
  timePickerActions: { flexDirection: "row", marginTop: 12 },
  syncBtn: {
    marginTop: 16,
    borderWidth: 1.5,
    borderColor: PURPLE,
    borderRadius: 10,
    padding: 16,
    alignItems: "center",
  },
  syncBtnText: { color: PURPLE, fontWeight: "600", fontSize: 16 },
  contactSearch: {
    borderBottomWidth: 1,
    borderBottomColor: "#eee",
    padding: 12,
    fontSize: 15,
    backgroundColor: "#fafafa",
  },
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
  tabIcon: { fontSize: 15, color: "#aaa", marginBottom: 2 },
  tabIconActive: { color: PURPLE },
  tabLabel: { fontSize: 12, color: "#aaa" },
  tabLabelActive: { color: PURPLE, fontWeight: "600" },

  // Contact select overlay
  overlay: {
    position: "absolute",
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: "#f6f7fb",
    zIndex: 100,
  },
  overlayHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingTop: Platform.OS === "ios" ? 56 : 24,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#eee",
    backgroundColor: "#fff",
  },
  overlayTitle: { fontSize: 18, fontWeight: "700" },
  overlayClose: { fontSize: 20, color: "#888", paddingLeft: 16 },
  overlayBody: { paddingHorizontal: 16, paddingTop: 12 },
  overlayList: { flex: 1 },
  overlayManualSection: {
    borderTopWidth: 1,
    borderTopColor: "#eee",
    backgroundColor: "#fff",
  },
  overlayFooter: {
    flexDirection: "row",
    padding: 16,
    paddingBottom: Platform.OS === "ios" ? 36 : 16,
    borderTopWidth: 1,
    borderTopColor: "#eee",
    backgroundColor: "#fff",
  },
  selectAllRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  selectedCount: { fontSize: 13, color: "#888" },
  selectAllBtn: { fontSize: 14, color: PURPLE, fontWeight: "600" },
  selectRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#f0f0f0",
    backgroundColor: "#fff",
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 5,
    borderWidth: 2,
    borderColor: "#ccc",
    marginRight: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxChecked: { backgroundColor: PURPLE, borderColor: PURPLE },
  checkmark: { color: "#fff", fontSize: 13, fontWeight: "700" },

  // Manual add contact
  manualAddToggle: {
    padding: 14,
    borderTopWidth: 1,
    borderTopColor: "#eee",
  },
  manualAddToggleText: { color: PURPLE, fontWeight: "600", fontSize: 14 },
  manualAddForm: { padding: 14, paddingTop: 4 },
});
