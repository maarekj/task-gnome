import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inline, parseMarkdown } from '../src/shared/markdown.ts';

describe('inline', () => {
  it('styles et échappement', () => {
    assert.equal(inline('**gras** _ital_ ~~barré~~ a < b & c'), '<b>gras</b> <i>ital</i> <s>barré</s> a &lt; b &amp; c');
  });
  it('le code n\'est pas interprété et le texte qui suit est conservé', () => {
    // régression : un marqueur NUL coupait le texte après le premier `code`
    assert.equal(inline('La commande `sleep 5 && date` a **fini**'), 'La commande <tt>sleep 5 &amp;&amp; date</tt> a <b>fini</b>');
  });
  it('liens', () => {
    assert.equal(inline('[doc](https://x.y) et https://a.b/c.'), '<a href="https://x.y">doc</a> et <a href="https://a.b/c">https://a.b/c</a>.');
  });
});

describe('parseMarkdown', () => {
  it('blocs', () => {
    const md = ['# Titre', '', 'Un paragraphe', 'sur deux lignes.', '', '- a', '  - b', '1. un', '- [x] fait', '> cité', '', '```', 'code <x>', '```', '---', '| A | B |', '|---|---|', '| 1 | 2 |'].join('\n');
    assert.deepEqual(parseMarkdown(md), [
      { kind: 'heading', level: 1, markup: 'Titre' },
      { kind: 'paragraph', markup: 'Un paragraphe\nsur deux lignes.' },
      { kind: 'item', depth: 0, bullet: '•', markup: 'a' },
      { kind: 'item', depth: 1, bullet: '◦', markup: 'b' },
      { kind: 'item', depth: 0, bullet: '1.', markup: 'un' },
      { kind: 'item', depth: 0, bullet: '☑', markup: 'fait' },
      { kind: 'quote', markup: 'cité' },
      { kind: 'code', text: 'code <x>' },
      { kind: 'rule' },
      { kind: 'table', header: ['A', 'B'], rows: [['1', '2']] },
    ]);
  });
});
