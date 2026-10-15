// Minimal Markdown -> Gtk widgets renderer (paragraphs, headings, lists, quotes, code blocks, tables, inline styles).
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';

const esc = s => GLib.markup_escape_text(s, -1);

/** Inline markdown -> Pango markup. */
export function inline(src) {
    const codes = [];
    // protect code spans first
    let s = src.replace(/`([^`]+)`/g, (_m, c) => {
        codes.push(c);
        return `\uE000${codes.length - 1}\uE000`;
    });
    s = esc(s);
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, t, u) => `<a href="${u.replace(/"/g, '&quot;')}">${t}</a>`);
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, (_m, p, u) => `${p}<a href="${u}">${u}</a>`);
    s = s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/__(.+?)__/g, '<b>$1</b>');
    s = s.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<i>$2</i>').replace(/(^|[^_\w])_([^_\s][^_]*?)_(?!\w)/g, '$1<i>$2</i>');
    s = s.replace(/~~(.+?)~~/g, '<s>$1</s>');
    s = s.replace(/\uE000(\d+)\uE000/g, (_m, i) => `<tt>${esc(codes[Number(i)])}</tt>`);
    return s;
}

function mlabel(markup, css = []) {
    const l = new Gtk.Label({
        wrap: true, wrap_mode: Pango.WrapMode.WORD_CHAR, xalign: 0, selectable: true, use_markup: true, css_classes: css,
    });
    try {
        l.set_markup(markup);
    } catch {
        l.set_text(markup);
    }
    return l;
}

function table(rows) {
    const cells = rows
        .filter(r => !/^\s*\|?\s*:?-{2,}/.test(r))
        .map(r => r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim()));
    const grid = new Gtk.Grid({column_spacing: 18, row_spacing: 6, margin_top: 8, margin_bottom: 8, margin_start: 12, margin_end: 12});
    cells.forEach((row, y) => {
        row.forEach((c, x) => {
            const l = mlabel(y === 0 ? `<b>${inline(c)}</b>` : inline(c));
            l.wrap = true;
            l.max_width_chars = 50;
            grid.attach(l, x, y, 1, 1);
        });
    });
    const sc = new Gtk.ScrolledWindow({
        child: grid, vscrollbar_policy: Gtk.PolicyType.NEVER, propagate_natural_height: true, css_classes: ['card'],
    });
    return sc;
}

function codeBlock(text) {
    const l = new Gtk.Label({
        label: text, xalign: 0, selectable: true, wrap: true, wrap_mode: Pango.WrapMode.CHAR, css_classes: ['monospace'],
        margin_top: 8, margin_bottom: 8, margin_start: 12, margin_end: 12,
    });
    return new Gtk.Frame({child: l});
}

/** Renders markdown text into a vertical Gtk.Box. */
export function renderMarkdown(text) {
    const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 8});
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    let para = [];
    const flush = () => {
        if (para.length)
            box.append(mlabel(inline(para.join('\n'))));
        para = [];
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        let m;
        if ((m = /^\s*(```|~~~)/.exec(line))) {
            flush();
            const fence = m[1];
            const buf = [];
            while (++i < lines.length && !lines[i].trim().startsWith(fence))
                buf.push(lines[i]);
            box.append(codeBlock(buf.join('\n')));
        } else if (/^\s*\|.*\|\s*$/.test(line)) {
            flush();
            const rows = [line];
            while (i + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[i + 1]))
                rows.push(lines[++i]);
            box.append(table(rows));
        } else if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) {
            flush();
            const css = m[1].length === 1 ? ['title-2'] : m[1].length === 2 ? ['title-3'] : ['heading'];
            const l = mlabel(inline(m[2].replace(/\s#+\s*$/, '')), css);
            l.margin_top = 6;
            box.append(l);
        } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
            flush();
            box.append(new Gtk.Separator({margin_top: 4, margin_bottom: 4}));
        } else if ((m = /^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?(.*)$/.exec(line))) {
            flush();
            const depth = Math.floor(m[1].replace(/\t/g, '  ').length / 2);
            let bullet = /\d/.test(m[2]) ? m[2] : depth ? '◦' : '•';
            if (m[3])
                bullet = /x/i.test(m[3]) ? '☑' : '☐';
            let content = m[4];
            // continuation lines of the same item
            while (i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1]) && !/^\s*([-*+]|\d+[.)])\s/.test(lines[i + 1]))
                content += ` ${lines[++i].trim()}`;
            const row = new Gtk.Box({spacing: 8, margin_start: 6 + depth * 18});
            row.append(new Gtk.Label({label: bullet, valign: Gtk.Align.START, width_chars: 3, xalign: 1, css_classes: ['dim-label']}));
            const l = mlabel(inline(content));
            l.hexpand = true;
            row.append(l);
            box.append(row);
        } else if ((m = /^\s*>\s?(.*)$/.exec(line))) {
            flush();
            const buf = [m[1]];
            while (i + 1 < lines.length && /^\s*>/.test(lines[i + 1]))
                buf.push(lines[++i].replace(/^\s*>\s?/, ''));
            const row = new Gtk.Box({spacing: 10});
            row.append(new Gtk.Separator({orientation: Gtk.Orientation.VERTICAL}));
            row.append(mlabel(`<i>${inline(buf.join(' '))}</i>`, ['dim-label']));
            box.append(row);
        } else if (!line.trim()) {
            flush();
        } else {
            para.push(line.trim());
        }
    }
    flush();
    return box;
}
