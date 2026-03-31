import { MediaPlayer } from "dashjs";
import { PlinthDashjs } from "@wirevice/plinth-dashjs";
import { setupDemo } from "./demo-shell.js";

setupDemo(async (url, video, sessionFactory) => {
  const player = MediaPlayer().create();
  const instance = await PlinthDashjs.initialize(player as any, video, { id: url }, { sessionFactory });
  player.initialize(video, url, false);
  return () => { instance.destroy(); player.reset(); };
});
