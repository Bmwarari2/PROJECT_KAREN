# Accessibility

Thapsus-HR targets **WCAG 2.2 level AA** for the marketing site, the app (PWA), the shared kiosk and the back office. Meeting WCAG 2.2 AA also covers the US Section 508 expectations (the Revised 508 Standards incorporate WCAG 2.0 AA) and EN 301 549 for the web content in scope. This document records the scope, the method, the automated checks, the audit results and the manual checklist for the key flows (PROGRESS 12.5).

## 1. Scope

| Surface                    | Routes                                                                       | How it is reached in the audit                                                                                                                                |
| -------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Marketing and trust        | `/`, `/pricing`, `/trust`, `/trust/subprocessors`, `/status`, `/developers`  | Signed out                                                                                                                                                    |
| Authentication             | `/signin`, `/signup`, `/find-workspace`, `/auth/magic`, `/backoffice/signin` | Signed out (MFA steps through the sign-up and sign-in flows)                                                                                                  |
| App                        | every `apps/web/app/app/**/page.tsx` (74 routes, including dynamic ones)     | Owner of a fictional UK workspace with three staff, an invited manager, a pending leave request, a published rota, a kiosk, a support ticket and a report run |
| Shared kiosk               | `/kiosk` unpaired and paired                                                 | A separate, signed-out device                                                                                                                                 |
| Back office                | every `apps/web/app/backoffice/**/page.tsx`                                  | A fictional Thapsus super admin (passkey on a virtual authenticator, with an approved elevation)                                                              |
| Offline and design gallery | `/offline`, `/design/gallery`                                                | Signed out                                                                                                                                                    |

Supported browsers and assistive technology for manual testing: Chrome and Edge with NVDA and JAWS on Windows, Safari with VoiceOver on macOS and iOS, Chrome with TalkBack on Android, Windows high-contrast (forced colours) mode, and browser zoom to 400%.

Content customers write themselves (policy documents, help article overrides, uploaded PDFs) is the customer's responsibility as controller of that content; the editors and viewers around it are in scope.

## 2. Method

1. **Design tokens and components.** Colour pairs are contrast-tested in both modes (`packages/ui/test/contrast.test.ts`); components carry the focus ring, target sizes and ARIA wiring (`packages/ui/test/button.test.ts` covers `Button asChild` and the focus-ring classes).
2. **Automated sweep of every route** — `apps/web/e2e/a11y-sweep.spec.ts` (functional Playwright project, runs in `pnpm verify`). It enumerates `apps/web/app/**/page.tsx`, fails if a route belongs to no area or a dynamic route has no fictional record to open, and on every route runs the checks in §3. Problems are collected per area and reported together.
3. **Flow specs.** Every feature spec (time off, rota, clock, kiosk, timesheets, documents, payslips, reports, settings, privacy, support, back office…) runs axe (WCAG 2.2 AA tags) in light and dark mode at the important states of its flow: dialogs open, forms with errors, after submitting.
4. **Lighthouse** (mobile, `scripts/lighthouse.mjs`): accessibility ≥ 95 and performance ≥ 90 on the key marketing pages and app screens. All 18 audited pages score 100 for accessibility (results in `docs/PERFORMANCE.md` §2.2).
5. **Manual checklist** per key flow (§5), run before each major release and whenever a flow changes. Each item says whether a test proves it, whether it was reviewed in the code during this audit, or whether it needs people and real assistive technology (tracked in `docs/HUMAN_TODO.md` §8).

## 3. Automated checks

