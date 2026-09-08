
## How to use this file (AI instructions)
- This file is the source of truth for SPM's design tokens and UI rules. Read it before generating, editing, or reviewing any UI code or design in this repo — don't guess at colours, spacing, type, or radii from general conventions.
- Read Section 0 first — it's process/enforcement rules (grid, column mapping, icons, fonts, token fidelity), not reference tables. It governs *how* you apply everything in Sections 1–8.
- Reference tokens by name (e.g. `Colors/Purple Primary/600`, `spacing-24`), not by re-deriving a hex or px value from memory — Section 0.9 requires exact reuse of what's defined here.
- If asked to add or change a token (new colour, new scale, new rule), update *this* file rather than letting the addition live only in generated code — keep the file authoritative.

## 0. Process & Usage Rules

Process and code-generation rules for applying the tokens defined in this file — column mapping, grid enforcement, icon usage, font loading, and token fidelity.

### 0.1 Column Mapping Requirement

- Every section/component must state its explicit column span per device breakpoint (e.g. desktop col 3–10 centred; tablet col 1–6 full width; mobile col 1–4 full width).
- Restate the column mapping fresh for every screen — even if unchanged from the previous screen. Never assume or carry over a prior mapping.
- If producing 3+ screens in one flow and no column mapping has been stated for the current screen, do not render that screen until its mapping is written first. This is a blocking condition mid-generation.

### 0.2 Centred Layout Rule

- Do not position centred elements using only left-margin or padding values. Always use column-span math to guarantee symmetric whitespace on both sides.
- The outer content container must always span col 1–12 (respecting `grid-desktop-margin`, see Section 6.2), but content within it must be explicitly positioned — full-width, centred (symmetric offset), or split (e.g. col 1–3 / 4–12) — never left-floated by default.

### 0.3 Nested Grid Rule

- If a container does not span the full page width (e.g. main content next to a sidebar), its internal grid must be declared with a column count equal to the remaining columns, not a fresh 12/6/4 count.
- State both page-level and local column numbers in the column mapping whenever a nested grid is used.
- When generating multiple screens sharing a layout shell (sidebar + main), validate the first screen's grid math before replicating the pattern to subsequent screens — do not regenerate grid logic independently per screen.

### 0.4 CSS Grid Safety Rule

- Any container using CSS Grid with a fixed or viewport-based height (`min-height`, `height: 100vh`, etc.) must explicitly declare `align-content` (default to `start`) unless full-height stretching is intentionally required.
- Any grid container with more than one row track must explicitly define `grid-template-rows` or set `align-content: start`. Never leave row sizing to default `auto` + implicit stretch behaviour.
- **AVOID:** Relying on CSS Grid's default `align-content: normal` (resolves to stretch) for containers with `min-height` or `height` set — this creates invisible auto-row gaps.

### 0.5 Sidebar Margin Rule

- Default sidebar width is col 1–2 (desktop 12-col grid) unless the user specifies a different span. Main content takes the remaining columns (col 3–12).
- If a sidebar is present, set left margin to 0px (sidebar sits flush against the viewport edge). Right margin stays at the default token (`grid-desktop-margin`, Section 6.2).
- State this in the column mapping, e.g.: "Sidebar: col 1–3, margin-left: 0px | Main: col 4–12, margin-right: grid-desktop-margin."
- **AVOID:** Applying the default left margin when a sidebar is present.
- **AVOID:** Assuming a sidebar span wider than col 1–2 without explicit user instruction.

### 0.6 Icon and Symbol Usage

- Do not use emojis anywhere in generated UI — buttons, labels, headings, body text, empty states, tooltips, notifications, or placeholder content, including Unicode emoji characters (✅ 🎉 📋 ⚠️).
- **AVOID:** Using emoji as a substitute for semantic colour tokens (e.g. ✅ instead of `Green Success/600`, ⚠️ instead of `Orange Warning/600`).

### 0.7 Font Loading Verification

Whenever generating code that uses the Lato typeface:

1. Confirm a `<link>` tag or `@font-face` declaration exists in the document head or global CSS before any component references "Lato" in `fontFamily`.
2. If using `@font-face`, confirm the `src` path points to a valid font file and `font-weight`/`font-style` values match weights actually used (400, 700, 900).
3. Confirm every `fontFamily` value includes a fallback (e.g. `"Lato, sans-serif"`) so the UI degrades gracefully if Lato fails to load.

**AVOID:** Referencing "Lato" in `fontFamily` without a corresponding loading mechanism (link tag, `@font-face`, or library import such as `next/font` or `@fontsource/lato`) present in the same codebase.  
**AVOID:** Assuming "Lato" exists as a system font — it must always be explicitly loaded.

