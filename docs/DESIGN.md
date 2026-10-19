# Thapsus-HR design contract

Every screen is built from the tokens and components defined here. Do not add colours, sizes, radii, shadows or durations ad hoc: add a token here first, then implement it in `packages/ui/src/tokens.ts`. CSS variables and the contrast test are generated from that file.

The look follows the principles of calm, premium product sites: generous space, few colours, large type and quiet motion. It never copies Apple's (or anyone's) logos, images, icons, wording or exact layouts. SF Pro and SF Symbols are never bundled.

## 1. Principles

1. **Calm.** One accent colour. Mostly white and soft-grey surfaces. Near-black text. Dark full-width sections for contrast on marketing pages.
2. **Clarity first in the app.** Dense tables and dashboards stay readable at 200,000 rows. Hierarchy comes from type and space, not borders and colour.
3. **Fast everywhere.** Designed for low-cost phones. No layout shift. Images are lazy and responsive. Motion runs at 60fps on compositor-only properties (opacity, transform).
4. **Accessible by default.** WCAG 2.2 AA. All text and background pairs meet contrast. Focus is always visible. Targets are at least 24×24px (44px for primary touch actions). Motion respects `prefers-reduced-motion`.
5. **Localised.** No hard-coded copy. Layouts tolerate strings 40% longer than English.

## 2. Colour tokens

Semantic tokens only; components never use raw hex values.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--color-bg` | `#ffffff` | `#0a0a0b` | Page background |
| `--color-surface` | `#f5f5f7` | `#161618` | Alternating sections, sidebar, table header |
| `--color-surface-raised` | `#ffffff` | `#1c1c1f` | Cards, dialogs, menus |
| `--color-surface-inverse` | `#111113` | `#f5f5f7` | Full-width dark marketing sections |
| `--color-text` | `#1d1d1f` | `#f5f5f7` | Primary text |
| `--color-text-secondary` | `#5f5f66` | `#a8a8ae` | Secondary text, captions |
| `--color-text-inverse` | `#f5f5f7` | `#111113` | Text on inverse surfaces |
| `--color-border` | `#d2d2d7` | `#3a3a3f` | Hairlines, dividers |
| `--color-border-strong` | `#8e8e93` | `#6e6e73` | Borders of inputs, selects and other controls (≥ 3:1 against `bg` and `surface-raised`) |
| `--color-accent` | `#0b6b63` | `#5fd3c6` | The single accent: links, primary buttons, focus ring |
| `--color-accent-hover` | `#085650` | `#86e0d6` | Hover or pressed accent |
| `--color-on-accent` | `#ffffff` | `#04201d` | Text on accent backgrounds |
| `--color-accent-subtle` | `#e6f2f1` | `#0f2e2b` | Selected rows, subtle highlights |
| `--color-success` | `#1b7a3a` | `#5fd38a` | Status text and icons |
| `--color-warning` | `#8a5a00` | `#f2c14e` | Status text and icons |
| `--color-danger` | `#b42318` | `#ff7b72` | Errors, destructive actions |
| `--color-on-danger` | `#ffffff` | `#2a0705` | Text on danger buttons |
| `--color-focus` | = accent | = accent | 2px focus outline, 2px offset |

The accent is a deep teal, Thapsus-HR's own colour. Status colours are only used as text or icons on `bg` and `surface`, never as large fills. Every text token is contrast-tested against `bg`, `surface` and `surface-raised` (and the inverse and on-accent pairs). The threshold is ≥ 4.5:1 for text and ≥ 3:1 for borders of focusable controls, in both modes (`packages/ui/test/contrast.test.ts`).

## 3. Typography

Font stack: `-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif`. Inter (SIL OFL) is self-hosted as the fallback, so rendering is consistent where system fonts are absent (Linux CI, Android). Numbers in tables use `font-variant-numeric: tabular-nums`.

| Token | Size / line height | Weight | Tracking | Use |
| --- | --- | --- | --- | --- |
| `display` | 80/84 (phone 48/52) | 700 | -0.03em | Marketing hero only |
| `headline` | 56/60 (phone 36/40) | 700 | -0.025em | Marketing section titles |
| `title-1` | 40/44 (phone 30/34) | 700 | -0.02em | Page titles (marketing) |
| `title-2` | 28/32 | 600 | -0.015em | App page titles, card titles on marketing |
| `title-3` | 21/26 | 600 | -0.01em | Section titles in the app |
| `body-lg` | 21/30 | 400 | 0 | Marketing lead paragraphs |
| `body` | 17/26 | 400 | 0 | Default body text |
| `callout` | 15/22 | 400 | 0 | Dense app UI, tables, forms |
| `footnote` | 13/18 | 400 | 0 | Captions, helper text, table meta |

Reading width is at most 680px for prose. Never use text smaller than 13px.

## 4. Spacing, layout, radii, shadows

