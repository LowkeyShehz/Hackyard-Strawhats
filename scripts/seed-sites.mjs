#!/usr/bin/env node
/**
 * Nirman Mitra — seed work sites through the admin API.
 *
 * Usage:
 *   node scripts/seed-sites.mjs <API_BASE_URL> <ACCESS_TOKEN> [sites.json]
 *   API_URL=https://xxxx.execute-api.ap-south-1.amazonaws.com/prod ADMIN_TOKEN=eyJ... node scripts/seed-sites.mjs
 *
 * ACCESS_TOKEN is an admin/super_admin access token (the accessToken from POST /api/auth/login).
 * The sites file defaults to data/sites.seed.json; each entry is POSTed to /api/admin/sites,
 * which creates the site or updates it when site_id already exists.
 */
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import path from 'path';

const [argUrl, argToken, argFile] = process.argv.slice(2);
const apiUrl = (argUrl || process.env.API_URL || '').replace(/\/+$/, '');
const token = argToken || process.env.ADMIN_TOKEN || '';
const file = argFile || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'sites.seed.json');

if (!apiUrl || !token) {
  console.error('Usage: node scripts/seed-sites.mjs <API_BASE_URL> <ACCESS_TOKEN> [sites.json]');
  process.exit(1);
}

const { sites } = JSON.parse(await readFile(file, 'utf8'));
let failed = 0;

for (const entry of sites) {
  const site = Object.fromEntries(Object.entries(entry).filter(([k]) => !k.startsWith('_')));
  const res = await fetch(`${apiUrl}/api/admin/sites`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(site),
  });
  const body = await res.json().catch(() => ({}));
  if (res.ok) {
    console.log(`${body.created ? 'created' : 'updated'} ${body.site?.site_id} (${body.site?.name})`);
  } else {
    failed++;
    console.error(`failed ${site.site_id || site.name}: HTTP ${res.status} ${body.error || ''}`);
  }
}

process.exit(failed ? 1 : 0);
