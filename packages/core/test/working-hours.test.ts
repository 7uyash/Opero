import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { calendarFromOrg, computeDueAt, isWithinWorkingHours, nextWorkingTime, todayBounds } from "../src";

const day = [{ start: "09:00", end: "18:00" }];
const weekdays = { mon: day, tue: day, wed: day, thu: day, fri: day, sat: [], sun: [] };

const at = (iso: string, zone: string) => DateTime.fromISO(iso, { zone }).toJSDate();
const local = (d: Date, zone: string) => DateTime.fromJSDate(d, { zone }).toFormat("yyyy-MM-dd ccc HH:mm");

describe("nextWorkingTime (Asia/Kolkata, Mon–Fri 09–18)", () => {
  const cal = calendarFromOrg({ timezone: "Asia/Kolkata", workingHours: weekdays, holidays: [{ date: "2026-11-19" }] });
  const tz = "Asia/Kolkata";

  it("keeps times inside working hours", () => {
    const t = at("2026-11-17T10:30", tz); // Tuesday
    expect(nextWorkingTime(t, cal)).toEqual(t);
    expect(isWithinWorkingHours(t, cal)).toBe(true);
  });

  it("moves early-morning times to opening", () => {
    expect(local(nextWorkingTime(at("2026-11-17T06:00", tz), cal), tz)).toBe("2026-11-17 Tue 09:00");
  });

  it("moves evening times to the next working day", () => {
    expect(local(nextWorkingTime(at("2026-11-17T18:00", tz), cal), tz)).toBe("2026-11-18 Wed 09:00");
  });

  it("skips weekends and holidays", () => {
    expect(local(nextWorkingTime(at("2026-11-21T12:00", tz), cal), tz)).toBe("2026-11-23 Mon 09:00"); // Saturday
    expect(local(nextWorkingTime(at("2026-11-18T19:00", tz), cal), tz)).toBe("2026-11-20 Fri 09:00"); // Thu 19th is a holiday
  });

  it("handles split shifts", () => {
    const split = calendarFromOrg({
      timezone: tz,
      workingHours: { ...weekdays, tue: [{ start: "09:00", end: "13:00" }, { start: "14:00", end: "18:00" }] },
      holidays: [],
    });
    expect(local(nextWorkingTime(at("2026-11-17T13:30", tz), split), tz)).toBe("2026-11-17 Tue 14:00");
  });

  it("never delays when no working hours are configured", () => {
    const none = calendarFromOrg({ timezone: tz, workingHours: {}, holidays: [] });
    const t = at("2026-11-22T03:00", tz);
    expect(nextWorkingTime(t, none)).toEqual(t);
  });

  it("computes a 24h step from a Friday-evening lead as Monday morning", () => {
    const due = computeDueAt(at("2026-11-20T19:00", tz), 24 * 60, cal); // Fri 19:00 + 24h = Sat 19:00
    expect(local(due, tz)).toBe("2026-11-23 Mon 09:00");
  });
});

describe("DST (America/New_York)", () => {
  const tz = "America/New_York";
  const cal = calendarFromOrg({ timezone: tz, workingHours: weekdays, holidays: [] });

  it("opens at 09:00 local on the Monday after clocks spring forward", () => {
    // DST starts Sun 2026-03-08. Saturday 12:00 → Monday 09:00 EDT (13:00 UTC).
    const next = nextWorkingTime(at("2026-03-07T12:00", tz), cal);
    expect(local(next, tz)).toBe("2026-03-09 Mon 09:00");
    expect(next.toISOString()).toBe("2026-03-09T13:00:00.000Z");
  });

  it("opens at 09:00 local after clocks fall back", () => {
    // DST ends Sun 2026-11-01. → Monday 09:00 EST (14:00 UTC).
    const next = nextWorkingTime(at("2026-10-31T12:00", tz), cal);
    expect(next.toISOString()).toBe("2026-11-02T14:00:00.000Z");
  });
});

describe("todayBounds", () => {
  it("uses the business timezone, not the server's", () => {
    // 20:00 UTC on Nov 17 is already Nov 18 in Kolkata (UTC+5:30).
    const { start } = todayBounds("Asia/Kolkata", new Date("2026-11-17T20:00:00Z"));
    expect(start.toISOString()).toBe("2026-11-17T18:30:00.000Z");
  });
});
