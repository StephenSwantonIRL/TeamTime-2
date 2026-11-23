import { fileURLToPath } from 'node:url';
import express from 'express';
import { bookingApi, publicError } from './api/booking-api.js';

const publicDirectory = fileURLToPath(new URL('../public/', import.meta.url));

function rateLimit(maximum) {
  const windowMs = 60_000;
  const counts = new Map();
  let resetAt = 0;
  return (req, res, next) => {
    const now = Date.now();
    if (now >= resetAt) {
      counts.clear();
      resetAt = now + windowMs;
    }
    const count = counts.get(req.ip) ?? 0;
    if (count >= maximum || (!count && counts.size >= 10_000)) {
      res.set('Retry-After', String(Math.ceil((resetAt - now) / 1_000)));
      return res.status(429).json({ code: 'rate_limited', message: 'Too many requests. Try again in a minute.' });
    }
    counts.set(req.ip, count + 1);
    next();
  };
}

export function createApp({ store, demo = false, trustProxyHops = 0, clock = Date.now, invitationService }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', trustProxyHops);

  app.use((_req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    next();
  });
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use('/api', rateLimit(120), bookingApi({ store, demo, clock, invitationService, bookingLimit: rateLimit(12) }));
  app.use('/api', (_req, res) => res.status(404).json({ code: 'not_found', message: 'Resource not found.' }));
  app.use(express.static(publicDirectory));
  app.use(publicError);
  return app;
}