### 0.8 Grid Enforcement

- Every screen must be wrapped in an actual grid container using CSS Grid (`grid-template-columns: repeat(12, 1fr)` desktop, 6 tablet, 4 mobile) or the Tailwind equivalent (`grid grid-cols-12 gap-8`).
- Column spans stated in the column mapping must be implemented as explicit grid placement — `grid-column: 3/11` in CSS, or `col-start-3 col-span-8` in Tailwind — never percentage-width or Flexbox approximation.
- Do not substitute visual approximation for structural grid placement, even when content is sparse.
- If multiple screens share a content width, use identical `grid-column` values across those screens — do not let width drift from inconsistent sizing methods.

### 0.9 Token Fidelity

- Reuse the exact token names and values defined in this file — do not introduce new hex values, spacing, or type styles during code generation.
- Map composite text styles (Section 5) to reusable typography components or utility classes, not repeated inline declarations.

## 1. Token Naming Convention

Tokens follow two naming formats depending on their collection. Both are valid — use the format that matches the token's collection.

**Path format** — used for Colours, Typography, and Effects:

`[Collection]/[Group]/[Scale or Descriptor]`

| Example | Collection |
|---|---|
| `Colors/Purple Primary/600` | Colours |
| `Font/Line Height/20` | Typography |
| `Shadows/shadow-light-bg` | Effects |

**Kebab-case format** — used for Spacing and Border Radius (exception: these tokens use a flat `name-value` pattern, not the path format):

| Example | Collection |
|---|---|
| `spacing-16` | Spacing |
| `radius-full` | Border Radius |

**Exception — Grey Alpha tokens:** These tokens use a non-standard naming pattern (`Grey/10% Grey #454545`) inherited directly from Figma. Treat these as a known exception; do not apply the path format to them.

---

## 2. Colour Tokens

Use the `600` shade as the primary shade for each colour family when defining its main interactive or semantic role.

### 2.1 Base

| Token | Hex | Semantic Role |
|-------|-----|---------------|
| `Colors/Base/White` | `#FFFFFF` | Pure white — modal overlays, high-contrast text on dark bg |
| `Colors/Base/Black` | `#121212` | Near-black — body text default, max-contrast text |

### 2.2 Grey Scale (Neutral Foundation)

All surfaces, borders, disabled states, and body text should draw from this scale.

| Token | Hex | Semantic Role |
|-------|-----|---------------|
| `Colors/Grey/25` | `#FCFCFC` | Primary page background / app canvas |
| `Colors/Grey/50` | `#F7F7F7` | Secondary background / large surface areas / alternate page sections |
| `Colors/Grey/75` | `#F0F0F0` | Subtle surface contrast / chat bubble background / light container fill |
| `Colors/Grey/100` | `#E5E5E5` | Disabled input border / non-interactive outline / divider |
| `Colors/Grey/200` | `#CCCCCC` | Default input border / active neutral outline |
| `Colors/Grey/300` | `#ABABAB` | Placeholder text / disabled text |
| `Colors/Grey/400` | `#999999` | Secondary supporting text / helper text / caption text / muted icons |
| `Colors/Grey/500` | `#7A7A7A` | Tertiary text / low-emphasis content / light neutral surface alternative |
| `Colors/Grey/600` | `#5E5E5E` | Label text / stronger secondary text |
| `Colors/Grey/700` | `#454545` | Supporting text / default dark neutral surface / footer background |
| `Colors/Grey/800` | `#2F2F2F` | Strong dark surface / non-black background |
| `Colors/Grey/900` | `#222222` | Maximum-contrast dark text on light backgrounds |

**USE:** `Grey/700` for all body copy. `Grey/50` for card backgrounds. `Grey/100` for dividers and input borders.  
**AVOID:** Using raw `#000000` black for text — use `Grey/900` or `Colors/Base/Black` (`#121212`) instead.

### 2.3 Grey Alpha Variants

Use Grey Alpha tokens to create hierarchy, separation, and contrast without introducing additional colours. These tokens are intended for subtle surfaces, overlays, dividers, muted text treatments, and layered emphasis.

