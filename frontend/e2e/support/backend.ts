import {
  AUTH_URL,
  EQUIPMENT_CATALOG_URL,
  EQUIPMENT_URL,
  EVENTS_URL,
  NOTIFICATIONS_URL,
  REGISTRATION_URL,
  SEEDED_PASSWORD,
  VENUES_URL,
} from "./env";

/**
 * Test data is created through each service's real HTTP API — the same
 * way a real client would — not through direct DB writes and not by
 * clicking through the UI. Only the one flow a test is actually about gets
 * driven through the browser; everything that flow needs to exist
 * beforehand is set up here. See e2e/README.md.
 */

export interface Session {
  id: string;
  name: string;
  email: string;
  password: string;
  role: string;
  token: string;
  user: { id: string; name: string; email: string; role: string };
  /** Where the router sends this role after login (frontend/src/lib/auth.ts LANDING_ROUTE_BY_ROLE). */
  landingPath: string;
}

const LANDING_PATH_BY_ROLE: Record<string, string> = {
  organiser: "/",
  coordinator: "/coordinator",
  attendee: "/attendee/events",
  venue_staff: "/venue-schedule",
  technical_support: "/equipment-requests",
  coordinator_lead: "/lead",
  safety_officer: "/safety-review",
};

/** A per-run-unique, human-readable name — never hardcode one (AGENTS.md, e2e/README.md). */
export function uniqueName(label: string): string {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  return `${label}-${suffix}`;
}

function uniqueEmail(label: string): string {
  return `${uniqueName(label)}@e2e.example.com`;
}

/**
 * A far-future date that's different on every call, so two tests that each
 * book a venue (AGENTS.md §3a: first to reach On Hold/Approved for an
 * overlapping window wins, and the loser is rejected) never collide on the
 * exact same event date purely because they both used eventDetails()'s
 * fixed default. Random within a wide range rather than incrementing, so
 * concurrent test workers can't still collide by racing the same counter.
 */
export function uniqueFutureDate(): string {
  const year = 2090 + Math.floor(Math.random() * 9); // 2090–2098
  const month = 1 + Math.floor(Math.random() * 12);
  const day = 1 + Math.floor(Math.random() * 28); // every month has at least 28 days
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

class ApiError extends Error {
  constructor(method: string, url: string, status: number, body: unknown) {
    super(`${method} ${url} -> ${status}: ${JSON.stringify(body)}`);
  }
}

async function call<T>(method: string, url: string, token: string | null, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(method, url, res.status, parsed);
  return parsed as T;
}

interface LoginResponse {
  token: string;
  user: { id: string; name: string; email: string; role: string };
}

async function sessionFromLogin(email: string, password: string): Promise<Session> {
  const { token, user } = await call<LoginResponse>("POST", `${AUTH_URL}/login`, null, { email, password });
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    password,
    role: user.role,
    token,
    user,
    landingPath: LANDING_PATH_BY_ROLE[user.role] ?? "/",
  };
}

/**
 * Only "attendee" and "organiser" can self-register (the backend rejects
 * every other role at signup) — this is how every test gets a fresh
 * organiser or attendee, never a shared/seeded one.
 */
export async function registerSelfServiceUser(label: string, role: "attendee" | "organiser"): Promise<Session> {
  const name = uniqueName(label);
  const email = uniqueEmail(label);
  const { token, user } = await call<LoginResponse>("POST", `${AUTH_URL}/signup`, null, {
    name,
    email,
    password: SEEDED_PASSWORD,
    role,
  });
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    password: SEEDED_PASSWORD,
    role: user.role,
    token,
    user,
    landingPath: LANDING_PATH_BY_ROLE[user.role] ?? "/",
  };
}

export const registerOrganiser = (label: string) => registerSelfServiceUser(label, "organiser");
export const registerAttendee = (label: string) => registerSelfServiceUser(label, "attendee");

/**
 * coordinator, coordinator_lead, venue_staff, technical_support and
 * safety_officer have no self-signup path (AGENTS.md §5) — they only exist
 * via supabase/seed.sql. Internal-staff tests log in as one of these fixed
 * seeded accounts instead of registering a fresh one. Every seeded account
 * shares SEEDED_PASSWORD.
 */
