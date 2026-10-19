import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const root = fileURLToPath(new URL("../src/", import.meta.url));
export function loadSource(entry, { modules = {}, globals = {} } = {}) {
  const cache = new Map();
  function load(path) {
    if (cache.has(path)) return cache.get(path);
    const exports = {};
    cache.set(path, exports);
    const { outputText } = ts.transpileModule(readFileSync(path, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }
    });
    runInNewContext(outputText, {
      exports, ...globals,
      require(name) {
        if (name in modules) return modules[name];
        if (name.startsWith(".")) {
          const target = resolve(dirname(path), name);
          return load(existsSync(target + ".ts") ? target + ".ts" : target + ".tsx");
        }
        throw new Error(`Unexpected module ${name}`);
      }
    });
    return exports;
  }
  return load(resolve(root, entry));
}