| Token | Base | Alpha | Suggested Use |
|-------|------|-------|---------------|
| `Grey/10% Dark #454545` | `#454545` | 10% | Very subtle surface tint, light separators, low-emphasis fills |
| `Grey/20% Dark #454545` | `#454545` | 20% | Subtle borders, soft container contrast, light overlays |
| `Grey/30% Dark #454545` | `#454545` | 30% | Stronger separators, selected neutral surfaces, supporting emphasis |
| `Grey/40% Dark #454545` | `#454545` | 40% | Medium-emphasis overlays and stronger neutral contrast |
| `Grey/60% Dark #454545` | `#454545` | 60% | High-emphasis neutral overlays and stronger layered treatments |
| `Grey/80% Dark #454545` | `#454545` | 80% | Dark neutral overlays, high-contrast surface tinting |
| `Grey/10% Light #FCFCFC` | `#FCFCFC` | 10% | Very subtle light overlay on dark backgrounds |
| `Grey/20% Light #FCFCFC` | `#FCFCFC` | 20% | Soft light overlay on dark surfaces |
| `Grey/30% Light #FCFCFC` | `#FCFCFC` | 30% | Medium light overlay on dark surfaces |
| `Grey/40% Light #FCFCFC` | `#FCFCFC` | 40% | Stronger light overlay on dark surfaces |
| `Grey/60% Light #FCFCFC` | `#FCFCFC` | 60% | High-emphasis light overlay on dark surfaces |
| `Grey/80% Light #FCFCFC` | `#FCFCFC` | 80% | Maximum light overlay / near-solid light treatment on dark surfaces |
| `Grey/80% Black #121212` | `#121212` | 80% | — |
| `Grey/80% White #FFFFFF` | `#FFFFFF` | 80% | — |

**USE:** Use lower alpha values (`10%`–`30%`) for subtle hierarchy and separation.  
**USE:** Use mid alpha values (`40%`–`60%`) for stronger overlays and layered emphasis.  
**USE:** Use `White` alpha tokens on dark backgrounds and `Grey` / `Black` alpha tokens on light backgrounds.  
**AVOID:** Using alpha tokens as substitutes for semantic colours such as `Error`, `Warning`, or `Success`.  
**AVOID:** Stacking multiple alpha overlays unless a documented effect specifically requires it.

### 2.4 Purple Primary (Brand Colour)

**This is the primary brand and interactive colour.** Use `600` for interactive defaults.

| Token | Hex | Semantic Role |
|-------|-----|---------------|
| `Colors/Purple Primary/100` | `#F3EAFC` | Tinted background (selected row, tag bg) |
| `Colors/Purple Primary/200` | `#E5D3F7` | Hover state background |
| `Colors/Purple Primary/300` | `#CEABF1` | Stroke colour, secondary button hover |
| `Colors/Purple Primary/400` | `#A25FE5` | Secondary badge / chip fill |
| `Colors/Purple Primary/500` | `#8841CF` | Interactive icon, link hover, Primary Button hover |
| `Colors/Purple Primary/600` | `#701EC2` | **Primary button fill, primary link, active nav, secondary button label, text links and icons** |
| `Colors/Purple Primary/700` | `#5A04AF` | — |
| `Colors/Purple Primary/800` | `#3F037A` | Deep emphasis |
| `Colors/Purple Primary/900` | `#230244` | — |

**USE:** `600` for CTAs, primary buttons, active tabs, focus rings, and links.  
**AVOID:** Using `400` or below for interactive text — insufficient contrast on white.

### 2.5 Red / Error

Error colours communicate a destructive or negative action, such as removing a user or a failed operation.

| Token | Hex | Semantic Role |
|-------|-----|---------------|
| `Colors/Red Error/100` | `#FFF6F5` | — |
| `Colors/Red Error/200` | `#FFE3E0` | Light background for error state elements |
| `Colors/Red Error/300` | `#FFA199` | Stroke colour |
| `Colors/Red Error/400` | `#FF5444` | Background for "New" tag |
| `Colors/Red Error/500` | `#EE3424` | — |
| `Colors/Red Error/600` | `#CC1000` | Text and icon colour for error states |
| `Colors/Red Error/700` | `#B31000` | — |
| `Colors/Red Error/800` | `#970c00` | — |
| `Colors/Red Error/900` | `#520600` | — |

**AVOID:** Using red for non-error states — reserve exclusively for failure/destructive contexts.

### 2.6 Orange / Warning

Warning colours communicate actions that are potentially destructive or on-hold. Commonly used in confirmations to grab the user's attention.

| Token | Hex | Semantic Role |
|-------|-----|---------------|
| `Colors/Orange Warning/100` | `#FEF5E7` | — |
| `Colors/Orange Warning/200` | `#FCE1B6` | Light background for warning state elements |
| `Colors/Orange Warning/300` | `#F9C26C` | Stroke colour |
| `Colors/Orange Warning/400` | `#F5A01A` | Date and time, content emphasis |
| `Colors/Orange Warning/500` | `#F5831E` | Accent orange |
| `Colors/Orange Warning/600` | `#F2721B` | — |
| `Colors/Orange Warning/700` | `#E06A27` | — |
| `Colors/Orange Warning/800` | `#C65D00` | — |
| `Colors/Orange Warning/900` | `#994400` | — |

