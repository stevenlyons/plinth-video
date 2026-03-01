import Hls from "hls.js";
import { PlinthHlsJs } from "@plinth/hlsjs";
import { PlinthSession } from "@plinth/js";
import type { PlinthConfig, PlayerEvent, SessionMeta } from "@plinth/js";

function log(msg: string) {
  const ul = document.getElementById("log")!;
  const li = document.createElement("li");
  const ts = new Date().toISOString().slice(11, 23);
  li.innerHTML = `<span class="ts">${ts}</span><span class="msg">${msg}</span>`;
  ul.appendChild(li);
  ul.scrollTop = ul.scrollHeight;
}

async function loggingSessionFactory(
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

let currentInstance: PlinthHlsJs | null = null;

document.getElementById("load-btn")!.addEventListener("click", async () => {
  currentInstance?.destroy();
  currentInstance = null;
  log("— loading —");

  const url = (document.getElementById("url-input") as HTMLInputElement).value.trim();
  if (!url) return;

  const video = document.getElementById("video") as HTMLVideoElement;

  if (!Hls.isSupported()) {
    log("ERROR: Hls.js not supported in this browser");
    return;
  }

  const hls = new Hls();
  hls.loadSource(url);
  hls.attachMedia(video);

  try {
    currentInstance = await PlinthHlsJs.initialize(hls, video, { id: url }, {
      sessionFactory: loggingSessionFactory,
    });
    log("Session started");
  } catch (err) {
    log(`ERROR: ${err}`);
  }
});
