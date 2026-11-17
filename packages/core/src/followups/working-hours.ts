import { DateTime } from "luxon";
import { WEEKDAYS, workingHoursSchema, type Holiday, type WorkingHours } from "@lfm/shared";

/**
 * Business-hours arithmetic in the organization's timezone (ADR-010).
 * All inputs/outputs are UTC Dates; calculations happen in `tz`, so DST changes are handled by Luxon.
 */

export type BusinessCalendar = {
  timezone: string;
  workingHours: WorkingHours;
  /** Dates (YYYY-MM-DD, in the business timezone) with no working hours. */
  holidays: Set<string>;
};

export function calendarFromOrg(org: { timezone: string; workingHours: unknown; holidays: unknown }): BusinessCalendar {
  const parsed = workingHoursSchema.safeParse(org.workingHours);
  const workingHours = parsed.success ? parsed.data : (Object.fromEntries(WEEKDAYS.map((d) => [d, []])) as unknown as WorkingHours);
  const holidays = new Set(
    (Array.isArray(org.holidays) ? (org.holidays as Holiday[]) : []).map((h) => (typeof h === "string" ? h : h?.date)).filter(Boolean),
  );
  return { timezone: org.timezone, workingHours, holidays };
}

// Luxon weekday: 1 = Monday … 7 = Sunday.
const dayKey = (dt: DateTime) => WEEKDAYS[dt.weekday - 1]!;

function hasAnyHours(cal: BusinessCalendar) {
  return WEEKDAYS.some((d) => cal.workingHours[d].length > 0);
}

function rangesOn(dt: DateTime, cal: BusinessCalendar) {
  if (cal.holidays.has(dt.toISODate()!)) return [];
  return [...cal.workingHours[dayKey(dt)]]
    .sort((a, b) => a.start.localeCompare(b.start))
    .map((r) => {
      const [sh, sm] = r.start.split(":").map(Number) as [number, number];
      const [eh, em] = r.end.split(":").map(Number) as [number, number];
      return { start: dt.set({ hour: sh, minute: sm, second: 0, millisecond: 0 }), end: dt.set({ hour: eh, minute: em, second: 0, millisecond: 0 }) };
    });
}

/**
 * Returns `at` if it falls inside working hours, otherwise the start of the next working window.
 * With no working hours configured at all, nothing is ever delayed.
 */
export function nextWorkingTime(at: Date, cal: BusinessCalendar): Date {
  if (!hasAnyHours(cal)) return at;
  let cursor = DateTime.fromJSDate(at, { zone: cal.timezone });
  // Holidays could in theory block many days; cap the search at a year.
  for (let i = 0; i < 366; i++) {
    for (const r of rangesOn(cursor.startOf("day"), cal)) {
      if (cursor < r.start) return r.start.toJSDate();
      if (cursor < r.end) return cursor.toJSDate();
    }
    cursor = cursor.plus({ days: 1 }).startOf("day");
  }
  return at;
}

export function isWithinWorkingHours(at: Date, cal: BusinessCalendar): boolean {
  return nextWorkingTime(at, cal).getTime() === at.getTime();
}

/** Due time for a step: elapsed delay from the anchor, then moved into working hours. */
export function computeDueAt(anchor: Date, delayMinutes: number, cal: BusinessCalendar): Date {
  return nextWorkingTime(new Date(anchor.getTime() + delayMinutes * 60_000), cal);
}

/** Start/end of "today" in the business timezone. */
export function todayBounds(timezone: string, now = new Date()) {
  const d = DateTime.fromJSDate(now, { zone: timezone });
  return { start: d.startOf("day").toJSDate(), end: d.endOf("day").toJSDate() };
}