### 2.7 Green / Success

Success colours communicate a positive action, positive trend, or successful confirmation.

| Token | Hex | Semantic Role |
|-------|-----|---------------|
| `Colors/Green Success/100` | `#F3F9F3` | — |
| `Colors/Green Success/200` | `#DAEDD9` | Light background for success state elements |
| `Colors/Green Success/300` | `#BBE2C1` | Stroke colour |
| `Colors/Green Success/400` | `#48BB78` | Alt text colour for success states on light backgrounds |
| `Colors/Green Success/500` | `#369F62` | — |
| `Colors/Green Success/600` | `#008545` | Text and icon colour for success states on light backgrounds |
| `Colors/Green Success/700` | `#017031` | — |
| `Colors/Green Success/800` | `#026529` | — |
| `Colors/Green Success/900` | `#005C30` | — |


### 2.8 Secondary Blue (Accent Colour)

A muted, dusty periwinkle-blue — same hue family as before (~230°, analogous to Purple Primary) but desaturated so it reads as a quiet companion rather than a vivid accent competing with the primary purple. Ramp generated the same way as Purple Primary — same lightness curve, recentred on this hue at a capped, lower saturation — anchored at **300**, where the lightness (~84%) sits on the curve.

Treat this the way a secondary colour is meant to work: a minority presence that supports without competing, roughly in line with a 60% neutral / 30% primary / 10% secondary split. It is not a second brand colour and should not appear anywhere near as often as Purple Primary — see Section 3.4 for how this plays out on buttons specifically.

| Token | Hex | Contrast vs white | Semantic Role |
|-------|-----|--------------------|---------------|
| `Colors/Secondary Blue/100` | `#F4F5FB` | 1.1:1 | Very subtle tint background |
| `Colors/Secondary Blue/200` | `#E6E9F5` | 1.2:1 | Light background, hover fill |
| `Colors/Secondary Blue/300` | `#C4CAE8` | 1.6:1 | Accent background, feature highlight, secondary tag/badge fill |
| `Colors/Secondary Blue/400` | `#818FD0` | 3.1:1 | Secondary badge / chip fill, large-text-only accent |
| `Colors/Secondary Blue/500` | `#6372B8` | 4.5:1 | Interactive icon, secondary link hover |
| `Colors/Secondary Blue/600` | `#3F52AA` | 7.0:1 | **Secondary button fill, secondary link, secondary icons** |
| `Colors/Secondary Blue/700` | `#253A95` | 9.9:1 | Secondary link hover/pressed |
| `Colors/Secondary Blue/800` | `#1A2868` | 13.6:1 | Deep emphasis |
| `Colors/Secondary Blue/900` | `#0F173A` | 17.4:1 | — |

**USE:** As an occasional relief accent — badges/tags, category markers, or a rare secondary action — when a view is already carrying heavy purple density (nav, primary CTA, links, active states, focus rings all purple) and one more purple element would blur which purple thing is actually primary. This is the *only* case where it substitutes for purple in an interactive element.  
**USE:** `100`–`300` as background fills behind dark text — `Grey/900` (`#222222`) or `Purple Primary/800` (`#3F037A`) both clear AA comfortably on top of any of these three.  
**USE:** `500`–`900` directly as text, icon, link, or border colour on white/light surfaces — `500` clears AA at 4.5:1, `600` and darker pass AAA.  
**AVOID:** Using `100`–`300` as text, icon, link, or border colour — insufficient contrast on white or light surfaces (this is the same category Purple Primary/100–300 falls into).  
**AVOID:** Using `400` for normal-weight body text — it lands under AA (3.1:1); fine for large text (≥18px/700 or ≥24px) or non-text accents only.  
**AVOID:** Pairing `300` directly against `Purple Primary/600` for adjacent large fills (e.g. side-by-side banner blocks) — the two sit fairly close in lightness and can feel muddy together at that scale; use `300` as a *fill*, not next to the primary at equal visual weight.  
**AVOID:** Reaching for Secondary Blue as the *default* outline/secondary button colour. It is a minority accent, not a second brand colour — see Section 3.4.


## 3. Colour Semantic Mapping

### 3.1 UI State Colours

| State | Background Token | Border Token | Text/Icon Token |
|-------|-----------------|--------------|-----------------|
| Default | `Colors/Grey/50` | `Colors/Grey/100` | `Colors/Grey/700` |
| Hover | `Colors/Grey/75` | `Colors/Grey/200` | `Colors/Grey/800` |
| Active / Pressed | `Colors/Purple Primary/100` | `Colors/Purple Primary/300` | `Colors/Purple Primary/700` |
| Focus | — | `Colors/Purple Primary/600` (ring) | — |
| Disabled | `Colors/Grey/25` | `Colors/Grey/100` | `Colors/Grey/300` |
| Selected | `Colors/Purple Primary/100` | `Colors/Purple Primary/300` | `Colors/Purple Primary/800` |
| Error | Use tokens from the `Red Error` set | — | — |
| Warning | Use tokens from the `Orange Warning` set | — | — |
| Success | Use tokens from the `Green Success` set | — | — |

