// Whether this process should talk to the Starlink router at all.
//
// A kit with no router — a dish on its own, or one behind third-party gear —
// has nothing at 192.168.1.1 to answer. Every poll against it is then a timeout
// that holds up the cycle it runs in and a warning that says nothing new, on
// every cycle, for as long as the recorder runs.
//
// HISTORIAN_ROUTER_DISABLED=1 turns every router call off: the client poll, the
// router's event log, its status and ping, radio temperatures, and the browser
// host's /router proxy. Dish recording is untouched. Read once at import, like
// ROUTER_URL: it describes the kit, which does not change while running.

export function routerPollingDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.HISTORIAN_ROUTER_DISABLED?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}
