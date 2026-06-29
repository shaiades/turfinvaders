
-- Owner-permissive RLS for performance tables
CREATE POLICY "Owners insert daily_logs" ON public.daily_logs FOR INSERT TO authenticated WITH CHECK (public.has_role(auth.uid(), 'owner'));
CREATE POLICY "Owners update daily_logs" ON public.daily_logs FOR UPDATE TO authenticated USING (public.has_role(auth.uid(), 'owner')) WITH CHECK (public.has_role(auth.uid(), 'owner'));
CREATE POLICY "Owners delete daily_logs" ON public.daily_logs FOR DELETE TO authenticated USING (public.has_role(auth.uid(), 'owner'));