### 3.2 Text Colour Hierarchy

| Role | Token | Hex |
|------|-------|-----|
| Primary body text | `Colors/Grey/700` | `#454545` |
| Secondary / muted text | `Colors/Grey/500` | `#7A7A7A` |
| Placeholder text | `Colors/Grey/300` | `#ABABAB` |
| Disabled text | `Colors/Grey/300` | `#ABABAB` |
| Inverse text (on dark bg) | `Colors/Base/White` | `#FFFFFF` |
| Link (default) | `Colors/Purple Primary/600` | `#701EC2` |
| Link (hover) | `Colors/Purple Primary/700` | `#5A04AF` |
| Error text | `Colors/Red Error/600` | `#CC1000` |
| Warning text | `Colors/Orange Warning/600` | `#F2721B` |
| Success text | `Colors/Green Success/600` | `#008545` |

### 3.3 Surface Hierarchy

| Layer | Token | Hex | Use |
|-------|-------|-----|-----|
| App background | `Colors/Grey/25` | `#FCFCFC` | Root page background |
| Primary surface | `Colors/Grey/50` | `#F7F7F7` | Large background areas, alternate sections, subtle separation |

### 3.4 Button Hierarchy

A view should have exactly one visual "loudest" action. Solid, fully-saturated fills (Purple Primary/600 or Secondary Blue/600) both read as maximum emphasis regardless of hue — pairing two of them in the same view creates two competing focal points and erases the primary/secondary distinction the colours exist to signal.

Colour choice on the *non-solid* buttons follows the same logic as Section 2.8: Purple Primary is the identity colour and should be the default for outline/ghost buttons too, since a secondary-emphasis button is still a purple-brand action, just quieter. Secondary Blue is a minority relief accent (see Section 2.8) — it is not an interchangeable second "secondary button colour," and reaching for it by default inflates its usage well past the 10% a secondary colour is supposed to occupy.

| Style | Background | Border | Text | Use |
|-------|-----------|--------|------|-----|
| Solid (filled) | `600` shade, full opacity | none | `Base/White` | The one primary action in the view |
| Outline | Transparent | `300` shade, 1px | `600` shade | Secondary actions alongside a solid button |
| Ghost | Transparent | none | `600` shade | Lowest-emphasis actions; background fills to `100` shade on hover only |

**RULE:** Only one solid/filled button per view or component group. Every other button in that group must be outline or ghost.  
**RULE:** Outline and ghost buttons default to **Purple Primary**, not Secondary Blue — an outline button is still a purple action at lower visual weight, not a different colour identity.  
**RULE:** Secondary Blue may only replace Purple Primary on an outline/ghost button when the view is already purple-saturated (nav, primary CTA, links, active states, and focus rings are all purple) and one more purple element would make it unclear which purple thing is actually primary. This is a relief valve for excess purple density, not a standing style choice — most views will never need it.  
**USE:** Solid Purple Primary for the single primary CTA (e.g. "Save", "Send invite", "Create project").  
**USE:** Outline Purple Primary for a secondary action that still needs a visible boundary (e.g. "Cancel" next to "Save") — this is the default, not Secondary Blue.  
**USE:** Ghost Purple Primary for tertiary/low-commitment actions (e.g. "Skip", inline row actions).  
**USE:** Outline/ghost Secondary Blue only in the purple-density exception above, and sparingly even then.  
**AVOID:** Two solid buttons of equal visual weight in the same toolbar or button group, even if one is purple and one is blue — matching saturation and fill-weight cancels out the hue difference and the eye can't tell which action matters more.  
**AVOID:** Using colour alone to imply hierarchy between two solid buttons (e.g. "the purple one is primary, the blue one is secondary") — hierarchy must come from fill weight (solid vs outline vs ghost), not colour choice.  
**AVOID:** Defaulting to a hollow/outline Secondary Blue button as if it were the standard secondary-button treatment — that treats a 10%-presence accent colour like a second primary, which is the mistake this section exists to prevent.

---

## 4. Typography Tokens

### 4.1 Font Family

| Token | Value | Use |
|-------|-------|-----|
| `Font/Font Family/Lato` | `"Lato", sans-serif` | **Sole typeface** — all text styles use Lato |

