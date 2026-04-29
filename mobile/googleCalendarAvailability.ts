import { DateTime } from "luxon";

/** UTC interval from ISO bounds for overlap checks */
export type UtcInterval = { start: DateTime; end: DateTime };

export type CalendarRecurrence = "weekly" | "biweekly" | "monthly";

export type DayWindowInput = {
  enabled: boolean;
  start_time: string;
  end_time: string;
};

export type TimeSlot = { start_time: string; end_time: string };
export type DaySlotsInput = {
  enabled: boolean;
  slots: TimeSlot[];
};

type Seg = { start: number; end: number };

function mergeIntervals(segs: Seg[]): Seg[] {
  if (!segs.length) return [];
  const sorted = [...segs].sort((a, b) => a.start - b.start);
  const out: Seg[] = [];
  let cur = { ...sorted[0] };
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start <= cur.end) {
      cur.end = Math.max(cur.end, sorted[i].end);
    } else {
      out.push(cur);
      cur = { ...sorted[i] };
    }
  }
  out.push(cur);
  return out;
}

function intersectTwo(listA: Seg[], listB: Seg[]): Seg[] {
  const out: Seg[] = [];
  for (const a of listA) {
    for (const b of listB) {
      const s = Math.max(a.start, b.start);
      const e = Math.min(a.end, b.end);
      if (e > s) out.push({ start: s, end: e });
    }
  }
  return mergeIntervals(out);
}

function intersectAll(lists: Seg[][]): Seg[] {
  if (!lists.length) return [];
  let acc = mergeIntervals(lists[0]);
  for (let i = 1; i < lists.length; i++) {
    acc = intersectTwo(acc, mergeIntervals(lists[i]));
  }
  return acc;
}

function subtractFromBand(busy: Seg[], bandStart: number, bandEnd: number): Seg[] {
  let parts: Seg[] = [{ start: bandStart, end: bandEnd }];
  for (const b of mergeIntervals(busy)) {
    parts = parts
      .flatMap((p) => {
        if (b.end <= p.start || b.start >= p.end) return [p];
        const res: Seg[] = [];
        if (b.start > p.start) res.push({ start: p.start, end: Math.min(b.start, p.end) });
        if (b.end < p.end) res.push({ start: Math.max(b.end, p.start), end: p.end });
        return res;
      })
      .filter((x) => x.end > x.start);
  }
  return mergeIntervals(parts);
}

function minutesFromMidnight(dt: DateTime): number {
  return dt.hour * 60 + dt.minute + dt.second / 60 + dt.millisecond / 60000;
}

/** Luxon Mon=1 … Sun=7 → app Sun=0 … Sat=6 */
export function luxonWeekdayToAppDow(weekday: number): number {
  return weekday === 7 ? 0 : weekday;
}

