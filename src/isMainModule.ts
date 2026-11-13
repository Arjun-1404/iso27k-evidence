import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * True when the file whose address is `moduleUrl` (pass `import.meta.url`) is the program being run, rather than
 * something another file imported. Used so that `tsx src/server.ts` starts the server but importing server.ts in a test does not.
 *
 * Comparing `import.meta.url` with the text `file://${process.argv[1]}` looks equivalent and is not: on Windows the
 * address is `file:///C:/folder/file.ts` while the path is `C:\folder\file.ts`, and on any system a folder name with a
 * space (which the address writes as %20) or a link to the folder makes them differ. The server then silently did
 * nothing. `pathToFileURL` writes a path the way Node writes the address, and `realpathSync` follows links first,
 * because Node gives a module its real location.
 */
export function isMainModule(moduleUrl: string, argv1: string | undefined = process.argv[1]): boolean {
  if (!argv1) return false;
  try { return moduleUrl === pathToFileURL(realpathSync(argv1)).href; }
  catch { return false; }
}
