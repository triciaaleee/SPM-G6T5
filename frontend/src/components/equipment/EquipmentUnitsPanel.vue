<script setup lang="ts">
/**
 * E5-5: Technical Support mark equipment damaged or under maintenance for a
 * period, so it stops being offered to events.
 *
 * Units are interchangeable and anonymous, so marking is by quantity from the
 * equipment type: enter how many, the reason and the dates, and "Check impact"
 * shows every unit of that type for those dates (free, reserved for which
 * events, or already out of use) with the system's suggestion pre-ticked — free
 * units first, then those reserved for the events furthest away. Tick other
 * units if you know which ones broke. Nothing is saved, and no coordinator is
 * told, until you confirm.
 *
 * What is out of use is listed under each type, grouped as it was marked, with
 * one "Mark usable again". The per-unit list (with search and an optional label
 * such as the sticker number) is there for the odd case where one specific unit
 * matters. A unit marked Damaged or Under Maintenance outside the app (no dates)
 * shows as unusable with no way to clear it here.
 */
import AppButton from "../ui/AppButton.vue";
import { computed, onMounted, reactive, ref, watch } from "vue";
import {
  EquipmentRequestError,
  EquipmentValidationError,
  UNIT_UNAVAILABILITY_REASONS,
  clearUnavailability,
  fetchEquipmentUnits,
  fetchUnitImpact,
  markUnitUsable,
  markUnitsUnusable,
  setUnitLabel,
  type EquipmentUnit,
  type UnitImpactPreview,
  type UnitUnavailabilityPeriod,
  type UnitUnavailabilityReason,
} from "../../lib/equipmentApi";
import { formatCardDate } from "../../lib/attendeeEvents";

/** Lets the page refresh the stock numbers: marking or clearing units changes what is available. */
const emit = defineEmits<{ changed: [] }>();

const units = ref<EquipmentUnit[]>([]);
const loading = ref(true);
const errorMessage = ref<string | null>(null);
const notice = ref<{ text: string; warning: boolean } | null>(null);

/** Local calendar date, YYYY-MM-DD. */
function todayLocal(): string {
  return new Date().toLocaleDateString("en-CA");
}

const groups = computed(() => {
  const byType = new Map<string, EquipmentUnit[]>();
  for (const unit of units.value) byType.set(unit.type, [...(byType.get(unit.type) ?? []), unit]);
  return [...byType.entries()].map(([type, list]) => ({ type, units: list }));
});

function isRunning(period: UnitUnavailabilityPeriod): boolean {
  const today = todayLocal();
  return period.startDate <= today && (period.endDate === null || period.endDate >= today);
}

function isUnusableNow(unit: EquipmentUnit): boolean {
  return unit.status !== "Available" || unit.periods.some(isRunning);
}

function unusableCount(list: EquipmentUnit[]): number {
  return list.filter(isUnusableNow).length;
}

/** "Projector #12", or "Projector #12 · A-012" when the unit has a label. */
function unitName(type: string, id: number, label: string | null): string {
  return label ? `${type} #${id} · ${label}` : `${type} #${id}`;
}

function periodText(period: { startDate: string; endDate: string | null }): string {
  const from = formatCardDate(period.startDate);
  return period.endDate === null ? `From ${from} until marked usable again` : `${formatCardDate(period.startDate)} to ${formatCardDate(period.endDate)}`;
}

/** What the unit's condition is today, for its badge. */
function stateOf(unit: EquipmentUnit): { label: string; tone: "ok" | "bad" } {
  if (unit.status !== "Available") return { label: unit.status, tone: "bad" };
  const running = unit.periods.find(isRunning);
  if (running) return { label: running.reason, tone: "bad" };
  return { label: "Available", tone: "ok" };
}

// What is out of use, grouped as it was marked ---------------------------------

interface OutGroup {
  key: string;
  reason: UnitUnavailabilityReason;
  startDate: string;
  endDate: string | null;
  note: string | null;
  periodIds: number[];
  units: { id: number; label: string | null }[];
}

