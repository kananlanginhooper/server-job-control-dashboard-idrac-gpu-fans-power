import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { BoardLayout } from '../../core/layout/board-layout';

/**
 * Saved views, at the left of the header (owner 2026-11-06): switch between them in one click; "Layout" drops down
 * the rest. Views are kept in this browser only. Each view's Copy gives its text, to share it or to hand back as the
 * new default; Load takes such a text as a view.
 */
@Component({
  selector: 'app-views-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown.escape)': 'open.set(false)' },
  template: `
    <div class="seg views" role="group" aria-label="Saved views">
      @for (n of layout.names(); track n) {
        <button
          type="button"
          [attr.aria-pressed]="n === layout.active()"
          (click)="layout.select(n)"
        >
          {{ n }}
        </button>
      }
    </div>
    <button type="button" class="dx views-edit" [attr.aria-expanded]="open()" (click)="toggle()">
      Layout {{ open() ? '▴' : '▾' }}
    </button>
    @if (open()) {
      <div class="views-panel" role="dialog" aria-label="Layout">
        <p class="sub">
          @if (layout.stacked()) {
            Phone width: the cards stack in one column and don't move.
          } @else {
            Drag a card by its top edge (the dotted grip); resize it from its right edge or
            lower-right corner. A resized card keeps its height (at most the window's); the others
            fit their content.
          }
          Views are saved in this browser only.
        </p>
        <div class="views-line">
          <input
            type="text"
            aria-label="View name"
            [value]="name()"
            (input)="name.set($any($event.target).value)"
          />
          <button type="button" class="dx" (click)="saveAs()">Save as new view</button>
          <button type="button" class="dx" [disabled]="!canRename()" (click)="rename()">
            Rename
          </button>
          <button type="button" class="dx" (click)="confirm('reset')">
            {{ asking() === 'reset' ? 'Click again to reset' : 'Reset to default' }}
          </button>
          <button type="button" class="dx" (click)="confirm('delete')">
            {{ asking() === 'delete' ? 'Click again to delete' : 'Delete view' }}
          </button>
        </div>
        <div class="views-line">
          <span class="sub">Text:</span>
          @for (n of layout.names(); track n) {
            <button type="button" class="dx" [title]="'Copy the text of ' + n" (click)="copy(n)">
              Copy {{ n }}
            </button>
          }
        </div>
        <div class="views-line">
          <textarea
            rows="3"
            aria-label="View text"
            placeholder="Paste a view's text here to load it"
            [value]="text()"
            (input)="text.set($any($event.target).value)"
          ></textarea>
          <button type="button" class="dx" [disabled]="!text().trim()" (click)="paste()">
            Load
          </button>
        </div>
        @if (note()) {
          <p class="sub" role="status">{{ note() }}</p>
        }
      </div>
    }
  `,
})
export class ViewsBar {
  readonly layout = inject(BoardLayout);
  readonly open = signal(false);
  readonly name = signal('');
  readonly text = signal('');
  readonly note = signal('');
  readonly asking = signal<'' | 'reset' | 'delete'>('');

  readonly canRename = computed(() => {
    const n = this.name().trim();
    return !!n && n !== this.layout.active() && !this.layout.names().includes(n);
  });

  toggle() {
    this.open.update((o) => !o);
    this.name.set(this.layout.active());
    this.note.set('');
  }
  saveAs() {
    const n = this.layout.saveAs(this.name());
    this.name.set(n);
    this.note.set(`Saved as "${n}".`);
  }
  rename() {
    this.layout.rename(this.name());
    this.note.set(`Renamed to "${this.layout.active()}".`);
  }
  confirm(what: 'reset' | 'delete') {
    if (this.asking() !== what) {
      this.asking.set(what);
      setTimeout(() => this.asking.set(''), 4000);
      return;
    }
    this.asking.set('');
    if (what === 'reset') this.layout.resetView();
    else this.layout.remove();
    this.name.set(this.layout.active());
    this.note.set(what === 'reset' ? 'Back to the default layout.' : 'View deleted.');
  }

  copy(n: string) {
    const t = this.layout.exportText(n);
    this.text.set(t); // shown too, in case the clipboard is unavailable
    this.note.set(
      `Copied the text of "${n}". Load it on another browser, or send it to set the default.`,
    );
    // plain http on the LAN has no clipboard API; the old way still works there (not awaited: a permission prompt
    // must not hold the panel up)
    const old = () => {
      const ta = document.createElement('textarea');
      ta.value = t;
      document.body.append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    };
    if (navigator.clipboard) navigator.clipboard.writeText(t).catch(old);
    else old();
  }

  paste() {
    const r = this.layout.importText(this.text());
    if (r.error) return this.note.set(r.error);
    this.name.set(r.name!);
    this.text.set('');
    this.note.set(`Loaded "${r.name}".`);
  }
}
