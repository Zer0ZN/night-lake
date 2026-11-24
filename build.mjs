import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const opts = {
  entryPoints: ['src/main.js'],
  bundle: true,
  format: 'esm',
  target: 'es2020',
  outfile: 'dist/app.js',
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(opts);
  await ctx.watch();
  console.log('[watch] building…');
} else {
  const t = Date.now();
  await esbuild.build(opts);
  console.log(`[build] done in ${Date.now() - t}ms`);
}
