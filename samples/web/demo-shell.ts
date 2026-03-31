import { PlinthSession } from "@wirevice/plinth-js";
import type { PlinthConfig, PlayerEvent, SessionMeta } from "@wirevice/plinth-js";

export type SessionFactory = (meta: SessionMeta, config?: PlinthConfig) => Promise<PlinthSession>;
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
  const orig = session.processEvent.bind(session);
  session.processEvent = (event: PlayerEvent) => {
    log(`→ ${JSON.stringify(event)}`);
    orig(event);
  };
  return session;
}

export function setupDemo(loader: Loader): void {
  let teardown: Teardown | null = null;

  document.getElementById("clear-log")!.addEventListener("click", () => {
    document.getElementById("log")!.innerHTML = "";
  });

  document.getElementById("url-input")!.addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("load-btn")!.click();
  });

  document.getElementById("load-btn")!.addEventListener("click", async () => {
    if (teardown) { await teardown(); teardown = null; }
    log("— loading —");
    const url = (document.getElementById("url-input") as HTMLInputElement).value.trim();
    if (!url) return;
    const video = document.getElementById("video") as HTMLVideoElement;
    try {
      teardown = await loader(url, video, loggingSessionFactory);
      log("Session started");
    } catch (err) {
      log(`ERROR: ${err}`);
    }
  });
}
