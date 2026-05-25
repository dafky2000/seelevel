import * as esbuild from "npm:esbuild@0.24";
import { denoPlugins } from "jsr:@luca/esbuild-deno-loader@0.11";
import { join } from "jsr:@std/path@1";

const dir = new URL(".", import.meta.url).pathname;
const manifest = JSON.parse(await Deno.readTextFile(join(dir, "manifest.json")));
const version = manifest.version as string;

// Plugin: resolve CSS imports from npm packages as plain text strings.
// deno-loader intercepts npm: specifiers before esbuild's native loader can
// apply `loader: { ".css": "text" }`, so we handle CSS explicitly here.
// We map bare npm specifiers to their location in the Deno npm cache:
//   leaflet/dist/leaflet.css → $DENO_DIR/npm/registry.npmjs.org/leaflet/<ver>/dist/leaflet.css
const npmCssPlugin: esbuild.Plugin = {
  name: "npm-css-text",
  setup(build) {
    // Intercept bare npm specifiers ending in .css (skip relative/absolute paths)
    build.onResolve({ filter: /\.css$/ }, (args) => {
      if (args.path.startsWith(".") || args.path.startsWith("/")) return null;
      return { path: args.path, namespace: "npm-css" };
    });

    build.onLoad({ filter: /.*/, namespace: "npm-css" }, async (args) => {
      const specifier = args.path;
      // Parse "pkg/path/to/file.css" or "@scope/pkg/path/to/file.css"
      let pkgName: string;
      let subPath: string;
      if (specifier.startsWith("@")) {
        const parts = specifier.split("/");
        pkgName = parts[0] + "/" + parts[1];
        subPath = parts.slice(2).join("/");
      } else {
        const parts = specifier.split("/");
        pkgName = parts[0];
        subPath = parts.slice(1).join("/");
      }

      // Find the installed version in the npm cache
      const denoDir = Deno.env.get("DENO_DIR") ?? join(Deno.env.get("HOME") ?? "", ".cache", "deno");
      const pkgCacheDir = join(denoDir, "npm", "registry.npmjs.org", pkgName);
      let version: string | undefined;
      try {
        for await (const entry of Deno.readDir(pkgCacheDir)) {
          if (entry.isDirectory) { version = entry.name; break; }
        }
      } catch {
        return { errors: [{ text: `Cannot find npm cache for: ${pkgName}` }] };
      }

      if (!version) return { errors: [{ text: `No version found for: ${pkgName}` }] };

      const cssPath = join(pkgCacheDir, version, subPath);
      try {
        const contents = await Deno.readTextFile(cssPath);
        return { contents, loader: "text" };
      } catch {
        return { errors: [{ text: `Cannot read CSS: ${cssPath}` }] };
      }
    });
  },
};

// --package implies a production build, then zips build/ for the Web Store.
const isPackage = Deno.args.includes("--package");
const isProd = isPackage || Deno.args.includes("--prod");

const shared: esbuild.BuildOptions = {
  bundle: true,
  minify: isProd,
  sourcemap: isProd ? false : "inline",
  plugins: [npmCssPlugin, ...denoPlugins({ configPath: join(dir, "deno.json") })],
  loader: { ".css": "text" },
};

await Promise.all([
  esbuild.build({
    ...shared,
    entryPoints: [join(dir, "src/content/fetch-interceptor.ts")],
    outfile: join(dir, "build/content/fetch-interceptor.js"),
    format: "iife",
  }),
  esbuild.build({
    ...shared,
    entryPoints: [join(dir, "src/content/relay.ts")],
    outfile: join(dir, "build/content/relay.js"),
    format: "iife",
  }),
  esbuild.build({
    ...shared,
    entryPoints: [join(dir, "src/background/sw.ts")],
    outfile: join(dir, "build/background/sw.js"),
    format: "esm",
  }),
  esbuild.build({
    ...shared,
    entryPoints: [join(dir, "src/panel/App.tsx")],
    outfile: join(dir, "build/panel/panel.js"),
    format: "iife",
    jsx: "automatic",
    jsxImportSource: "preact",
    define: { __EXT_VERSION__: JSON.stringify(version) },
  }),
]);

// Ensure output directories exist
await Deno.mkdir(join(dir, "build/panel"), { recursive: true });
await Deno.mkdir(join(dir, "build/icons"), { recursive: true });

// Copy static panel files
await Deno.copyFile(join(dir, "src/panel/index.html"), join(dir, "build/panel/index.html"));
await Deno.copyFile(join(dir, "src/panel/panel.css"), join(dir, "build/panel/panel.css"));

// Copy icons
for (const size of [16, 48, 128]) {
  await Deno.copyFile(join(dir, `icons/icon${size}.png`), join(dir, `build/icons/icon${size}.png`));
}

// Copy manifest
await Deno.copyFile(join(dir, "manifest.json"), join(dir, "build/manifest.json"));

await esbuild.stop();

// Lodash (pulled in transitively by Geoman) ships a `Function("return this")()`
// globalThis polyfill. The string is bundled, so it isn't "remote code", but
// the `Function(...)` constructor trips Chrome Web Store's automated CSP
// scanners and would also throw a CSP violation if it ever executed under
// MV3's default `script-src 'self'`. The path is dead in practice - the
// surrounding `||` short-circuit picks `self`/`global` first - so swapping
// it for a direct `globalThis` reference is behaviour-preserving.
const FUNCTION_RETURN_THIS = /Function\(["']return this["']\)\(\)/g;
for (
  const rel of [
    "build/content/fetch-interceptor.js",
    "build/content/relay.js",
    "build/background/sw.js",
    "build/panel/panel.js",
  ]
) {
  const path = join(dir, rel);
  const original = await Deno.readTextFile(path);
  const stripped = original.replace(FUNCTION_RETURN_THIS, "globalThis");
  if (stripped !== original) await Deno.writeTextFile(path, stripped);
}

console.log(`Build complete${isProd ? " (production)" : ""}.`);

// ─── Package for the Chrome Web Store ─────────────────────────────────────────
// Zip the *contents* of build/ (manifest.json at the zip root, as the store
// requires). Google signs the upload - no local signing/.crx involved.
if (isPackage) {
  const zipName = `seelevel-${version}.zip`;
  const zipPath = join(dir, zipName);
  await Deno.remove(zipPath).catch(() => {}); // zip appends; start fresh
  const zip = new Deno.Command("zip", {
    args: ["-r", "-X", "-q", zipPath, "."],
    cwd: join(dir, "build"),
  });
  const { code, stderr } = await zip.output();
  if (code !== 0) {
    console.error(new TextDecoder().decode(stderr));
    throw new Error(`zip failed (exit ${code}) - is the 'zip' CLI installed?`);
  }
  const { size } = await Deno.stat(zipPath);
  console.log(`Packaged ${zipName} (${(size / 1024).toFixed(0)} KB) - upload this to the Web Store.`);
}