const outOfUse = computed(() => {
  const byType = new Map<string, Map<string, OutGroup>>();
  for (const unit of units.value) {
    for (const period of unit.periods) {
      const key = [period.reason, period.startDate, period.endDate ?? "", period.note ?? ""].join("|");
      const typeGroups = byType.get(unit.type) ?? new Map<string, OutGroup>();
      const group = typeGroups.get(key) ?? {
        key,
        reason: period.reason,
        startDate: period.startDate,
        endDate: period.endDate,
        note: period.note,
        periodIds: [],
        units: [],
      };
      group.periodIds.push(period.id);
      group.units.push({ id: unit.id, label: unit.label });
      typeGroups.set(key, group);
      byType.set(unit.type, typeGroups);
    }
  }
  return new Map([...byType].map(([type, map]) => [type, [...map.values()].sort((a, b) => a.startDate.localeCompare(b.startDate))]));
});

function outGroupsOf(type: string): OutGroup[] {
  return outOfUse.value.get(type) ?? [];
}

const clearingKey = ref<string | null>(null);

async function markGroupUsable(type: string, group: OutGroup): Promise<void> {
  clearingKey.value = group.key;
  try {
    await clearUnavailability(group.periodIds);
    const gone = new Set(group.periodIds);
    for (const unit of units.value) unit.periods = unit.periods.filter((p) => !gone.has(p.id));
    emit("changed");
    notice.value = {
      text: `${group.units.length} ${type} ${group.units.length === 1 ? "unit" : "units"} marked usable again.`,
      warning: false,
    };
  } catch (err) {
    notice.value = { text: err instanceof EquipmentRequestError ? err.message : "We couldn't update those units. Please try again.", warning: true };
  } finally {
    clearingKey.value = null;
  }
}

// Mark unusable: quantity, check impact, confirm --------------------------------

const markingType = ref<string | null>(null);
const form = reactive({
  quantity: "1",
  reason: "Damaged" as UnitUnavailabilityReason,
  startDate: "",
  endDate: "",
  note: "",
  checking: false,
  saving: false,
  fieldErrors: {} as Record<string, string>,
  error: null as string | null,
});
const impact = ref<UnitImpactPreview | null>(null);
const selected = reactive(new Set<number>());

function startMarking(type: string): void {
  notice.value = null;
  Object.assign(form, { quantity: "1", reason: "Damaged", startDate: todayLocal(), endDate: "", note: "", checking: false, saving: false, fieldErrors: {}, error: null });
  impact.value = null;
  selected.clear();
  markingType.value = type;
}

function stopMarking(): void {
  markingType.value = null;
  impact.value = null;
  selected.clear();
}

// A preview only holds for the quantity and dates it was made for.
watch(
  () => [form.quantity, form.startDate, form.endDate],
  () => {
    impact.value = null;
    selected.clear();
  },
);

async function checkImpact(): Promise<void> {
  const type = markingType.value;
  if (!type) return;
  form.fieldErrors = {};
  form.error = null;

  const quantity = Number(form.quantity);
  if (!Number.isInteger(quantity) || quantity < 1) form.fieldErrors.quantity = "Enter a whole number, 1 or more.";
  if (!form.startDate) form.fieldErrors.startDate = "Start date is required.";
  if (Object.keys(form.fieldErrors).length > 0) return;

  form.checking = true;
  try {
    const preview = await fetchUnitImpact(type, { startDate: form.startDate, endDate: form.endDate || undefined, quantity });
    impact.value = preview;
    selected.clear();
    for (const id of preview.suggested) selected.add(id);
  } catch (err) {
    if (err instanceof EquipmentValidationError) form.fieldErrors = err.fields;
    else form.error = err instanceof EquipmentRequestError ? err.message : "We couldn't check the impact. Please try again.";
  } finally {
    form.checking = false;
  }
}

function toggleUnit(id: number): void {
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
}

function resetToSuggestion(): void {
  selected.clear();
  for (const id of impact.value?.suggested ?? []) selected.add(id);
}

