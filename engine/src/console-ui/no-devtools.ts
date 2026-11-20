// Ink loads React DevTools only when DEV=true; the console never does, so the bundle carries this stand-in.
export default { initialize: () => undefined, connectToDevTools: () => undefined };
