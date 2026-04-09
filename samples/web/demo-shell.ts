import { PlinthSession } from "@wirevice/plinth-js";
import type { BeaconBatch, PlinthConfig, PlayerEvent, SessionMeta } from "@wirevice/plinth-js";

type SessionFactory = (meta: SessionMeta, config?: PlinthConfig) => Promise<PlinthSession>;
type Teardown = () => void | Promise<void>;
type Loader = (url: string, video: HTMLVideoElement, sessionFactory: SessionFactory) => Promise<Teardown>;

export function log(msg: string): void {
  const ul = document.getElementById("log")!;
  const li = document.createElement("li");
  const ts = new Date().toISOString().slice(11, 23);
  li.innerHTML = `<span class="ts">${ts}</span><span class="msg">${msg}</span>`;
  ul.appendChild(li);
  ul.scrollTop = ul.scrollHeight;
}

export async function loggingSessionFactory(
  meta: SessionMeta,
  config?: PlinthConfig,
): Promise<PlinthSession> {
  const session = await PlinthSession.create(meta, config);
  const origProcessEvent = session.processEvent.bind(session);
  session.processEvent = (event: PlayerEvent) => {
    const batch = origProcessEvent(event);
    for (const beacon of batch.beacons) {
      log(`◆ ${beacon.event} (seq=${beacon.seq})`);
    }
    return batch;
  };
  const origTick = session.tick.bind(session);
  session.tick = () => {
    const sent = origTick();
    if (sent) log("♥ heartbeat");
    return sent;
  };
  return session;
}

export function showVersions(versions: Record<string, string>): void {
  const el = document.getElementById("versions");
  if (!el) return;
  el.textContent = Object.entries(versions)
    .map(([k, v]) => `${k} ${v}`)
    .join("  ·  ");
}

export function setupDemo(loader: Loader): void {
  let teardown: Teardown | null = null;

  document.getElementById("clear-log")!.addEventListener("click", () => {
    document.getElementById("log")!.innerHTML = "";
  });

  document.getElementById("copy-log")!.addEventListener("click", () => {
    const items = document.getElementById("log")!.querySelectorAll("li");
    const text = Array.from(items)
      .map((li) => {
        const ts = li.querySelector(".ts")?.textContent ?? "";
        const msg = li.querySelector(".msg")?.textContent ?? "";
        return ts + msg;
      })
      .join("\n");
    navigator.clipboard.writeText(text);
  });

  document.getElementById("url-input")!.addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("load-btn")!.click();
  });

  document.getElementById("load-btn")!.addEventListener("click", async () => {
    const pending = teardown;
    teardown = null;
    if (pending) await pending();
    log("— loading —");
    const url = (document.getElementById("url-input") as HTMLInputElement).value.trim();
    if (!url) return;
    const video = document.getElementById("video") as HTMLVideoElement;
    try {
      teardown = await loader(url, video, loggingSessionFactory);
      log("Session started");
      const autostart = (document.getElementById("autostart") as HTMLInputElement).checked;
      if (autostart) video.play();
    } catch (err) {
      log(`ERROR: ${err}`);
    }
  });
}