/** The events the ticked units are reserved for, with how many of their units are affected. */
const affected = computed(() => {
  const byEvent = new Map<number, { eventId: number; eventName: string; proposedDate: string | null; units: number }>();
  for (const unit of impact.value?.units ?? []) {
    if (!selected.has(unit.id)) continue;
    for (const event of unit.events) {
      const entry = byEvent.get(event.eventId) ?? { ...event, units: 0 };
      entry.units += 1;
      byEvent.set(event.eventId, entry);
    }
  }
  return [...byEvent.values()].sort((a, b) => (a.proposedDate ?? "9999").localeCompare(b.proposedDate ?? "9999"));
});

const shortBy = computed(() => {
  if (!impact.value) return 0;
  return Math.max(0, Number(form.quantity) - impact.value.pickable);
});

function stateText(unit: { state: string; reason: string | null; events: { eventName: string; proposedDate: string | null }[] }): string {
  if (unit.state === "unavailable") return `Already out of use (${unit.reason})`;
  if (unit.state === "reserved") {
    return `Reserved for ${unit.events.map((e) => `${e.eventName}${e.proposedDate ? ` (${formatCardDate(e.proposedDate)})` : ""}`).join(", ")}`;
  }
  return "Free";
}

async function confirm(): Promise<void> {
  const type = markingType.value;
  if (!type || selected.size === 0) return;
  form.saving = true;
  form.error = null;
  try {
    const result = await markUnitsUnusable({
      type,
      unitIds: [...selected],
      reason: form.reason,
      startDate: form.startDate,
      endDate: form.endDate || undefined,
      note: form.note || undefined,
    });

    const marked = result.periods.map((p) => `#${p.unitId}`).join(", ");
    const head = `Marked ${result.periods.length} ${type} ${result.periods.length === 1 ? "unit" : "units"} unusable (${marked}).`;
    if (result.affectedEvents.length === 0) {
      notice.value = { text: `${head} No reserved events are affected.`, warning: false };
    } else {
      const names = result.affectedEvents.map((e) => e.eventName).join(", ");
      notice.value = result.notified
        ? { text: `${head} Reserved for ${names}; the coordinator${result.affectedEvents.length === 1 ? " has" : "s have"} been notified.`, warning: false }
        : { text: `${head} Reserved for ${names}, but we couldn't notify every coordinator — please follow up directly.`, warning: true };
    }
    stopMarking();
    emit("changed");
    try {
      units.value = await fetchEquipmentUnits();
    } catch {
      // The periods are saved; the list just stays as it was until the page is reloaded.
    }
  } catch (err) {
    if (err instanceof EquipmentValidationError) form.fieldErrors = err.fields;
    else form.error = err instanceof EquipmentRequestError ? err.message : "We couldn't save that. Please try again.";
  } finally {
    form.saving = false;
  }
}

// The per-unit list -------------------------------------------------------------

const open = reactive(new Set<string>());
const search = ref("");
const unusableOnly = ref(false);

function toggleList(type: string): void {
  if (open.has(type)) open.delete(type);
  else open.add(type);
}

