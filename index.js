/**
 * Host half of DSH CtrlF.
 *
 * The whole capability is browser-side: the bar reads the transcript the Client
 * already rendered and paints matches through the CSS Custom Highlight API.
 * There is no Host service to register, nothing to persist, and no session
 * event to write, so this half deliberately does nothing at all.
 *
 * It exists because a bundle's patch inserts a plugin row, and a row needs a
 * module to load. Keeping it empty is the point: the plugin's entire surface is
 * one slot registration in the browser.
 */
export function apply() {}
