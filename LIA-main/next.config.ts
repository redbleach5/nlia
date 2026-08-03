import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  // Указываем workspace root явно — иначе Next.js warns:
  // "We detected multiple lockfiles and selected the directory of /Users/ruslan/bun.lock as the root directory"
  // Это происходит, когда у пользователя в родительских директориях лежат чужие bun.lock
  // (например ~/bun.lock). Указывая __dirname, говорим Next: "наш проект — здесь".
  outputFileTracingRoot: path.resolve(__dirname),
  serverExternalPackages: [
    'better-sqlite3',
    'sqlite-vec',
    'pino',
    'pino-pretty',
    // KB Phase 7: native/dynamic dependencies
    'pdf-parse',
    'mammoth',
    'jsdom',
    'chokidar',
    // re2 is a native C++ addon (Node via node-gyp). Turbopack can't bundle
    // .node assets into ESM chunks — "non-ecmascript placeable asset" error.
    // Marking it external lets Node load it via require() at runtime, exactly
    // what src/lib/agent/tools.ts does with `createRequire(import.meta.url)('re2')`.
    're2',
  ],
  // VRM models can be up to 50MB — allow large uploads
  experimental: {
    serverActions: {
      bodySizeLimit: '50mb',
    },
    // Next.js 16 proxy (formerly middleware) clones the request body for
    // potential re-reading. Default limit is 10MB — anything bigger gets
    // truncated, which breaks `req.formData()` in the upload-vrm route
    // (TypeError: Failed to parse body as FormData).
    // В Next.js 16 эта опция ЭКСПЕРИМЕНТАЛЬНАЯ — должна быть внутри experimental.
    // Старое имя `middlewareClientMaxBodySize` deprecated.
    proxyClientMaxBodySize: '50mb',
  },
};

export default nextConfig;
