import { expect, test } from "@playwright/test";
import {
  approveRequest,
  assignCoordinator,
  expectRefused,
  fetchChat,
  fetchMyNotifications,
  markChatRead,
  registerAttendee,
  registerOrganiser,
  sendChatMessage,
  signInAsCoordinator,
  signInAsCoordinatorLead,
  signInAsSeeded,
  SEEDED_ACCOUNTS,
  submitEvent,
} from "./support/backend";

/**
 * E2-15: each event has a private chat between its organiser and its
 * assigned coordinator, open while the event is in Planning or Confirmed.
 * chat-service checks access against events-service on every call, and a
 * new message notifies the other party through notification-service.
 */

test("organiser and coordinator chat; unread counts and the other side's notification follow", async () => {
  const organiser = await registerOrganiser("chat");
  const [coordinator, lead] = await Promise.all([signInAsCoordinator(), signInAsCoordinatorLead()]);
  const event = await submitEvent(organiser);

  // No coordinator yet: there's nobody to talk to.
  await expectRefused(sendChatMessage(organiser, event.id, "Hello?"), 409);

  await assignCoordinator(lead, event.id, coordinator.id);
  // Requested: assigned, but chat only opens once the request is approved.
  await expectRefused(sendChatMessage(organiser, event.id, "Hello?"), 409);

  await approveRequest(coordinator, event.id);
  const sent = await sendChatMessage(organiser, event.id, "Can we start setup at 9?");
  expect(sent.mine).toBe(true);

  const forCoordinator = await fetchChat(coordinator, event.id);
  expect(forCoordinator.messages.map((m) => [m.body, m.mine])).toEqual([["Can we start setup at 9?", false]]);
  expect(forCoordinator.unreadCount).toBe(1);

  await markChatRead(coordinator, event.id);
  expect((await fetchChat(coordinator, event.id)).unreadCount).toBe(0);

  await expect
    .poll(
      async () =>
        (await fetchMyNotifications(coordinator, 50)).some((n) => n.eventId === event.id && n.type === "message.sent"),
      { message: "waiting for the coordinator's chat notification", timeout: 10_000 },
    )
    .toBe(true);

  await sendChatMessage(coordinator, event.id, "Yes, 9 works.");
  expect((await fetchChat(organiser, event.id)).messages.map((m) => m.body)).toEqual([
    "Can we start setup at 9?",
    "Yes, 9 works.",
  ]);
});

test("nobody outside the event can read or post in its chat", async () => {
  const organiser = await registerOrganiser("chat-private");
  const stranger = await registerOrganiser("chat-stranger");
  const attendee = await registerAttendee("chat-attendee");
  const [coordinator, lead] = await Promise.all([signInAsCoordinator(), signInAsCoordinatorLead()]);
  const otherCoordinator = await signInAsSeeded(SEEDED_ACCOUNTS.coordinatorTwo);
  const event = await submitEvent(organiser);
  await assignCoordinator(lead, event.id, coordinator.id);
  await approveRequest(coordinator, event.id);
  await sendChatMessage(organiser, event.id, "Just between us.");

  for (const outsider of [stranger, otherCoordinator, attendee, lead]) {
    await expectRefused(fetchChat(outsider, event.id), 403);
    await expectRefused(sendChatMessage(outsider, event.id, "Let me in"), 403);
  }
});