function visibleUnits(list: EquipmentUnit[]): EquipmentUnit[] {
  const needle = search.value.trim().toLowerCase();
  return list.filter((unit) => {
    if (unusableOnly.value && !isUnusableNow(unit)) return false;
    if (!needle) return true;
    return String(unit.id).includes(needle.replace(/^#/, "")) || (unit.label ?? "").toLowerCase().includes(needle);
  });
}

const removingId = ref<number | null>(null);

async function markUsable(unit: EquipmentUnit, period: UnitUnavailabilityPeriod): Promise<void> {
  removingId.value = period.id;
  try {
    await markUnitUsable(unit.id, period.id);
    unit.periods = unit.periods.filter((p) => p.id !== period.id);
    emit("changed");
    notice.value = { text: `${unitName(unit.type, unit.id, unit.label)} marked usable again.`, warning: false };
  } catch (err) {
    notice.value = { text: err instanceof EquipmentRequestError ? err.message : "We couldn't update that unit. Please try again.", warning: true };
  } finally {
    removingId.value = null;
  }
}

const editingLabel = reactive<Record<number, string>>({});

function startLabel(unit: EquipmentUnit): void {
  editingLabel[unit.id] = unit.label ?? "";
}

function cancelLabel(unit: EquipmentUnit): void {
  delete editingLabel[unit.id];
}

async function saveLabel(unit: EquipmentUnit): Promise<void> {
  try {
    const saved = await setUnitLabel(unit.id, editingLabel[unit.id] ?? "");
    unit.label = saved.label;
    delete editingLabel[unit.id];
  } catch (err) {
    const message = err instanceof EquipmentValidationError ? err.fields.label : err instanceof EquipmentRequestError ? err.message : null;
    notice.value = { text: message ?? "We couldn't save that label. Please try again.", warning: true };
  }
}

onMounted(async () => {
  try {
    units.value = await fetchEquipmentUnits();
  } catch {
    errorMessage.value = "We couldn't load the equipment units. Please try again.";
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <section class="units" aria-labelledby="units-title">
    <div>
      <h2 id="units-title" class="h4">Equipment units</h2>
      <p class="body-small muted">
        Mark equipment damaged or under maintenance so it isn't offered to events. You'll see which events a change touches
        before anything is saved.
      </p>
    </div>

    <p v-if="notice" class="body-small notice" :class="{ 'notice--warning': notice.warning }" role="status" data-testid="units-notice">
      {{ notice.text }}
    </p>

    <p v-if="loading" class="body-default muted">Loading the equipment units…</p>
    <p v-else-if="errorMessage" class="body-default error-text" role="alert">{{ errorMessage }}</p>
    <p v-else-if="groups.length === 0" class="body-default muted">There are no equipment units yet.</p>

    <ul v-else class="type-list">
      <li v-for="group in groups" :key="group.type" class="type" :data-testid="`type-${group.type}`">
        <div class="type__top">
          <button
            type="button"
            class="type__header"
            :aria-expanded="open.has(group.type)"
            :aria-controls="`units-${group.type}`"
            @click="toggleList(group.type)"
          >
            <span class="type__name">{{ group.type }}</span>
            <span class="body-small muted">
              {{ group.units.length }} {{ group.units.length === 1 ? "unit" : "units" }}
              <template v-if="unusableCount(group.units) > 0"> · {{ unusableCount(group.units) }} unusable now</template>
            </span>
          </button>
          <AppButton
            v-if="markingType !== group.type"
            variant="outline"
            size="sm"
            type="button"
            :aria-label="`Mark ${group.type} unusable`"
            data-testid="type-mark"
            @click="startMarking(group.type)"
          >
            Mark unusable
          </AppButton>
        </div>

        <!-- What is out of use, grouped as it was marked -->
        <ul v-if="outGroupsOf(group.type).length > 0" class="out-list" :aria-label="`${group.type} out of use`">
          <li v-for="out in outGroupsOf(group.type)" :key="out.key" class="out body-small" data-testid="out-group">
            <span>
              <strong>{{ out.units.length }}× {{ out.reason }}</strong> · {{ periodText(out) }}<template v-if="out.note"> — {{ out.note }}</template>
              <span class="muted"> ({{ out.units.map((u) => `#${u.id}`).join(", ") }})</span>
            </span>
            <AppButton
              variant="ghost"
              size="sm"
              type="button"
              :disabled="clearingKey === out.key"
              :aria-label="`Mark ${out.units.length} ${group.type} usable again (${out.reason}, ${periodText(out)})`"
              data-testid="group-usable"
              @click="markGroupUsable(group.type, out)"
            >
              {{ clearingKey === out.key ? "Updating…" : "Mark usable again" }}
            </AppButton>
          </li>
        </ul>

        <!-- Mark unusable: quantity, then the impact, then confirm -->
        <form v-if="markingType === group.type" class="form" data-testid="mark-form" @submit.prevent="checkImpact">
          <p v-if="form.error" class="body-small error-text" role="alert">{{ form.error }}</p>

          <div class="form__fields">
            <div class="field">
              <label :for="`qty-${group.type}`" class="field-label">How many</label>
              <input :id="`qty-${group.type}`" v-model="form.quantity" type="number" min="1" class="input input--short" />
              <p v-if="form.fieldErrors.quantity" class="field-error" role="alert">{{ form.fieldErrors.quantity }}</p>
            </div>
            <div class="field">
              <label :for="`reason-${group.type}`" class="field-label">Reason</label>
              <select :id="`reason-${group.type}`" v-model="form.reason" class="input">
                <option v-for="reason in UNIT_UNAVAILABILITY_REASONS" :key="reason" :value="reason">{{ reason }}</option>
              </select>
              <p v-if="form.fieldErrors.reason" class="field-error" role="alert">{{ form.fieldErrors.reason }}</p>
            </div>
            <div class="field">
              <label :for="`from-${group.type}`" class="field-label">From</label>
              <input :id="`from-${group.type}`" v-model="form.startDate" type="date" class="input" />
              <p v-if="form.fieldErrors.startDate" class="field-error" role="alert">{{ form.fieldErrors.startDate }}</p>
            </div>
            <div class="field">
              <label :for="`until-${group.type}`" class="field-label">Until (optional)</label>
              <input :id="`until-${group.type}`" v-model="form.endDate" type="date" class="input" :min="form.startDate" />
              <p v-if="form.fieldErrors.endDate" class="field-error" role="alert">{{ form.fieldErrors.endDate }}</p>
            </div>
          </div>
          <p class="body-small muted">Leave "Until" blank if it is unusable until it is repaired.</p>

          <div class="field">
            <label :for="`note-${group.type}`" class="field-label">Note (optional)</label>
            <textarea :id="`note-${group.type}`" v-model="form.note" class="input" rows="2" maxlength="500" />
            <p v-if="form.fieldErrors.note" class="field-error" role="alert">{{ form.fieldErrors.note }}</p>
          </div>

          <div v-if="!impact" class="form__actions">
            <AppButton variant="primary" type="submit" :disabled="form.checking" data-testid="check-impact">
              {{ form.checking ? "Checking…" : "Check impact" }}
            </AppButton>
            <AppButton variant="outline" type="button" @click="stopMarking">Cancel</AppButton>
          </div>

          <!-- The impact preview: nothing is saved until Confirm -->
          <section v-else class="impact" aria-label="Impact" data-testid="impact">
            <p v-if="shortBy > 0" class="body-small impact__warn" data-testid="impact-short">
              Only {{ impact.pickable }} of the {{ form.quantity }} can be marked: the rest are already out of use for those dates.
            </p>

            <p v-if="affected.length === 0" class="body-small impact__ok" data-testid="impact-none">
              No reserved events are affected.
            </p>
            <div v-else class="impact__affects" data-testid="impact-events">
              <p class="body-small"><strong>This will affect:</strong></p>
              <ul class="impact__events">
                <li v-for="event in affected" :key="event.eventId" class="body-small">
                  {{ event.eventName }}<template v-if="event.proposedDate"> ({{ formatCardDate(event.proposedDate) }})</template>
                  — {{ event.units }} {{ event.units === 1 ? "unit" : "units" }}. Its coordinator will be notified.
                </li>
              </ul>
            </div>

            <p class="body-small muted">
              {{ selected.size }} selected. The units below are suggested; tick others if you know which ones are affected.
              <button type="button" class="link-button" data-testid="reset-suggestion" @click="resetToSuggestion">Use the suggestion</button>
            </p>

            <ul class="pick-list">
              <li v-for="unit in impact.units" :key="unit.id" class="pick" :class="{ 'pick--disabled': unit.state === 'unavailable' }">
                <label class="pick__label">
                  <input
                    type="checkbox"
                    :checked="selected.has(unit.id)"
                    :disabled="unit.state === 'unavailable'"
                    :aria-label="`Select ${unitName(group.type, unit.id, unit.label)}`"
                    :data-testid="`pick-${unit.id}`"
                    @change="toggleUnit(unit.id)"
                  />
                  <span class="pick__name">{{ unitName(group.type, unit.id, unit.label) }}</span>
                  <span class="body-small" :class="unit.state === 'reserved' ? 'pick__reserved' : 'muted'">{{ stateText(unit) }}</span>
                </label>
              </li>
            </ul>

            <div class="form__actions">
              <AppButton variant="primary" type="button" :disabled="form.saving || selected.size === 0" data-testid="confirm-mark" @click="confirm">
                {{ form.saving ? "Saving…" : `Confirm — mark ${selected.size} unusable` }}
              </AppButton>
              <AppButton variant="outline" type="button" :disabled="form.saving" @click="stopMarking">Cancel</AppButton>
            </div>
          </section>
        </form>

        <!-- The per-unit list -->
        <div v-if="open.has(group.type)" :id="`units-${group.type}`" class="unit-section">
          <div class="unit-filters">
            <input v-model="search" type="search" class="input" placeholder="Find a unit by number or label" aria-label="Find a unit" />
            <label class="check body-small">
              <input v-model="unusableOnly" type="checkbox" /> Unusable only
            </label>
          </div>
          <ul class="unit-list">
            <li v-for="unit in visibleUnits(group.units)" :key="unit.id" class="unit" :data-testid="`unit-${unit.id}`">
              <div class="unit__row">
                <span class="unit__name">{{ unitName(unit.type, unit.id, unit.label) }}</span>
                <span class="chip" :class="stateOf(unit).tone === 'bad' ? 'chip--bad' : 'chip--ok'">{{ stateOf(unit).label }}</span>
                <AppButton
                  v-if="editingLabel[unit.id] === undefined"
                  variant="ghost"
                  size="sm"
                  type="button"
                  :aria-label="`Edit the label of ${unitName(unit.type, unit.id, unit.label)}`"
                  data-testid="edit-label"
                  @click="startLabel(unit)"
                >
                  {{ unit.label ? "Edit label" : "Add label" }}
                </AppButton>
              </div>
              <div v-if="editingLabel[unit.id] !== undefined" class="label-edit">
                <input v-model="editingLabel[unit.id]" type="text" maxlength="50" class="input" :aria-label="`Label for #${unit.id}`" data-testid="label-input" />
                <AppButton variant="primary" size="sm" type="button" data-testid="save-label" @click="saveLabel(unit)">Save</AppButton>
                <AppButton variant="outline" size="sm" type="button" @click="cancelLabel(unit)">Cancel</AppButton>
              </div>
              <ul v-if="unit.periods.length > 0" class="period-list">
                <li v-for="period in unit.periods" :key="period.id" class="period body-small">
                  <span>
                    <strong>{{ period.reason }}</strong> · {{ periodText(period) }}<template v-if="period.note"> — {{ period.note }}</template>
                  </span>
                  <AppButton
                    variant="ghost"
                    size="sm"
                    type="button"
                    :disabled="removingId === period.id"
                    :aria-label="`Mark ${unitName(unit.type, unit.id, unit.label)} usable again (${period.reason}, ${periodText(period)})`"
                    data-testid="mark-usable"
                    @click="markUsable(unit, period)"
                  >
                    {{ removingId === period.id ? "Updating…" : "Mark usable again" }}
                  </AppButton>
                </li>
              </ul>
            </li>
          </ul>
          <p v-if="visibleUnits(group.units).length === 0" class="body-small muted">No units match.</p>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.units {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-16);
}

.h4 {
  font-size: 1.25rem;
  font-weight: 700;
  line-height: 1.75rem;
  color: var(--color-grey-900);
  margin: 0;
}

.body-default {
  font-size: 1rem;
  line-height: 1.25rem;
  margin: 0;
}

.body-small {
  font-size: 0.875rem;
  line-height: 1.125rem;
  margin: 0;
}

.muted {
  color: var(--color-grey-500);
}

.error-text {
  color: var(--color-error-600);
}

.notice {
  padding: var(--spacing-8) var(--spacing-12);
  border-radius: var(--radius-xs);
  background: var(--color-grey-75);
  color: var(--color-grey-900);
}

.notice--warning {
  background: var(--color-warning-100);
  color: var(--color-warning-900);
}

.type-list,
.unit-list,
.period-list,
.out-list,
.pick-list,
.impact__events {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.type-list {
  gap: var(--spacing-8);
}

.type {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-12);
  padding: var(--spacing-12) var(--spacing-16);
  background: var(--color-base-white);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-xs);
}

.type__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--spacing-12);
}

.type__header {
  flex: 1 1 12rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-16);
  padding: var(--spacing-4) 0;
  border: none;
  background: transparent;
  font-family: var(--font-family-lato);
  text-align: left;
  cursor: pointer;
}

