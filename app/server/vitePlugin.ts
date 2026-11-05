// Mounts the /api/* routes on the Vite dev server so `npm run dev` is a
// single process. Production uses server/standalone.ts with the same handler.

import type { Connect, Plugin } from "vite";
import { handleApi } from "./api.ts";

export function apiPlugin(): Plugin {
  const handler: Connect.NextHandleFunction = (req, res, next) => {
    handleApi(req, res).then((handled) => {
      if (!handled) next();
    });
  };
  return {
    name: "ap-api",
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}
