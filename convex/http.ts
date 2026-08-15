import { httpRouter } from "convex/server";

import { api } from "./_generated/api";
import { httpAction } from "./_generated/server";

const http = httpRouter();

http.route({
  path: "/community/board-exists",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const slug = url.searchParams.get("slug") ?? "";
    const exists = await ctx.runQuery(api.community.boardExists, { slug });
    return new Response(JSON.stringify({ exists }), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }),
});

http.route({
  path: "/community/snapshot",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const slug = url.searchParams.get("slug") ?? "";
    const snapshotId = url.searchParams.get("snapshotId") ?? "";
    const snapshot = await ctx.runQuery(api.community.getSnapshot, {
      slug,
      snapshotId,
    });
    return new Response(JSON.stringify(snapshot), {
      status: snapshot === null ? 404 : 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": snapshot === null
          ? "no-store"
          : "public, max-age=31536000, immutable",
        "Content-Type": "application/json; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }),
});

export default http;