| WCAG 2.2 criterion                                                                      | Check                                                                                                                                                                                                               | Where                                                                         |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| All A/AA rules axe can test (1.1.1, 1.3.1, 1.4.3, 1.4.11 partly, 2.4.2, 3.1.1, 4.1.2 …) | axe-core with tags `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa`, after finite animations finish                                                                                                           | sweep: every route in light and dark at 1280px and again at 320px; flow specs |
| 1.4.3 / 1.4.11 contrast                                                                 | token pairs ≥ 4.5:1 (text) and ≥ 3:1 (control borders, focus ring) in both modes                                                                                                                                    | `packages/ui/test/contrast.test.ts`                                           |
| 1.4.10 Reflow                                                                           | no horizontal page scroll at 320 CSS px; the outermost overflowing elements are named. Wide tables scroll inside their own named region                                                                             | sweep                                                                         |
| 1.4.12 Text spacing                                                                     | with line height 1.5, letter spacing 0.12em, word spacing 0.16em and paragraph spacing 2em, no fixed-height box clips text                                                                                          | sweep                                                                         |
| 2.1.1 Keyboard                                                                          | Tab walks the whole page; every visible, enabled control (links, buttons, inputs, selects, summaries, focusable regions) is reached. Composite widgets (tabs, radio groups) count when their active item is reached | sweep                                                                         |
| 2.4.1 Bypass blocks                                                                     | the first Tab on every page reaches the skip link                                                                                                                                                                   | sweep                                                                         |
| 2.4.3 Focus order, 2.4.7 Focus visible                                                  | each focused control has an outline or ring                                                                                                                                                                         | sweep                                                                         |
| 2.4.11 Focus not obscured                                                               | the focused control is not entirely covered (sampled at its centre and corners) by the sticky top bar, the marketing nav or overlays; `html` keeps `scroll-padding-top` for the top bar                             | sweep                                                                         |
| 2.3.3 / reduced motion                                                                  | with `prefers-reduced-motion: reduce` no animation runs and scroll reveals are already visible                                                                                                                      | sweep (every route)                                                           |
| 2.5.8 Target size                                                                       | axe `target-size` (24×24px or enough spacing)                                                                                                                                                                       | sweep at 1280px and 320px                                                     |
| 3.2.6 Consistent help                                                                   | every app screen has the contextual help link in the same place in the top bar                                                                                                                                      | sweep                                                                         |
| 3.3.8 Accessible authentication                                                         | sign-in, sign-up, MFA and back-office sign-in fields carry `autocomplete` (`username`, `current-password`, `new-password`, `one-time-code`), and paste is never blocked                                             | sweep (accessible authentication test)                                        |
| 1.3.1 Info and relationships (structure)                                                | headings do not skip levels, one `h1` per page, landmarks have distinct names (axe `heading-order`, `page-has-heading-one`, `landmark-unique`; Lighthouse scores these)                                             | sweep                                                                         |
| Robustness                                                                              | no uncaught script error on any route                                                                                                                                                                               | sweep                                                                         |

Run it locally: `E2E_WEB_PORT=… E2E_API_PORT=… pnpm --filter @thapsus/web exec playwright test --project=functional e2e/a11y-sweep.spec.ts` after `pnpm --filter @thapsus/web build`.

## 4. Audit results (2026-10-19)

The first sweep found the issues below; all are fixed and the sweep passes on every route.

