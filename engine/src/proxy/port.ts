/**
 * The sidecar proxy's listening port. Kept apart from `main.ts` so the
 * engine can use it without bundling the proxy's entry point, whose `main()`
 * would otherwise run inside the engine and read the engine's stdin.
 */
export const PROXY_PORT = 3128;
