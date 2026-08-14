import type { KeyedServiceConfig, ServiceId } from '../config/schema.ts';
import { apiKeyHeader } from '../core/auth.ts';
import { ServiceError } from '../core/errors.ts';
import { fenceText } from '../core/fence.ts';
import { ServiceHttp } from '../core/http.ts';
import {
    diagnoseConnection,
    type ConnectionDiagnosis,
    type GameLibraryCapable,
    type GameSummary,
    type HealthCheck,
    type HealthCheckCapable,
    type IndexerCapable,
    type IndexerRejection,
    type IndexerSummary,
    type PluginManageCapable,
    type QueueCapable,
    type QueueItem,
    type RomPlugin,
    type SearchCapable,
    type SearchHit,
    type SearchSource,
    type ServiceAdapter
} from './types.ts';

type RawStatus = {
    version?: string;
    clients?: { id?: string; name?: string; protocol?: string; configured?: boolean; ok?: boolean; detail?: string }[];
    libraries?: { id?: string; name?: string; type?: string; ok?: boolean; readable?: boolean; detail?: string }[];
    ggrequestz?: { configured?: boolean; ok?: boolean };
};

type RawGame = {
    id?: string;
    name?: string;
    platform?: string;
    year?: number;
    rating?: number;
    genres?: string[];
    source?: string;
    origin?: string;
    extension?: string;
};

type RawGames = { items?: RawGame[]; total?: number; grand_total?: number };
type RawQueue = { items?: { game?: string; platform?: string; release?: string; state?: string; detail?: string; at?: string }[] };
type RawIndexer = { id?: string; name?: string; type?: string; protocol?: string; enable?: boolean };
type RawIndexers = { items?: RawIndexer[]; proxied?: RawIndexer[] };
type RawPlugin = {
    slug?: string;
    name?: string;
    author?: string;
    version?: string;
    repository?: string;
    description?: string;
    capabilities?: string[];
    platforms?: string[];
    network?: string[];
    key_required?: boolean;
    installed?: boolean;
    enabled?: boolean;
};
type RawPlugins = { items?: RawPlugin[] };
type RawSearch = {
    top?: { title?: string; score?: number; seeders?: number; indexer?: string }[];
};

