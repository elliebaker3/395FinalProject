/**
 * Mirrors mobile/googleCalendarAvailability.ts derivation logic for server-side
 * Calendar flows using stored OAuth tokens (Luxon for timezone correctness).
 */
import { DateTime } from "luxon";

const DEFAULT_BAND_START = 7 * 60;
const DEFAULT_BAND_END = 22 * 60;

function mergeIntervals(segs) {
  if (!segs.length) return [];
  const sorted = [...segs].sort((a, b) => a.start - b.start);
  const out = [];
  let cur = { ...sorted[0] };
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start <= cur.end) cur.end = Math.max(cur.end, sorted[i].end);
    else {
      out.push(cur);
      cur = { ...sorted[i] };
    }
  }
  out.push(cur);
  return out;
}

function intersectTwo(listA, listB) {
  const out = [];
  for (const a of listA) {
    for (const b of listB) {
      const s = Math.max(a.start, b.start);
      const e = Math.min(a.end, b.end);
      if (e > s) out.push({ start: s, end: e });
    }
  }
  return mergeIntervals(out);
}

function intersectAll(lists) {
  if (!lists.length) return [];
  let acc = mergeIntervals(lists[0]);
  for (let i = 1; i < lists.length; i++) {
    acc = intersectTwo(acc, mergeIntervals(lists[i]));
  }
  return acc;
}

function subtractFromBand(busy, bandStart, bandEnd) {
  let parts = [{ start: bandStart, end: bandEnd }];
  for (const b of mergeIntervals(busy)) {
    parts = parts
      .flatMap((p) => {
        if (b.end <= p.start || b.start >= p.end) return [p];
        const res = [];
        if (b.start > p.start) res.push({ start: p.start, end: Math.min(b.start, p.end) });
        if (b.end < p.end) res.push({ start: Math.max(b.end, p.start), end: p.end });
        return res;
      })
      .filter((x) => x.end > x.start);
  }
  return mergeIntervals(parts);
}

function minutesFromMidnight(dt) {
  return dt.hour * 60 + dt.minute + dt.second / 60 + dt.millisecond / 60000;
}

function luxonWeekdayToAppDow(weekday) {
  return weekday === 7 ? 0 : weekday;
}

function minToHHMM(m) {
  const total = Math.round(m);
  const h = Math.floor(total / 60);
  const mm = total % 60;
  return `${String(Math.min(23, h)).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function pickLongest(segs) {
  if (!segs.length) return null;
  return segs.reduce((best, s) => (s.end - s.start > best.end - best.start ? s : best));
}

/** @param {{ start: string, end: string }[]} busy */
export function busyIntervalsPerLocalDate(busy, zone) {
  const map = new Map();

  for (const b of busy) {
    const bs = DateTime.fromISO(b.start, { setZone: true });
    const be = DateTime.fromISO(b.end, { setZone: true });
    if (!bs.isValid || !be.isValid || be <= bs) continue;

    let cursor = bs;
    while (cursor < be) {
      const localDay = cursor.setZone(zone);
      const dayStart = localDay.startOf("day");
      const dayEnd = localDay.endOf("day");
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

/**
 * @param {{ busy: { start: string, end: string }[], timezone: string, rangeDays?: number, bandStartMin?: number, bandEndMin?: number }} params
 * @returns {{ enabled: boolean, start_time: string, end_time: string }[]}
 */
export function deriveWeeklyAvailabilityFromBusy(params) {
  const zone = params.timezone || "UTC";
  const rangeDays = params.rangeDays ?? 28;
  const bandStart = params.bandStartMin ?? DEFAULT_BAND_START;
  const bandEnd = params.bandEndMin ?? DEFAULT_BAND_END;

  const now = DateTime.now().setZone(zone);
  const startDay = now.startOf("day");
  const endExclusive = startDay.plus({ days: rangeDays });

  const busyByDate = busyIntervalsPerLocalDate(params.busy, zone);

  const freeListsByDow = [[], [], [], [], [], [], []];

  for (let i = 0; i < rangeDays; i++) {
    const d = startDay.plus({ days: i });
    if (d >= endExclusive) break;
    const key = d.toFormat("yyyy-MM-dd");
    const dow = luxonWeekdayToAppDow(d.weekday);
    const busySegs = busyByDate.get(key) ?? [];
    const free = subtractFromBand(busySegs, bandStart, bandEnd);
    freeListsByDow[dow].push(free);
  }

  const result = Array.from({ length: 7 }, () => ({
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
        .filter((x) => x != null);
      seg =
        longestAcrossWeeks.length > 0
          ? longestAcrossWeeks.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a))
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

/**
 * @param {{ busyByLocalDate: Map<string, { start: number, end: number }[]>, timezone: string, targetDayOfWeek: number, schedTime: string, bandStartMin?: number, bandEndMin?: number, stepMinutes?: number, weeksAhead?: number, maxSuggestions?: number }} params
 */
export function suggestFreeTimes(params) {
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

  const candidates = [];

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
  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    if (seen.has(c.time)) continue;
    seen.add(c.time);
    out.push(c.time);
    if (out.length >= maxSug) break;
  }
  return out;
}