- **Spacing scale (px):** 0, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80, 96, 128 (`--space-0` … `--space-13`).
- **Containers:** marketing content 980px; wide marketing 1200px; app content up to 1440px. The side gutter is 16px on phones, 24px on tablets and 40px on desktop.
- **Breakpoints:** `sm` 640, `md` 768, `lg` 1024, `xl` 1280.
- **Radii:** `--radius-sm` 8 (inputs, small chips) · `--radius-md` 12 (buttons in dense UI, menus) · `--radius-lg` 18 (cards in the app) · `--radius-xl` 28 (large marketing cards) · `--radius-pill` 9999 (primary buttons, badges).
- **Shadows (subtle):** `--shadow-sm` `0 1px 2px rgb(0 0 0 / .06)`; `--shadow-md` `0 4px 16px rgb(0 0 0 / .08)`; `--shadow-lg` `0 12px 40px rgb(0 0 0 / .12)`. Dark mode uses a 1px `--color-border` outline instead of heavier shadows.
- **App chrome:** a sidebar 248px wide that collapses to a sheet below `lg`. On desktop it is sticky at full viewport height and scrolls on its own, so the page height never depends on how many navigation entries a user has. The top bar is 56px and sticky; the page keeps `scroll-padding-top` of top bar + 8px so focused or linked content is never hidden under it (WCAG 2.4.11). Marketing nav is 48px, sticky, with a translucent `--color-bg` at 72% opacity and `backdrop-filter: saturate(180%) blur(20px)`. Where `backdrop-filter` is unsupported it falls back to an opaque background.

## 5. Motion

| Token | Value | Use |
| --- | --- | --- |
| `--duration-fast` | 120ms | Hover, press, toggles |
| `--duration-base` | 200ms | Menus, tabs, toasts |
| `--duration-slow` | 320ms | Dialogs and sheets |
| `--duration-reveal` | 600ms | Marketing scroll reveals |
| `--ease-standard` | `cubic-bezier(0.2, 0.8, 0.2, 1)` | Default |
| `--ease-exit` | `cubic-bezier(0.4, 0, 1, 1)` | Leaving elements |

Rules:
- Animate only `opacity` and `transform`. Reveals translate at most 24px.
- Sticky feature showcases use CSS `position: sticky` with an IntersectionObserver that swaps panels. No scroll-jacking.
- `prefers-reduced-motion: reduce` sets every duration to 0ms, disables reveals (content is visible immediately) and disables parallax.
- App transitions stay under 200ms. Nothing animates on first paint of the app.

## 6. Components (`packages/ui`)

Restyled shadcn/ui-style components built on Radix primitives. They use only the tokens above.

| Component | Notes |
| --- | --- |
| Button | Variants: `primary` (pill, accent), `secondary` (pill, surface with border), `ghost`, `danger`, `link`. Sizes: `sm` (32px), `md` (40px), `lg` (48px, marketing CTAs). Has a loading state with an `aria-busy` spinner. |
| Input, Textarea | 40px high, `radius-sm`, 1px border. The focus ring is 2px accent. Errors are linked with `aria-describedby`. |
| Select | Radix Select, keyboard accessible, same metrics as Input |
| Card | `surface-raised`, `radius-lg` (`radius-xl` on marketing), `shadow-sm` |
| Table | Sticky header on `surface`, row height 44px (dense 36px), tabular numbers, a visible focus row, virtualised for more than 200 rows |
| Dialog, Sheet | Radix Dialog with a focus trap. Sheets slide from the right (or the bottom on phones). |
| Tabs | Underline indicator in accent |
| Toast | Polite live region, bottom-centre on phones and bottom-right on desktop, auto-dismisses after 5s (paused on hover or focus) |
| Sidebar, TopBar | App chrome (section 4) |
| EmptyState | Lucide icon at 32px with 1.5 stroke, `title-3`, body text and one action |
| Skeleton | `surface` shimmer (static under reduced motion) |
| Badge | Pill, `footnote` size, status colour text on the `surface` background |

Icons come from Lucide (ISC licence): 1.5px stroke, 20px in the app and 24px on marketing pages. Icon-only buttons always have an accessible name.

## 7. Light and dark mode

- Theme options: System (default), Light and Dark. The choice is stored in a cookie and applied on the server as `data-theme` on `<html>` to avoid a flash.
- Dark mode is a token swap only; components contain no mode-specific code.
- Visual regression covers every gallery component and key screen in light and dark × phone (390×844) and desktop (1440×900).

## 8. Imagery

- Product screenshots and device mock-ups show Thapsus-HR itself with fictional data only. Formats are AVIF or WebP with responsive `sizes`, lazy below the fold and explicit width and height.
- No stock photography of real people in product UI. Avatars are generated initials.

## 9. Content style

Plain, friendly and specific. Sentence case for headings and buttons. UK and US variants live in the message catalogues (`packages/core/src/i18n/messages`). A number next to a noun is always a plural family (`key_one` / `key_other`, chosen by `count`; ADR-0151), so one reads “1 day”, never “1 days”. Never use idioms that do not translate.
