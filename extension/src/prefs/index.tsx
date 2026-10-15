import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import { createRoot, This } from 'gnim';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import { OPEN_REQUEST, takeOpenRequest } from '../common/openRequest.ts';
import { HistoryPage, TasksPage } from './pages.tsx';
import { openRunDialog } from './RunDialog.tsx';

const noop = (): void => undefined;

// GNOME Shell 50 still hands extensions an Adw.PreferencesWindow (deprecated since libadwaita 1.6):
// its API is imposed here.
/* oxlint-disable typescript/no-deprecated */
export default class TaskGnomePrefs extends ExtensionPreferences {
  override fillPreferencesWindow(window: Adw.PreferencesWindow): Promise<void> {
    window.set_default_size(860, 720);
    window.searchEnabled = false;

    let closeRun = noop;
    const openRun = (runId: number): void => {
      closeRun(); // a single run dialog at a time
      closeRun = openRunDialog(window, runId);
    };
    const toast = (title: string): void => {
      window.add_toast(new Adw.Toast({ title, timeout: 4 }));
    };

    createRoot((dispose) => {
      let history: Adw.PreferencesPage | null = null;

      // "open on a run" requests (notification click, panel menu, `taskgnome open <run>`)
      const consume = (): void => {
        const run = takeOpenRequest();
        if (run === null) return;
        if (history !== null) window.visiblePage = history;
        openRun(run);
        window.present();
      };
      const monitor = Gio.File.new_for_path(OPEN_REQUEST).monitor_file(Gio.FileMonitorFlags.NONE, null);
      monitor.connect('changed', (_m: Gio.FileMonitor, _f: Gio.File, _o: Gio.File | null, event: Gio.FileMonitorEvent) => {
        if (event === Gio.FileMonitorEvent.CHANGES_DONE_HINT || event === Gio.FileMonitorEvent.CREATED) consume();
      });

      const root = (
        <This
          this={window}
          onCloseRequest={() => {
            monitor.cancel();
            dispose();
            return false;
          }}
        >
          <TasksPage toast={toast} openRun={openRun} />
          <HistoryPage
            toast={toast}
            openRun={openRun}
            $={(self: Adw.PreferencesPage) => {
              history = self;
            }}
          />
        </This>
      );
      consume();
      return root;
    });
    return Promise.resolve();
  }
}
/* oxlint-enable typescript/no-deprecated */
