/**
 * E3-8 AC2: an event's registrations, read from registration-service
 * (AGENTS.md §1 — events-service never queries its table directly). The
 * caller's own bearer token is forwarded; registration-service's own
 * GET /event/:eventId already admits the owning organiser or a coordinator
 * and checks access itself (via its own call back into events-service), so
 * there's no extra auth plumbing needed here.
 */

export interface EventRegistration {
  registrationId: number;
  userId: string;
  status: "Registered" | "Withdrawn";
  name: string | null;
}

export type FetchResult<T> = { status: "ok"; value: T } | { status: "error" };

function registrationServiceUrl(): string {
  return (
    process.env.REGISTRATION_SERVICE_URL ?? `http://localhost:${process.env.REGISTRATION_SERVICE_PORT ?? 4007}`
  );
}

/** Every registration recorded for the event, whatever its status. */
export async function fetchEventRegistrations(
  eventId: number,
  authorization: string,
): Promise<FetchResult<EventRegistration[]>> {
  try {
    const res = await fetch(`${registrationServiceUrl()}/api/registrations/event/${eventId}`, {
      headers: { Authorization: authorization },
    });
    if (!res.ok) return { status: "error" };
    const body = (await res.json()) as {
      registrations?: { registrationId: number; userId: string; status: string; name: string | null }[];
    };
    return {
      status: "ok",
      value: (body.registrations ?? []).map((row) => ({
        registrationId: row.registrationId,
        userId: row.userId,
        status: row.status as EventRegistration["status"],
        name: row.name,
      })),
    };
  } catch {
    return { status: "error" };
  }
}