**RULE:** Lato is the only font in this design system. Do not introduce other typefaces.

### 4.2 Font Size Scale

All sizes in `px` (design) — convert to `rem` for code (`px ÷ 16`).

| Token | px | rem | Semantic Label |
|-------|----|-----|----------------|
| `Font/Font Size/8` | 8 | 0.5rem | Micro label (use sparingly, badges only) |
| `Font/Font Size/10` | 10 | 0.625rem | Tiny label / tag |
| `Font/Font Size/11` | 11 | 0.6875rem | Caption / legal text |
| `Font/Font Size/12` | 12 | 0.75rem | **Caption / footnote** |
| `Font/Font Size/14` | 14 | 0.875rem | **Body small / label / button** |
| `Font/Font Size/16` | 16 | 1rem | **Body default** |
| `Font/Font Size/18` | 18 | 1.125rem | **Body large / lead paragraph** |
| `Font/Font Size/20` | 20 | 1.25rem | **Subheading / card title** |
| `Font/Font Size/24` | 24 | 1.5rem | **Section heading (H4)** |
| `Font/Font Size/28` | 28 | 1.75rem | **Section heading (H3)** |
| `Font/Font Size/32` | 32 | 2rem | **Page subheading (H2 — interior)** |
| `Font/Font Size/36` | 36 | 2.25rem | **Page title (H1 — interior)** |
| `Font/Font Size/48` | 48 | 3rem | **Hero / Display heading (H1 — hero)** |

**RULE:** Do not apply font size tokens directly. Always use a named composite text style from Section 5.

### 4.3 Font Weight

Weight choice should reinforce hierarchy, emphasis, and readability — not visual variety.

| Token | Value | Recommended Use |
|-------|-------|-----------------|
| `Font/Font Weight/light` | 300 | Long-form reading, low-emphasis content, secondary editorial text |
| `Font/Font Weight/regular` | 400 | Default body copy, supporting text, helper text, standard UI text |
| `Font/Font Weight/bold` | 700 | Headings, labels, emphasis, section titles, buttons |
| `Font/Font Weight/black` | 900 | High-impact display text, hero headings, promotional messaging — rare use only |
| `Font/Font Weight/regular italic` | Italic | Inline emphasis, quotes, editorial emphasis |
| `Font/Font Weight/bold italic` | Bold Italic | Strong emphasis within running text |
| `Font/Font Weight/black italic` | Black Italic | Display emphasis, stylised promotional headings — rare use only |

**USE:** `400` as the default weight for most UI text and body copy.  
**USE:** `700` for headings, labels, buttons, and important emphasis.  
**USE:** `900` only for high-impact display or promotional text.  
**USE:** `300` sparingly for low-emphasis or long-form editorial content.  
**AVOID:** Multiple font weights in the same component without a clear hierarchy purpose.  
**AVOID:** `900` for standard body copy, helper text, or dense UI.  
**AVOID:** `Italic` as a substitute for semantic emphasis.

### 4.4 Line Height Scale

| Token | px | Pair with Font Size |
|-------|----|---------------------|
| `Font/Line Height/10` | 10 | — |
| `Font/Line Height/12` | 12 | 8px, 10px text |
| `Font/Line Height/14` | 14 | 11px, 12px text |
| `Font/Line Height/16` | 16 | 12px, 14px text |
| `Font/Line Height/18` | 18 | 14px text |
| `Font/Line Height/20` | 20 | 16px body text (1.25 ratio) |
| `Font/Line Height/22` | 22 | 18px body large |
| `Font/Line Height/28` | 28 | 20px, 24px text |
| `Font/Line Height/32` | 32 | 24px, 28px headings |
| `Font/Line Height/36` | 36 | 28px, 32px headings |
| `Font/Line Height/40` | 40 | 32px headings |
| `Font/Line Height/42` | 42 | 36px headings |
| `Font/Line Height/58` | 58 | 48px display headings |

**RULE:** Line height must always be font size + 4px. For 16px body text use 20px. For 48px display use 58px.
**RULE:** Do not apply line height tokens directly. Always use a named composite text style from Section 5.

### 4.5 Letter Spacing

| Token | Value (px) | Use |
|-------|------------|-----|
| `Font/Letter Spacing/0` | 0 | Body text, headings (default) |
| `Font/Letter Spacing/2` | 2 | Subheadings, card titles |
| `Font/Letter Spacing/4` | 4 | Labels, uppercase tags |
| `Font/Letter Spacing/6` | 6 | Tight tracking for display |
| `Font/Letter Spacing/20` | 20 | Wide-tracked ALL CAPS labels only |

**USE:** 0 for all body and heading text. Positive tracking only for ALL CAPS labels or decorative display use.  
**AVOID:** Negative letter spacing on Lato — it disrupts legibility.

