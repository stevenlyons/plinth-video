import { PlinthDashjs } from "@plinth/dashjs";
import { PlinthSession } from "@plinth/js";
import type { PlinthConfig, PlayerEvent, SessionMeta } from "@plinth/js";
import { MediaPlayer } from "dashjs";

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

let currentPlayer: ReturnType<ReturnType<typeof MediaPlayer>["create"]> | null = null;
let currentInstance: PlinthDashjs | null = null;

document.getElementById("load-btn")!.addEventListener("click", async () => {
  currentInstance?.destroy();
  currentInstance = null;
  if (currentPlayer) {
    currentPlayer.reset();
    currentPlayer = null;
  }
  log("— loading —");

  const url = (document.getElementById("url-input") as HTMLInputElement).value.trim();
  if (!url) return;

  const video = document.getElementById("video") as HTMLVideoElement;
  const player = MediaPlayer().create();
  currentPlayer = player;

  try {
    currentInstance = await PlinthDashjs.initialize(player as any, video, { id: url }, {
      sessionFactory: loggingSessionFactory,
    });

    player.initialize(video, url, false);
    log("Session started");
  } catch (err) {
    log(`ERROR: ${err}`);
  }
});
