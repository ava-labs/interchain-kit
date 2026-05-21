// avalanchejs has a long-standing TypeScript packaging quirk: its public
// `dist/index.d.ts` does `export * from "./vms"` while the individual
// subpaths do `export * as pvm from "./pvm"` etc. Per the TS spec `export
// *` re-exports those namespace bindings, but tsc currently fails to
// surface them from the root entry — looks like a packaging issue where
// the .d.ts was generated separately from the runtime bundle. At runtime
// these bindings DO exist (verified via Object.keys(require(...))), so we
// patch the type-only side here.
//
// This file is pure ambient declaration — it does not emit JS — and is
// load-bearing for `tsc --noEmit` until upstream fixes packaging.

declare module "@avalabs/avalanchejs" {
  // Use export-as-namespace bindings so these names work in both value
  // (e.g. `new pvmSerial.L1Validator(...)`) and type positions
  // (`pvmSerial.L1Validator` as a type annotation).
  export * as pvm from "@avalabs/avalanchejs/dist/es/vms/pvm/index.js";
  export * as pvmSerial from "@avalabs/avalanchejs/dist/es/serializable/pvm/index.js";
  export * as Context from "@avalabs/avalanchejs/dist/es/vms/context/index.js";
  export * as secp256k1 from "@avalabs/avalanchejs/dist/es/crypto/secp256k1.js";
  export * as utils from "@avalabs/avalanchejs/dist/es/utils/index.js";
  export * as networkIDs from "@avalabs/avalanchejs/dist/es/constants/networkIDs.js";
  export { addTxSignatures } from "@avalabs/avalanchejs/dist/es/signer/addTxSignatures.js";
}
