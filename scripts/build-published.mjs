// Genera una versión del dashboard en UN solo archivo HTML (CSS y JS en línea),
// apta para publicarse como página estática o artifact. Uso: npm run build:published
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const out = 'dist-published';
execSync(`npx vite build --mode published --outDir ${out} --emptyOutDir`, { stdio: 'inherit' });
const assets = join(out, 'assets');
const files = readdirSync(assets);
const css = files.filter((f) => f.endsWith('.css')).map((f) => readFileSync(join(assets, f), 'utf8')).join('\n');
const js = files.filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(assets, f), 'utf8')).join('\n');
// Evita cerrar la etiqueta <script> antes de tiempo.
const safeJs = js.replace(/<\/script/gi, '<\\/script');
const html = `<title>HidroTwin</title>
<style>
${css}
</style>
<div id="root"></div>
<script type="module">
${safeJs}
</script>
`;
writeFileSync(join(out, 'hidrotwin.html'), html);
console.log(`OK: ${join(out, 'hidrotwin.html')} (${(html.length / 1024).toFixed(0)} KB)`);
