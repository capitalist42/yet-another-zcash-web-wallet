import { defineConfig, type Connect, type ViteDevServer, type PreviewServer } from 'vite';
import react from '@vitejs/plugin-react';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
// Ticket #2 spike config. Plan §1: no inlined assets (engine ships WASM, workers,
// proving params as real files). The S4 drill proxy and COOP/COEP headers exist
// only to qualify SUBMISSION_UNKNOWN and the threaded runtime; product config
// will not inherit them.

// S4's hang-proxy upstream. Configured NODE-side (the page cannot see the
// proxy's network), so it MUST be paired with the browser run target:
//   mainnet drill (default):  npm run dev / preview  (page default network=mainnet)
//   testnet drill:            YAW_ENDPOINT=https://zcash-testnet.chainsafe.dev YAW_NETWORK=testnet npm run dev
//                             and open the app with ?network=testnet — the page
//                             asks the proxy (GET /drill/config) and S4 refuses
//                             to broadcast if the two networks disagree.
const ENDPOINT = process.env.YAW_ENDPOINT ?? 'https://zcash-mainnet.chainsafe.dev';
const PROXY_NETWORK = process.env.YAW_NETWORK === 'testnet' ? 'testnet' : 'mainnet';
const HANG_PATH = decodeURIComponent(new URL('drill/HANG', import.meta.url).pathname);
// Spike-only deviation from plan §1 ("no COOP/COEP"): the drill host sends
// isolation headers so `crossOriginIsolated === true` and the engine's
// threaded (SharedArrayBuffer) path is what gets qualified. Product config
// stays COOP/COEP-free (plan §1 / Verification #8); YAW_ISOLATE=0 drops the
// headers to re-qualify the single-threaded path against `vite preview`.
const ISOLATE = process.env.YAW_ISOLATE !== '0';
const COOP_COEP: Record<string, string> = ISOLATE
  ? {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    }
  : {};
const FAUCET_PROXY = {
  // Spike-only: the faucet API answers without CORS headers.
  '/faucet-api': {
    target: 'https://faucet.testnet.valargroup.dev',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/faucet-api/, '/api'),
  },
};

type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;

function toggleMiddleware(): Middleware {
  return (req, res, next) => {
    const toggle = /^\/drill\/(on|off|status)$/.exec(req.url ?? '');
    if (toggle === null) return next();
    if (toggle[1] === 'on') {
      mkdirSync(dirname(HANG_PATH), { recursive: true });
      writeFileSync(HANG_PATH, '1');
    }
    if (toggle[1] === 'off' && existsSync(HANG_PATH)) unlinkSync(HANG_PATH);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ hang: existsSync(HANG_PATH) }));
  };
}

// Local broadcaster endpoint on :8081. Forwards every gRPC-Web call to the real
// lightd endpoint. When drill/HANG exists, SendTransaction has its client socket
// destroyed after the full request arrives (past-the-point-of-return), inducing
// SUBMISSION_UNKNOWN in the engine journal.
function createProxyServer() {
  return createServer((req, res) => {
    // Self-description for the page-side network guard (steps.ts
    // ensureProxyNetwork): the browser cannot know which network this node
    // process fronts; S4 refuses to broadcast on mismatch.
    if ((req.url ?? '').startsWith('/drill/config')) {
      res.setHeader('content-type', 'application/json');
      res.setHeader('access-control-allow-origin', req.headers.origin ?? '*');
      res.end(JSON.stringify({ network: PROXY_NETWORK, endpoint: ENDPOINT }));
      return;
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': req.headers.origin ?? '*',
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': req.headers['access-control-request-headers'] ?? '*',
        'access-control-max-age': '600',
        'access-control-allow-private-network': 'true',
      });
      res.end();
      return;
    }
    res.setHeader('access-control-allow-origin', req.headers.origin ?? '*');
    res.setHeader('access-control-expose-headers', 'grpc-status,grpc-message,grpc-status-bin,grpc-message-bin,trailer');
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      const isSend = (req.url ?? '').includes('SendTransaction');
      if (isSend && existsSync(HANG_PATH)) {
        setTimeout(() => req.destroy(), 50);
        return;
      }
      try {
        const upstream = await fetch(`${ENDPOINT}${req.url}`, {
          method: 'POST',
          headers: { 'content-type': 'application/grpc-web+proto', 'x-grpc-web': '1' },
          body: new Uint8Array(body),
        });
        res.statusCode = upstream.status;
        for (const [k, v] of upstream.headers) res.setHeader(k, v);
        res.end(Buffer.from(await upstream.arrayBuffer()));
      } catch {
        res.statusCode = 502;
        res.end();
      }
    });
  });
}

function hangProxy() {
  const attach = (middlewares: Connect.Server, httpServer: { once(event: 'close', listener: () => void): unknown } | null | undefined) => {
    middlewares.use(toggleMiddleware());
    const proxy = createProxyServer();
    const bind = () => {
      proxy.once('error', (e: { code?: string }) => {
        if (e.code === 'EADDRINUSE') setTimeout(bind, 250);
        else console.error('yaw-s4 proxy:', e);
      });
      proxy.listen(8081, '127.0.0.1');
    };
    bind();
    httpServer?.once('close', () => proxy.close());
  };
  return {
    name: 'yaw-s4-hang-proxy',
    configureServer(server: ViteDevServer) {
      attach(server.middlewares, server.httpServer);
    },
    configurePreviewServer(server: PreviewServer) {
      attach(server.middlewares, server.httpServer);
    },
  };
}

export default defineConfig(() => ({
  plugins: [react(), hangProxy()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    headers: COOP_COEP,
    proxy: FAUCET_PROXY,
  },
  optimizeDeps: {
    // Pre-bundling rewrites the engine's `new URL(asset, import.meta.url)` to
    // paths Vite does not serve; excluded, they resolve against real files.
    exclude: ['@zcashlabs/zcash.js'],
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
    headers: COOP_COEP,
    proxy: FAUCET_PROXY,
  },
  build: {
    target: 'esnext',
    assetsInlineLimit: 0,
  },
}));
