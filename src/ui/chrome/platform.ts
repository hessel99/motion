// the window frame the app runs in, as <html> attributes the layout reads (chrome.css):
//   data-platform="mac|win|linux|web"
//   data-traffic-lights   the mac window buttons float over the title bar's left end (desktop app,
//                         not in full screen): the title bar reserves --traffic-w for them
//   data-fullscreen       the window is full screen (mac: the traffic lights are gone)
// in the browser nothing is reserved. ?platform=mac emulates the mac app (dummy traffic lights drawn
// where electron puts the real ones, electron/main.cjs trafficLightPosition) so screenshots and
// scripts/layout-lock.mjs can check that nothing sits under them; add &fullscreen for full screen.

export type Platform = 'mac' | 'win' | 'linux' | 'web';

type Native = { platform?: string; isFullScreen?: () => Promise<boolean>; onFullScreen?: (cb: (on: boolean) => void) => () => void };
const native = (globalThis as any).motionNative as Native | undefined;
const q = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
const forced = q.get('platform');

function detect(): Platform {
  if (forced === 'mac' || forced === 'win' || forced === 'linux' || forced === 'web') return forced;
  const p = native?.platform;
  if (p === 'darwin') return 'mac';
  if (p === 'win32') return 'win';
  if (p) return 'linux';
  return 'web';
}

export const PLATFORM: Platform = detect();
/** the browser emulates a desktop frame (?platform=…): draw the dummy traffic lights */
export const EMULATED = !native && !!forced && forced !== 'web';
/** the mac desktop app (or its emulation): the window has no title bar, the traffic lights float */
export const MAC_FRAME = PLATFORM === 'mac' && (native?.platform === 'darwin' || EMULATED);

export function setupPlatform(root: HTMLElement = document.documentElement) {
  root.dataset.platform = PLATFORM;
  const set = (full: boolean) => {
    if (full) root.dataset.fullscreen = ''; else delete root.dataset.fullscreen;
    if (MAC_FRAME && !full) root.dataset.trafficLights = ''; else delete root.dataset.trafficLights;
  };
  set(EMULATED && q.has('fullscreen'));
  if (native?.onFullScreen) native.onFullScreen(set);
  native?.isFullScreen?.().then(set).catch(() => {});
}
