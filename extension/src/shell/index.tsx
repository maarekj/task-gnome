import { createRoot } from 'gnim';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import { Indicator } from './Indicator.tsx';

export default class TaskGnomeExtension extends Extension {
  private dispose: (() => void) | null = null;

  override enable(): void {
    createRoot((dispose) => {
      this.dispose = dispose;
      return new Indicator(this);
    });
  }

  override disable(): void {
    this.dispose?.();
    this.dispose = null;
  }
}
