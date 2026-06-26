// Shared helpers for live runtime statistics (frame rate + heap memory).
//
// `performance.memory` is a non-standard, Chromium-only API. It reports the
// JavaScript heap for the whole page (both viewers share it), so the memory
// figure is a process-level measurement rather than a per-engine one.

interface PerformanceMemory {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

export function readHeapStats(): { heapUsedBytes?: number; heapLimitBytes?: number } {
  const memory = (performance as Performance & { memory?: PerformanceMemory }).memory;
  if (!memory) {
    return {};
  }
  return {
    heapUsedBytes: memory.usedJSHeapSize,
    heapLimitBytes: memory.jsHeapSizeLimit,
  };
}

/**
 * Rolling frame-rate tracker. Call `tick()` once per rendered frame; read
 * `fps` / `frameTimeMs` for a smoothed (~0.5s window) measurement.
 */
export class FrameRateTracker {
  private frames = 0;
  private windowStart = performance.now();
  private _fps = 0;
  private _frameTimeMs = 0;

  tick(now = performance.now()): void {
    this.frames += 1;
    const elapsed = now - this.windowStart;
    if (elapsed >= 500) {
      this._fps = (this.frames * 1000) / elapsed;
      this._frameTimeMs = elapsed / this.frames;
      this.frames = 0;
      this.windowStart = now;
    }
  }

  get fps(): number {
    return this._fps;
  }

  get frameTimeMs(): number {
    return this._frameTimeMs;
  }
}
