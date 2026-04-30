/** Server-side Calendar endpoints (OAuth tokens stored on API). */

export type DayWindowInput = {
  enabled: boolean;
  start_time: string;
  end_time: string;
};

export async function fetchSuggestGeneralFromServer(
  apiBase: string,
  userId: string,
  timezone: string
): Promise<DayWindowInput[]> {
  const r = await fetch(`${apiBase}/users/${userId}/calendar/suggest-general-availability`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ timezone }),
  });
  const j = (await r.json().catch(() => ({}))) as { windows?: DayWindowInput[]; message?: string; error?: string };
  if (!r.ok) {
    throw new Error(String(j.message || j.error || `HTTP ${r.status}`));
  }
  return Array.isArray(j.windows) ? j.windows : [];
}

export async function fetchSuggestFreeTimesFromServer(
  apiBase: string,
  userId: string,
  params: { timezone: string; targetDayOfWeek: number; schedTime: string }
): Promise<string[]> {
  const r = await fetch(`${apiBase}/users/${userId}/calendar/suggest-free-times`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const j = (await r.json().catch(() => ({}))) as { times?: string[]; message?: string; error?: string };
  if (!r.ok) {
    throw new Error(String(j.message || j.error || `HTTP ${r.status}`));
  }
  return Array.isArray(j.times) ? j.times : [];
}
