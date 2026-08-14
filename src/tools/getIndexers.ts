import type { McpServer } from '@modelcontextprotocol/server';
import { gather } from '../core/gather.ts';
import { logger } from '../core/logger.ts';
import {
    DetailSchema,
    LimitSchema,
    OffsetSchema,
    PagedOutputSchema,
    READ_ONLY,
    applyLimit,
    toolInput,
    type DetailLevel
} from '../core/shape.ts';
import type { IndexerCapable, IndexerRejection, IndexerSummary, ServiceAdapter } from '../services/types.ts';

export type GetIndexersResult = {
    items: IndexerSummary[];
    total: number;
    returned: number;
    offset: number;
    truncated: boolean;
    degraded: string[];
    /** the "recent rejections". Present only at detail: full. */
    recentRejections?: IndexerRejection[];
};

const project = (i: IndexerSummary, detail: DetailLevel): IndexerSummary => {
    if (detail === 'minimal') return { service: i.service, id: i.id, name: i.name, enabled: i.enabled } as IndexerSummary;
    if (detail === 'full') return i;

    const { queries: _q, grabs: _g, rejectedQueries: _rq, rejectedGrabs: _rg, ...rest } = i;
    return rest as IndexerSummary;
};

/** Accepts one adapter for backward-compatible direct callers, while the MCP
 * registration supplies every capable adapter so Prowlarr and ROMarr can be
 * reported together. */
export async function buildGetIndexers(
    input: (ServiceAdapter & IndexerCapable) | readonly (ServiceAdapter & IndexerCapable)[] | undefined,
    opts: { detail: DetailLevel; limit: number; offset?: number }
): Promise<GetIndexersResult> {
    const adapters: readonly (ServiceAdapter & IndexerCapable)[] =
        input === undefined ? [] : Array.isArray(input) ? input : [input];
    if (adapters.length === 0) {
        return { items: [], total: 0, returned: 0, offset: 0, truncated: false, degraded: [] };
    }

    const gathered = await gather(adapters.map(adapter => ({ id: adapter.id, fetch: () => adapter.getIndexers() })));

    let recentRejections: IndexerRejection[] | undefined;
    if (opts.detail === 'full') {
        const settled = await Promise.allSettled(adapters.map(adapter => adapter.getRecentRejections(opts.limit)));
        const fulfilled = settled.filter(result => result.status === 'fulfilled');
        recentRejections = fulfilled.length === 0 ? undefined : settled.flatMap((result, index) => {
            if (result.status === 'fulfilled') return result.value;
            logger.warn({ service: adapters[index]?.id, err: result.reason }, 'rejection history unavailable; omitting');
            return [];
        });
    }

    const shaped = applyLimit(gathered.items, opts.limit, opts.offset);
    return {
        ...shaped,
        items: shaped.items.map(i => project(i, opts.detail)),
        degraded: gathered.degraded,
        ...(recentRejections === undefined ? {} : { recentRejections })
    };
}

export function registerGetIndexers(
    server: McpServer,
    adapters: readonly (ServiceAdapter & IndexerCapable)[]
): void {
    server.registerTool(
        'get_indexers',
        {
            title: 'Indexers and sources',
            annotations: READ_ONLY,
            description:
                'Indexer and plugin-source health across Prowlarr and ROMarr: enabled state, protocol or capability, query/grab counts where supplied, and at detail: full, recent rejections. Upstream text is fenced as untrusted data.',
            outputSchema: PagedOutputSchema,
            inputSchema: toolInput({ detail: DetailSchema, limit: LimitSchema, offset: OffsetSchema })
        },
        async ({ detail, limit, offset }) => {
            const result = await buildGetIndexers(adapters, { detail, limit, offset });
            const disabled = result.items.filter(i => !i.enabled || i.disabledUntil !== undefined).length;
            const summary =
                `${result.returned} of ${result.total} indexer/source(s)` +
                (disabled > 0 ? `, ${disabled} disabled` : '') +
                (result.degraded.length > 0 ? `; ${result.degraded.join(', ')} unreachable.` : '.');

            return { content: [{ type: 'text', text: summary }], structuredContent: result };
        }
    );
}
