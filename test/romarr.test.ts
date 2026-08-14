import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { KeyedServiceConfig } from '../src/config/schema.ts';
import { RomarrAdapter } from '../src/services/romarr.ts';
import { buildGetGames } from '../src/tools/getGames.ts';
import { buildGetPlugins } from '../src/tools/getPlugins.ts';
import { jsonResponse, serving } from './helpers/serve.ts';

const fixture = (name: string): unknown =>
    JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'romarr', `${name}.json`), 'utf8'));

const config: KeyedServiceConfig = {
    url: 'http://192.0.2.10:6868',
    api_key: 'k',
    timeout_ms: 10_000,
    permissions: { safe_write: false, destructive: false }
};

const routes = {
    '/api/v1/system/status': fixture('system-status'),
    '/api/v1/game': fixture('game'),
    '/api/v1/queue': fixture('queue'),
    '/api/v1/indexer': fixture('indexer'),
    '/api/v1/hub/plugins': fixture('hub-plugins'),
    '/api/search': fixture('search')
};

describe('RomarrAdapter', () => {
    const adapter = new RomarrAdapter(config, serving(routes));

    it('reads the live-captured ROMarr version and diagnoses a bad key', async () => {
        expect(await adapter.getVersion()).toBe('0.8.0');
        const bad = new RomarrAdapter(config, (async () => jsonResponse({}, 401)) as unknown as typeof fetch);
        expect((await bad.testConnection()).error?.kind).toBe('AuthFailed');
    });

    it('maps captured games, queue rows and live source/plugin inventories', async () => {
        const games = await adapter.listGames({ limit: 5, offset: 0 });
        expect(games.items.length).toBeGreaterThan(0);
        expect(games.items[0]).toMatchObject({ service: 'romarr', id: expect.any(String), platform: expect.any(String) });

        const queue = await adapter.getQueue();
        expect(queue.length).toBeGreaterThan(0);
        expect(queue[0]).toMatchObject({ service: 'romarr', status: expect.any(String) });

        const indexers = await adapter.getIndexers();
        expect(indexers.some(row => row.name.includes('ROM Hub:'))).toBe(true);
        expect(
            (await adapter.listPlugins()).some(row => row.repository?.startsWith('<<untrusted:romarr.plugin.repository>>'))
        ).toBe(true);
    });

    it('searches the owned library and current indexer releases without conflating games with films', async () => {
        const owned = await adapter.search('metroid', 'library');
        expect(owned[0]).toMatchObject({ service: 'romarr', source: 'library', kind: 'item' });

        const releases = await adapter.search('metroid', 'indexers');
        expect(releases[0]).toMatchObject({ service: 'romarr', source: 'indexers', kind: 'release' });
    });

    it('reports unhealthy configured dependencies as fenced health failures', async () => {
        const failures = await adapter.getFailedHealthChecks();
        expect(failures.every(row => row.service === 'romarr')).toBe(true);
    });
});

describe('ROMarr read tools', () => {
    const adapter = new RomarrAdapter(config, serving(routes));

    it('paginates the game library through ROMarr', async () => {
        const result = await buildGetGames([adapter], { query: 'metroid', limit: 5, offset: 0 });
        expect(result.items.length).toBeGreaterThan(0);
        expect(result.degraded).toEqual([]);
    });

    it('filters third-party plugins by capability and installation state', async () => {
        const result = await buildGetPlugins([adapter], { capability: 'search', limit: 50 });
        expect(result.items.length).toBeGreaterThan(0);
        expect(result.items.every(plugin => plugin.capabilities.includes('search'))).toBe(true);
    });
});
