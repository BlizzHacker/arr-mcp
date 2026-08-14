import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { DetailSchema, LimitSchema, OffsetSchema, PagedOutputSchema, READ_ONLY, toolInput } from '../core/shape.ts';
import { hasGameLibrary, type GameSummary, type ServiceAdapter } from '../services/types.ts';

export type GetGamesResult = {
    items: GameSummary[];
    total: number;
    returned: number;
    offset: number;
    truncated: boolean;
    degraded: string[];
};

export async function buildGetGames(
    adapters: readonly ServiceAdapter[],
    opts: { query?: string; platform?: string; genre?: string; limit: number; offset?: number }
): Promise<GetGamesResult> {
    const adapter = adapters.find(hasGameLibrary);
    const offset = opts.offset ?? 0;
    if (adapter === undefined) {
        return { items: [], total: 0, returned: 0, offset, truncated: false, degraded: [] };
    }

    try {
        const page = await adapter.listGames({
            ...(opts.query === undefined ? {} : { query: opts.query }),
            ...(opts.platform === undefined ? {} : { platform: opts.platform }),
            ...(opts.genre === undefined ? {} : { genre: opts.genre }),
            limit: opts.limit,
            offset
        });
        return {
            items: page.items,
            total: page.total,
            returned: page.items.length,
            offset,
            truncated: offset + page.items.length < page.total,
            degraded: []
        };
    } catch {
        return { items: [], total: 0, returned: 0, offset, truncated: false, degraded: [adapter.id] };
    }
}

export function registerGetGames(server: McpServer, adapters: readonly ServiceAdapter[]): void {
    server.registerTool(
        'get_games',
        {
            title: 'Game library',
            annotations: READ_ONLY,
            description:
                'Browse the ROMarr game library with server-side title, platform and genre filters. This is deliberately separate from get_library: games have no Jellyfin presence half, so treating them as films would fabricate broken-import warnings.',
            outputSchema: PagedOutputSchema,
            inputSchema: toolInput({
                query: z.string().min(1).optional().describe('Title text to search for.'),
                platform: z.string().min(1).optional().describe('ROMarr platform name or slug.'),
                genre: z.string().min(1).optional(),
                detail: DetailSchema,
                limit: LimitSchema,
                offset: OffsetSchema
            })
        },
        async ({ query, platform, genre, limit, offset }) => {
            const result = await buildGetGames(adapters, {
                ...(query === undefined ? {} : { query }),
                ...(platform === undefined ? {} : { platform }),
                ...(genre === undefined ? {} : { genre }),
                limit,
                offset
            });
            const summary =
                result.degraded.length > 0
                    ? 'ROMarr could not be reached; no game information is available.'
                    : `${result.returned} of ${result.total} game(s).`;
            return { content: [{ type: 'text', text: summary }], structuredContent: result };
        }
    );
}
