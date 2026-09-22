import type { IncomingHttpHeaders } from "node:http";
import pino from "pino";
import { clientIp } from "./client-ip.js";

/** The parts of a Fastify request the serializer below reports. */
interface LoggableRequest {
  method?: string;
  url?: string;
  host?: string;
  ip?: string;
  headers: IncomingHttpHeaders;
  socket?: { remoteAddress?: string; remotePort?: number };
}

export const log = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: [
      "password",
      "authorization",
      "*.password",
      "*.authorization",
      "*.xoauth2",
      "*.vault",
      "credentials",
    ],
    remove: true,
  },
  serializers: {
    // Same shape as Fastify's own request serializer, which it merges under
    // the ones carried by this instance. It reports the connection peer, which
    // behind a reverse proxy is the proxy, so the address is resolved from the
    // forwarding header instead.
    req(req: LoggableRequest) {
      return {
        method: req.method,
        url: req.url,
        host: req.host,
        remoteAddress: clientIp(req.socket?.remoteAddress, req.headers) ?? req.ip,
        remotePort: req.socket?.remotePort,
      };
    },
  },
});
