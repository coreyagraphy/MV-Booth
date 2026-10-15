// Lints the app's js/ with ESLint's API rooted at the repo (a config file in tests/ can't reach ../js).
import js from "@eslint/js";
import { ESLint } from "eslint";
import globals from "globals";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const eslint = new ESLint({
  cwd: root,
  overrideConfigFile: true,
  overrideConfig: [
    js.configs.recommended,
    {
      languageOptions: { ecmaVersion: 2022, sourceType: "module", globals: { ...globals.browser, ...globals.node } },
      rules: { "no-unused-vars": ["error", { varsIgnorePattern: "^_", argsIgnorePattern: "^_" }] },
    },
  ],
});
const results = await eslint.lintFiles(["js/*.js"]);
const problems = results.reduce((n, r) => n + r.errorCount + r.warningCount, 0);
if (problems || results.length < 5) {
  console.log((await eslint.loadFormatter("stylish")).format(results) || `only ${results.length} files linted`);
  process.exit(1);
}
console.log(`lint: ${results.length} files clean`);
