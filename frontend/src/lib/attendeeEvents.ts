import type { MyRegistration } from "./registrationApi";
import thumb1 from "../assets/event_thumbnail_1.jpg";
import thumb2 from "../assets/event_thumbnail_2.jpg";
import thumb3 from "../assets/event_thumbnail_3.jpg";
import thumb4 from "../assets/event_thumbnail_4.jpg";
import thumb5 from "../assets/event_thumbnail_5.jpg";
import thumb6 from "../assets/event_thumbnail_6.jpg";

const EVENT_THUMBNAILS = [thumb1, thumb2, thumb3, thumb4, thumb5, thumb6];

/** Deterministic per event (same event always shows the same picture) rather than re-randomized on every render. */
export function eventThumbnail(eventId: number): string {
  return EVENT_THUMBNAILS[eventId % EVENT_THUMBNAILS.length];
}

/** "2026-11-14" → "14 Nov 2026". Parsed as a local date so it never slips a day. */
export function formatCardDate(value: string | null | undefined): string {
  if (!value) return "Date to be confirmed";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** "16:00" → "4:00 PM". Anything that isn't HH:MM is shown as given. */
function formatClock(value: string): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return value;
  const hours = Number(match[1]);
  const suffix = hours >= 12 ? "PM" : "AM";
  return `${hours % 12 || 12}:${match[2]} ${suffix}`;
}

/** "10:00 AM to 4:00 PM"; either end missing degrades gracefully. */
export function formatCardTimeRange(start: string | null | undefined, end: string | null | undefined): string {
  if (start && end) return `${formatClock(start)} to ${formatClock(end)}`;
  if (start) return formatClock(start);
  return "Time to be confirmed";
}

/**
 * Past = the event has ended. An event with no usable date can't be placed
 * in time, so it stays under Upcoming rather than disappearing into Past.
 */
export function isPastRegistration(registration: MyRegistration, now: Date = new Date()): boolean {
  const date = registration.event?.proposedDate;
  if (!date) return false;
  const endsAt = new Date(`${date}T${registration.event?.endTime ?? "23:59"}`);
  return !Number.isNaN(endsAt.getTime()) && endsAt.getTime() < now.getTime();
}

/** "2026-11-14" → "14 November 2026" (no weekday). Parsed as a local date so it never slips a day. */
export function formatLongDate(value: string | null | undefined): string {
  if (!value) return "Date to be confirmed";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}
