/** Baked in by vite.config define: the commit this bundle was built from
 *  (VERCEL_GIT_COMMIT_SHA on Vercel, "dev" everywhere else). */
declare const __BUILD_COMMIT__: string;

interface Window {
  /** Set by RootComponent's mount effect; the boot watchdog inlined in the
   *  document head (__root.tsx) reloads once if it never appears. */
  __tiBooted?: boolean;
  __tiBootTimer?: number;
}
