<script setup lang="ts">
import { computed } from "vue";
import EventCard, { type CardFact } from "../ui/EventCard.vue";
import type { PublicEvent } from "../../lib/publicApi";
import { registrationStateBadge } from "../../lib/registrationStatus";
import { eventThumbnail, formatCardDate, formatCardTimeRange } from "../../lib/attendeeEvents";

/**
 * A listed event on the guest pages — the shared EventCard, linking to the
 * public event page (where the guest is asked to sign up before registering).
 */
const props = withDefaults(defineProps<{ event: PublicEvent; venues?: string[] }>(), { venues: () => [] });

const facts = computed<CardFact[]>(() => {
  const list: CardFact[] = [
    { icon: "calendar", text: formatCardDate(props.event.proposedDate) },
    { icon: "clock", text: formatCardTimeRange(props.event.startTime, props.event.endTime) },
  ];
  if (props.venues.length > 0) list.push({ icon: "pin", text: props.venues.join(", ") });
  return list;
});

const badge = computed(() => registrationStateBadge(props.event.registrationState));
</script>

<template>
  <EventCard
    :to="{ name: 'public-event-detail', params: { id: event.id } }"
    :thumbnail="eventThumbnail(event.id)"
    :title="event.name || `Event #${event.id}`"
    :description="event.description"
    :status-label="badge.label"
    :status-class="badge.className"
    :facts="facts"
    person-label="Organiser"
    :person-name="event.organiserName"
  />
</template>
