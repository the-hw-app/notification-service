/**
 * wrangler turns a relative `.wasm` import into a pre-instantiated
 * `WebAssembly.Module`. The file itself (`src/quickjs.wasm`) is copied in by
 * `scripts/copy-wasm.sh` at build time and is gitignored.
 */
declare module "*.wasm" {
  const wasmModule: WebAssembly.Module;
  export default wasmModule;
}
