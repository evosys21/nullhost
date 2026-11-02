<script setup lang="ts">
import { HighlightStyle, StreamLanguage, foldEffect, foldService, syntaxHighlighting } from "@codemirror/language";
import { EditorState, RangeSetBuilder, type Text } from "@codemirror/state";
import { Decoration, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { EditorView, basicSetup } from "codemirror";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import Banners from "../components/Banners.vue";
import Icon from "../components/Icon.vue";
import { act, api, cleanError, store } from "../store";

const START = "# >>> nullhost managed";
const END = "# <<< nullhost managed <<<";

function regionRange(doc: Text): { from: number; to: number } | null {
  const s = doc.toString();
  const a = s.indexOf(START);
  if (a < 0) return null;
  const b = s.indexOf(END, a);
  return b < 0 ? null : { from: a, to: b + END.length };
}

// hosts syntax: comments, the address at the start of a line, host names
const hostsLanguage = StreamLanguage.define({
  token(stream) {
    if (stream.eatSpace()) return null;
    if (stream.peek() === "#") {
      stream.skipToEnd();
      return "comment";
    }
    const first = stream.column() === stream.indentation();
    stream.eatWhile(/[^\s#]/);
    return first ? "number" : "variableName";
  },
});

// colours from the app's tokens (styles.css), so the editor follows light and dark
const hostsHighlight = syntaxHighlighting(HighlightStyle.define([
  { tag: tags.comment, color: "var(--muted)" },
  { tag: tags.number, color: "var(--accent-hover)" },
  { tag: tags.variableName, color: "var(--text)" },
]));

const editorTheme = EditorView.theme({
  "&": { color: "var(--text)", backgroundColor: "var(--surface)" },
  ".cm-gutters": { color: "var(--faint)", backgroundColor: "var(--bg)", borderRight: "1px solid var(--border)" },
  ".cm-activeLine": { backgroundColor: "var(--hover)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--row)", color: "var(--text-2)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--text)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": { backgroundColor: "var(--selection)" },
  ".cm-selectionMatch, .cm-searchMatch": { backgroundColor: "var(--warn-soft)" },
  ".cm-panels": { backgroundColor: "var(--bg)", color: "var(--text)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
  ".cm-textfield, .cm-button": { backgroundColor: "var(--surface)", backgroundImage: "none", color: "var(--text)", border: "1px solid var(--border-strong)" },
  ".cm-tooltip": { backgroundColor: "var(--surface)", color: "var(--text)", border: "1px solid var(--border)" },
});

// NullHost's region: tinted, folded to one line, not editable
const regionLines = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = this.build(view); }
    update(u: ViewUpdate) { if (u.docChanged || u.viewportChanged) this.decorations = this.build(u.view); }
    build(view: EditorView): DecorationSet {
      const b = new RangeSetBuilder<Decoration>();
      const r = regionRange(view.state.doc);
      if (!r) return b.finish();
      const deco = Decoration.line({ class: "cm-nullhost-region" });
      for (const { from, to } of view.visibleRanges) {
        for (let pos = Math.max(from, r.from); pos <= Math.min(to, r.to); ) {
          const line = view.state.doc.lineAt(pos);
          b.add(line.from, line.from, deco);
          pos = line.to + 1;
        }
      }
      return b.finish();
    }
  },
  { decorations: (v) => v.decorations },
);

const regionFold = foldService.of((state, lineStart, lineEnd) => {
  const r = regionRange(state.doc);
  return r && lineStart === r.from ? { from: lineEnd, to: r.to } : null;
});

const protectRegion = EditorState.changeFilter.of((tr) => {
  const r = regionRange(tr.startState.doc);
  return r ? [r.from, r.to] : true;
});

const host = ref<HTMLDivElement | null>(null);
const dirty = ref(false);
const loaded = ref("");
const lineCount = ref(0);
const canWrite = computed(() => store.info?.canWrite ?? false);
let view: EditorView | null = null;

// The main process hands over the file byte for byte (latin1). Show UTF-8 files
// decoded (and without their byte-order mark); write them back the same way.
let utf8 = false;
let hadBom = false;
function decodeForEditor(raw: string): string {
  const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0) & 0xff);
  hadBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); // drops the BOM
    utf8 = true;
    return text;
  } catch {
    utf8 = false;
    hadBom = false;
    return raw; // not UTF-8 (an old ANSI file): show the bytes as they are
  }
}
function encodeForFile(text: string): string {
  if (!utf8) return text;
  const bytes = new TextEncoder().encode(text);
  let out = hadBom ? "\xEF\xBB\xBF" : ""; // the UTF-8 byte-order mark, as latin1 characters
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return out;
}