export const SEEDED_ACCOUNTS = {
  coordinatorOne: "coordinator-one@example.com",
  coordinatorTwo: "coordinator-two@example.com",
  coordinatorLead: "coordinator-lead@example.com",
  venueStaffOne: "venue-staff-one@example.com",
  technicalSupportOne: "tech-support-one@example.com",
  safetyOfficerOne: "safety-officer-one@example.com",
} as const;

export function signInAsSeeded(email: string): Promise<Session> {
  return sessionFromLogin(email, SEEDED_PASSWORD);
}

export const signInAsCoordinator = () => signInAsSeeded(SEEDED_ACCOUNTS.coordinatorOne);
export const signInAsCoordinatorLead = () => signInAsSeeded(SEEDED_ACCOUNTS.coordinatorLead);
export const signInAsVenueStaff = () => signInAsSeeded(SEEDED_ACCOUNTS.venueStaffOne);
export const signInAsTechnicalSupport = () => signInAsSeeded(SEEDED_ACCOUNTS.technicalSupportOne);
export const signInAsSafetyOfficer = () => signInAsSeeded(SEEDED_ACCOUNTS.safetyOfficerOne);

// ---- events-service -------------------------------------------------------

export interface EventRow {
  id: number;
  status: string;
  submitted_details: Record<string, unknown>;
  coordinator_id: string | null;
  created_at: string;
}

/** A valid, minimal submitted_details body — override only the fields a test cares about. */
export function eventDetails(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    name: uniqueName("E2E Event"),
    purpose: "Playwright end-to-end coverage",
    description: "Created by the e2e suite's backend.ts — safe to ignore in the UI.",
    proposedDate: "2099-09-24",
    startTime: "10:00",
    endTime: "12:00",
    expectedAttendance: 50,
    venue: "Any suitable venue",
    accessibility: "None required",
    equipment: "None required",
    technicalSupport: "None required",
    registrationNeeded: false,
    ...overrides,
  };
}

/** Organiser submits a new request — lands directly in Unassigned (AGENTS.md §3). */
export async function submitEvent(
  organiser: Session,
  overrides: Partial<Record<string, unknown>> = {},
): Promise<EventRow> {
  const { event } = await call<{ event: EventRow }>("POST", EVENTS_URL, organiser.token, eventDetails(overrides));
  return event;
}

/** Lead assigns a coordinator — Unassigned -> Requested. */
export async function assignCoordinator(
  lead: Session,
  eventId: number,
  coordinatorId: string,
): Promise<EventRow> {
  const { event } = await call<{ event: EventRow }>(
    "POST",
    `${EVENTS_URL}/${eventId}/assign`,
    lead.token,
    { coordinatorId },
  );
  return event;
}

/** Assigned coordinator approves — Requested -> Planning. */
export async function approveRequest(coordinator: Session, eventId: number): Promise<EventRow> {
  const { event } = await call<{ event: EventRow }>("POST", `${EVENTS_URL}/${eventId}/approve`, coordinator.token, {});
  return event;
}

/** Assigned coordinator rejects — Requested/Clarification Requested -> Rejected. */
export async function rejectRequest(coordinator: Session, eventId: number, reason: string): Promise<EventRow> {
  const { event } = await call<{ event: EventRow }>("POST", `${EVENTS_URL}/${eventId}/reject`, coordinator.token, {
    reason,
  });
  return event;
}

/** Assigned coordinator submits for safety review — Planning -> Safety Review. Requires venue/equipment arrangements already settled. */
export async function submitForSafetyReview(coordinator: Session, eventId: number): Promise<EventRow> {
  const { event } = await call<{ event: EventRow }>(
    "POST",
    `${EVENTS_URL}/${eventId}/submit-safety-review`,
    coordinator.token,
    {
      safetyNotes: {
        equipmentPlacement: "Equipment kept clear of walkways.",
        crowdMovement: "Standard flow, no pinch points expected.",
        emergencyAccess: "Fire exits remain unobstructed.",
        venueRestrictions: "None beyond the venue's own posted capacity.",
      },
    },
  );
  return event;
}

/** Safety Officer approves — Safety Review -> Confirmed. */
export async function approveSafetyReview(safetyOfficer: Session, eventId: number): Promise<EventRow> {
  const { event } = await call<{ event: EventRow }>(
    "POST",
    `${EVENTS_URL}/${eventId}/safety-review/approve`,
    safetyOfficer.token,
    {},
  );
  return event;
}

