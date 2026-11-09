// Preload that makes this process look like a Windows host: `node:path` resolves to path.win32 and
// process.platform is 'win32'. Lets the suite catch host-path assumptions on Linux and macOS CI.
// Usage (Node >=20.6 for module.register): node --import ./test/win32-host.mjs --test test/*.test.mjs
import { register } from 'node:module';

const shim = 'data:text/javascript,' + encodeURIComponent(
  "import p from 'node:path?real';const w=p.win32;export default w;" +
  'export const {basename,delimiter,dirname,extname,format,isAbsolute,join,normalize,parse,posix,relative,resolve,sep,toNamespacedPath,win32}=w;',
);
const hooks = 'data:text/javascript,' + encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  if (spec === 'node:path?real') return { url: 'node:path', shortCircuit: true };
  if (spec === 'node:path' || spec === 'path') return { url: ${JSON.stringify(shim)}, shortCircuit: true };
  return next(spec, ctx);
}`);
register(hooks);
Object.defineProperty(process, 'platform', { value: 'win32' });
