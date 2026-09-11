// Type surface for the leaflet-rotate plugin (no upstream types). Only the
// options and methods this app touches — see NeonMap's rotation support.
import "leaflet";

declare module "leaflet" {
  interface Map {
    setBearing(theta: number): void;
    getBearing(): number;
  }
  interface MapOptions {
    /** leaflet-rotate: master switch — creates the rotate pane. */
    rotate?: boolean;
    /** Initial bearing in degrees. */
    bearing?: number;
    /** Two-finger twist rotation on touch devices. */
    touchRotate?: boolean;
    /** Shift + mouse-drag rotation on desktop. */
    shiftKeyRotate?: boolean;
    /** The plugin's own compass control — off; NeonMap draws its own. */
    rotateControl?: boolean | { closeOnZeroBearing?: boolean; position?: string };
  }
}

declare module "leaflet-rotate";
