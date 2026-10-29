# Frontend design-consistency audit against Style.md

Audit of `frontend/` against `Style.md` (read in full; Section 0 first). **Read-only**: no source file was changed. Test files (`__tests__/`), `dist/`, `node_modules/`, `e2e/` and `test-results/` were excluded. Nothing was rendered in a browser; every finding comes from reading the code, with a few contrast ratios calculated from the token hex values.

Date of audit: 2026-10-29. Branch: `FE` (mid-merge with `main`, working tree as it stood).

Severity key: **High** = breaks a RULE or the brand, **Medium** = inconsistent, **Low** = cosmetic.
Repeated issues are counted once per pattern, with every affected file listed under it.

---

## 0. Where to put this file

The request said "write the findings to frontend" and also named `docs/frontend-audit.md`. This file is at `frontend/docs/frontend-audit.md`, which satisfies both readings. Move it to the repo-root `docs/` if that was meant.

## 1. Frontend map (Step 2)

| Area | What exists |
|---|---|
| Stack | Vue 3 `<script setup>`, Vite, Tailwind 3 (PostCSS + autoprefixer), `@heroicons/vue`, vue-router. About 31,000 lines of `.vue`. |
| Token / theme files | `src/styles/tokens.css` (the only token file), `tailwind.config.js` (replaces Tailwind's colour and radius themes with `var(--color-*)` / `var(--radius-*)`; spacing, font size, font weight and shadows stay on Tailwind defaults). |
| Global CSS | `src/style.css`: imports tokens, Tailwind layers, body (Lato 400, 16/20, `Grey/700` on `Grey/25`), link colour, global `button/a:focus-visible` ring and the two-layer input focus. |
| Font loading | `index.html:10` Google Fonts `<link>`: Lato 400, 700, 900 and italics of each. Fallback `sans-serif` comes from `--font-family-lato` (`tokens.css:84`). |
| Shared UI (`components/ui/`) | `AppButton`, `DataTable`, `EventCard`, `PaginationBar`. |
| Other shared components | `EventStatusTracker`, `ClarificationPanel`, `RegistrationsPanel`, `RegistrationPeriodCard`, `SafetyReviewPanel`, `SafetyChangesCard`, `LeadEventList`, `LeadEventTable`, plus folders `venues/` (17), `equipment/` (2), `chat/`, `notifications/`, `public/` (3), `auth/` (1). |
| Pages | 26 views under `views/auth`, `events`, `attendee`, `coordinator`, `lead`, `safety`, `venue-staff`, `equipment`, `notifications`, `public`, plus `App.vue` (signed-in header). |
| Styling approach | Scoped CSS per component using `var(--…)` tokens. `NewEventRequestView.vue` is the one page written with Tailwind utility classes. |

---

## 2. Summary

**43 issue patterns: 7 High, 26 Medium, 10 Low.**

| Category | High | Medium | Low | Total |
|---|---:|---:|---:|---:|
| A. Colours | 1 | 6 | 1 | 8 |
| B. Typography | 2 | 5 | 3 | 10 |
| C. Radius | 0 | 1 | 3 | 4 |
| D. Components | 3 | 8 | 0 | 11 |
| E. Interaction | 0 | 3 | 1 | 4 |
| F. Content and assets | 0 | 1 | 1 | 2 |
| G. Tokens, grid and layout (found while auditing) | 1 | 2 | 1 | 4 |
| **Total** | **7** | **26** | **10** | **43** |

**What is in good shape** (checked and clean):
- No `#000` / `#000000`, no named colours, no Tailwind off-palette classes, no arbitrary `bg-[#…]` colours anywhere in source.
- Lato is the only typeface; it is loaded and every `font-family` carries a fallback (`tokens.css:84`). The 8 `font-family: inherit` lines inherit that.
- No negative letter spacing. No emoji or pictograph characters in any `.vue` or `.ts` file (arrows and `×` found are glyphs, see F2).
- Secondary Blue is **not** used as the default outline or ghost button colour: `AppButton` is Purple Primary throughout. No Purple Primary `400` or lower, and no Secondary Blue `100`–`300`, is used as text.
- Every form input shares the `Grey/200` border, `radius-xs` and `Base/White` fill.
- All drop shadows use the three defined tokens (`shadow-popover` 16 declarations, `shadow-card` 4, `shadow-card-hover` 1).
- 14 input focus rules apply the full `ring-brand` + `ring-light` treatment; 61 focus rules use the 2px `ring-brand` outline with 2px offset.
- Every view has an `<h1>` (`AttendeeEventDetailView`, `EquipmentRequestDetailView` and `PublicEventDetailView` contain two, presumably in separate `v-if` branches; not confirmed). Heading order is sound apart from one skip (B10).

---

## 3. Findings

### A. Colours

| ID | Sev | Where (file:line) | Issue | Rule broken | Suggested fix |
|---|---|---|---|---|---|
| A1 | High | `components/equipment/EquipmentRequestPanel.vue:640`, `components/EventStatusTracker.vue:278`, `components/venues/VenueRequestsPanel.vue:539`, `views/events/EventDetailView.vue:2424` | `.status-success` background is `#e5eee5`, which is not any Style.md value. | 0.9 token fidelity; 2.7 Green Success | `var(--color-success-200)` (`#DAEDD9`), as the other 10 `.status-success` copies use. |
| A2 | Medium | `EquipmentRequestPanel.vue:645`, `EventStatusTracker.vue:283`, `VenueRequestsPanel.vue:544`, `EventDetailView.vue:2429` | `.status-warning` background is a hard-coded `#fef5e7` / `#FEF5E7`. It equals `Orange Warning/100` but bypasses the token. | 0.9 | `var(--color-warning-100)`. |
| A3 | Medium | `components/venues/VenueRequestsPanel.vue:561`, `views/events/EventDetailView.vue:3527`, `views/events/EventsListView.vue:429` | Modal scrim is `rgb(0 0 0 / 40%)` (raw black). The other 5 modals use the token. | 3.5 Drawer scrim (`Grey/40% Dark #454545`); 2.2 avoid raw black | `var(--color-grey-alpha-40-dark)` (already in `tokens.css:20`). |
| A4 | Low | `views/events/EventDetailView.vue:2946` | `.conflict-item` border is `rgba(0, 0, 0, 0.06)`. | 0.9; 2.2 | `1px solid var(--color-grey-100)`. |
| A5 | Medium | `views/coordinator/CoordinatorWorkloadView.vue:686` | `var(--color-purple-alpha-24, rgba(112, 30, 194, 0.24))`: that variable does not exist, so the literal fallback always applies. | 0.9; 8.2 `ring-light` | `var(--ring-light)`. |
| A6 | Medium | Selected tab uses `Blue/600` text: `views/auth/SignupView.vue:310`, `views/coordinator/CoordinatorWorkloadView.vue:636`, `views/events/EventsListView.vue:353`. `Blue/700`: `views/coordinator/VenueSearchView.vue:610`, `views/events/EventDetailView.vue:2596`, `views/public/PublicEventsView.vue:229`, `views/public/PublicVenuesView.vue:224`. Unselected tab uses `Grey/600`: `views/attendee/AttendeeHomeView.vue:235`, `CoordinatorWorkloadView.vue:609`, `views/equipment/TechnicalSupportView.vue:539` (others `Grey/500`). | Same component, three colour treatments. | 3.5b Underline tabs (selected `Blue/700`, unselected `Grey/500`); 2.8 is itself ambiguous (see S9). | One shared tabs component using `Blue/700` / `Grey/500` once S9 is settled. |
| A7 | Medium | `views/attendee/AttendeeEventDetailView.vue:689` (`.detail-value--full`, event full), `views/equipment/EquipmentInventoryView.vue:719` (`.count--low`), `components/venues/VenueRequestsPanel.vue:364` (`.suitability--bad`, "shown, never enforced"), `views/equipment/EquipmentRequestDetailView.vue:1219` (`.unit-tag--short`) and `:1329` (`.shortfall-banner`), `:1413` (`.qty-stepper__warning`, named *warning*, painted with the Error set) | Red Error used for states that are not failures or destructive actions. | 2.5 "AVOID: red for non-error states"; 3.1 | Use the Orange Warning set for "low", "full", "unsuitable", "short"; keep Red for real errors. |
| A8 | Medium | `.status-warning` text `Orange/600` on its fill: `EquipmentRequestPanel.vue:646`, `EventStatusTracker.vue:284`, `VenueRequestsPanel.vue:545`, `EventDetailView.vue:2430`. `.status-info` text `Orange/700` on `Orange/200`: `EventStatusTracker.vue:292-295`, `VenueRequestsPanel.vue:553-556`, `EventDetailView.vue:2438-2441`, `views/safety/SafetyReviewQueueView.vue:548-551`. Lockout text `Orange/600` on `Grey/75`: `views/auth/LoginView.vue:147`. | Contrast calculated from the hex values: 2.70:1, 2.65:1 and 2.56:1. All below 4.5:1 for 12px bold text. `Orange/600` text is what 3.2 prescribes, so part of this is a spec problem (S7); the `Orange/700`-on-`/200` pairing is not prescribed anywhere. | 3.2 Warning text; 3.1 | Use `Orange/900` text on `Orange/100` (6.11:1, as `LeadEventList.vue:108` already does). Fix S7 in Style.md first. |

### B. Typography

| ID | Sev | Where | Issue | Rule broken | Suggested fix |
|---|---|---|---|---|---|
| B1 | High | `components/auth/AuthSplitLayout.vue:69-71` | Headline is `font-size: 2.85rem` (45.6px, not on the scale), `font-weight: 800` (not a Style.md weight and not loaded; the browser will map it to a loaded weight), `line-height: 2.75rem` (44px, **smaller than the font size**, so the two lines overlap). | 4.2 scale; 4.3 weights; 4.4 / 5 line height | H1 composite (48px / 58px) with weight 900, i.e. `3rem` / `3.625rem` / `900` (hero use is allowed by 4.3). |
| B2 | High | Per-file re-declarations of the Section 5 composites: `.body-default` in 32 files, `.body-small` in 34, `.h2` in 19, `.subheading` in 19, `.h3`/`.h4`/`.h5`/`.h6` in 4–5 each. The same class name carries different values: `.body-default` is 14px at `components/RegistrationsPanel.vue:151`, `views/safety/SafetyReviewQueueView.vue:460`, `components/venues/VenueRequestsPanel.vue:324` and 18px at `components/RegistrationPeriodCard.vue:93`; `.body-small` is 12px at `SafetyReviewQueueView.vue:465`, `components/venues/BufferOverlapList.vue:64`, `VenueRequestsPanel.vue:329`; `.h6` is 24/32 (that is H5) at `components/venues/BlockOutPanel.vue:408` and `VenueFormPanel.vue:485`; `.h3` is 20/28 (that is H6) at `views/equipment/EquipmentRequestDetailView.vue:842`. | Composite styles are copied into each component instead of shared, and drift. `src/style.css` has no typography utilities. | 0.9 ("map composite text styles to reusable typography components or utility classes"); 4.2 and 4.4 ("do not apply tokens directly") | Define H1–H6, Subheading, Body Default/Small, Small Text/Tag once (global utility classes or a `Typography` component) and delete the copies. |
| B3 | Medium | `font-weight: 600` at `components/RegistrationsPanel.vue:209`, `views/coordinator/CoordinatorWorkloadView.vue:927`, `views/events/EventDetailView.vue:3231`, `views/events/EventsListView.vue:344`, `:405`, `:417`. Tailwind `font-semibold` (also 600) at `components/equipment/EquipmentRequestPanel.vue:330`, `components/SafetyReviewPanel.vue:200`, `:238`, `components/venues/VenueRecommendations.vue:196`, `:224`, `:236`. | 600 is not a Style.md weight and is not loaded (only 400 / 700 / 900). `components/venues/BookingPlanForm.vue:233` redefines a class named `.font-semibold` as 700, so the name and the value disagree. | 4.3 weights; 0.7 | `700`. Drop the Tailwind `font-semibold` class. |
| B4 | Medium | `font-size: 0.9375rem` (15px) at `components/chat/ChatDrawer.vue:539`, `components/ClarificationPanel.vue:381`, `components/equipment/EquipmentRequestPanel.vue:767`, `components/equipment/EquipmentUnitsPanel.vue:1034`, `:1123`, `:1179`, `components/SafetyReviewPanel.vue:494`, `views/events/EventDetailView.vue:3155`. `0.8125rem` (13px) at `ChatDrawer.vue:563` (rule starts there). | 15px and 13px are not on the size scale. | 4.2 | `0.875rem` (Body Small) or `1rem` (Body Default). |
| B5 | Medium | Font-size / line-height pairs that are not a Section 5 composite: `.section-title` 24px / 28px at `components/RegistrationPeriodCard.vue:86`, `components/RegistrationsPanel.vue:144`, `views/events/EventDetailView.vue:2646` (H5 is 24/32); `.request-purpose` 16/24 `components/venues/VenueRequestsPanel.vue:413`; helper text 16/24 `EventDetailView.vue:3344`; `.tab-count` 12/20 `views/equipment/TechnicalSupportView.vue:572` and `.tab-badge` 12/20 `EventDetailView.vue:2578`; `.nav__tab` 16/18 `App.vue:215`; `.bubble__body` 14/20 `ChatDrawer.vue:614`; `.thread-reply__text` 16px / 1.32rem `ClarificationPanel.vue:543`; `.item-name` 18/24 `EquipmentRequestDetailView.vue:1137`; `.coordinator-person__name` 18/28 `EventDetailView.vue:3228`; `.you-badge` 14/16 `EventDetailView.vue:3244`; `.item__title` 16/18 `views/notifications/NotificationsView.vue:168`. | Pairs differ from the composite for that size (16/20, 14/18, 12/16, 18/22). The H5 case also exposes a Style.md conflict (S2). | 5 composites; 4.4 | Use the matching composite. Settle S2 before touching the 24px cases. |
| B6 | Medium | `views/events/NewEventRequestView.vue:154` (`text-3xl`, 30px / 36px), `:135`, `:157` (`text-lg`, 18/28), 28 uses of `text-sm` (14/20), `text-xl`, `text-2xl` at `:140`, `leading-tight` at `:154` | Tailwind's default font sizes and line heights are not overridden in `tailwind.config.js`, so every `text-*` class yields a size/line-height pair that is not a Style.md composite (30px is not on the scale). | 4.2; 5; 0.9 | Either override `fontSize` in `tailwind.config.js` with the Section 5 pairs or rebuild the page on the shared typography (see D11). |
| B7 | Low | Raw `px` font sizes: `App.vue:215` (16px), `components/ClarificationPanel.vue:543`, `components/RegistrationsPanel.vue:157`, `:181`, `components/RegistrationPeriodCard.vue:86`, `:94`, `views/coordinator/CoordinatorWorkloadView.vue:925`, `views/events/EventDetailView.vue:2376`, `:2488`, `:3228`, `views/events/EventsListView.vue:401`, `:410` (14 declarations) | The rest of the codebase uses `rem`. | 4.2 ("convert to rem for code") | Convert to `rem`. |
| B8 | Low | Positive tracking in `em`: `components/ui/DataTable.vue:164` (0.02em), `components/equipment/EquipmentUnitsPanel.vue:911` (0.03em), `views/equipment/EquipmentInventoryView.vue:843` (0.03em), `views/equipment/EquipmentRequestDetailView.vue:1188` (0.04em), `views/events/EventDetailView.vue:2727`, `:2828`, `:3040` (0.04em) | All are uppercase labels, so positive tracking is allowed, but the tokens are in px (4, 6, 20) and the three `em` values differ between files. `AuthSplitLayout.vue:72` is uppercase with none. | 4.5; 5 All Caps Caption (12px, 6px) | One uppercase-label style using the token value. See S4. |
| B9 | Medium | 146 rules set `font-size` with no `line-height` in the same rule (e.g. `App.vue:277` `.account-role`, `App.vue:289` `.role-pill`, 44 of them at 12px, 51 at 14px, 19 at 16px). Many inherit from a parent, but where they do not they inherit the body's 20px, giving 12px text a 20px line. | The rule that each size pairs with its own line height cannot be confirmed from CSS alone (see section 7). | 4.4; 5 | Set the composite (size + line height together) in the shared typography classes from B2. |
| B10 | Low | `components/public/VenueCard.vue:29` | `<h3>` card title under `PublicVenuesView.vue:88` `<h1>`, with no `<h2>` between. | 5 "avoid skipping heading levels" | `<h2>`, as `EventCard.vue` already does. |

### C. Radius

| ID | Sev | Where | Issue | Rule broken | Suggested fix |
|---|---|---|---|---|---|
| C1 | Low | `border-radius: 50%` at `App.vue:336`, `components/ClarificationPanel.vue:439`, `components/EventStatusTracker.vue:333`, `:361`, `:472`, `components/SafetyReviewPanel.vue:343`, `views/events/EventDetailView.vue:3208`, `:3446` | Circles drawn with a percentage, not a token. | 7 (`radius-full` for pills and avatar circles) | `var(--radius-full)`. |
| C2 | Low | `components/venues/VenueCalendar.vue:609` | `border-radius: var(--spacing-2)`: a spacing token used as a radius, because there is no 2px radius token. | 7 | Use `var(--radius-xs)`, or add a radius token to Style.md first (gap G-3). |
| C3 | Medium | `views/coordinator/CoordinatorWorkloadView.vue:667` (status filter trigger: `radius-sm`, `Grey/300` border) and `:701` (popover `radius-sm`) | A select-like control, but its radius and border differ from every input in the app (`radius-xs`, `Grey/200`). | 7 ("inputs: radius-xs"); 3.1 | `radius-xs` and `Grey/200` border. |
| C4 | Low | `radius-sm` (25 declarations) and `radius-md` (`views/attendee/AttendeeDiscoverView.vue:204`, `views/events/EventDetailView.vue:2810`, `:2938`) where `radius-xs` or `radius-lg` is the stated pair. Tables and lists (`components/ui/DataTable.vue:111`, `components/venues/VenueRequestRows.vue:218`, `views/venue-staff/VenueStaff.vue:819`) are `radius-sm`; Section 7 lists `radius-none` for "Tables". | "Favour `radius-xs` and `radius-lg` as the two primary radii"; the Tables line may mean the container or the cells (S14). | 7 | Decide S14, then align. |

### D. Components

Full inventory is in section 4. Findings:

| ID | Sev | Where | Issue | Rule broken | Suggested fix |
|---|---|---|---|---|---|
| D1 | High | `.status-*` badge classes are redefined in **15 files** and `.badge` in 15. Same class, different look: `.status-info` is `Orange/200` + `/700` in `EventStatusTracker.vue:292`, `VenueRequestsPanel.vue:553`, `EventDetailView.vue:2438`, `SafetyReviewQueueView.vue:548`; `Orange/100` + `/800` in `LeadEventTable.vue:115`, `LeadUnassignedQueueView.vue:266`; `Blue/200` + `/800` in `LeadEventList.vue:117`, `CoordinatorWorkloadView.vue:955`. `.status-warning` is `Orange/100` + `/900` in 8 files, `Orange/200` + `/900` in `LeadEventTable.vue:105` and `LeadUnassignedQueueView.vue:256`, `#fef5e7` + `/600` in 4 files (A2). `.badge` shape: `radius-xs` with 4/8 padding in 5 files, `radius-full` 4/8 in 3, `radius-full` 0/12 in 4 (incl. `EventCard.vue:193`), plus `VenueRequestsPanel.vue:427` (16px, 8/16 padding) and `views/venue-staff/VenueCatalogueView.vue:316`. `EventCard.vue:214-242` has a further set including `Blue/200` and `Grey/200`. Result: the same event status ("Clarification Requested", "Needs Review") is amber on some pages and blue on others, and square on some and round on others. | Inline components that already should be one shared component. Style.md also defines no event-status colour table (S11). | 0.9; 3.5b ("Replacement Required badge ... `radius-full`") | One `StatusBadge` (colour from `lib/eventStatus.ts`, `bookingStatus.ts`, `registrationStatus.ts`), `radius-full`; add the status colour table to Style.md first. |
| D2 | High | Eight separate modal implementations: `components/equipment/EquipmentRequestPanel.vue:832`, `components/venues/BlockOutPanel.vue:372`, `components/venues/VenueFormPanel.vue:449`, `components/venues/VenueRequestsPanel.vue:558`, `views/attendee/AttendeeEventDetailView.vue:553`, `views/equipment/EquipmentInventoryView.vue:848`, `views/events/EventDetailView.vue:3524`, `views/events/EventsListView.vue:426` (plus the side panel at `VenueCalendar.vue:864`). Widths 400 / 440 / 600 / 800 / 850px. Three of them (`VenueRequestsPanel.vue:558-569`, `EventDetailView.vue:3524-3535`, `EventsListView.vue:426-437`) use the raw-black scrim and have **no** shadow; the other five use `shadow-popover`. | Inconsistent variants of one component, built inline. A comment at `EventDetailView.vue:3522` claims all "are you sure" dialogs match; they do not. | 3.5 Toast / Drawer scrim; 8.1 | One `AppModal` (scrim token, `radius-lg`, one elevation, size prop). Define modal elevation in Style.md (S1). |
| D3 | High | Hand-built buttons and links styled as buttons instead of `AppButton`: `components/chat/ChatDrawer.vue:324` + `:662` (`.btn-send`, a solid `Purple/600` button with its own CSS and **no hover rule**); `views/events/EventsListView.vue:224` + `:410` (`.delete-draft-action`); `views/events/EventDetailView.vue:2286` (`.add-venue__cancel`); `components/equipment/EquipmentRequestPanel.vue:438`, `:500` (`.eq-add`); `views/coordinator/VenueAvailabilityView.vue:319` (`.btn-link`); `components/venues/BookingPlanForm.vue:171` (`.link-btn`); `.link-button` at `EquipmentUnitsPanel.vue:646`, `components/venues/VenueRequestRows.vue:149`, `views/venue-staff/VenueStaff.vue:496`, `:590`; `.cancelled-toggle` `EquipmentRequestDetailView.vue:723`; `.clarification-thread__reply-btn` `ClarificationPanel.vue:266`, `:304`. That is 7 text-button implementations (each 0 padding, `Purple/600`, own hover) plus 1 solid. | "Every button in the app is the one `AppButton` component; views do not define their own button CSS." | 3.4 Button component | `AppButton` `ghost` (`sm` where dense). |
| D4 | Medium | Back links: 6 variants. `views/attendee/AttendeeEventDetailView.vue:177`, `views/equipment/EquipmentRequestDetailView.vue:439`, `views/events/EventDetailView.vue:1211` (a `<button>` with an `&larr;` entity), `views/coordinator/VenueSearchView.vue:563`, `views/lead/LeadCoordinatorView.vue:154`, `views/lead/LeadUnassignedQueueView.vue:144`. Heights: 44px at three, unset at the others. | Same element, different heights and markup. | 0.9; 3.4 (44px touch target) | One `BackLink` component. |
| D5 | Medium | Icon-only buttons: `components/chat/ChatDrawer.vue:474` (32px, round), `components/venues/CalendarPicker.vue:176` (32px, round), `components/venues/VenueCalendar.vue:494` (40px, `radius-xs`, white), `views/events/EventDetailView.vue:3378` (36px, `radius-xs`, white, purple), `components/venues/BlockOutPanel.vue:431` and `VenueFormPanel.vue:508` (padding 4, `radius-xs`, `Grey/500`), `components/notifications/NotificationBell.vue:486` (padding 2), and four `.search-box__clear` (32px, round): `VenueFilterBar.vue:231`, `AttendeeDiscoverView.vue:242`, `PublicEventsView.vue:308`, `PublicVenuesView.vue:303`. Close glyphs are a literal `×` (`VenueCalendar.vue:407`) or `&times;` (`EquipmentRequestPanel.vue:430`, `:496`). | 3.4 says icon-only buttons are a separate pattern but defines none, so every file invents one (S16). | 0.6; 0.9 | One `IconButton` once a spec exists. |
| D6 | Medium | `views/events/EventDetailView.vue:2062` ("Mark as completed", `primary`) and `:2174` ("Open registration", `primary`), both in the coordinator's panel for a `Confirmed` event. Needs a browser check to confirm both show at once. Other files with several `primary`/`danger-solid` buttons (`EquipmentUnitsPanel.vue`, `NewEventRequestView.vue`, `EquipmentRequestPanel.vue`) are probably separated by `v-if`/modals but were not confirmed. | Likely two solid buttons in one view. | 3.4 "only one solid/filled button per view or component group" (S18 notes how unclear "view" is for multi-panel pages) | Make "Open registration" `outline`, or confirm they never co-occur. |
| D7 | Medium | Inputs share the border and radius but not size: font 0.875rem (`components/venues/*`, `views/coordinator/VenueAvailabilityView.vue:535`), 0.9375rem (`EquipmentUnitsPanel.vue:1032`, `ClarificationPanel.vue:376`, `EquipmentRequestPanel.vue:764`, `EventDetailView.vue:3152`), 1rem (`views/auth/LoginView.vue:123`, `SignupView.vue:261`, `EquipmentInventoryView.vue:682`, `EventDetailView.vue:3276`, `:3367`); padding `0 12px`, `8px 12px`, `12px`, `0 16px`; only `TechnicalSupportView.vue:603` sets a 44px height. Four search boxes differ: `components/venues/VenueFilterBar.vue:184` (56px tall, `radius-lg`, **`shadow-popover` on an in-flow control**), `views/attendee/AttendeeDiscoverView.vue:196` (`radius-md`, `Grey/200`), `views/public/PublicEventsView.vue:265` and `PublicVenuesView.vue` (48px, `radius-xs`). | One component, four to five looks. `shadow-popover` is for floating surfaces. | 8.1 AVOID; 7 | One `AppInput` / `AppSelect` / `SearchBox` (44px, one font size). |
| D8 | Medium | Panels and empty states built many times. Panel padding is 32 at `EventStatusTracker.vue:240`, `SafetyReviewPanel.vue:301`, `VenueRequestsPanel.vue:311`, `EventDetailView.vue:2443`, `:2624`, and 24 at `EquipmentInventoryView.vue:641`, `LeadDashboardView.vue:240`, `SafetyReviewQueueView.vue:495`, `EquipmentRequestDetailView.vue:986`. Empty state is `radius-sm` at `BufferOverlapList.vue:77`, `VenueStaff.vue:1079` and `radius-lg` at `VenueAvailabilityView.vue:678`, `VenueSearchView.vue:800`, `TechnicalSupportView.vue:732` (5 implementations). Card surface is `Grey/50` in 19 rules and `Base/White` in 8, because Style.md says both (S13). | Inconsistent variants. | 3.1; 3.3; 7 | Shared `Panel` and `EmptyState` components with one padding and radius. |
| D9 | Medium | Tables and lists: `DataTable` (10 files) is canonical, but bespoke lists remain: `components/venues/VenueRequestRows.vue:218`, `views/venue-staff/VenueStaff.vue:819`, `views/notifications/NotificationsView.vue:129`, `components/equipment/EquipmentUnitsPanel.vue:880`, `views/equipment/EquipmentInventoryView.vue:762`; raw `<table>` at `views/events/EventDetailView.vue:1680` and `views/events/NewEventRequestView.vue:256`. `LeadEventList` (used by `LeadDashboardView.vue`) and `LeadEventTable` (used by two other Lead pages) show the same data two ways. | Components built inline that already exist as a shared component. | 0.9 | Move to `DataTable`; retire `LeadEventList` or document why it differs. |
| D10 | Medium | Tabs: 12 hand-built implementations (`App.vue:215`, `ChatDrawer.vue:357`, `AttendeeHomeView.vue:235`, `SignupView.vue:290`, `CoordinatorWorkloadView.vue:609`, `VenueSearchView.vue:593`, `TechnicalSupportView.vue:539`, `EventDetailView.vue:2488`, `EventsListView.vue:336`, `PublicEventsView.vue:208`, `PublicVenuesView.vue:203`, `VenueStaff.vue:784`) and two toggle-button groups of different height (`RegistrationsPanel.vue:200` vs `VenueStaff.vue:952`, 40px). See A6 for the colour drift. | Near-duplicates of one component. | 3.5b Underline tabs | One `UnderlineTabs`. |
| D11 | Medium | `views/events/NewEventRequestView.vue` is the only page built with Tailwind utility classes (`:129` grid, 18 `font-bold`, `px-3 py-3`, `text-sm`, hard-coded `md:` / `lg:` breakpoints) and the only one with its own raw `<table>` (`:256`). It also lacks a column-mapping comment (G3). | Different build method from the rest of the app, so it cannot pick up shared styles. Inputs here (`:170`, `:181`, `:192`) have a fixed `border-grey-200` and no invalid state (E2). | 0.1; 0.9 | Rebuild on the shared form components (D7) and scoped CSS. |

### E. Interaction

| ID | Sev | Where | Issue | Rule broken | Suggested fix |
|---|---|---|---|---|---|
| E1 | Medium | Input focus deviates from the two-layer ring: `components/venues/VenueRequestRows.vue:336-338` and `views/safety/SafetyReviewQueueView.vue:665-667` (2px `Purple/600` outline at 1px offset **plus** a `Purple/100` glow), `views/events/EventDetailView.vue:3436` (2px `Purple/300` outline, low contrast), `views/coordinator/CoordinatorWorkloadView.vue:686` (see A5). | The glow must be `ring-light` (24% `Purple/600`), not `Purple/100`; buttons and links get the outline only. | 8.2 | Reuse the global `input:focus-visible` rule from `style.css:42-48`. |
| E2 | Medium | Three invalid-state conventions: `.invalid` (`views/auth/SignupView.vue:306`), `[aria-invalid="true"]` (`SafetyReviewPanel.vue:503`, `BlockOutPanel.vue:522`, `BookingPlanForm.vue:289`, `VenueFormPanel.vue:621`, `EquipmentInventoryView.vue:704`) and `.input--error` (`VenueAvailabilityView.vue:256-274`). `NewEventRequestView.vue:170-192` shows error text but no invalid border or `aria-invalid`. | Error state not applied uniformly. | 3.1; 8.2 | One invalid style keyed on `[aria-invalid="true"]` in the shared input. |
| E3 | Medium | Hand-built buttons with no hover rule: `ChatDrawer.vue:662` (`.btn-send`), `ClarificationPanel.vue:499` (`.clarification-thread__reply-btn`), `EquipmentRequestDetailView.vue:1018` (`.cancelled-toggle`), `VenueRequestRows.vue:300` and `VenueStaff.vue:1016` (`.link-button`). Focus is still covered by the global `button:focus-visible` rule (`style.css:35`). | Missing hover state on interactive components. | 3.1 Hover | `AppButton` (D3) fixes all of them. |
| E4 | Low | `outline-offset: -2px` (inset ring) at `components/LeadEventList.vue:61`, `components/notifications/NotificationBell.vue:380`, `components/RegistrationsPanel.vue:225`, `components/ui/DataTable.vue:147`, `views/equipment/EquipmentRequestDetailView.vue:1397`, `views/notifications/NotificationsView.vue:165` | Row links use an inside ring so `overflow: hidden` does not clip it; 8.2 specifies a 2px outward offset. Likely deliberate, but undocumented. | 8.2 | Document the inset variant in Style.md or keep the offset and drop the clipping. |

### F. Content and assets

| ID | Sev | Where | Issue | Rule broken | Suggested fix |
|---|---|---|---|---|---|
| F1 | Medium | Heroicons `16/solid` (11 files), `20/solid` (12), `24/outline` (6), plus 29 hand-drawn inline `<svg>` (13 files, outline style; widths 20 x10, 16 x10, 14, 12), e.g. `EquipmentRequestDetailView.vue` (6), `AttendeeEventDetailView.vue` (6), `EventDetailView.vue` (3), `TechnicalSupportView.vue` (3). | Mixed solid and outline styles and sizes. Style.md has no icon size or style rule beyond "no emoji" (gap G-4). | 0.6 | Pick one set and sizes (e.g. 20/solid for UI, 16/solid inline) and write them into Style.md; replace the inline SVGs. |
| F2 | Low | Text glyphs used as icons: `×` `components/venues/VenueCalendar.vue:407`, `&times;` `components/equipment/EquipmentRequestPanel.vue:430`, `:496`, `&larr;` `views/events/EventDetailView.vue:1211`, `+ Add another item` `EquipmentRequestPanel.vue:438`, `:500`. | Not emoji (so 0.6 is not broken) but inconsistent with the icon set. | 0.6 spirit | Icons from the chosen set. |

### G. Tokens, grid and layout (outside the A–F list, found while auditing)

| ID | Sev | Where | Issue | Rule broken | Suggested fix |
|---|---|---|---|---|---|
| G1 | High | `src/styles/tokens.css:102` | `--grid-desktop-gutter: 28px`. Style.md says 32px. Used in 32 places, so every desktop grid is 4px narrower per gutter than specified. | 6.2 `grid-desktop-gutter` | `32px`. |
| G2 | Medium | `components/auth/AuthSplitLayout.vue:36` | Login and sign-up use a `3fr 7fr` split, not the 12-column grid, and the header comment says "cols 1-3.6", which is not a whole column. | 0.8 (explicit 12/6/4 grid placement, no percentage approximation); 0.1 | Place the graphic on columns 1–4 and the form on 5–12 (or 1–3 / 4–12), and state it. Style.md should say whether this layout is an exception. |
| G3 | Medium | `views/notifications/NotificationsView.vue:111` (a centred `max-width: 800px` flex column, `padding: 28px` at `:147`); no column-mapping comment in `views/notifications/NotificationsView.vue`, `views/events/NewEventRequestView.vue`, `views/safety/SafetyReviewQueueView.vue` (the other 23 views have one). | A page not on the grid, and three pages without the mapping the rule requires. | 0.1; 0.2; 0.8 | Put the page on the 12/6/4 grid and add the comments. |
| G4 | Low | Spacing values off the scale: `NotificationsView.vue:147` (28px), `:173` (4px literal), `views/venue-staff/VenueStaff.vue:682` (8px literal), `components/ui/DataTable.vue:175` (`gap: 8px`), `components/equipment/EquipmentRequestPanel.vue:700` and `views/events/EventDetailView.vue:2527` (`margin-left: 5px`), `components/SafetyReviewPanel.vue:432` (`margin-top:-12px`), `components/ClarificationPanel.vue:477` (0.15rem), `views/events/EventsListView.vue:407`, `:419` (2px). The 1px `margin-bottom: -1px` tab underline overlap (7 files) is a border trick, not spacing. | Values not in `spacing-*`, or literals where a token exists. | 6.1 "arbitrary padding or gaps outside the defined scale" | `var(--spacing-*)`. |

---

## 4. Component inventory

| Component | Implementations found | Where | Canonical (recommended) |
|---|---|---|---|
| **Button** | `AppButton` (31 files, 144 uses) + 7 text-button styles + 1 hand-built solid | see D3 | `AppButton` (`ghost` for the text styles). |
| **Icon-only button** | 6+ (32 / 36 / 40px, round or `radius-xs`) | see D5 | None yet. Spec first, then one `IconButton`. |
| **Back link** | 6 | see D4 | One `BackLink` (44px, `Purple/600`). |
| **Text input / select / textarea** | 71 inputs, 11 selects, 23 textareas, about 25 CSS classes, 3 font sizes | see D7 | One `AppInput` at the `LoginView` `.text-input` size (1rem, 44px). |
| **Search box** | 4 | `VenueFilterBar.vue:184`, `AttendeeDiscoverView.vue:196`, `PublicEventsView.vue`, `PublicVenuesView.vue` | One `SearchBox` (`radius-xs`, no shadow). |
| **Card** | `EventCard` (shared, via `PublicEventCard`), `VenueCard` (public), plus about 40 inline panel and card rules (`Grey/50` + `radius-lg` + padding 24 or 32) | see D8 | `EventCard` for events; add a shared `Panel`. |
| **Modal** | 8 (+ 1 side panel) | see D2 | One `AppModal`. |
| **Tag / badge** | `.badge` x15 files with 5 shapes; `.status-*` x15 files with 3 colourings each; `.role-pill` (`App.vue:289`); chips (`FilterChip.vue`, `CoordinatorWorkloadView.vue`); `EventCard` status pill | see D1 | One `StatusBadge`, `radius-full`. |
| **Nav item** | `.nav__tab` (`App.vue:215`, signed in); public header in `PublicLayout.vue` | per 3.5a / 3.5b | `App.vue` nav as is; check `PublicLayout` against 3.5b. |
| **Tabs** | 12 | see D10 | One `UnderlineTabs`. |
| **Table / list** | `DataTable` (10 files), 5 bespoke lists, 2 raw `<table>`, `LeadEventList` | see D9 | `DataTable`. |
| **Pagination** | `PaginationBar` (6 files) | - | Already canonical. |
| **Empty state** | 5 | see D8 | One `EmptyState`. |

---

## 5. The ten fixes with the highest impact, in priority order

1. **Resolve the Style.md contradictions in section 6 first** (line-height rule vs composites, secondary text colour, mobile margin, `paragraph-max-width`, `ring-error` visibility, tab colour, Replacement Required colour, status colours). Several code findings below cannot be fixed correctly until the spec is.
2. **One `StatusBadge` and an event / booking / registration status colour table in Style.md.** Removes 15 copies of `.status-*` and `.badge` (D1), the off-token hex (A1, A2) and the sub-3:1 text pairs (A8).
3. **Shared typography classes or a `Typography` component** for the Section 5 composites. Deletes the per-file copies (about 19–34 per class) and the same-name-different-size drift (B2), and fixes the off-scale sizes and pairs (B4, B5, B9).
4. **Fix `--grid-desktop-gutter` to 32px** in `tokens.css:102` (G1). One line, affects every desktop page.
5. **One `AppModal`** (D2), which also removes the raw-black scrims (A3).
6. **Replace the hand-built text and link buttons with `AppButton`** (D3, E3), including the `ChatDrawer` send button.
7. **Fix the auth headline** (`AuthSplitLayout.vue:69-71`, B1) and place the layout on the 12-column grid (G2).
8. **Shared `AppInput` / `SearchBox` / `BackLink` / `IconButton`** (D4, D5, D7), which fixes the focus-ring deviations (E1), the invalid-state conventions (E2) and the `shadow-popover` search box.
9. **One `UnderlineTabs`** (D10, A6), and `radius-xs` for the status filter trigger (C3).
10. **Rebuild `NewEventRequestView.vue` on the shared form components** (D11, B6, E2, G3), the only Tailwind-utility page.

---

## 6. Where Style.md is unclear or contradicts itself

I did not pick an answer for any of these.

| ID | Where in Style.md | Problem |
|---|---|---|
| S1 | 8 intro and 8.1 | The note says 8.1 is "missing" and "only 9.2 survived", but 8.1 now exists (partially, three tokens) and the focus ring is 8.2. Section 1's example `Shadows/shadow-light-bg` is not defined. Code uses only the three defined shadows (`shadow-popover` x16, `shadow-card` x4, `shadow-card-hover` x1), so those are verified against the tokens. Anything beyond them is **unverifiable**: there is no modal elevation (modals use `shadow-popover`, which 8.1 describes as "anchored to a trigger"), no inset or pressed elevation, and `shadow-popover` is used on a search box (`VenueFilterBar.vue:193`) which 8.1 forbids for in-flow cards. |
| S2 | 4.4 vs 5 | "Line height must always be font size + 4px" is contradicted by the Section 5 composites: H1 48/58 (+10), H2 36/42 (+6), H3 32/40 (+8), H4 28/36 (+8), H5 24/32 (+8), H6 20/28 (+8), xSmall 11/14 (+3), xxSmall 10/12 (+2), xxxSmall 8/10 (+2). The 4.4 table also pairs 24px with line height 28 while H5 says 32. Code uses both (e.g. 24/28 at `RegistrationsPanel.vue:144`, 24/32 in H5 classes). |
| S3 | 4.2 vs 5 | 4.2 labels 36px "H1 (interior)" and 32px "H2 (interior)"; Section 5 calls 36px H2 and 32px H3. |
| S4 | 4.5 vs 5 | 4.5 says positive tracking only for ALL CAPS, but Section 5 gives xSmall Text (11px / 700) and xxSmall Text (10px / 400) 4px tracking, and they are not caps. 4.5 also lists `Letter Spacing/2` for "subheadings, card titles" while the composites for those use 0. Tokens are in px; code uses `em`. |
| S5 | 6.2 | `paragraph-max-width` is "20rem / 720px". 20rem is 320px and 720px is 45rem, so the two values disagree. The code has one `max-width: 720px` and one `45rem`; I did not verify that either is a paragraph block. **Is 720px (45rem) the intended value?** |
| S6 | 6.1 vs 6.2 | 6.1 says `spacing-24` is "the standard left/right page margin"; 6.2 says the margins are 80 / 32 / **6px**. A 6px mobile margin on a 375px screen looks like a typo (the code uses `--grid-mobile-margin` 6px at 55 places). **Is 6px intended?** |
| S7 | 2.2, 3.2 | Secondary text is `Grey/400` in 2.2 and `Grey/500` in 3.2. Calculated contrast on white: `Grey/400` 2.85:1, `Grey/500` 4.29:1 (4.01:1 on `Grey/50`), `Grey/300` placeholder 2.30:1. Warning text `Orange/600` is 2.92:1 on white and 2.70:1 on `Orange/100`. Style.md does not state a contrast target, so these are recorded, not judged. |
| S8 | 8.2 | `ring-error` is `Red Error/200` (`#FFE3E0`) at 100%, 1.21:1 against white. Used as a 2px focus outline (3.4 `danger`, `danger-solid`) it is close to invisible. |
| S9 | 2.8 vs 3.5b | 2.8 says "`600` (label) and `700` for the selected tab" and 3.5b says the selected tab text is `Secondary Blue/700`. Code has both (A6). Unselected tab colour is `Grey/500` in 3.5b; code also uses `Grey/600`. |
| S10 | 3.5 | Replacement Required is an Orange Warning badge in the "Replacement Required badge" row, but Red Error `200/600/800` in `schedule-block-*`, while the same section says to reserve Orange for "bookings that need action (Replacement Required)". Code follows the red version on the calendar (`CalendarEntryButton.vue:156`, `VenueCalendar.vue:667`) and `bookingStatus.ts:29` maps the badge to `status-info`. |
| S11 | 3.4 EventCard, 3.5 | The EventCard rule points to "Section 3.5" for event and registration status colours, but 3.5 only defines availability and notification patterns. No table gives a colour to `Planning`, `Confirmed`, `Cancelled`, `Needs Review`, "Full", "Registration closed". Code currently colours `Planning` and `Completed` green, `Rejected` and `Cancelled` red, and "Full" / "Registration closed" amber (`lib/eventStatus.ts:5-10`, `lib/registrationStatus.ts:24-25`). |
| S12 | headings | Sections run 3.3, 3.5, 3.4, 3.5a, 3.5b, 3.6, and 3.1's "Selected" row duplicates the tab rule. Cosmetic, but cross-references (AGENTS.md cites Style.md sections) are easy to get wrong. |
| S13 | 2.2, 3.1, 3.4, 3.5b | "`Grey/50` for card backgrounds" and Default state `Grey/50`, versus EventCard, Venue card and modals as `Base/White`. The code does both. |
| S14 | 7 | `radius-none` is listed for "Tables, full-bleed images". It is unclear whether that is the outer container of a table or its cells. `DataTable` uses `radius-sm`. |
| S15 | 0.7 vs 4.3 | 0.7 lists weights 400, 700, 900; 4.3 also defines 300 and three italics. `index.html:10` does not load 300, so that token cannot render. Weights 600 and 800 appear in code but are not defined anywhere. |
| S16 | gaps | Needed but not defined: icon size and style; icon-only button; modal (width, padding, elevation, scrim use); input and select (height, font size); badge shape (`radius-xs` vs `radius-full`); an inset focus ring; a 2px radius; spacing tokens `spacing-64`, `-96`, `-128`, `-200` and `spacing-none` exist in 6.1 but not in `tokens.css`; Tailwind's `fontSize` and `fontWeight` and `spacing` are not aliased to Style.md. |
| S17 | 0.8 | The auth split screen (30% / 70%) cannot be expressed as whole 12-column spans (G2). |
| S18 | 3.4 | "One solid button per view or component group" does not say how to treat a page of several independent panels, such as `EventDetailView`. |

---

## 7. Things I could not verify

- **Anything visual at runtime.** I did not open the app. Hover, active and disabled appearance, real focus rings, clipping of outlines inside `overflow: hidden` containers, and the actual weight Lato 600 / 800 resolves to were not seen.
- **D6 (two solid buttons).** Needs a browser on a `Confirmed` event as the assigned coordinator. The other multi-`primary` files were not checked for co-occurrence.
- **Line height where it is inherited (B9).** 146 rules set a size with no line height; whether each is wrong depends on its parent and cannot be told from CSS alone.
- **Disabled styling of inputs.** 17 of the 25 files that contain inputs have no disabled input style (list available on request); whether those inputs are ever disabled was not checked.
- **Contrast.** Calculated only for the pairs named in A8 and S7. No other pair was measured.
- **Grid placement of each component (0.8).** I checked page-level grids and column-mapping comments, not every component's column spans.
- **Assets.** `public/favicon.svg`, `public/icons.svg`, `public/logoo.svg` and the `assets/*.jpg` thumbnails and `login_pic.png` were not inspected for off-token colours.
- **`e2e/`, `dist/`, tests** were out of scope.
- **Shadows beyond the three tokens** (see S1).
- **Whether `status-*` classes are reachable** for every status; only the mapping functions (`lib/eventStatus.ts`, `bookingStatus.ts`, `equipmentApi.ts`, `registrationStatus.ts`) were read.

---

## 8. Status after the fixes (2026-10-29)

The findings above describe the code as it was when audited. This is where each one stands now. Fixed items are guarded by `src/__tests__/styleGuard.test.ts` where a rule can be checked mechanically.

| Finding | Status | Note |
|---|---|---|
| A1, A2, A3, A5 | Fixed | Off-token hex, raw-black scrims and the undefined variable are gone. |
| A4 | Open | `rgba(0, 0, 0, 0.06)` border in `EventDetailView.vue` (`.conflict-item`). |
| A6 | Fixed | One selected-tab colour (Blue/700); Style.md 2.8 and 3.5b agree. |
| A7 | Open | Red used for "full", "low stock", "unsuitable", "short" and one "warning" class. |
| A8 | Mostly fixed | Badges use `Orange/900` text; the login lockout message still uses `Orange/600`. |
| B1 | Fixed | Auth headline is H1 (3rem / 3.625rem / 900). |
| B2, B4, B5, B9 | Fixed | Shared type classes in `style.css`; no off-scale sizes; every size has its line height. |
| B3 | Fixed | Weight 600 became 700 (Google Fonts has no Lato 600). |
| B6 | Fixed | `NewEventRequestView` no longer uses Tailwind utilities. |
| B7, B8 | Open | 3 raw-px font sizes; 4 uppercase labels track in `em` (Style.md now says 0.04em). |
| B10 | Open | `VenueCard` still uses an `<h3>` under the guest page `<h1>`. |
| C1, C3 | Fixed | Circles use `radius-full`; the status filter is `radius-xs`. |
| C2 | Open | `VenueCalendar.vue` uses a spacing token as a 2px radius. |
| C4 | Resolved in the spec | A table container is `radius-sm` (Style.md 7). |
| D1 to D5, D8, D10, D11 | Fixed | `StatusBadge`, `AppModal`, `AppButton` `link`, `BackLink`, `IconButton`, `AppPanel`, `EmptyState`, `UnderlineTabs`, `SegmentedToggle`. |
| D9 | Mostly fixed | `VenueRequestRows` and the Venue Staff rows list were left as they are (chosen scope). |
| D6 | Open | "Mark as completed" and "Open registration" can still show together; needs a browser check. |
| D7 | Fixed in effect | Inputs, selects and textareas share one look from `style.css` (Style.md 3.8) and `SearchBox` replaced the four search boxes. There is no separate `AppInput` component. |
| E1, E2, E3 | Fixed | Local focus-ring deviations deleted; invalid state is `[aria-invalid="true"]` everywhere; hand-built buttons gone. |
| E4 | Open | Inset (`-2px`) focus rings on row links are unchanged and not yet documented. |
| F1 | Open | 10 files still draw some icons as inline SVG, and Heroicons sizes are mixed. |
| F2 | Mostly fixed | `×` and `&larr;` glyphs replaced; "+ Add another item" keeps its text plus. |
| G1 | Fixed | `--grid-desktop-gutter` is 32px. |
| G2 | Fixed | The 30 / 70 auth split is a documented exception (Style.md 0.8). |
| G3 | Fixed | `NotificationsView` is on the 12/6/4 grid; all views carry a column-mapping comment. |
| G4 | Mostly fixed | Literal spacing replaced with tokens except one deliberate overlap (`margin-top: -12px`). |

Style.md contradictions: S1 to S4, S6 to S15, S17 and S18 are settled in Style.md; S5 is 45rem; S7 is Grey/600 for muted text, S8 is `Red Error/600`, S10 is orange. S16 (missing specs) is covered by the new 3.7 and 3.8 sections. S12 (section numbering) was left as it is, because other documents refer to the current numbers.
