import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { DetailSchema, LimitSchema, OffsetSchema, PagedOutputSchema, READ_ONLY, applyLimit, toolInput } from '../core/shape.ts';
import { hasPluginDirectory, type RomPlugin, type ServiceAdapter } from '../services/types.ts';

export type GetPluginsResult = {
    items: RomPlugin[];
    total: number;
    returned: number;
    offset: number;
    truncated: boolean;
    degraded: string[];
};

export async function buildGetPlugins(
    adapters: readonly ServiceAdapter[],
    opts: { installed?: boolean; enabled?: boolean; capability?: string; limit: number; offset?: number }
): Promise<GetPluginsResult> {
    const adapter = adapters.find(hasPluginDirectory);
    if (adapter === undefined) {
        return { items: [], total: 0, returned: 0, offset: opts.offset ?? 0, truncated: false, degraded: [] };
    }
    try {
        const plugins = (await adapter.listPlugins()).filter(plugin => {
            if (opts.installed !== undefined && plugin.installed !== opts.installed) return false;
            if (opts.enabled !== undefined && plugin.enabled !== opts.enabled) return false;
            if (opts.capability !== undefined && !plugin.capabilities.includes(opts.capability)) return false;
            return true;
        });
        const shaped = applyLimit(plugins, opts.limit, opts.offset);
        return { ...shaped, degraded: [] };
    } catch {
        return { items: [], total: 0, returned: 0, offset: opts.offset ?? 0, truncated: false, degraded: [adapter.id] };
    }
}

export function registerGetPlugins(server: McpServer, adapters: readonly ServiceAdapter[]): void {
    server.registerTool(
        'get_plugins',
        {
            title: 'ROM Hub plugins',
            annotations: READ_ONLY,
            description:
                'ROM Hub plugin directory as exposed by ROMarr: catalog slug, repository, author, capabilities, supported platforms, declared network hosts, and installation state. Includes third-party catalogs configured in ROM Hub.',
            outputSchema: PagedOutputSchema,
            inputSchema: toolInput({
                installed: z.boolean().optional(),
                enabled: z.boolean().optional(),
                capability: z.string().min(1).optional().describe('For example search, importer, metadata, stream or cores.'),
                detail: DetailSchema,
                limit: LimitSchema,
                offset: OffsetSchema
            })
        },
        async ({ installed, enabled, capability, limit, offset }) => {
            const result = await buildGetPlugins(adapters, {
                ...(installed === undefined ? {} : { installed }),
                ...(enabled === undefined ? {} : { enabled }),
                ...(capability === undefined ? {} : { capability }),
                limit,
                offset
            });
            const summary =
                result.degraded.length > 0
                    ? 'ROMarr could not be reached; no plugin information is available.'
                    : `${result.returned} of ${result.total} ROM Hub plugin(s).`;
            return { content: [{ type: 'text', text: summary }], structuredContent: result };
        }
    );
}
