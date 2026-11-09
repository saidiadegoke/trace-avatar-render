/**
 * The auto camera: zoom in on the action before it happens, pan between actions close in time, and zoom
 * back out between bursts. Deterministic: the same timeline gives the same camera. PURE.
 *
 * Times are output milliseconds (after cuts); points and rects are source pixels.
 */

export interface Rect { x: number; y: number; w: number; h: number }
export interface Action { t: number; x: number; y: number; kind: string }

export interface CameraOptions {
  width: number;
  height: number;
  /** How far in. Default 1.6. */
  zoom?: number;
  /** The camera arrives this long before the action. Default 400. */
  leadMs?: number;
  /** Each move takes this long. Default 400. */
  easeMs?: number;
  /** Actions closer than this stay in one zoomed shot (the camera pans). Default 2500. */
  joinMs?: number;
  /** Stay in after the last action of a shot. Default 900. */
  holdMs?: number;
  /** A zoom change at most this often: shots closer than this are joined. Default 1500. */
  minChangeMs?: number;
}

interface Key { t: number; z: number; x: number; y: number }

/** Steps the camera zooms to; scrolls (and anything without a point) send it back out. */
export const ZOOM_KINDS = new Set(['click', 'dblclick', 'type', 'key', 'hover']);

const smooth = (u: number) => u * u * (3 - 2 * u);

/** Keyframes for the camera (exported for tests). */
export function cameraKeys(actions: readonly Action[], o: CameraOptions): Key[] {
  const Z = o.zoom ?? 1.6;
  const lead = o.leadMs ?? 400;
  const ease = o.easeMs ?? 400;
  const join = o.joinMs ?? 2500;
  const hold = o.holdMs ?? 900;
  const minChange = o.minChangeMs ?? 1500;
  const sorted = actions.slice().sort((a, b) => a.t - b.t);
  // Shots: runs of zoomable actions; a scroll ends a shot.
  const shots: Action[][] = [];
  let cur: Action[] = [];
  for (const a of sorted) {
    if (!ZOOM_KINDS.has(a.kind)) { if (cur.length) shots.push(cur); cur = []; continue; }
    const last = cur[cur.length - 1];
    if (last && a.t - last.t > join) { shots.push(cur); cur = []; }
    cur.push(a);
  }
  if (cur.length) shots.push(cur);
  // Join shots whose zoom-out and zoom-in would come too close together.
  const merged: Action[][] = [];
  for (const s of shots) {
    const prev = merged[merged.length - 1];
    if (prev) {
      const outAt = prev[prev.length - 1].t + hold;
      const inAt = s[0].t - lead - ease;
      const scrollBetween = sorted.some((a) => !ZOOM_KINDS.has(a.kind) && a.t > prev[prev.length - 1].t && a.t < s[0].t);
      if (!scrollBetween && inAt - (outAt + ease) < minChange) { prev.push(...s); continue; }
    }
    merged.push(s.slice());
  }
  const keys: Key[] = [];
  for (const s of merged) {
    const first = s[0];
    const inEnd = Math.max(first.t - lead, (keys[keys.length - 1]?.t ?? -Infinity) + ease);
    keys.push({ t: inEnd - ease, z: 1, x: first.x, y: first.y }, { t: inEnd, z: Z, x: first.x, y: first.y });
    for (let k = 1; k < s.length; k += 1) {
      const a = s[k];
      const prev = keys[keys.length - 1];
      const arrive = Math.max(a.t - lead, prev.t + ease);
      keys.push({ t: arrive - ease, z: Z, x: prev.x, y: prev.y }, { t: arrive, z: Z, x: a.x, y: a.y });
    }
    const last = keys[keys.length - 1];
    const out = Math.max(s[s.length - 1].t + hold, last.t);
    keys.push({ t: out, z: Z, x: last.x, y: last.y }, { t: out + ease, z: 1, x: last.x, y: last.y });
  }
  return keys;
}

/** The camera at each output time: the source rect to show. */
export function cameraPath(actions: readonly Action[], o: CameraOptions): (t: number) => Rect {
  const keys = cameraKeys(actions, o);
  const full: Rect = { x: 0, y: 0, w: o.width, h: o.height };
  const rectOf = (z: number, x: number, y: number): Rect => {
    if (z <= 1.0001) return full;
    const w = o.width / z;
    const h = o.height / z;
    return { x: Math.min(Math.max(0, x - w / 2), o.width - w), y: Math.min(Math.max(0, y - h / 2), o.height - h), w, h };
  };
  return (t) => {
    if (!keys.length || t <= keys[0].t || t >= keys[keys.length - 1].t) return full;
    let k = 0;
    while (k < keys.length - 2 && keys[k + 1].t <= t) k += 1;
    const a = keys[k];
    const b = keys[k + 1];
    const u = b.t > a.t ? smooth(Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t)))) : 1;
    // Ease the visible size (not the zoom factor) so zooming feels even; pan the centre.
    const za = 1 / a.z; const zb = 1 / b.z;
    const z = 1 / (za + (zb - za) * u);
    return rectOf(z, a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u);
  };
}
