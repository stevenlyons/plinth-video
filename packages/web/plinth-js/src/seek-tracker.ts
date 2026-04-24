/** Returns true if `video.currentTime` falls within any buffered range. */
function isBufferReady(video: HTMLVideoElement): boolean {
  const ct = video.currentTime;
  for (let i = 0; i < video.buffered.length; i++) {
    if (video.buffered.start(i) <= ct && ct <= video.buffered.end(i)) {
      return true;
    }
  }
  return false;
}

/**
 * Manages seek debounce state for HTML video element adapters.
 *
 * Attaches `seeking` and `seeked` listeners to the video element, debounces
 * rapid scrub events into a single seek_start/seek_end pair, and fires
 * callbacks for the adapter to translate into PlayerEvents.
 */
export class VideoSeekTracker {
  private _active = false;
  private _pendingSeekFrom: number | null = null;
  private _debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly _video: HTMLVideoElement;
  private readonly _onSeekEnd: (toMs: number, bufferReady: boolean) => void;
  private readonly _seekingHandler: EventListener;
  private readonly _seekedHandler: EventListener;

  /**
   * @param video         The video element to observe.
   * @param getPlayheadMs Returns the current playhead position in ms (sampled on seekStart).
   * @param onSeekStart   Called once when a seek gesture begins, with the position it started from.
   * @param onSeekEnd     Called after the 300 ms debounce settles with the destination position
   *                      and whether the buffer is ready at that position.
   */
  constructor(
    video: HTMLVideoElement,
    getPlayheadMs: () => number,
    onSeekStart: (fromMs: number) => void,
    onSeekEnd: (toMs: number, bufferReady: boolean) => void,
  ) {
    this._onSeekEnd = onSeekEnd;
    this._video = video;

    this._seekingHandler = () => {
      if (this._pendingSeekFrom === null) {
        this._pendingSeekFrom = Math.round(getPlayheadMs());
        onSeekStart(this._pendingSeekFrom);
      }
      this._active = true;
      clearTimeout(this._debounceTimer ?? undefined);
      this._debounceTimer = null;
    };

    this._seekedHandler = () => {
      clearTimeout(this._debounceTimer ?? undefined);
      this._debounceTimer = setTimeout(() => {
        this._debounceTimer = null;
        this._active = false;
        if (this._pendingSeekFrom !== null) {
          this._pendingSeekFrom = null;
          onSeekEnd(Math.round(video.currentTime * 1000), isBufferReady(video));
        }
      }, 300);
    };

    video.addEventListener("seeking", this._seekingHandler);
    video.addEventListener("seeked", this._seekedHandler);
  }

  /** True while a seek gesture is in progress (between seekStart and debounce settlement). */
  get active(): boolean {
    return this._active;
  }

  /**
   * Force-settle any in-flight seek without waiting for the debounce.
   * Call before emitting `ended` or `error` so the state machine exits Seeking first.
   * @param bufferReadyOverride  When provided, overrides isBufferReady(). Pass `true` when
   *                             the video has ended (buffer is effectively complete).
   */
  settle(bufferReadyOverride?: boolean): void {
    if (this._pendingSeekFrom === null) return;
    clearTimeout(this._debounceTimer ?? undefined);
    this._debounceTimer = null;
    this._active = false;
    this._pendingSeekFrom = null;
    const bufferReady = bufferReadyOverride ?? isBufferReady(this._video);
    this._onSeekEnd(Math.round(this._video.currentTime * 1000), bufferReady);
  }

  /** Reset seek state — call when a new asset is loaded to clear any in-flight seek. */
  reset(): void {
    clearTimeout(this._debounceTimer ?? undefined);
    this._debounceTimer = null;
    this._active = false;
    this._pendingSeekFrom = null;
  }

  /** Remove event listeners and cancel any pending debounce timer. */
  destroy(): void {
    this.reset();
    this._video.removeEventListener("seeking", this._seekingHandler);
    this._video.removeEventListener("seeked", this._seekedHandler);
  }
}