| Issue                                                                                                                                                                                                                                    | Criterion                             | Where                                                                                                                                                          | Fix                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| No visible focus ring on any `Button`, `Input`, `Textarea`, `Select` trigger, link styled as a button or focusable table region. Tailwind v4's `outline-none` sets `--tw-outline-style: none`, which `focus-visible:outline-2` then used | 2.4.7                                 | every screen                                                                                                                                                   | `focusRing` sets `outline-solid` explicitly; a unit test guards it                                                                          |
| `Button asChild` crashed (Radix Slot received the spinner placeholder and the child)                                                                                                                                                     | 4.1.2                                 | anywhere a link should look like a button                                                                                                                      | the spinner goes inside the child through `Slottable`; a disabled or loading link gets `aria-disabled` and leaves the tab order; unit tests |
| The Me hub threw "Invalid time value" for anyone with an upcoming shift (the summary gives local timestamps, the page expected `HH:MM`)                                                                                                  | 4.1.2, robustness                     | `/app/me`                                                                                                                                                      | times are taken from the local timestamp                                                                                                    |
| Approval details showed raw message keys, internal ids and ISO dates                                                                                                                                                                     | 1.3.1, 3.3.2                          | `/app/approvals`                                                                                                                                               | labelled fields, leave type names, formatted dates, no ids                                                                                  |
| The settings sub-navigation was sticky and taller than a laptop screen: its last entries took focus but could never scroll into view                                                                                                     | 2.4.11                                | every settings screen                                                                                                                                          | bounded height with its own scroll                                                                                                          |
| The app sidebar was taller than the viewport, so the whole page scrolled to fit the navigation                                                                                                                                           | layout, 2.4.11                        | every app screen                                                                                                                                               | sticky, full height, scrolls on its own (ADR-0142)                                                                                          |
| Pricing CTAs overflowed at 320px                                                                                                                                                                                                         | 1.4.10                                | `/pricing`                                                                                                                                                     | large buttons may wrap                                                                                                                      |
| Wide tables and their grid cells widened the page at 320px                                                                                                                                                                               | 1.4.10                                | sub-processors, support, privacy, retention                                                                                                                    | grid items get `min-w-0` or explicit `minmax(0, 1fr)` columns                                                                               |
| Tables that overflow on phones had no keyboard access to their scroll area                                                                                                                                                               | 2.1.1                                 | timesheets, support SLA, privacy queue, retention, exports, EEO-1, organisation, role editor, design gallery, back-office audit, law changes, plans and tenant | `scrollLabel` (named, focusable region)                                                                                                     |
| Native file pickers widened forms past 320px                                                                                                                                                                                             | 1.4.10                                | imports, payslips, support                                                                                                                                     | the picker takes the container width on phones                                                                                              |
| Profile tabs overflowed at 320px                                                                                                                                                                                                         | 1.4.10                                | `/app/people/[id]` and every tab list                                                                                                                          | tab lists wrap                                                                                                                              |
| Disclosure summaries were 22px high                                                                                                                                                                                                      | 2.5.8                                 | `/developers`                                                                                                                                                  | 30px                                                                                                                                        |
| The offline page had no page heading                                                                                                                                                                                                     | 1.3.1, 2.4.6                          | `/offline`                                                                                                                                                     | the empty state renders an `h1`                                                                                                             |
| In US English the same feature was called "Pay stubs" in the navigation but "Payslips" on the Me hub, in notification settings and in role permissions                                                                                   | 3.2.4                                 | `/app/me`, `/app/notifications`, role editor                                                                                                                   | the en-US catalogue says pay stubs everywhere                                                                                               |
| A person's employment type, contract type and pay frequency showed coded values (`full_time`, `permanent`)                                                                                                                               | 3.3.2, 1.3.1 (understandable content) | `/app/people/[id]`                                                                                                                                             | shown as words, numbers in the locale's format                                                                                              |
| Headings skipped a level (page `h1`, then card titles and empty states as `h3`) on 57 app screens; some forms then used `h4`                                                                                                             | 1.3.1                                 | almost every app screen                                                                                                                                        | `CardTitle` and `EmptyState` default to `h2`; nested headings are `h3`                                                                      |
| The sub-processor tables' scroll regions had the same names as their sections                                                                                                                                                            | 1.3.1, 4.1.2                          | `/trust/subprocessors`                                                                                                                                         | named "… (scrollable table)"                                                                                                                |
| Pages had no heading in their no-record or no-access state (for example My details and Welcome for someone without an employee record)                                                                                                   | 1.3.1, 2.4.6                          | `/app/me/details`, `/app/welcome`, people, reports, settings, billing and compliance pages                                                                     | My details keeps its heading in every state; full-page empty states render their title as the `h1`                                          |

## 5. Manual checklist by key flow

Legend: **A** automated (the test that proves it is named), **R** reviewed in the code during this audit (no automated check yet), **H** human-only: needs real assistive technology, devices or people (`docs/HUMAN_TODO.md` §8).

Every flow below is also covered by the route-level checks of the sweep (**A**): axe in light, dark and at 320px; reflow at 320px; text spacing; Tab reachability; visible and unobscured focus; reduced motion; consistent help; no script errors.

### 5.1 Sign up and MFA enrolment (`/signup` → `/app/security?setup=1`)

| Check                                                                                                     | Criteria            | Status                                                          |
| --------------------------------------------------------------------------------------------------------- | ------------------- | --------------------------------------------------------------- |
| Region radios, fields and DPA checkbox reachable by keyboard in visual order, focus visible               | 2.1.1, 2.4.3, 2.4.7 | A (sweep)                                                       |
| Every field has a visible label; errors are text in an alert linked with `aria-describedby` (`Field`)     | 1.3.1, 3.3.1, 3.3.2 | A (axe), R                                                      |
| Password allows password managers and paste (`new-password`); the authenticator code uses `one-time-code` | 3.3.8               | A (sweep: accessible authentication)                            |
| The authenticator secret is shown as text that can be copied, not only as a QR code                       | 1.1.1, 3.3.8        | A (`signUpAndEnrol` in `e2e/helpers.ts` reads it from the page) |
| Name and email given at sign-up are not asked for again during enrolment                                  | 3.3.7               | R                                                               |
| Region choice, DPA link and enrolment success are announced                                               | 4.1.2, 4.1.3        | H                                                               |

### 5.2 Sign in (`/signin`, magic link, passkey, SSO)

