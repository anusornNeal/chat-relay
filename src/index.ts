export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({
        status: "ok",
        service: "chat-relay",
      });
    }

    return new Response("chat-relay is running", {
      headers: {
        "content-type": "text/plain; charset=utf-8",
      },
    });
  },
};
