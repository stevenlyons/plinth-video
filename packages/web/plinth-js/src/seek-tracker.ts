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
  private readonly _seekingHandler: EventListener;
  private readonly _seekedHandler: EventListener;

  /**
   * @param video         The video element to observe.
   * @param getPlayheadMs Returns the current playhead position in ms (sampled on seekStart).
   * @param onSeekStart   Called once when a seek gesture begins, with the position it started from.
   * @param onSeekEnd     Called after the 300 ms debounce settles; receives `paused` state.
   */
  constructor(
    video: HTMLVideoElement,
    getPlayheadMs: () => number,
    onSeekStart: (fromMs: number) => void,
    onSeekEnd: (paused: boolean) => void,
  ) {
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
          onSeekEnd(video.paused);
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
