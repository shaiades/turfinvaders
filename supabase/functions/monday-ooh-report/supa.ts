// Shared Supabase client factory + type for the OOH edge function and its
// helper modules. Using ONE factory means every module's `Supa` param is the
// exact type `createClient(url, key)` returns here — without it, index.ts
// (which calls createClient directly) and history.ts/watchdog.ts (which import
// the SupabaseClient type) disagree on the schema generics and Deno's
// typechecker rejects the hand-off.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export function makeClient(url: string, key: string) {
  return createClient(url, key);
}

export type Supa = ReturnType<typeof makeClient>;