### 4.6 Paragraph & List Spacing

| Token | Value | Use |
|-------|-------|-----|
| `Font/Paragraph Spacing/0` | 0 | Default (margin-based spacing preferred) |
| `Font/Paragraph Spacing/18` | 18 | Body paragraph spacing |
| `Font/Paragraph Indent/0` | 0 | No indent (standard) |
| `Font/List Spacing/0` | 0 | Default list spacing |

---

## 5. Composite Text Styles

Use these combinations in component specs.

| Style Name | Size | Weight | Line Height | Letter Spacing | Use |
|------------|------|--------|-------------|----------------|-----|
| **H1** | 48px | 700 | 58px | 0 | Primary page heading / hero title |
| **H2** | 36px | 700 | 42px | 0 | Interior page title / primary section heading |
| **H3** | 32px | 700 | 40px | 0 | Section title |
| **H4** | 28px | 700 | 36px | 0 | Sub-section title / mobile screen title |
| **H5** | 24px | 700 | 32px | 0 | Section divider title |
| **H6** | 20px | 700 | 28px | 0 | Secondary section divider title |
| **Subheading** | 18px | 400 | 22px | 0 | Short lead-in content, up to 4 lines |
| **Body Default** | 16px | 400 / 700 | 20px | 0 | Standard body copy; Bold only for inline emphasis |
| **Body Small** | 14px | 400 / 700 | 18px | 0 | Mobile body copy, helper text |
| **Small Text / Tag** | 12px | 700 | 16px | 0 | Tags and compact labels |
| **Small Text** | 12px | 400 / 700 | 16px | 0 | Captions, supporting descriptions, secondary content |
| **xSmall Text** | 11px | 700 | 14px | 4 | Mobile navigation text |
| **xxSmall Text** | 10px | 400 | 12px | 4 | Constrained UI labels |
| **xxxSmall Text** | 8px | 400 | 10px | 0 | Rare use only — avoid unless space is extremely limited |
| **All Caps Heading** | 18px | 700 | 22px | 6 | Swim lane headers, major promo titles |
| **All Caps Caption** | 12px | 700 | 16px | 6 | App captions and short uppercase labels |

**USE:** Apply heavier weights only where hierarchy or emphasis is required.  
**USE:** Keep body styles primarily at `400`, with `700` reserved for selective emphasis.  
**USE:** Reserve `900` for display and promotional heading styles only.  
**AVOID:** Skipping heading levels without a clear structural reason.  
**AVOID:** Using `300`, `700`, or `900` as decorative variation without a semantic purpose.

---

## 6. Spacing Tokens

Spacing is based on a **primary unit of 4px**. Multiples of 4px govern all spatial dimensions. Multiples of 2px are available for fine-grained adjustments where 4px increments are too coarse.

> **Naming exception:** Spacing tokens use a flat kebab-case format (`spacing-{value}`) rather than the path format. See Section 1.

### 6.1 Spacing Scale

| Token | px |
|-------|----|
| `spacing-none` | 0 |
| `spacing-2` | 2 |
| `spacing-4` | 4 |
| `spacing-6` | 6 |
| `spacing-8` | 8 |
| `spacing-12` | 12 |
| `spacing-16` | 16 |
| `spacing-20` | 20 |
| `spacing-24` | 24 |
| `spacing-32` | 32 |
| `spacing-40` | 40 |
| `spacing-48` | 48 |
| `spacing-64` | 64 |
| `spacing-80` | 80 |
| `spacing-96` | 96 |
| `spacing-128` | 128 |
| `spacing-200` | 200 |

**USE:** `spacing-24` as the standard left/right page margin and default spacing between adjacent components.   
**USE:** `spacing-40` to separate major content sections on mobile.  
**USE:** `spacing-80` to separate major content sections on larger layouts.  
**RULE:** All page margins, component spacing, and section spacing must reference named spacing tokens.  
**AVOID:** Mixing multiple page margin values within the same breakpoint without a clear layout reason.  
**AVOID:** Using component spacing values in place of section spacing where a stronger visual break is required.  
**AVOID:** Arbitrary padding or gaps outside the defined spacing scale.

### 6.2 Layout Grid Tokens

Grid systems define column structure, gutters, and margins across breakpoints. All screen layouts must map to these grids — no arbitrary column counts or margins.

