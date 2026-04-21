import "./style.css";

function getApiBase(): string {
  const env = import.meta.env.VITE_API_BASE_URL?.trim();
  if (env) return env.replace(/\/$/, "");
  if (import.meta.env.DEV) return "/api";
  return "";
}

function normalizePhoneE164(raw: string): string {
  let s = raw.trim().replace(/[\s().-]/g, "");
  if (!s) return "";
  if (s.startsWith("+")) return s;
  const digits = s.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return s.startsWith("+") ? s : `+${digits}`;
}

function mount() {
  const root = document.querySelector<HTMLDivElement>("#app");
  if (!root) return;

  const apiBase = getApiBase();

  root.innerHTML = `
    <main class="card">
      <p class="brand">CallWizard</p>
      <h1>Get started</h1>
      <p class="sub">Add your name and phone so we can reach you when it’s time to connect.</p>
      <form id="intake" novalidate>
        <div class="field">
          <label for="name">Name</label>
          <input id="name" name="name" type="text" autocomplete="name" required placeholder="Alex Kim" />
        </div>
        <div class="field">
          <label for="phone">Phone number</label>
          <input id="phone" name="phone" type="tel" autocomplete="tel" inputmode="tel" required placeholder="+1 555 123 4567" />
          <p class="hint">Include country code (e.g. +1 for US). We’ll normalize common formats.</p>
        </div>
        <button type="submit" id="submit">Submit</button>
        <div id="banner" role="status" aria-live="polite"></div>
      </form>
    </main>
  `;

  const form = root.querySelector<HTMLFormElement>("#intake");
  const banner = root.querySelector<HTMLDivElement>("#banner");
  const submitBtn = root.querySelector<HTMLButtonElement>("#submit");

  if (!apiBase && !import.meta.env.DEV) {
    banner!.className = "banner warn";
    banner!.textContent =
      "This site build has no API URL. In GitHub: Settings → Secrets and variables → Actions → Variables → add API_BASE_URL with your deployed API origin (e.g. https://api.example.com).";
    submitBtn!.disabled = true;
    return;
  }

  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    banner!.className = "";
    banner!.textContent = "";
    const name = root.querySelector<HTMLInputElement>("#name")?.value.trim() ?? "";
    const phoneRaw = root.querySelector<HTMLInputElement>("#phone")?.value ?? "";
    const phoneE164 = normalizePhoneE164(phoneRaw);

    if (!name || !phoneE164 || phoneE164.length < 8) {
      banner!.className = "banner error";
      banner!.textContent = "Please enter your name and a valid phone number with country code.";
      return;
    }

    submitBtn!.disabled = true;
    try {
      const res = await fetch(`${apiBase}/users`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: name, phoneE164 }),
      });
      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        const msg =
          typeof body?.error === "string"
            ? body.error
            : res.status === 500
              ? "Server error — is the database configured?"
              : "Could not save. Try again.";
        banner!.className = "banner error";
        banner!.textContent = msg;
        return;
      }

      banner!.className = "banner success";
      banner!.textContent = "You’re in. We’ll use this to coordinate calls.";
      form.reset();
    } catch {
      banner!.className = "banner error";
      banner!.textContent = "Network error — check the API URL or your connection.";
    } finally {
      submitBtn!.disabled = false;
    }
  });
}

mount();
