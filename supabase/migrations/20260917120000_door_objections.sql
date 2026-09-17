-- Door objections quick-pick (captain feedback 2026-09-17): an optional,
-- toggleable prompt for the "Not Interested" objection a rep hit at the
-- door, so captains can review the next day what's coming up most.

ALTER TABLE public.field_pins ADD COLUMN objection text;

ALTER TABLE public.company_settings
  ADD COLUMN objections_quickpick_enabled boolean NOT NULL DEFAULT false;

-- No RLS/grant changes needed: both columns ride the existing table-level
-- grants and row policies (field_pins: canvasser owns their own rows,
-- captains/owner/office_staff already have SELECT; company_settings:
-- everyone SELECTs, admin-tier already has UPDATE per 20260916120000).