function minToHHMM(m: number): string {
  const total = Math.round(m);
  const h = Math.floor(total / 60);
  const mm = total % 60;
  return `${String(Math.min(23, h)).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

export function toMinuteSegments(slots: TimeSlot[]): Seg[] {
  return mergeIntervals(
    slots
      .map((s) => {
        const [sh, sm] = s.start_time.split(":").map((v) => Number(v));
        const [eh, em] = s.end_time.split(":").map((v) => Number(v));
        if (![sh, sm, eh, em].every((v) => Number.isFinite(v))) return null;
        const start = sh * 60 + sm;
        const end = eh * 60 + em;
        if (end <= start) return null;
        return { start, end };
      })
      .filter((s): s is Seg => s != null)
  );
}

function weekBoundsSunday(zone: string) {
  const now = DateTime.now().setZone(zone);
  const sundayOffset = now.weekday % 7; // Sun=>0, Mon=>1...
  const start = now.startOf("day").minus({ days: sundayOffset });
  const endExclusive = start.plus({ days: 7 });
  return { start, endExclusive };
}

/** Largest contiguous segment (widest span). */
function pickLongest(segs: Seg[]): Seg | null {
  if (!segs.length) return null;
  return segs.reduce((best, s) => (s.end - s.start > best.end - best.start ? s : best));
}

export async function fetchPrimaryCalendarFreeBusy(
  accessToken: string,
  timeMinIso: string,
  timeMaxIso: string
): Promise<{ busy: { start: string; end: string }[] }> {
  const res = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      timeMin: timeMinIso,
      timeMax: timeMaxIso,
      items: [{ id: "primary" }],
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Calendar FreeBusy failed (${res.status}): ${t.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    calendars?: { primary?: { busy?: { start: string; end: string }[] } };
  };
  const busy = data.calendars?.primary?.busy ?? [];
  return { busy };
}

/** Map ISO busy intervals into minutes-from-midnight segments per local calendar date key (yyyy-MM-dd). */
export function busyIntervalsPerLocalDate(
  busy: { start: string; end: string }[],
  zone: string
): Map<string, Seg[]> {
  const map = new Map<string, Seg[]>();

  for (const b of busy) {
    const bs = DateTime.fromISO(b.start, { setZone: true });
    const be = DateTime.fromISO(b.end, { setZone: true });
    if (!bs.isValid || !be.isValid || be <= bs) continue;

    let cursor: DateTime = bs;
    while (cursor < be) {
      const localDay = cursor.setZone(zone);
      const dayStart = localDay.startOf("day");
      const dayEnd = dayStart.endOf("day");
      const segStart = cursor > dayStart ? cursor : dayStart;
      const segEnd = be < dayEnd ? be : dayEnd;
      if (segEnd > segStart) {
        const key = dayStart.toFormat("yyyy-MM-dd");
        const sMin = minutesFromMidnight(segStart.setZone(zone));
        const eMin = Math.min(1440, minutesFromMidnight(segEnd.setZone(zone)));
        if (eMin > sMin) {
          const arr = map.get(key) ?? [];
          arr.push({ start: sMin, end: eMin });
          map.set(key, arr);
        }
      }
      const next = dayEnd.plus({ millisecond: 1 });
      cursor = next;
    }
  }

  for (const [k, v] of map) {
    map.set(k, mergeIntervals(v));
  }
  return map;
}

const DEFAULT_BAND_START = 7 * 60;
const DEFAULT_BAND_END = 22 * 60;
export const SCHEDULE_SEARCH_BAND_START = DEFAULT_BAND_START;
export const SCHEDULE_SEARCH_BAND_END = DEFAULT_BAND_END;

export function deriveWeeklyAvailabilityFromBusy(params: {
  busy: { start: string; end: string }[];
  timezone: string;
  rangeDays?: number;
  bandStartMin?: number;
  bandEndMin?: number;
}): DayWindowInput[] {
  const zone = params.timezone || "UTC";
  const rangeDays = params.rangeDays ?? 28;
  const bandStart = params.bandStartMin ?? DEFAULT_BAND_START;
  const bandEnd = params.bandEndMin ?? DEFAULT_BAND_END;

  const now = DateTime.now().setZone(zone);
  const startDay = now.startOf("day");
  const endExclusive = startDay.plus({ days: rangeDays });

  const busyByDate = busyIntervalsPerLocalDate(params.busy, zone);

  const freeListsByDow: Seg[][][] = [[], [], [], [], [], [], []];

  for (let i = 0; i < rangeDays; i++) {
    const d = startDay.plus({ days: i });
    if (d >= endExclusive) break;
    const key = d.toFormat("yyyy-MM-dd");
    const dow = luxonWeekdayToAppDow(d.weekday);
    const busySegs = busyByDate.get(key) ?? [];
    const free = subtractFromBand(busySegs, bandStart, bandEnd);
    freeListsByDow[dow].push(free);
  }

  const result: DayWindowInput[] = Array.from({ length: 7 }, () => ({
    enabled: false,
    start_time: "09:00",
    end_time: "17:00",
  }));

  for (let dow = 0; dow < 7; dow++) {
    const lists = freeListsByDow[dow].filter((l) => l.length > 0);
    if (!lists.length) continue;

    let chosen = intersectAll(lists.map((l) => mergeIntervals(l)));
    let seg = pickLongest(chosen);

    if (!seg || seg.end - seg.start < 30) {
      const longestAcrossWeeks = lists
        .map((l) => pickLongest(l))
        .filter((x): x is Seg => x != null);
      seg =
        longestAcrossWeeks.length > 0
          ? longestAcrossWeeks.reduce((a, b) =>
              b.end - b.start > a.end - a.start ? b : a
            )
          : null;
    }

    if (seg && seg.end > seg.start && seg.end - seg.start >= 30) {
      let endMin = seg.end;
      let startMin = seg.start;
      if (endMin - startMin < 30) continue;
      if (endMin > bandEnd) endMin = bandEnd;
      if (startMin < bandStart) startMin = bandStart;
      if (endMin <= startMin) continue;
      let startHHMM = minToHHMM(startMin);
      let endHHMM = minToHHMM(endMin);
      if (startHHMM === endHHMM) continue;
      if (startHHMM >= endHHMM) continue;
      result[dow] = { enabled: true, start_time: startHHMM, end_time: endHHMM };
    }
  }

  return result;
}

export async function fetchAvailabilityWindowsFromCalendar(
  accessToken: string,
  timezone: string
): Promise<DayWindowInput[]> {
  const zone = timezone || "UTC";
  const now = DateTime.now().setZone(zone);
  const timeMin = now.toUTC().toISO()!;
  const timeMax = now.plus({ days: 28 }).toUTC().toISO()!;
  const { busy } = await fetchPrimaryCalendarFreeBusy(accessToken, timeMin, timeMax);
  return deriveWeeklyAvailabilityFromBusy({ busy, timezone: zone });
}

export async function fetchAvailabilityWindowsForCurrentWeekFromCalendar(
  accessToken: string,
  timezone: string
): Promise<DayWindowInput[]> {
  const zone = timezone || "UTC";
  const now = DateTime.now().setZone(zone);
  const weekStart = now.startOf("week");
  const weekEndExclusive = weekStart.plus({ days: 7 });
  const timeMin = weekStart.toUTC().toISO()!;
  const timeMax = weekEndExclusive.toUTC().toISO()!;
  const { busy } = await fetchPrimaryCalendarFreeBusy(accessToken, timeMin, timeMax);
  const rangeDays = Math.max(1, Math.ceil(weekEndExclusive.diff(now.startOf("day"), "days").days));
  return deriveWeeklyAvailabilityFromBusy({ busy, timezone: zone, rangeDays });
}

export function computeThisWeekSlotsFromGeneral(params: {
  general: DaySlotsInput[];
  busy: { start: string; end: string }[];
  timezone: string;
  minCallMinutes: number;
}): DaySlotsInput[] {
  const zone = params.timezone || "UTC";
  const minCallMinutes = Math.max(1, params.minCallMinutes || 15);
  const busyByDate = busyIntervalsPerLocalDate(params.busy, zone);
  const { start } = weekBoundsSunday(zone);
  const out: DaySlotsInput[] = Array.from({ length: 7 }, () => ({ enabled: false, slots: [] }));

  for (let i = 0; i < 7; i += 1) {
    const day = start.plus({ days: i });
    const dow = luxonWeekdayToAppDow(day.weekday);
    const key = day.toFormat("yyyy-MM-dd");
    const busy = busyByDate.get(key) ?? [];
    const generalDay = params.general[dow];
    if (!generalDay?.enabled || !generalDay.slots.length) {
      out[dow] = { enabled: false, slots: [] };
      continue;
    }
    const base = toMinuteSegments(generalDay.slots);
    const free = base
      .flatMap((band) => subtractFromBand(busy, band.start, band.end))
      .filter((seg) => seg.end - seg.start >= minCallMinutes);
    out[dow] = {
      enabled: free.length > 0,
      slots: free.map((seg) => ({
        start_time: minToHHMM(seg.start),
        end_time: minToHHMM(seg.end),
      })),
    };
  }
  return out;
}

export async function fetchThisWeekSlotsFromCalendar(params: {
  accessToken: string;
  timezone: string;
  general: DaySlotsInput[];
  minCallMinutes: number;
}): Promise<DaySlotsInput[]> {
  const zone = params.timezone || "UTC";
  const { start, endExclusive } = weekBoundsSunday(zone);
  const { busy } = await fetchPrimaryCalendarFreeBusy(
    params.accessToken,
    start.toUTC().toISO()!,
    endExclusive.toUTC().toISO()!
  );
  return computeThisWeekSlotsFromGeneral({
    general: params.general,
    busy,
    timezone: zone,
    minCallMinutes: params.minCallMinutes,
  });
}

/** Merge busy intervals (UTC instants) for overlap checks. */
export function mergedBusyIntervalsUtc(busy: { start: string; end: string }[]): UtcInterval[] {
  const intervals = busy
    .map((b) => {
      const s = DateTime.fromISO(b.start, { setZone: true });
      const e = DateTime.fromISO(b.end, { setZone: true });
      if (!s.isValid || !e.isValid || e <= s) return null;
      return { start: s, end: e };
    })
    .filter((x): x is UtcInterval => x != null)
    .sort((a, b) => a.start.toMillis() - b.start.toMillis());

  const merged: UtcInterval[] = [];
  for (const iv of intervals) {
    const last = merged[merged.length - 1];
    if (!last) {
      merged.push(iv);
      continue;
    }
    if (iv.start.toMillis() <= last.end.toMillis()) {
      const newEnd = iv.end > last.end ? iv.end : last.end;
      merged[merged.length - 1] = { start: last.start, end: newEnd };
    } else {
      merged.push(iv);
    }
  }
  return merged;
}

function instantInBusy(dt: DateTime, busy: UtcInterval[]): boolean {
  const t = dt.toMillis();
  for (const iv of busy) {
    const s = iv.start.toMillis();
    const e = iv.end.toMillis();
    if (t >= s && t < e) return true;
  }
  return false;
}

export function nextOccurrenceDates(params: {
  timezone: string;
  recurrence: CalendarRecurrence;
  dayOfWeek: number;
  dayOfMonth: number;
  count: number;
}): DateTime[] {
  const zone = params.timezone || "UTC";
  const today = DateTime.now().setZone(zone).startOf("day");
  const out: DateTime[] = [];

  if (params.recurrence === "monthly") {
    let monthCursor = today.startOf("month");
    for (let i = 0; i < 36 && out.length < params.count; i++) {
      const dim = monthCursor.daysInMonth ?? 31;
      const dom = Math.min(params.dayOfMonth, dim);
      const candidate = monthCursor.set({ day: dom });
      if (candidate >= today) out.push(candidate);
      monthCursor = monthCursor.plus({ months: 1 });
    }
    return out.slice(0, params.count);
  }

  let d = today;
  while (luxonWeekdayToAppDow(d.weekday) !== params.dayOfWeek) {
    d = d.plus({ days: 1 });
  }

  if (params.recurrence === "weekly") {
    for (let k = 0; k < params.count; k++) {
      out.push(d.plus({ weeks: k }));
    }
    return out;
  }

  for (let k = 0; k < params.count; k++) {
    out.push(d.plus({ weeks: 2 * k }));
  }
  return out;
}

export function scheduleInstantForDate(localDate: DateTime, schedTimeHHMM: string): DateTime | null {
  const [hh, mm] = schedTimeHHMM.split(":").map((x) => parseInt(x, 10));
  if (Number.isNaN(hh) || Number.isNaN(mm)) return null;
  return localDate.set({ hour: hh, minute: mm, second: 0, millisecond: 0 });
}

export function checkScheduleConflictsWithBusy(params: {
  busyMerged: UtcInterval[];
  timezone: string;
  recurrence: CalendarRecurrence;
  dayOfWeek: number;
  dayOfMonth: number;
  schedTime: string;
  occurrencesToCheck?: number;
}): boolean {
  const n = params.occurrencesToCheck ?? 3;
  const dates = nextOccurrenceDates({
    timezone: params.timezone,
    recurrence: params.recurrence,
    dayOfWeek: params.dayOfWeek,
    dayOfMonth: params.dayOfMonth,
    count: n,
  });

  for (const d of dates) {
    const inst = scheduleInstantForDate(d, params.schedTime);
    if (!inst) continue;
    if (instantInBusy(inst, params.busyMerged)) return true;
  }
  return false;
}

/** Find up to `maxSuggestions` free slots on the same weekday in `band`, stepping `stepMinutes`. */
export async function runScheduleConflictCheck(params: {
  accessToken: string;
  timezone: string;
  recurrence: CalendarRecurrence;
  dayOfWeek: number;
  dayOfMonth: number;
  schedTime: string;
}): Promise<boolean> {
  const zone = params.timezone || "UTC";
  const now = DateTime.now().setZone(zone);
  const timeMin = now.toUTC().toISO()!;
  const timeMax = now.plus({ days: 56 }).toUTC().toISO()!;
  const { busy } = await fetchPrimaryCalendarFreeBusy(params.accessToken, timeMin, timeMax);
  const merged = mergedBusyIntervalsUtc(busy);
  return checkScheduleConflictsWithBusy({
    busyMerged: merged,
    timezone: zone,
    recurrence: params.recurrence,
    dayOfWeek: params.dayOfWeek,
    dayOfMonth: params.dayOfMonth,
    schedTime: params.schedTime,
  });
}

export async function runSuggestFreeTimes(params: {
  accessToken: string;
  timezone: string;
  targetDayOfWeek: number;
  schedTime: string;
}): Promise<string[]> {
  const zone = params.timezone || "UTC";
  const now = DateTime.now().setZone(zone);
  const timeMin = now.toUTC().toISO()!;
  const timeMax = now.plus({ days: 56 }).toUTC().toISO()!;
  const { busy } = await fetchPrimaryCalendarFreeBusy(params.accessToken, timeMin, timeMax);
  const busyByLocal = busyIntervalsPerLocalDate(busy, zone);
  return suggestFreeTimes({
    busyByLocalDate: busyByLocal,
    timezone: zone,
    targetDayOfWeek: params.targetDayOfWeek,
    schedTime: params.schedTime,
  });
}

export function suggestFreeTimes(params: {
  busyByLocalDate: Map<string, Seg[]>;
  timezone: string;
  targetDayOfWeek: number;
  schedTime: string;
  bandStartMin?: number;
  bandEndMin?: number;
  stepMinutes?: number;
  weeksAhead?: number;
  maxSuggestions?: number;
}): string[] {
  const zone = params.timezone || "UTC";
  const bandStart = params.bandStartMin ?? DEFAULT_BAND_START;
  const bandEnd = params.bandEndMin ?? DEFAULT_BAND_END;
  const step = params.stepMinutes ?? 30;
  const weeksAhead = params.weeksAhead ?? 8;
  const maxSug = params.maxSuggestions ?? 3;

  const [curH, curM] = params.schedTime.split(":").map((x) => parseInt(x, 10));
  const preferredMin =
    Number.isNaN(curH) || Number.isNaN(curM) ? 18 * 60 : curH * 60 + curM;

  let probe = DateTime.now().setZone(zone).startOf("day");
  const endProbe = probe.plus({ weeks: weeksAhead });

  const candidates: { time: string; dist: number }[] = [];

  while (probe <= endProbe && candidates.length < maxSug * 6) {
    if (luxonWeekdayToAppDow(probe.weekday) === params.targetDayOfWeek) {
      const key = probe.toFormat("yyyy-MM-dd");
      const busySegs = params.busyByLocalDate.get(key) ?? [];
      const free = subtractFromBand(busySegs, bandStart, bandEnd);

      for (let m = bandStart; m + step <= bandEnd; m += step) {
        const inside = free.some((seg) => m >= seg.start && m + step <= seg.end);
        if (!inside) continue;
        const hhmm = minToHHMM(m);
        const dist = Math.abs(m - preferredMin);
        candidates.push({ time: hhmm, dist });
      }
    }
    probe = probe.plus({ days: 1 });
  }

  candidates.sort((a, b) => a.dist - b.dist);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of candidates) {
    if (seen.has(c.time)) continue;
    seen.add(c.time);
    out.push(c.time);
    if (out.length >= maxSug) break;
  }
  return out;
}
