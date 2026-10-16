import { buildCommand } from '@stricli/core';
import { readConfig, writeConfig } from '../../config.ts';
import type { TerminalInfo } from '../../shared/api.ts';
import { installedTerminals, KNOWN_TERMINALS, resolveTerminal } from '../../terminal.ts';
import { UsageError } from '../ops.ts';
import { guard, jsonFlag, output, parseString, print, type Context, type JsonFlag } from '../shared.ts';

interface Flags extends JsonFlag {
  readonly set?: string;
  readonly auto: boolean;
}

export function terminalInfo(): TerminalInfo {
  const r = resolveTerminal();
  return {
    current: r.name ?? null,
    source: r.source,
    configured: readConfig().terminal ?? null,
    installed: installedTerminals(),
    known: [...KNOWN_TERMINALS],
  };
}

export const terminalCommand = buildCommand({
  docs: {
    brief: 'Terminal utilisé par « Continuer » (affiche ou change le réglage)',
    fullDescription: 'Ordre de priorité : option --terminal de resume, variable TASKGNOME_TERMINAL, ce réglage, puis le premier terminal connu installé.',
  },
  parameters: {
    flags: {
      set: { kind: 'parsed', parse: parseString, brief: 'Terminal à utiliser (ghostty, kgx, ptyxis…, ou une commande acceptant -e)', placeholder: 'nom', optional: true },
      auto: { kind: 'boolean', brief: 'Revenir au choix automatique', default: false },
      ...jsonFlag,
    },
  },
  async func(this: Context, flags: Flags) {
    await guard(this, flags, () => {
      if (flags.set !== undefined && flags.auto) throw new UsageError('--set et --auto sont incompatibles');
      if (flags.set !== undefined) {
        const name = flags.set.trim();
        if (name === '') throw new UsageError('Nom de terminal vide');
        writeConfig({ ...readConfig(), terminal: name });
      } else if (flags.auto) {
        const { terminal: _removed, ...rest } = readConfig();
        writeConfig(rest);
      }
      const info = terminalInfo();
      output(this, flags, info, () => {
        const why = { option: 'option', env: 'variable TASKGNOME_TERMINAL', config: 'réglage', auto: 'automatique' }[info.source];
        print(this, `Terminal : ${info.current ?? '(aucun trouvé)'} (${why})`);
        print(this, `Installés : ${info.installed.join(', ') || '(aucun connu)'}`);
      });
    });
  },
});
