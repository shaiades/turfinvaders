CREATE OR REPLACE FUNCTION public.evaluate_canvasser_suspension(_canvasser_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _this_week_start date := (date_trunc('week', CURRENT_DATE))::date;
  _last_week_start date := _this_week_start - 7;
  _prev_week_start date := _this_week_start - 14;
  _last_pts int := 0;
  _prev_pts int := 0;
BEGIN
  SELECT COALESCE(SUM(demos_sits + sales), 0) INTO _last_pts
  FROM public.daily_logs
  WHERE canvasser_id = _canvasser_id
    AND log_date BETWEEN _last_week_start AND _last_week_start + 5;

  SELECT COALESCE(SUM(demos_sits + sales), 0) INTO _prev_pts
  FROM public.daily_logs
  WHERE canvasser_id = _canvasser_id
    AND log_date BETWEEN _prev_week_start AND _prev_week_start + 5;

  IF _last_pts < 3 AND _prev_pts < 3 THEN
    UPDATE public.profiles
    SET status = 'suspension_review'::canvasser_status
    WHERE id = _canvasser_id
      AND COALESCE(status::text, '') <> 'suspension_review';
  END IF;
END $function$;