.type__header:focus-visible {
  outline: 2px solid var(--ring-brand);
  outline-offset: 2px;
}

.type__name {
  font-size: 1rem;
  font-weight: 700;
  color: var(--color-grey-900);
}

/* What is out of use: the Warning set's "needs attention" role. */
.out-list {
  gap: var(--spacing-4);
}

.out,
.period {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--spacing-8);
  padding: var(--spacing-4) var(--spacing-8);
  border-radius: var(--radius-xs);
  background: var(--color-warning-100);
  color: var(--color-warning-900);
}

.form {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-12);
  padding: var(--spacing-12);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-xs);
  background: var(--color-grey-50);
}

.form__fields {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-12);
}

.form__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-8);
}

.field {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-4);
  min-width: 0;
}

.field-label {
  font-size: 0.875rem;
  font-weight: 700;
  color: var(--color-grey-700);
}

.field-error {
  margin: 0;
  font-size: 0.875rem;
  color: var(--color-error-600);
}

.input {
  font-family: var(--font-family-lato);
  font-size: 0.9375rem;
  color: var(--color-grey-900);
  background: var(--color-base-white);
  border: 1px solid var(--color-grey-200);
  border-radius: var(--radius-xs);
  padding: var(--spacing-8) var(--spacing-12);
}

