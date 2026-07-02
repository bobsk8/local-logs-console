// Bundles the webview (src/webview-src/) into media/. The extension host is
// compiled separately by tsc; type-checking for the webview happens via
// `tsc -p tsconfig.webview.json` (esbuild does not check types).
import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const jsOptions = {
    entryPoints: { webview: 'src/webview-src/main.ts' },
    bundle: true,
    outdir: 'media',
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    sourcemap: production ? false : 'inline',
    minify: production,
    logLevel: 'info'
};

/** @type {import('esbuild').BuildOptions} */
const cssOptions = {
    entryPoints: { webview: 'src/webview-src/style.css' },
    bundle: true,
    outdir: 'media',
    minify: production,
    logLevel: 'info'
};

if (watch) {
    const [jsCtx, cssCtx] = await Promise.all([esbuild.context(jsOptions), esbuild.context(cssOptions)]);
    await Promise.all([jsCtx.watch(), cssCtx.watch()]);
    console.log('[esbuild] watching src/webview-src/ → media/');
} else {
    await Promise.all([esbuild.build(jsOptions), esbuild.build(cssOptions)]);
}
