import { PlinthSession } from "@wirevice/plinth-js";
import type { Beacon, PlinthConfig, PlayerEvent, SessionMeta } from "@wirevice/plinth-js";

type SessionFactory = (meta: SessionMeta, config?: PlinthConfig) => Promise<PlinthSession>;
type Teardown = () => void | Promise<void>;
type Loader = (url: string, video: HTMLVideoElement, sessionFactory: SessionFactory) => Promise<Teardown>;

function appendLogItem(html: string): void {
  const ul = document.getElementById("log")!;
  const li = document.createElement("li");
  li.innerHTML = html;
  ul.appendChild(li);
  ul.scrollTop = ul.scrollHeight;
}

export function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  appendLogItem(`<span class="ts">${ts}</span><span class="msg">${msg}</span>`);
}

function logBeacon(beacon: Beacon): void {
  const ts = new Date().toISOString().slice(11, 23);
  const summary = `◆ ${beacon.event} (seq=${beacon.seq})`;
  const detail = JSON.stringify(beacon, null, 2);
  appendLogItem(
    `<details>` +
    `<summary><span class="ts">${ts}</span><span class="msg">${summary}</span></summary>` +
    `<pre class="beacon-detail">${detail}</pre>` +
    `</details>`,
  );
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
      logBeacon(beacon);
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
        const detail = li.querySelector(".beacon-detail")?.textContent ?? "";
        return detail ? `${ts}${msg}\n${detail}` : `${ts}${msg}`;
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
