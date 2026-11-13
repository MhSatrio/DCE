#!/usr/bin/env node
/**
 * Stand-alone relay for the browser build:   npm run relay   →   http://127.0.0.1:8788
 * (The desktop app starts the same relay by itself — you do not need this there.)
 */
import { createRequire } from 'node:module';
const { createRelay } = createRequire(import.meta.url)('./relay-core.cjs');

const PORT = Number(process.env.RELAY_PORT ?? 8788);
const upstream = process.env.BUFFER_UPSTREAM ?? 'https://api.buffer.com'; // override only for tests
const origins = (process.env.RELAY_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);

// DCE_TEST_ALLOW_PRIVATE=1 lets /fetch read a mock site on 127.0.0.1 — used by the automated tests only.
export const server = createRelay({ upstream, origins, allowPrivateFetch: process.env.DCE_TEST_ALLOW_PRIVATE === '1' });
server.listen(PORT, '127.0.0.1', () => console.log(`DCE relay listening on http://127.0.0.1:${PORT}  →  ${new URL(upstream).origin}`));
