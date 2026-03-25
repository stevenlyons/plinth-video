import { PlinthShaka } from "@wirevice/plinth-shaka";
import { PlinthSession } from "@wirevice/plinth-js";
import type { PlinthConfig, PlayerEvent, SessionMeta } from "@wirevice/plinth-js";
import shaka from "shaka-player";

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

let currentPlayer: any = null;
let currentInstance: PlinthShaka | null = null;

document.getElementById("url-input")!.addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("load-btn")!.click();
});

document.getElementById("load-btn")!.addEventListener("click", async () => {
  currentInstance?.destroy();
  currentInstance = null;
  if (currentPlayer) {
    await currentPlayer.destroy();
    currentPlayer = null;
  }
  log("— loading —");

  const url = (document.getElementById("url-input") as HTMLInputElement).value.trim();
  if (!url) return;

  const video = document.getElementById("video") as HTMLVideoElement;

  shaka.polyfill.installAll();

  if (!shaka.Player.isBrowserSupported()) {
    log("ERROR: Shaka Player not supported in this browser");
    return;
  }

  const player = new shaka.Player(video);
  currentPlayer = player;

  try {
    currentInstance = await PlinthShaka.initialize(player, video, { id: url }, {
      sessionFactory: loggingSessionFactory,
    });

    await player.load(url);
    log("Session started");
  } catch (err) {
    log(`ERROR: ${err}`);
  }
});
