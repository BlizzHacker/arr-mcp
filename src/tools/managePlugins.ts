import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { ServiceError } from '../core/errors.ts';
import { hasPluginManage, type PluginManageCapable, type RomPlugin, type ServiceAdapter } from '../services/types.ts';
import { registerWriteTool, type WriteContext, type WritePlan } from './write.ts';

const adapterOf = (adapters: readonly ServiceAdapter[]): ServiceAdapter & PluginManageCapable => {
    const adapter = adapters.find(hasPluginManage);
    if (adapter === undefined) {
        throw new ServiceError('NotFound', 'romarr', 'ROMarr is not configured', {
            remedy: 'Add services.romarr to config.yaml and restart.'
        });
    }
    return adapter;
};

async function pluginOf(adapters: readonly ServiceAdapter[], slug: string): Promise<RomPlugin> {
    const plugin = (await adapterOf(adapters).listPlugins()).find(row => row.slug === slug);
    if (plugin === undefined) {
        throw new ServiceError('NotFound', 'romarr', `ROM Hub has no plugin with slug "${slug}"`, {
            remedy: 'Call get_plugins and copy the exact slug. Add a third-party catalog in ROM Hub first if it is not listed.'
        });
    }
    return plugin;
}

const ToggleSchema = z.object({
    slug: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Use the exact safe slug returned by get_plugins.'),
    enabled: z.boolean()
});

export function registerSetPluginState(
    server: McpServer,
    context: WriteContext,
    adapters: readonly ServiceAdapter[]
): void {
    registerWriteTool(server, context, {
        name: 'set_plugin_state',
        title: 'Enable or disable a ROM Hub plugin',
        description:
            'Enable or disable one installed ROM Hub plugin. Safe tier because it is reversible; still requires the standard preview, permission and confirmation handshake.',
        inputSchema: ToggleSchema,
        service: 'romarr',
        operation: 'set_plugin_state',
        tier: 'safe',
        async plan(args): Promise<WritePlan> {
            const plugin = await pluginOf(adapters, args.slug);
            const verb = args.enabled ? 'Enable' : 'Disable';
            return {
                target: plugin.slug,
                summary: `${verb} ROM Hub plugin ${plugin.name} (${plugin.slug}).`,
                effects: [`The plugin will be ${args.enabled ? 'available to ROMarr' : 'skipped by ROMarr'}.`],
                args: { enabled: args.enabled },
                noop: plugin.enabled === args.enabled
            };
        },
        async apply(_plan, args) {
            return adapterOf(adapters).setPluginEnabled(args.slug, args.enabled);
        }
    });
}

const InstallationSchema = z.object({
    slug: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Use the exact safe slug returned by get_plugins.'),
    installed: z.boolean()
});

export function registerManagePluginInstallation(
    server: McpServer,
    context: WriteContext,
    adapters: readonly ServiceAdapter[]
): void {
    registerWriteTool(server, context, {
        name: 'manage_plugin_installation',
        title: 'Install or uninstall a ROM Hub plugin',
        description:
            'Install or uninstall one catalogued ROM Hub plugin. Destructive tier: installation executes third-party plugin code under ROM Hub confinement, and uninstall removes its local checkout.',
        inputSchema: InstallationSchema,
        service: 'romarr',
        operation: 'manage_plugin_installation',
        tier: 'destructive',
        async plan(args): Promise<WritePlan> {
            const plugin = await pluginOf(adapters, args.slug);
            const verb = args.installed ? 'Install' : 'Uninstall';
            return {
                target: plugin.slug,
                summary: `${verb} ROM Hub plugin ${plugin.name} (${plugin.slug}).`,
                effects: args.installed
                    ? [
                          `Fetch and execute plugin code from ${plugin.repository ?? 'its configured catalog repository'}.`,
                          `Permit the plugin process to reach only its declared hosts: ${plugin.network.join(', ') || '(none)'}.`
                      ]
                    : ['Remove the installed plugin checkout and make its capabilities unavailable.'],
                args: { installed: args.installed },
                noop: plugin.installed === args.installed
            };
        },
        async apply(_plan, args) {
            return adapterOf(adapters).setPluginInstalled(args.slug, args.installed);
        }
    });
}
