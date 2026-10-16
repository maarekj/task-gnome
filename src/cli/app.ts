import { buildApplication, buildCommand, buildRouteMap, help, version } from '@stricli/core';
import pkg from '../../package.json' with { type: 'json' };
import { cancelCommand, historyCommand, logsCommand, openCommand, resumeCommand, runCommand } from './commands/runs.ts';
import { terminalCommand } from './commands/terminal.ts';
import { daemonCommand, installCommand, overviewCommand, statusCommand } from './commands/system.ts';
import { addCommand, disableCommand, editCommand, enableCommand, listCommand, rmCommand, showCommand } from './commands/tasks.ts';
import type { Context } from './shared.ts';
import { buildText } from './text.ts';

const interactiveCommand = buildCommand({
  docs: { brief: 'Mode interactif (menus) — aussi lancé par `taskgnome` sans argument' },
  parameters: {},
  async func(this: Context) {
    const { interactive } = await import('./interactive.ts');
    await interactive();
  },
});

const routes = buildRouteMap({
  routes: {
    add: addCommand,
    edit: editCommand,
    list: listCommand,
    show: showCommand,
    rm: rmCommand,
    enable: enableCommand,
    disable: disableCommand,
    run: runCommand,
    cancel: cancelCommand,
    history: historyCommand,
    logs: logsCommand,
    resume: resumeCommand,
    terminal: terminalCommand,
    open: openCommand,
    status: statusCommand,
    overview: overviewCommand,
    interactive: interactiveCommand,
    daemon: daemonCommand,
    install: installCommand,
  },
  aliases: { ls: 'list', i: 'interactive' },
  docs: {
    brief: 'Planifie des prompts opencode (cron), suit les sessions et notifie dans GNOME',
    fullDescription:
      '<task> = id ou nom de la tâche. Les commandes acceptent --json (sortie machine, pour les scripts et les agents).\n' +
      'Sans argument dans un terminal : mode interactif.',
    hideRoute: { daemon: true, overview: true },
  },
});

/** `json`: Stricli's own errors (unknown command, invalid argument…) are printed as JSON. */
export const buildApp = (json: boolean): ReturnType<typeof buildApplication<Context>> => buildApplication(
  routes,
  {
    name: 'taskgnome',
    scanner: { caseStyle: 'allow-kebab-for-camel' },
    localization: { text: buildText(json) },
    determineExitCode: () => 1,
  },
  {
    help: help({
      brief: 'Affiche l\'aide',
      defaultForRouteMap: true,
      formatting: { caseStyle: 'convert-camel-to-kebab', useAliasInUsageLine: false, onlyRequiredInUsageLine: false },
    }),
    version: version({ brief: 'Affiche la version', info: { currentVersion: pkg.version } }),
  },
);
