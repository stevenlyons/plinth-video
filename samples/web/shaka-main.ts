import shaka from "shaka-player";
import { PlinthShaka } from "@wirevice/plinth-shaka";
import { setupDemo } from "./demo-shell.js";

setupDemo(async (url, video, sessionFactory) => {
  shaka.polyfill.installAll();
  if (!shaka.Player.isBrowserSupported()) throw new Error("Shaka Player not supported in this browser");
  const player = new shaka.Player(video);
  const instance = await PlinthShaka.initialize(player, video, { id: url }, { sessionFactory });
  await player.load(url);
  return async () => { instance.destroy(); await player.destroy(); };
});