| Token | Value | Use |
|-------|-------|-----|
| `grid-desktop-columns` | 12 | Desktop web layouts |
| `grid-desktop-gutter` | 32px | Desktop column gutter |
| `grid-desktop-margin` | 80px | Desktop left/right page margin |
| `grid-tablet-columns` | 6 | Tablet layouts |
| `grid-tablet-width` | 768px | Tablet max content width |
| `grid-tablet-gutter` | 32px | Tablet column gutter |
| `grid-tablet-margin` | 32px | Tablet left/right page margin |
| `grid-mobile-columns` | 4 | Mobile layouts |
| `grid-mobile-width` | 375px | Mobile max content width |
| `grid-mobile-gutter` | 16px | Mobile column gutter |
| `grid-mobile-margin` | 6px | Mobile left/right page margin |
| `paragraph-max-width` | 20rem / 720px | Maximum width for paragraph/body text blocks |

**RULE:** Every screen must use the grid matching its target breakpoint (12-col desktop, 6-col tablet, 4-col mobile). Do not mix column counts within the same breakpoint.  
**RULE:** When a layout includes a sidebar, `grid-desktop-margin` is overridden per the Sidebar Margin Rule (Section 0.5) — left margin drops to 0px; the right edge and sidebar-free layouts keep the default 80px.  
**USE:** `grid-desktop-margin` (80px) and `grid-desktop-gutter` (32px) as the default spacing structure for all 1280px desktop layouts.  
**USE:** `grid-tablet-margin` (32px) and `grid-tablet-gutter` (32px) for 768px tablet layouts.  
**USE:** `grid-mobile-margin` (6px) and `grid-mobile-gutter` (16px) for 375px mobile layouts.  
**AVOID:** Rendering any section without a column-span annotation.  
**AVOID:** Mixing grid systems (e.g., 8-col and 12-col, or desktop and tablet margins) within the same flow.  
---

## 7. Border Radius Tokens

> **Naming exception:** Radius tokens use a flat kebab-case format (`radius-{value}`) rather than the path format. See Section 1.

| Token | px | Frequency |
|-------|----|-----------|
| `radius-none` | 0px | Tables, full-bleed images |
| `radius-xs` | 4px | **Common — small cards, inputs, chips** |
| `radius-sm` | 8px | Moderate use |
| `radius-md` | 12px | Moderate use |
| `radius-lg` | 16px | **Common — big cards, modals, containers** |
| `radius-xl` | 20px | Occasional — oversized containers |
| `radius-2xl` | 24px | — |
| `radius-full` | 128px | Pills, avatar circles, toggle switches |

**Common patterns:**
- **Big cards / modals / featured containers** — `radius-lg`
- **Small cards / inputs / chips** — `radius-xs`
- **Pill-shaped elements** — `radius-full`

**RULE:** Favour `radius-xs` and `radius-lg` as the two primary radii to maintain visual consistency.  
**RULE:** When nesting rounded elements, inner radius = outer radius gap padding.

## 8. Elevation & Interaction States

> **Note:** Section 8.1 (likely Shadows/Elevation, referenced as an "Effects" token collection in Section 1) appears to be missing from this adaptation — only 9.2 survived. Flagging so it can be re-added rather than guessed at.

### 8.2 Focus Ring

Use focus ring styles to provide a visible keyboard-focus indicator on all interactive elements. Form inputs and selects use a two-layer focus treatment: an inner border plus an outer glow. Other interactive elements (buttons, links) use a single ring only.

| Token | Value | Use |
|-------|-------|-----|
| `ring-brand` | `Purple Primary/600` (`#701EC2`), 100% opacity | Inner border/stroke — default focus ring for all interactive elements |
| `ring-light` | `Purple Primary/600` (`#701EC2`), 24% opacity | Outer glow layer — paired with `ring-brand` on form inputs and selects only |
| `ring-grey` | `Grey/200` (`#CCCCCC`), 24% opacity | Neutral supporting ring where lower emphasis is needed |
| `ring-error` | `Red Error/200` (`#FFE3E0`), 100% opacity | Used for destructive and error focus states |

**RULE:** For form inputs and selects (text fields, dropdowns, textareas), apply BOTH layers simultaneously:
- Inner: `ring-brand` border, 1px width
- Outer: `ring-light` glow, 4px spread, 0px offset (implemented as `box-shadow: 0 0 0 4px [ring-light value]`, applied outside the border)

**RULE:** For buttons, links, checkboxes, and other non-input interactive elements, apply `ring-brand` alone as a single 2px outline with 2px offset — do not add the outer glow layer.

**RULE:** All interactive elements must display a visible focus ring. Use `ring-brand` as the default colour unless a semantic state requires an alternate ring token (e.g. `ring-error`).

**AVOID:** Removing `outline` without providing an equivalent visible focus indicator.  
**AVOID:** Applying the two-layer glow treatment to buttons or links — reserve it for form input components only.  
**AVOID:** Using semantic focus ring colours when the component is not in the matching semantic state.