function makeState(text: string): EditorState {
  const sep = text.includes("\r\n") ? "\r\n" : "\n";
  return EditorState.create({
    doc: text,
    extensions: [
      basicSetup,
      editorTheme,
      EditorState.lineSeparator.of(sep),
      hostsLanguage,
      hostsHighlight,
      regionLines,
      regionFold,
      protectRegion,
      EditorView.updateListener.of((u) => {
        if (u.docChanged) {
          dirty.value = u.state.doc.toString() !== loaded.value;
          lineCount.value = u.state.doc.lines;
        }
      }),
      EditorView.editable.of(canWrite.value),
    ],
  });
}

function foldRegion(): void {
  if (!view) return;
  const r = regionRange(view.state.doc);
  if (!r) return;
  const first = view.state.doc.lineAt(r.from);
  view.dispatch({ effects: foldEffect.of({ from: first.to, to: r.to }) });
}

async function load(): Promise<void> {
  try {
    const text = decodeForEditor(await api.readHosts());
    loaded.value = text;
    dirty.value = false;
    const state = makeState(text);
    lineCount.value = state.doc.lines;
    if (view) view.setState(state);
    else if (host.value) view = new EditorView({ state, parent: host.value });
    foldRegion();
  } catch (err) {
    store.error = cleanError(err);
  }
}

async function save(): Promise<void> {
  if (!view) return;
  const doc = view.state.doc.toString();
  // an ANSI file holds one byte per character: anything past U+00FF would be cut short
  const wide = utf8 ? null : /[^\x00-\xff]/.exec(doc);
  if (wide) {
    store.error = `This hosts file is not UTF-8, so it cannot hold "${wide[0]}". Remove that character, or save the file as UTF-8 in another editor first.`;
    return;
  }
  const text = encodeForFile(doc);
  await act("Saving", () => api.saveHosts(text), () => "Saved. A snapshot of the previous file was taken first.");
  if (!store.error) await load();
}

async function reload(): Promise<void> {
  if (dirty.value && !confirm("Discard your unsaved changes?")) return;
  await load();
}

onMounted(load);
onBeforeUnmount(() => { view?.destroy(); view = null; });
</script>

<template>
  <header class="header">
    <div class="title">
      <h1>Hosts file editor</h1>
      <div class="sub"><span class="mono">{{ store.info?.hostsFile }}</span> · {{ lineCount.toLocaleString("en-US") }} lines<span v-if="dirty"> · modified, unsaved</span></div>
    </div>
    <button class="btn" type="button" @click="reload"><Icon name="refresh" />Reload</button>
    <button class="btn primary" type="button" :disabled="!canWrite || !dirty || !!store.busy" @click="save"><Icon name="check" />Save</button>
  </header>
  <div class="content">
    <Banners />
    <div ref="host" class="editor-host"></div>
    <div class="hint">
      Your dev vhosts, redirects and own blocks live here, outside NullHost's region. The region (tinted, folded) is read-only:
      change it through Sources, the Allowlist or the Enable switch. Every save takes a snapshot first.
    </div>
  </div>
</template>
