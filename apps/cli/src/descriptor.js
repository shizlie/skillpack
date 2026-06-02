// Marker for CLI command descriptors. Lives in its own module so both
// runner.js and commands.js can import it without creating a cycle
// (runner.js already imports from commands.js).
export const DESCRIPTOR = Symbol.for("skillpack.descriptor");
