// The real "@x402/extensions/bazaar", imported by file path so wrangler's [alias] (which points the package
// specifier at the no-op src/shims/bazaar.ts for @x402/hono's dynamic import) does not apply here.
// The type-only import is erased at build time, so it never triggers the alias.
import type * as Bazaar from "@x402/extensions/bazaar";
// @ts-ignore - direct file import of the real module (bypasses the alias); typed via the cast below
import * as real from "../node_modules/@x402/extensions/dist/esm/bazaar/index.mjs";

const m = real as typeof Bazaar;
export const declareDiscoveryExtension: typeof Bazaar.declareDiscoveryExtension = m.declareDiscoveryExtension;
export const bazaarResourceServerExtension: typeof Bazaar.bazaarResourceServerExtension = m.bazaarResourceServerExtension;
