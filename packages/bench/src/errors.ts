/**
 * `name: message` and the stack. JavaScriptCore's `stack` holds only the
 * frames (and can be empty), V8's starts with the message, so the message is
 * added when the stack does not begin with it. Shared by the runner and the
 * Loro worker; no Pixi or Loro imports here.
 */
export function describeError(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const head = `${e.name}: ${e.message}`;
  return e.stack?.startsWith(head) ? e.stack : `${head}\n${e.stack ?? ''}`;
}
