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

export class ApiError extends Error {
  constructor(
    method: string,
    url: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`${method} ${url} -> ${status}: ${JSON.stringify(body)}`);
  }
}

/**
 * Asserts an API call is refused with exactly `status` — for the backend's
 * own enforcement of who may do what and which transitions are legal
 * (AGENTS.md §3: the backend is the source of truth, not the UI).
 */
export async function expectRefused(request: Promise<unknown>, status: number): Promise<ApiError> {
  try {
    await request;
  } catch (err) {
    if (err instanceof ApiError && err.status === status) return err;
    throw err;
  }
  throw new Error(`expected the request to be refused with ${status}, but it succeeded`);
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

function toSession({ token, user }: LoginResponse, password: string): Session {
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

async function sessionFromLogin(email: string, password: string): Promise<Session> {
  return toSession(await call<LoginResponse>("POST", `${AUTH_URL}/login`, null, { email, password }), password);
}

/**
 * Only "attendee" and "organiser" can self-register (the backend rejects
 * every other role at signup) — this is how every test gets a fresh
 * organiser or attendee, never a shared/seeded one.
 */
export async function registerSelfServiceUser(label: string, role: "attendee" | "organiser"): Promise<Session> {
  const name = uniqueName(label);
  const email = uniqueEmail(label);
  const res = await call<LoginResponse>("POST", `${AUTH_URL}/signup`, null, {
    name,
    email,
    password: SEEDED_PASSWORD,
    role,
  });
  return toSession(res, SEEDED_PASSWORD);
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

/**
 * Assigned coordinator sets the registration open date to today. Attendees
 * only see an event once its open date has arrived (events-service
 * lib/registrationPeriod.ts isListed), and a Confirmed event has none until
 * the coordinator sets one. "Today" is the Singapore date, the same UTC+8
 * the service reads open dates in.
 */
export async function openRegistrationToday(coordinator: Session, eventId: number): Promise<void> {
  const singaporeToday = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  await call("PUT", `${EVENTS_URL}/${eventId}/registration`, coordinator.token, { openDate: singaporeToday });
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

// ---- more lifecycle steps ---------------------------------------------------

/** Assigned coordinator asks the organiser a question — Requested/Planning -> Clarification Requested. */
export async function requestClarification(coordinator: Session, eventId: number, message: string): Promise<EventRow> {
  const { event } = await call<{ event: EventRow }>(
    "POST",
    `${EVENTS_URL}/${eventId}/request-clarification`,
    coordinator.token,
    { message },
  );
  return event;
}

/** Safety Officer rejects the safety arrangement — Safety Review -> Planning (E3-13). */
export async function rejectSafetyReview(safetyOfficer: Session, eventId: number, reason: string): Promise<EventRow> {
  const { event } = await call<{ event: EventRow }>(
    "POST",
    `${EVENTS_URL}/${eventId}/safety-review/reject`,
    safetyOfficer.token,
    { reason },
  );
  return event;
}

/** Owning organiser cancels — any active status -> Cancelled (E3-6). */
export async function cancelEvent(organiser: Session, eventId: number, reason: string): Promise<EventRow> {
  const { event } = await call<{ event: EventRow }>("POST", `${EVENTS_URL}/${eventId}/cancel`, organiser.token, {
    reason,
  });
  return event;
}

/** A direct edit of the event's details (PATCH /events/:id) with the full details body. */
export async function editEvent(
  session: Session,
  eventId: number,
  details: Record<string, unknown>,
): Promise<EventRow> {
  const { event } = await call<{ event: EventRow }>("PATCH", `${EVENTS_URL}/${eventId}`, session.token, details);
  return event;
}

export interface ClimbedEvent {
  event: EventRow;
  organiser: Session;
  coordinator: Session;
  lead: Session;
  venueStaff: Session;
  safetyOfficer: Session;
  venue: VenueRow;
  booking: VenueBookingRow;
}

/**
 * Drives a fresh event to Safety Review through the real APIs: submit,
 * assign, approve, book and approve a venue, submit for safety review. For
 * tests whose subject is what happens next, not the climb itself
 * (event-lifecycle.e2e.ts covers that).
 */
export async function climbToSafetyReview(
  label: string,
  overrides: Partial<Record<string, unknown>> = {},
): Promise<ClimbedEvent> {
  const organiser = await registerOrganiser(`${label}-organiser`);
  const [coordinator, lead, venueStaff, safetyOfficer] = await Promise.all([
    signInAsCoordinator(),
    signInAsCoordinatorLead(),
    signInAsVenueStaff(),
    signInAsSafetyOfficer(),
  ]);
  const event = await submitEvent(organiser, { proposedDate: uniqueFutureDate(), ...overrides });
  await assignCoordinator(lead, event.id, coordinator.id);
  await approveRequest(coordinator, event.id);
  // Any of this staff member's venues, picked at random so parallel tests
  // don't all queue on one venue's decision lock (venue-service lib/venueLock.ts).
  const venues = await fetchMyVenues(venueStaff);
  const venue = venues[Math.floor(Math.random() * venues.length)];
  const requested = await requestVenueBooking(coordinator, event.id, venue.id);
  const booking = await approveVenueBooking(venueStaff, requested.id);
  const inReview = await submitForSafetyReview(coordinator, event.id);
  return { event: inReview, organiser, coordinator, lead, venueStaff, safetyOfficer, venue, booking };
}

/** climbToSafetyReview, then the Safety Officer approves: the event is Confirmed. */
export async function climbToConfirmed(
  label: string,
  overrides: Partial<Record<string, unknown>> = {},
): Promise<ClimbedEvent> {
  const climbed = await climbToSafetyReview(label, overrides);
  const confirmed = await approveSafetyReview(climbed.safetyOfficer, climbed.event.id);
  return { ...climbed, event: confirmed };
}

/** Lead moves an event to a different active coordinator (E2-12); its status doesn't change. */
export async function reassignCoordinator(lead: Session, eventId: number, coordinatorId: string): Promise<EventRow> {
  const { event } = await call<{ event: EventRow }>("POST", `${EVENTS_URL}/${eventId}/reassign`, lead.token, {
    coordinatorId,
  });
  return event;
}

export interface HistoryRow {
  field: string;
  old_value: string | null;
  new_value: string | null;
  changed_by: string;
}

/** The event's change history (field, old value, new value, who), newest first. */
export async function fetchEventHistory(session: Session, eventId: number): Promise<HistoryRow[]> {
  const { history } = await call<{ history: HistoryRow[] }>("GET", `${EVENTS_URL}/${eventId}/history`, session.token);
  return history;
}

// ---- safety review outcomes ----------------------------------------------------

export interface SafetyArrangement {
  type: "venue_booking" | "equipment_item";
  id: number;
  note: string;
}

/** Safety Officer asks for specific arrangements to change — Safety Review -> Planning (E3-14). */
export async function requestSafetyChanges(
  safetyOfficer: Session,
  eventId: number,
  arrangements: SafetyArrangement[],
  generalNote?: string,
): Promise<EventRow> {
  const { event } = await call<{ event: EventRow }>(
    "POST",
    `${EVENTS_URL}/${eventId}/safety-review/request-changes`,
    safetyOfficer.token,
    { arrangements, generalNote },
  );
  return event;
}

export interface SafetyChanges {
  reason: string;
  generalNote: string | null;
  flags: { type: string; id: number; note: string; clearedAt: string | null }[];
}

/** The open "changes requested" outcome and its flags, or null when there's none. */
export async function fetchSafetyChanges(session: Session, eventId: number): Promise<SafetyChanges | null> {
  const { changeRequest } = await call<{ changeRequest: SafetyChanges | null }>(
    "GET",
    `${EVENTS_URL}/${eventId}/safety-changes`,
    session.token,
  );
  return changeRequest;
}

// ---- change requests on a Confirmed event --------------------------------------

export interface ChangeRequestResult {
  changeRequestId: number;
  applied: string[];
  held: string[];
}

/** Organiser asks to change fields of a Confirmed / Needs Review event (E3-9). Only the fields sent are changed. */
export async function raiseChangeRequest(
  organiser: Session,
  eventId: number,
  fields: Record<string, unknown>,
): Promise<ChangeRequestResult> {
  return call<ChangeRequestResult>("POST", `${EVENTS_URL}/${eventId}/change-requests`, organiser.token, fields);
}

/** Assigned coordinator approves every held field of a change request (E3-11). */
export async function approveChangeRequest(coordinator: Session, eventId: number, requestId: number): Promise<void> {
  await call("POST", `${EVENTS_URL}/${eventId}/change-requests/${requestId}/approve`, coordinator.token, {});
}

/** Assigned coordinator rejects a whole change request, with a reason. */
export async function rejectChangeRequest(
  coordinator: Session,
  eventId: number,
  requestId: number,
  reason: string,
): Promise<void> {
  await call("POST", `${EVENTS_URL}/${eventId}/change-requests/${requestId}/reject`, coordinator.token, { reason });
}

// ---- venue availability ----------------------------------------------------------

/** Venue Staff block a venue out for whole days (E4-3), flagging and notifying any booking it hits. */
export async function blockOutVenue(
  venueStaff: Session,
  venueId: number,
  date: string,
  reason: string,
): Promise<void> {
  await call("POST", `${VENUES_URL}/unavailability`, venueStaff.token, {
    venueId,
    startDate: date,
    endDate: date,
    allDay: true,
    reason,
  });
}

/** Coordinator releases a confirmed (or replaced) booking (E4-9, E4-15). */
export async function releaseVenueBooking(coordinator: Session, bookingId: number): Promise<void> {
  await call("POST", `${VENUES_URL}/bookings/${bookingId}/release`, coordinator.token, {});
}

// ---- reading other services' side of a flow ----------------------------------

/** Every venue booking of an event, any status — as its coordinator or organiser sees them. */
export async function fetchEventBookings(
  session: Session,
  eventId: number,
): Promise<(VenueBookingRow & { decisionReason: string | null })[]> {
  const { bookings } = await call<{
    bookings: (VenueBookingRow & { decisionReason: string | null })[];
  }>("GET", `${VENUES_URL}/events/${eventId}/bookings`, session.token);
  return bookings;
}

/** An event's registrations, any status — as its organiser or coordinator sees them. */
export async function fetchEventRegistrations(session: Session, eventId: number): Promise<RegistrationRow[]> {
  const { registrations } = await call<{ registrations: RegistrationRow[] }>(
    "GET",
    `${REGISTRATION_URL}/event/${eventId}`,
    session.token,
  );
  return registrations;
}

/** Attendee gives up their own place (E6-4). */
export async function withdrawRegistration(attendee: Session, eventId: number): Promise<void> {
  await call("PATCH", `${REGISTRATION_URL}/event/${eventId}/withdraw`, attendee.token, {});
}
