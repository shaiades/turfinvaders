
CREATE TABLE public.turfs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#39ff14',
  polygon_coordinates JSONB NOT NULL,
  assigned_user_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.turfs TO authenticated;
GRANT ALL ON public.turfs TO service_role;

ALTER TABLE public.turfs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Owners and Captains can view all turfs"
  ON public.turfs FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'owner')
    OR public.has_role(auth.uid(), 'captain')
    OR public.has_role(auth.uid(), 'office_staff')
  );

CREATE POLICY "Canvassers can view their assigned turfs"
  ON public.turfs FOR SELECT TO authenticated
  USING (assigned_user_id = auth.uid());

CREATE POLICY "Owners and Captains can insert turfs"
  ON public.turfs FOR INSERT TO authenticated
  WITH CHECK (
    public.has_role(auth.uid(), 'owner')
    OR public.has_role(auth.uid(), 'captain')
  );

CREATE POLICY "Owners and Captains can update turfs"
  ON public.turfs FOR UPDATE TO authenticated
  USING (
    public.has_role(auth.uid(), 'owner')
    OR public.has_role(auth.uid(), 'captain')
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'owner')
    OR public.has_role(auth.uid(), 'captain')
  );

CREATE POLICY "Owners and Captains can delete turfs"
  ON public.turfs FOR DELETE TO authenticated
  USING (
    public.has_role(auth.uid(), 'owner')
    OR public.has_role(auth.uid(), 'captain')
  );

CREATE TRIGGER turfs_touch_updated_at
  BEFORE UPDATE ON public.turfs
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE INDEX idx_turfs_assigned_user ON public.turfs(assigned_user_id);