export async function getEvent(session: Session, eventId: number): Promise<EventRow> {
  const { event } = await call<{ event: EventRow }>("GET", `${EVENTS_URL}/${eventId}`, session.token);
  return event;
}

// ---- venue-service ---------------------------------------------------------

export interface VenueBookingRow {
  id: number;
  status: string;
  venue: { id: number; name: string; location: string };
}

export interface VenueRow {
  id: number;
  name: string;
  location: string;
  capacity: number;
}

/** Coordinator-only search — used to find a venue id to book. */
export async function searchVenues(coordinator: Session): Promise<VenueRow[]> {
  const body = await call<{ venues: VenueRow[] }>("GET", VENUES_URL, coordinator.token);
  return body.venues;
}

/**
 * The signed-in Venue Staff's own venues (`venues.staff_id`, AGENTS.md §3a
 * "Who may decide"). The dev database has more than one venue_staff
 * account with venues split between them (seed migration 0015 only backs
 * every *unassigned* venue onto the first seeded account — a later one
 * created through the UI keeps its own), so a test that both requests a
 * booking as a coordinator and approves it as `signInAsVenueStaff()` must
 * pick a venue from here, not just the first coordinator search result.
 */
export async function fetchMyVenues(venueStaff: Session): Promise<VenueRow[]> {
  const { venues } = await call<{ venues: VenueRow[] }>("GET", `${VENUES_URL}/staff/my-venues`, venueStaff.token);
  return venues;
}

/** Assigned coordinator requests a venue for an event's main programme. */
export async function requestVenueBooking(
  coordinator: Session,
  eventId: number,
  venueId: number,
): Promise<VenueBookingRow> {
  const { booking } = await call<{ booking: VenueBookingRow }>(
    "POST",
    `${VENUES_URL}/bookings`,
    coordinator.token,
    { eventId, venueId },
  );
  return booking;
}

/** Venue Staff approves a pending booking request — Requested/On Hold -> Approved. Must be the venue's own assigned staff member. */
export async function approveVenueBooking(venueStaff: Session, bookingId: number): Promise<VenueBookingRow> {
  const { booking } = await call<{ booking: VenueBookingRow }>(
    "POST",
    `${VENUES_URL}/staff/bookings/${bookingId}/approve`,
    venueStaff.token,
    {},
  );
  return booking;
}

// ---- equipment-service -------------------------------------------------------

export interface CatalogItem {
  id: number;
  name: string;
  totalStock: number;
  availableStock: number;
}

export async function listEquipmentCatalog(session: Session): Promise<CatalogItem[]> {
  const { equipmentCatalog } = await call<{ equipmentCatalog: CatalogItem[] }>(
    "GET",
    EQUIPMENT_CATALOG_URL,
    session.token,
  );
  return equipmentCatalog;
}

/** Assigned coordinator records what an event needs while it's in Planning. */
export async function requestEquipment(
  coordinator: Session,
  eventId: number,
  items: { equipmentCatalogId: number; quantity: number }[],
) {
  return call("POST", EQUIPMENT_URL, coordinator.token, { eventId, items });
}

// ---- registration-service -------------------------------------------------------

export interface RegistrationRow {
  registrationId: number;
  eventId: number;
  userId: string;
  status: string;
}

/** Attendee registers for a Confirmed, registration-open event. */
export async function registerForEvent(attendee: Session, eventId: number): Promise<RegistrationRow> {
  const { registration } = await call<{ registration: RegistrationRow }>(
    "POST",
    REGISTRATION_URL,
    attendee.token,
    { eventId },
  );
  return registration;
}

// ---- notification-service -------------------------------------------------------

export interface NotificationRow {
  id: number;
  type: string;
  title: string;
  body: string;
  link: string | null;
  eventId: number | null;
  read: boolean;
  createdAt: string;
}

/** The caller's own in-app notification feed (E7-1), newest first — used to confirm an action notified someone. */
export async function fetchMyNotifications(session: Session, limit = 20): Promise<NotificationRow[]> {
  const { notifications } = await call<{ notifications: NotificationRow[] }>(
    "GET",
    `${NOTIFICATIONS_URL}?limit=${limit}`,
    session.token,
  );
  return notifications;
}
