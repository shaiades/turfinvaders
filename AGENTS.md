<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

## Responsive layout rules (owner mandate 2026-08-14)

The app must work flawlessly on iPhone, scale to iPad, and look great on
desktop. Every new screen or component follows these rules:

1. **Mobile-first layouts.** Containers default to stacked `flex-col` /
   `w-full` / `grid-cols-1`; expand to rows or multi-column grids only via
   `md:` / `lg:`. Wide data tables keep desktop markup behind
   `hidden md:block` with a sibling `MobileCardList` (see
   `src/components/arcade.tsx`) — never `useIsMobile()` for visibility.
2. **No stray horizontal overflow.** `body` has `overflow-x: clip` and the
   AppShell adds `overflow-x-hidden`. Sideways scrolling happens only inside
   explicit `overflow-x-auto` wrappers. Because ArcadePanel (`arcade-card`)
   clips overflow, every such wrapper needs an intact width chain: floored
   grid tracks (`grid-cols-1`, i.e. `minmax(0,1fr)`) or `min-w-0` on
   flex/grid ancestors — a content-sized track silently clips data with no
   way to scroll to it (the Fleet Dispatch bug, PR #83). `scrollbar-hide`
   is for nav/chip strips ONLY; data scrollers (tables, boards) keep their
   scrollbar so desktop users can see there is more.
3. **44px touch targets + safe areas.** Interactive controls are ≥44px tall
   below `md` (`h-11`/`min-h-11`), compact from `md` up. The ui primitives
   (button/tabs/select) encode this — explicit dense overrides via
   className are the opt-out, reserved for manager data-grid rows. The
   shell handles iOS insets with `pt-safe`/`pb-safe`/`px-safe` utilities
   (viewport-fit=cover is set in `__root.tsx`); keep them when touching
   AppShell. Inputs/selects that focus a keyboard stay ≥16px font on
   mobile (`text-base md:text-xs` pattern) so iOS doesn't zoom-jump.
4. **Fluid typography.** Page-level headings step down on phones
   (`text-base md:text-lg`, etc.). The arcade small-caps display font is a
   deliberate aesthetic — don't "fix" panel titles to be huge.
