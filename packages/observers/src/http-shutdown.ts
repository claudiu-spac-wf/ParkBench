import http from "node:http";

/** Drain accepted observer responses without allowing a persistent scraper to
 * keep the server alive after its listener has stopped accepting connections. */
export function createObserverHttpServer(
  handler: (request: http.IncomingMessage, response: http.ServerResponse) => unknown
) {
  const active = new Set<http.ServerResponse>();
  const inFlight = new Set<Promise<unknown>>();
  let draining = false,
    closing: Promise<void> | undefined;
  const server = http.createServer((request, response) => {
    if (draining) {
      response.statusCode = 503;
      response.setHeader("connection", "close");
      response.end("observer_shutting_down");
      return;
    }
    active.add(response);
    response.once("close", () => active.delete(response));
    response.once("finish", () => {
      active.delete(response);
      // Headers may already have been sent when shutdown started. end() drains
      // queued bytes before FIN, preserving the complete response in that case.
      if (draining && !request.socket.destroyed && !request.socket.writableEnded)
        request.socket.end();
    });
    const task = Promise.resolve(handler(request, response)).finally(() => inFlight.delete(task));
    inFlight.add(task);
    return task;
  });
  return {
    server,
    close() {
      if (closing) return closing;
      draining = true;
      for (const response of active) {
        response.shouldKeepAlive = false;
        if (!response.headersSent) response.setHeader("connection", "close");
      }
      closing = new Promise<void>((resolve, reject) => {
        server.close((error) =>
          error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING"
            ? reject(error)
            : resolve()
        );
        server.closeIdleConnections();
      }).then(async () => {
        // A disconnected caller may leave its asynchronous capture running.
        while (inFlight.size) await Promise.allSettled([...inFlight]);
      });
      return closing;
    }
  };
}
