// French texts for Stricli (help + errors), with an optional JSON mode for `--json`.
import {
  ArgumentScannerError, formatMessageForArgumentScannerError, text_en, type ApplicationText,
} from '@stricli/core';
import { errorMessage } from '../util.ts';

const quote = (s: string): string => `« ${s.replaceAll('`', '')} »`;
const flag = (name: string): string => (name.startsWith('-') ? name : `--${name}`);

/** French message for an argument scanning error. */
export function scannerMessage(error: unknown): string {
  if (!(error instanceof ArgumentScannerError)) return errorMessage(error);
  return formatMessageForArgumentScannerError(error, {
    // our input parsers already throw readable French messages (task not found, invalid cron…)
    ArgumentParseError: (e) => {
      const msg = errorMessage(e.exception);
      // messages that already name what is wrong (task, cron, folder…) are kept as is
      return /introuvable|invalide|inexistant/iu.test(msg) ? msg : `${flag(e.externalFlagNameOrPlaceholder)} : ${msg}`;
    },
    FlagNotFoundError: (e) =>
      `Option inconnue ${quote(flag(e.input))}${e.corrections.length > 0 ? `, vouliez-vous dire ${e.corrections.map((c) => quote(flag(c))).join(' ou ')} ?` : ''}`,
    AliasNotFoundError: (e) => `Option courte inconnue ${quote(`-${e.input}`)}`,
    EnumValidationError: (e) => `Valeur ${quote(e.input)} invalide pour ${flag(e.externalFlagName)} (valeurs possibles : ${e.values.join(', ')})`,
    UnsatisfiedFlagError: (e) => `Option requise manquante : ${flag(e.externalFlagName)}`,
    UnexpectedFlagError: (e) => `Option ${flag(e.externalFlagName)} donnée plusieurs fois (${quote(e.previousInput)} puis ${quote(e.input)})`,
    InvalidNegatedFlagSyntaxError: (e) => `L'option ${flag(e.externalFlagName)} n'accepte pas de valeur (${quote(e.valueText)})`,
    UnexpectedPositionalError: (e) => `Argument en trop : ${quote(e.input)} (${e.expectedCount} attendu${e.expectedCount > 1 ? 's' : ''})`,
    UnsatisfiedPositionalError: (e) => `Argument requis manquant : <${e.placeholder}>`,
  });
}

/**
 * Stricli texts. With `json`, error messages are bare (main.ts collects them into one
 * `{"ok":false,"error":…}` line on stdout, the shape used by the commands themselves).
 */
export function buildText(json: boolean): ApplicationText {
  const fmt = (message: string): string => (json ? message : `Erreur: ${message}`);
  return {
    ...text_en,
    headers: { usage: 'USAGE', aliases: 'ALIAS', commands: 'COMMANDES', flags: 'OPTIONS', arguments: 'ARGUMENTS' },
    keywords: { default: 'défaut =', separator: 'séparateur =' },
    briefs: {
      help: "Affiche l'aide",
      helpAll: "Affiche l'aide (y compris les commandes et options cachées)",
      version: 'Affiche la version',
      argumentEscapeSequence: 'Tout ce qui suit est traité comme des arguments',
    },
    noCommandRegisteredForInput: ({ input, corrections }) =>
      fmt(`Commande inconnue ${quote(input)}${corrections.length > 0 ? `, vouliez-vous dire ${corrections.map((c) => quote(c)).join(' ou ')} ?` : ''}`),
    exceptionWhileParsingArguments: (exc) => fmt(scannerMessage(exc)),
    exceptionWhileRunningCommand: (exc) => fmt(errorMessage(exc)),
    commandErrorResult: (err) => fmt(err.message),
  };
}
