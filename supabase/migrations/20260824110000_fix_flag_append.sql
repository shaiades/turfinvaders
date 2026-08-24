-- Fix for 20260824100000: `NEW.flag_reasons || 'literal'` parses the untyped
-- literal as an ARRAY literal (22P02 "malformed array literal") the moment a
-- flag fires. array_append() is unambiguous. Found by the first flagged
-- insert in production; the failed transaction rolled back cleanly.

CREATE OR REPLACE FUNCTION public.compute_time_entry_hours()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _raw_hours numeric;
  _meal_hours numeric := 0;
  _has_compliant_meal boolean := false;
  _has_late_meal boolean := false;
  _local_hour int;
BEGIN
  IF NEW.voided_at IS NOT NULL THEN
    NEW.billable_hours := 0;
    RETURN NEW;
  END IF;

  -- Punch-time anomaly flags (INSERT): early start and Sunday work.
  IF TG_OP = 'INSERT' THEN
    _local_hour := EXTRACT(HOUR FROM (NEW.clock_in AT TIME ZONE 'America/Los_Angeles'))::int;
    IF _local_hour < 7 AND NOT ('early_clock_in' = ANY(NEW.flag_reasons)) THEN
      NEW.flag_reasons := array_append(NEW.flag_reasons, 'early_clock_in');
      NEW.needs_correction := true;
    END IF;
    IF EXTRACT(ISODOW FROM NEW.log_date)::int = 7
       AND NOT ('sunday_shift' = ANY(NEW.flag_reasons)) THEN
      NEW.flag_reasons := array_append(NEW.flag_reasons, 'sunday_shift');
      NEW.needs_correction := true;
    END IF;
  END IF;

  IF NEW.clock_out IS NULL THEN
    NEW.billable_hours := 0;
    RETURN NEW;
  END IF;

  _raw_hours := EXTRACT(EPOCH FROM (NEW.clock_out - NEW.clock_in)) / 3600.0;
  IF _raw_hours < 0 THEN _raw_hours := 0; END IF;

  SELECT COALESCE(SUM(GREATEST(0,
           EXTRACT(EPOCH FROM (LEAST(mp.meal_end, NEW.clock_out)
                             - GREATEST(mp.meal_start, NEW.clock_in))) / 3600.0)), 0),
         bool_or(mp.meal_end - mp.meal_start >= interval '30 minutes'
                 AND mp.meal_start <= NEW.clock_in + interval '5 hours'),
         bool_or(mp.meal_end - mp.meal_start >= interval '30 minutes'
                 AND mp.meal_start > NEW.clock_in + interval '5 hours')
    INTO _meal_hours, _has_compliant_meal, _has_late_meal
  FROM public.meal_periods mp
  WHERE mp.time_entry_id = NEW.id AND mp.meal_end IS NOT NULL;

  NEW.billable_hours := ROUND(GREATEST(_raw_hours - _meal_hours, 0)::numeric, 2);

  IF _raw_hours <= 5.0 THEN
    NEW.meal_status := CASE WHEN _meal_hours > 0 THEN 'taken' ELSE 'not_required' END;
  ELSIF COALESCE(_has_compliant_meal, false) THEN
    NEW.meal_status := 'taken';
  ELSIF COALESCE(_has_late_meal, false) THEN
    NEW.meal_status := 'taken_late';
  ELSIF NEW.meal_status NOT IN ('missed', 'unrecorded') THEN
    NEW.meal_status := 'pending';
  END IF;

  -- Close-time anomaly flags.
  IF _raw_hours > 12 AND NOT ('very_long_shift' = ANY(NEW.flag_reasons)) THEN
    NEW.flag_reasons := array_append(NEW.flag_reasons, 'very_long_shift');
    NEW.needs_correction := true;
  END IF;
  IF NEW.meal_status IN ('missed', 'taken_late')
     AND NOT ('missed_meal' = ANY(NEW.flag_reasons)) THEN
    NEW.flag_reasons := array_append(NEW.flag_reasons, 'missed_meal');
    NEW.needs_correction := true;
  END IF;
  IF NEW.meal_status = 'unrecorded'
     AND NOT ('unrecorded_lunch' = ANY(NEW.flag_reasons)) THEN
    NEW.flag_reasons := array_append(NEW.flag_reasons, 'unrecorded_lunch');
    NEW.needs_correction := true;
  END IF;

  RETURN NEW;
END $$;
