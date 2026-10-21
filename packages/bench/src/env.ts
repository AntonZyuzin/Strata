/** What the report needs to know about the machine and the WebView. */
export interface Environment {
  userAgent: string;
  platform: string;
  language: string;
  devicePixelRatio: number;
  screen: { width: number; height: number };
  viewport: { width: number; height: number };
  hardwareConcurrency: number;
  deviceMemoryGb: number | null;
  webgl: { version: string; vendor: string; renderer: string } | null;
  refreshHzEstimate: number | null;
  /** Mean refresh period, ms (see `estimateVsyncMs`). */
  vsyncMs: number;
  /** Smallest step of `performance.now()`: about 1 ms in WebKit, 0.1 ms or less in Chromium. */
  timerResolutionMs: number;
}

function webglInfo(): Environment['webgl'] {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2');
  if (!gl) return null;
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const info = {
    version: String(gl.getParameter(gl.VERSION)),
    vendor: String(dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR)),
    renderer: String(
      dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    ),
  };
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return info;
}

/**
 * Display refresh period: the mean rAF interval over 120 idle frames (2 s at
 * 60 Hz). Not the median: WebKit rounds timestamps to 1 ms, so at 60 Hz the
 * intervals read 16 or 17 and only their mean is 16.7.
 */
export function estimateVsyncMs(frames = 120): Promise<number> {
  return new Promise((resolve) => {
    const stamps: number[] = [];
    const tick = (t: number) => {
      stamps.push(t);
      if (stamps.length <= frames) requestAnimationFrame(tick);
      else {
        // Drop the slowest tenth: a stray long frame should not shift the period.
        const d = stamps
          .slice(1)
          .map((s, i) => s - (stamps[i] ?? s))
          .sort((a, b) => a - b)
          .slice(0, Math.ceil(frames * 0.9));
        resolve(d.reduce((a, b) => a + b, 0) / Math.max(1, d.length));
      }
    };
    requestAnimationFrame(tick);
  });
}

export function timerResolution(): number {
  let best = Number.POSITIVE_INFINITY;
  let last = performance.now();
  for (let i = 0; i < 200_000 && best > 0.001; i++) {
    const now = performance.now();
    if (now > last) {
      best = Math.min(best, now - last);
      last = now;
    }
  }
  return Math.round(best * 1e4) / 1e4;
}

export async function collectEnvironment(): Promise<Environment> {
  const vsyncMs = await estimateVsyncMs();
  const nav = navigator as Navigator & { deviceMemory?: number };
  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    language: navigator.language,
    devicePixelRatio: window.devicePixelRatio,
    screen: { width: window.screen.width, height: window.screen.height },
    viewport: { width: window.innerWidth, height: window.innerHeight },
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemoryGb: nav.deviceMemory ?? null,
    webgl: webglInfo(),
    refreshHzEstimate: vsyncMs > 0 ? Math.round(1000 / vsyncMs) : null,
    vsyncMs: Math.round(vsyncMs * 1000) / 1000,
    timerResolutionMs: timerResolution(),
  };
}
