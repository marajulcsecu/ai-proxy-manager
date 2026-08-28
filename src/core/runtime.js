/**
 * @fileoverview Facts about the currently running server that are not in
 * config.json — chiefly the port actually bound, which can differ from
 * config.proxy_port when `--port` was passed.
 */

const runtime = {
  port: null,
  host: null,
  startedAt: null
};

/**
 * @param {{port:number, host:string}} info
 */
export function setRuntime(info) {
  runtime.port = info.port ?? null;
  runtime.host = info.host ?? null;
  runtime.startedAt = new Date().toISOString();
}

/** @returns {{port:number|null, host:string|null, startedAt:string|null}} */
export function getRuntime() {
  return { ...runtime };
}