.input--short {
  width: 6rem;
}

.input:focus-visible {
  outline: none;
  border-color: var(--ring-brand);
  box-shadow: 0 0 0 4px var(--ring-light);
}

/* Impact preview ------------------------------------------------------------ */

.impact {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-12);
}

.impact__ok {
  padding: var(--spacing-8) var(--spacing-12);
  border-radius: var(--radius-xs);
  background: var(--color-success-200);
  color: var(--color-success-700);
}

.impact__warn,
.impact__affects {
  padding: var(--spacing-8) var(--spacing-12);
  border-radius: var(--radius-xs);
  background: var(--color-warning-100);
  color: var(--color-warning-900);
}

.impact__events {
  gap: var(--spacing-4);
  margin-top: var(--spacing-4);
}

.link-button {
  border: none;
  background: none;
  padding: 0;
  font-family: var(--font-family-lato);
  font-size: 0.875rem;
  font-weight: 700;
  color: var(--color-purple-600);
  cursor: pointer;
}

.link-button:hover {
  text-decoration: underline;
}

.pick-list {
  max-height: 16rem;
  overflow-y: auto;
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-xs);
  background: var(--color-base-white);
}

.pick + .pick {
  border-top: 1px solid var(--color-grey-100);
}

.pick__label {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--spacing-12);
  padding: var(--spacing-8) var(--spacing-12);
  cursor: pointer;
}