| Check                                                                                                                           | Criteria     | Status                                                              |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------- |
| Workspace, email, password and code use `organization`, `username`, `current-password`, `one-time-code`; paste is never blocked | 3.3.8        | A (sweep)                                                           |
| The whole sign-in with password and authenticator code works with the keyboard alone                                            | 2.1.1        | A (sweep: keyboard sign-in)                                         |
| Password, magic link, passkey and SSO are alternatives; none needs more than a password manager can fill                        | 3.3.8        | R                                                                   |
| A wrong password gives a text error announced as an alert                                                                       | 3.3.1, 4.1.3 | A (`foundation.spec.ts` "wrong password shows an accessible error") |
| Lockout and rate-limit messages say what to do next, in text (`errors.lockedOut`, `errors.rateLimited`)                         | 3.3.1, 3.3.3 | R                                                                   |

### 5.3 Add employee (`/app/people/new` → profile)

| Check                                                                                               | Criteria             | Status    |
| --------------------------------------------------------------------------------------------------- | -------------------- | --------- |
| Every field labelled; date inputs operable by keyboard (Tab moves through day, month, year)         | 1.3.1, 2.1.1         | A (sweep) |
| Validation errors are text linked to the field (`Field` sets `aria-describedby` and `aria-invalid`) | 3.3.1                | R         |
| Profile tabs: arrow keys move between tabs, the panel is reachable with Tab; tabs wrap at 320px     | 1.4.10, 2.1.1, 4.1.2 | A (sweep) |
| Nothing entered earlier in the form is asked for again                                              | 3.3.7                | R         |
| The form and profile read sensibly with a screen reader (groups, required fields)                   | 1.3.1                | H         |

### 5.4 Request and approve leave (`/app/time-off`, `/app/approvals`)

| Check                                                                                       | Criteria            | Status                                         |
| ------------------------------------------------------------------------------------------- | ------------------- | ---------------------------------------------- |
| Request form labelled; balances are text, not only colour or charts                         | 1.1.1, 1.3.1, 1.4.1 | A (`time-off.spec.ts` with axe light and dark) |
| The confirmation is a polite toast and the request also appears in the list                 | 4.1.3               | A (`time-off.spec.ts`)                         |
| Approving works with the keyboard alone (Space to tick, Enter on "Approve selected")        | 2.1.1               | A (sweep: keyboard approval)                   |
| Request details are words (type, first and last day, days requested), not field keys or ids | 1.3.1, 3.3.2        | A (sweep keyboard test reads the row), R       |
| Row checkboxes are named after the person                                                   | 4.1.2               | A (axe, named in the keyboard test)            |
| The approvals list reads as a table with headers                                            | 1.3.1               | H                                              |

### 5.5 Rota and shift swap (`/app/rota`)

| Check                                                                                             | Criteria     | Status                                 |
| ------------------------------------------------------------------------------------------------- | ------------ | -------------------------------------- |
| The week is an ARIA grid; add-shift buttons and shift chips have names with person, day and times | 1.3.1, 4.1.2 | A (`rota.spec.ts` uses those names), R |
| **No dragging**: shifts are added, moved and edited with buttons and a dialog                     | 2.5.7        | R (the app has no drag handlers)       |
| Add-shift buttons are 28px                                                                        | 2.5.8        | A (axe target-size), R                 |
| The grid scrolls inside its own region; the page does not scroll sideways at 320px                | 1.4.10       | A (sweep)                              |
| Dialogs trap focus and return it to the trigger (Radix Dialog)                                    | 2.4.3        | R                                      |
| Working-time warnings are text, not only colour                                                   | 1.4.1        | R                                      |
| Swap request and accept announced to a screen reader                                              | 4.1.3        | H                                      |

### 5.6 Clock in, including the kiosk (`/app/clock`, `/kiosk`)

| Check                                                                                                                                                                  | Criteria            | Status                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------ |
| Clock buttons are 48px (app) and 64px (kiosk)                                                                                                                          | 2.5.8               | A (axe), R                                                         |
| The location notice is shown in text before location is read                                                                                                           | 3.3.2               | A (`clock.spec.ts`)                                                |
| Kiosk keypad digits are named ("Digit 4"); the number and PIN can also be typed                                                                                        | 4.1.2, 2.1.1        | A (`kiosk.spec.ts`; sweep: kiosk clock-in with the keyboard alone) |
| Kiosk messages are announced (`role="status"`) and never say whether a number exists                                                                                   | 4.1.3               | A (`kiosk.spec.ts`), R                                             |
| The kiosk PIN is a memorised secret on a shared device; the accessible alternative is clocking in from the person's own app, where password managers and passkeys work | 3.3.8 (alternative) | R                                                                  |
| Kiosk on the mounted tablet, at arm's length and with a screen reader                                                                                                  | 2.5.8, 4.1.2        | H                                                                  |

