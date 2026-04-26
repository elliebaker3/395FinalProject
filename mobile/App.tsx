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
import * as Contacts from "expo-contacts";
import * as Notifications from "expo-notifications";
import { StatusBar } from "expo-status-bar";

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
        onDone={() => showContactSelect(() => setScreen("app"))}
      />
    );
  }

  return (
    <View style={styles.root}>
      <StatusBar style="dark" />
      {activeTab === "home" && user && <HomeScreen user={user} />}
      {activeTab === "schedule" && user && <ScheduleScreen user={user} />}
      {activeTab === "settings" && user && (
        <SettingsScreen
          user={user}
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
        <View style={styles.overlayBody}>
          <Text style={styles.emptyText}>
            Contacts permission denied. Enable it in your phone Settings.
          </Text>
          <Pressable style={[styles.primaryBtn, { marginTop: 24 }]} onPress={onCancel}>
            <Text style={styles.primaryBtnText}>Close</Text>
          </Pressable>
        </View>
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
                    <Text style={styles.contactListPhone}>{c.phoneE164}</Text>
                  </View>
                </Pressable>
              );
            })}
            {filtered.length === 0 && (
              <Text style={[styles.emptyText, { padding: 20 }]}>No contacts found</Text>
            )}
          </ScrollView>

          <View style={styles.overlayFooter}>
            <Pressable
              style={[styles.primaryBtn, { flex: 1, marginRight: 8 }, syncing && styles.btnDisabled]}
              onPress={syncSelected}
              disabled={syncing}
            >
              <Text style={styles.primaryBtnText}>
                {syncing ? "Syncing…" : `Sync ${selected.size} Contact${selected.size !== 1 ? "s" : ""}`}
              </Text>
            </Pressable>
            <Pressable style={[styles.outlineBtn, { flex: 1 }]} onPress={onCancel}>
              <Text style={styles.outlineBtnText}>Cancel</Text>
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

  useEffect(() => {
    Promise.all([
      fetchWithTimeout(`${getApiBase()}/users/${user.id}/schedules`).then((r) => r.json()),
      fetchWithTimeout(`${getApiBase()}/users/${user.id}/contacts`).then((r) => r.json()),
    ])
      .then(([s, c]) => {
        setSchedules(Array.isArray(s) ? s : []);
        setContacts(Array.isArray(c) ? c : []);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [user.id]);

  async function addSchedule() {
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

      const res = await fetchWithTimeout(`${getApiBase()}/users/${user.id}/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Server error: ${res.status}`);

      const refreshed = await fetchWithTimeout(
        `${getApiBase()}/users/${user.id}/schedules`
      ).then((r) => r.json());
      setSchedules(Array.isArray(refreshed) ? refreshed : []);
      setShowForm(false);
      setSelContactId("");
    } catch (e: unknown) {
      Alert.alert("Error", e instanceof Error ? e.message : "Could not save schedule.");
    } finally {
      setSaving(false);
    }
  }

  async function deleteSchedule(id: string) {
    try {
      await fetchWithTimeout(`${getApiBase()}/users/${user.id}/schedules/${id}`, {
        method: "DELETE",
      });
      setSchedules((prev) => prev.filter((s) => s.id !== id));
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
    } catch (e: unknown) {
      Alert.alert("Error", e instanceof Error ? e.message : "Could not add contact.");
    } finally {
      setAddingManual(false);
    }
  }

  const selectedContact = contacts.find((c) => c.id === selContactId);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.screenContent}>
      <Text style={styles.greeting}>Scheduled Calls</Text>

      {loading ? (
        <ActivityIndicator color={PURPLE} style={styles.loader} />
      ) : schedules.length === 0 && !showForm ? (
        <View style={styles.card}>
          <Text style={styles.emptyText}>No scheduled calls yet</Text>
        </View>
      ) : (
        schedules.map((s) => (
          <View key={s.id} style={styles.scheduleRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardName}>{s.contact_name}</Text>
              <Text style={styles.scheduleDetail}>{scheduleLabel(s)}</Text>
            </View>
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
          </View>
        ))
      )}

      {showForm ? (
        <View style={[styles.card, { marginTop: 16 }]}>
          <Text style={styles.sectionTitle}>New Scheduled Call</Text>

          {/* Contact picker */}
          <Text style={styles.settingsLabel}>CONTACT</Text>
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
                    <Text style={styles.contactListPhone}>{c.phone_e164}</Text>
                  </Pressable>
                ))}
              {/* Manual add toggle */}
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
                    placeholder="+1 555 000 0000"
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
          <Text style={styles.settingsLabel}>TIME (HH:MM, 24-hour)</Text>
          <TextInput
            style={[styles.input, { marginTop: 4 }]}
            value={schedTime}
            onChangeText={setSchedTime}
            placeholder="18:00"
            keyboardType="numbers-and-punctuation"
            maxLength={5}
          />

          <View style={{ flexDirection: "row", marginTop: 12 }}>
            <Pressable
              style={[styles.primaryBtn, { flex: 1, marginRight: 8 }, saving && styles.btnDisabled]}
              onPress={addSchedule}
              disabled={saving}
            >
              <Text style={styles.primaryBtnText}>{saving ? "Saving…" : "Add Schedule"}</Text>
            </Pressable>
            <Pressable
              style={[styles.outlineBtn, { flex: 1 }]}
              onPress={() => setShowForm(false)}
            >
              <Text style={styles.outlineBtnText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <Pressable style={[styles.primaryBtn, { marginTop: 16 }]} onPress={() => setShowForm(true)}>
          <Text style={styles.primaryBtnText}>+ Add Scheduled Call</Text>
        </Pressable>
      )}
    </ScrollView>
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

function SettingsScreen({
  user,
  onLogout,
  onSyncContacts,
}: {
  user: User;
  onLogout: () => void;
  onSyncContacts: () => void;
}) {
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

      <Pressable style={styles.syncBtn} onPress={onSyncContacts}>
        <Text style={styles.syncBtnText}>Sync Phone Contacts</Text>
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
  const tabs: { key: Tab; label: string }[] = [
    { key: "home", label: "Home" },
    { key: "schedule", label: "Schedule" },
    { key: "settings", label: "Settings" },
  ];
  return (
    <View style={styles.tabBar}>
      {tabs.map(({ key, label }) => (
        <Pressable key={key} style={styles.tabItem} onPress={() => onTabChange(key)}>
          <Text style={styles.tabIcon}>{activeTab === key ? "⬤" : "○"}</Text>
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
  tabIcon: { fontSize: 10, color: "#ccc", marginBottom: 2 },
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