/** Stable positive integer for the numeric id the shared indexer shape uses. */
function numericId(value: string): number {
    let hash = 2166136261;
    for (const char of value) {
        hash ^= char.charCodeAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

/** Preserve machine-useful identifiers while fencing anything capable of
 * carrying prose. ROMarr catalog metadata can come from third-party authors. */
function safeToken(value: string, field: string): string {
    return /^[A-Za-z0-9][A-Za-z0-9._:+/@-]*$/.test(value)
        ? value
        : fenceText(value, { service: 'romarr', field });
}

export class RomarrAdapter
    implements
        ServiceAdapter,
        HealthCheckCapable,
        QueueCapable,
        IndexerCapable,
        SearchCapable,
        GameLibraryCapable,
        PluginManageCapable
{
    readonly id = 'romarr';
    readonly type: ServiceId = 'romarr';
    readonly #http: ServiceHttp;

    constructor(config: KeyedServiceConfig, fetchImpl: typeof fetch = fetch) {
        this.#http = new ServiceHttp(this.id, config, apiKeyHeader('X-Api-Key', config.api_key), fetchImpl);
    }

    async getVersion(): Promise<string> {
        const status = await this.#http.get<RawStatus>('/api/v1/system/status');
        if (!status.version) throw new ServiceError('UpstreamError', this.id, 'system/status returned no version field');
        return status.version;
    }

    async testConnection(): Promise<ConnectionDiagnosis> {
        return diagnoseConnection(this.id, this.type, () => this.getVersion());
    }

    async getFailedHealthChecks(): Promise<HealthCheck[]> {
        const status = await this.#http.get<RawStatus>('/api/v1/system/status');
        const failures: HealthCheck[] = [];
        for (const client of status.clients ?? []) {
            if (client.configured !== false && client.ok !== true) {
                failures.push({
                    service: this.id,
                    source: client.name ?? client.id ?? 'download client',
                    type: 'error',
                    message: fenceText(client.detail || 'configured client is unreachable', {
                        service: this.id,
                        field: 'client.detail'
                    })
                });
            }
        }
        for (const library of status.libraries ?? []) {
            if (library.ok !== true || library.readable === false) {
                failures.push({
                    service: this.id,
                    source: library.name ?? library.id ?? library.type ?? 'game library',
                    type: 'error',
                    message: fenceText(library.detail || 'library is not readable', {
                        service: this.id,
                        field: 'library.detail'
                    })
                });
            }
        }
        if (status.ggrequestz?.configured === true && status.ggrequestz.ok !== true) {
            failures.push({
                service: this.id,
                source: 'ggrequestz',
                type: 'warning',
                message: 'GG Requestz is configured but unreachable'
            });
        }
        return failures;
    }

    async getQueue(): Promise<QueueItem[]> {
        const body = await this.#http.get<RawQueue>('/api/v1/queue');
        return (body.items ?? []).map((row, index) => ({
            service: this.id,
            id: `${row.at ?? 'queue'}:${index}`,
            title: fenceText(row.release || row.game || '', { service: this.id, field: 'queue.title' }),
            status: row.state ?? 'unknown',
            ...(row.detail
                ? { errorMessage: fenceText(row.detail, { service: this.id, field: 'queue.detail' }) }
                : {})
        }));
    }

    async listGames(opts: {
        query?: string;
        platform?: string;
        genre?: string;
        limit: number;
        offset: number;
    }): Promise<{ items: GameSummary[]; total: number }> {
        const query = new URLSearchParams({ limit: String(opts.limit), offset: String(opts.offset) });
        if (opts.query) query.set('q', opts.query);
        if (opts.platform) query.set('platform', opts.platform);
        if (opts.genre) query.set('genre', opts.genre);
        const body = await this.#http.get<RawGames>(`/api/v1/game?${query}`);
        return {
            total: body.total ?? body.grand_total ?? body.items?.length ?? 0,
            items: (body.items ?? []).map(row => this.#toGame(row))
        };
    }

    #toGame(row: RawGame): GameSummary {
        return {
            service: this.id,
            id: row.id ?? '',
            title: fenceText(row.name ?? '', { service: this.id, field: 'game.name' }),
            platform: fenceText(row.platform ?? '', { service: this.id, field: 'game.platform' }),
            ...(row.year === undefined ? {} : { year: row.year }),
            ...(row.rating === undefined ? {} : { rating: row.rating }),
            ...(row.genres === undefined
                ? {}
                : { genres: row.genres.map(genre => fenceText(genre, { service: this.id, field: 'game.genre' })) }),
            ...(row.source === undefined ? {} : { source: safeToken(row.source, 'game.source') }),
            ...(row.origin === undefined ? {} : { origin: safeToken(row.origin, 'game.origin') }),
            ...(row.extension === undefined ? {} : { extension: safeToken(row.extension, 'game.extension') })
        };
    }

    async search(query: string, source: SearchSource): Promise<SearchHit[]> {
        if (source === 'library') {
            const games = await this.listGames({ query, limit: 50, offset: 0 });
            return games.items.map(game => ({
                service: this.id,
                source,
                kind: 'item',
                id: game.id,
                title: game.title,
                ...(game.year === undefined ? {} : { year: game.year }),
                ids: {},
                ...(game.rating === undefined ? {} : { ratings: { romarr: game.rating } })
            }));
        }
        if (source !== 'indexers') return [];

        const body = await this.#http.get<RawSearch>(`/api/search?game=${encodeURIComponent(query)}`);
        return (body.top ?? []).map((row, index) => ({
            service: this.id,
            source,
            kind: 'release',
            id: `${index}`,
            title: fenceText(row.title ?? '', { service: this.id, field: 'release.title' }),
            ids: {},
            ...(row.indexer === undefined
                ? {}
                : { indexer: fenceText(row.indexer, { service: this.id, field: 'release.indexer' }) }),
            ...(row.seeders === undefined ? {} : { seeders: row.seeders })
        }));
    }

    async getIndexers(): Promise<IndexerSummary[]> {
        const [indexers, plugins] = await Promise.all([
            this.#http.get<RawIndexers>('/api/v1/indexer'),
            this.#http.get<RawPlugins>('/api/v1/hub/plugins')
        ]);
        const configured = [...(indexers.items ?? []), ...(indexers.proxied ?? [])].map((row, index) => ({
            service: this.id,
            id: numericId(row.id ?? row.name ?? `indexer-${index}`),
            name: fenceText(row.name ?? row.id ?? 'indexer', { service: this.id, field: 'indexer.name' }),
            enabled: row.enable ?? false,
            protocol: row.protocol ?? row.type ?? 'unknown',
            priority: 0
        }));
        const hub = (plugins.items ?? []).map((row, index) => ({
            service: this.id,
            id: numericId(`hub:${row.slug ?? index}`),
            name: fenceText(`ROM Hub: ${row.name ?? row.slug ?? 'plugin'}`, {
                service: this.id,
                field: 'plugin.name'
            }),
            enabled: row.enabled ?? false,
            protocol: (row.capabilities ?? []).join(',') || 'plugin',
            priority: 0
        }));
        return [...configured, ...hub];
    }

    async getRecentRejections(_limit: number): Promise<IndexerRejection[]> {
        return [];
    }

    async listPlugins(): Promise<RomPlugin[]> {
        const body = await this.#http.get<RawPlugins>('/api/v1/hub/plugins');
        return (body.items ?? []).map(row => ({
            service: this.id,
            slug: row.slug ?? '',
            name: fenceText(row.name ?? row.slug ?? '', { service: this.id, field: 'plugin.name' }),
            ...(row.author === undefined
                ? {}
                : { author: fenceText(row.author, { service: this.id, field: 'plugin.author' }) }),
            ...(row.version === undefined ? {} : { version: safeToken(row.version, 'plugin.version') }),
            ...(row.repository === undefined
                ? {}
                : { repository: fenceText(row.repository, { service: this.id, field: 'plugin.repository' }) }),
            ...(row.description === undefined
                ? {}
                : { description: fenceText(row.description, { service: this.id, field: 'plugin.description' }) }),
            capabilities: (row.capabilities ?? []).map(value => safeToken(value, 'plugin.capability')),
            platforms: (row.platforms ?? []).map(value => safeToken(value, 'plugin.platform')),
            network: (row.network ?? []).map(value => safeToken(value, 'plugin.network')),
            keyRequired: row.key_required ?? false,
            installed: row.installed ?? false,
            enabled: row.enabled ?? false
        }));
    }

    async setPluginEnabled(slug: string, enabled: boolean): Promise<unknown> {
        return this.#http.post('/api/v1/hub/plugin', { slug, action: enabled ? 'enable' : 'disable' });
    }

    async setPluginInstalled(slug: string, installed: boolean): Promise<unknown> {
        return this.#http.post('/api/v1/hub/plugin', { slug, action: installed ? 'install' : 'uninstall' });
    }
}