### 5.7 Timesheets (`/app/timesheets`)

| Check                                                                | Criteria     | Status                   |
| -------------------------------------------------------------------- | ------------ | ------------------------ |
| Week tables have headers; their scroll areas are named and focusable | 1.3.1, 2.1.1 | A (sweep)                |
| Variance is shown as signed numbers, not colour only                 | 1.4.1        | R                        |
| Submitting announces the result                                      | 4.1.3        | A (`timesheets.spec.ts`) |

### 5.8 Documents and signing (`/app/documents`)

| Check                                                                                           | Criteria     | Status                                   |
| ----------------------------------------------------------------------------------------------- | ------------ | ---------------------------------------- |
| Signing is a typed name and a consent checkbox: no drawn signature, no dragging, no memory test | 2.5.7, 3.3.8 | A (`corehr.spec.ts` new joiner signs), R |
| Document status (to sign, signed) is text                                                       | 1.3.1, 1.4.1 | R                                        |
| The generated PDFs are usable with a screen reader (the content is the customer's template)     | 1.3.1        | H                                        |

### 5.9 Payslips (`/app/payslips`)

| Check                                                                     | Criteria      | Status               |
| ------------------------------------------------------------------------- | ------------- | -------------------- |
| Upload fields labelled; the file picker fits a 320px screen               | 1.3.1, 1.4.10 | A (sweep)            |
| An employee sees and downloads only their own payslips, from a named link | 2.4.4         | A (`phase6.spec.ts`) |
| New payslips are marked in text                                           | 1.4.1         | R                    |

### 5.10 Reports (`/app/reports`, builder, runs)

| Check                                                                                               | Criteria     | Status                              |
| --------------------------------------------------------------------------------------------------- | ------------ | ----------------------------------- |
| Charts are `role="img"` with a title and description, and the same figures are in a captioned table | 1.1.1, 1.3.1 | A (axe in `reports-ess.spec.ts`), R |
| Chart labels use the 13px minimum                                                                   | 1.4.4        | R                                   |
| Builder pickers and filters work with the keyboard                                                  | 2.1.1        | A (sweep)                           |
| Export progress is a named progress bar; the download link is named                                 | 4.1.2, 2.4.4 | A (axe), R                          |

### 5.11 Settings (`/app/settings/**`)

| Check                                                                                                                             | Criteria             | Status                                   |
| --------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ---------------------------------------- |
| Every settings screen passes the sweep                                                                                            | all automated checks | A (sweep)                                |
| The settings sub-navigation is the same on every settings screen                                                                  | 3.2.3                | R (one registry, `settings/sections.ts`) |
| Removing an SSO connection, SCIM token, delegation or support grant asks for confirmation (`ConfirmAction` in `settings/kit.tsx`) | 3.3.4                | R                                        |
| Custom brand accents are adjusted until every text pair passes contrast                                                           | 1.4.3                | A (`packages/ui/test/branding.test.ts`)  |

### 5.12 Privacy requests (`/app/privacy/**`)

| Check                                                     | Criteria      | Status                       |
| --------------------------------------------------------- | ------------- | ---------------------------- |
| Access requests show the legal deadline as a date in text | 1.3.1         | A (`privacy.spec.ts`)        |
| Section navigation scrolls inside its own area at 320px   | 1.4.10        | A (sweep)                    |
| Every privacy screen passes axe in light and dark         | all axe rules | A (`privacy.spec.ts`, sweep) |

## 6. Human-only items

These cannot be proven by the automated suite and are tracked as numbered steps in `docs/HUMAN_TODO.md` §8: screen-reader passes of the key flows (NVDA + Chrome, JAWS + Edge, VoiceOver on macOS and iOS, TalkBack), forced-colours mode, 200% and 400% zoom on real devices, speech input (Voice Control, Dragon), a low-cost Android phone, and an accessibility statement reviewed by legal.

## 7. Keeping it accessible

- New screens get a `page.tsx` and are picked up by the sweep automatically; a dynamic route must be added to `concrete()` in the sweep or the sweep fails.
- Use `focusRing` or the base `:focus-visible` outline; never combine `outline-none` with `focus-visible:outline-*`.
- Wide tables pass `scrollLabel`; grids that hold tables use `min-w-0`.
- Use `EmptyState level={1}` when an empty state is the whole page.