.pick--disabled .pick__label {
  cursor: not-allowed;
  background: var(--color-grey-25);
}

.pick__name {
  min-width: 8rem;
  font-size: 0.9375rem;
  color: var(--color-grey-900);
}

.pick__reserved {
  color: var(--color-warning-900);
}

/* Per-unit list --------------------------------------------------------------- */

.unit-section {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-8);
}

.unit-filters {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--spacing-16);
}

.check {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-8);
}

.unit-list {
  max-height: 20rem;
  overflow-y: auto;
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-xs);
}

.unit {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-8);
  padding: var(--spacing-8) var(--spacing-12);
}

.unit + .unit {
  border-top: 1px solid var(--color-grey-100);
}

.unit__row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--spacing-12);
}

.unit__name {
  flex: 1 1 8rem;
  font-size: 0.9375rem;
  color: var(--color-grey-900);
}

.label-edit {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--spacing-8);
}

/* Small Text / Tag: Available reads as success, unusable as the Warning set's "needs attention" role. */
.chip {
  display: inline-block;
  padding: var(--spacing-4) var(--spacing-8);
  border-radius: var(--radius-full);
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
}

.chip--ok {
  background: var(--color-success-200);
  color: var(--color-success-700);
}

.chip--bad {
  background: var(--color-warning-200);
  color: var(--color-warning-900);
}

.period-list {
  gap: var(--spacing-4);
}
</style>
