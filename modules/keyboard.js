import _ from 'lodash';
import clone from 'clone';
import equal from 'deep-equal';
import extend from 'extend';
import Delta from 'quill-delta';
import DeltaOp from 'quill-delta/lib/op';
import { EmbedBlot, TextBlot } from 'parchment';
import Quill from '../core/quill';
import logger from '../core/logger';
import Module from '../core/module';
import AdditorImage from '../formats/image';

const debug = logger('quill:keyboard');
const SHORTKEY = /Mac/i.test(navigator.platform) ? 'metaKey' : 'ctrlKey';

class Keyboard extends Module {
  static match(evt, binding) {
    if (
      ['altKey', 'ctrlKey', 'metaKey', 'shiftKey'].some(key => {
        return !!binding[key] !== evt[key] && binding[key] !== null;
      })
    ) {
      return false;
    }
    return binding.key === evt.key || binding.key === evt.which;
  }

  constructor(quill, options) {
    super(quill, options);
    this.bindings = {};
    Object.keys(this.options.bindings).forEach(name => {
      if (this.options.bindings[name]) {
        this.addBinding(this.options.bindings[name]);
      }
    });
    this.addBinding({ key: 'Enter', shiftKey: null }, handleEnter);
    this.addBinding(
      { key: 'Enter', metaKey: null, ctrlKey: null, altKey: null },
      () => {},
    );
    if (/Firefox/i.test(navigator.userAgent)) {
      // Need to handle delete and backspace for Firefox in the general case #1171
      this.addBinding(
        { key: 'Backspace' },
        { collapsed: true },
        handleBackspace,
      );
      this.addBinding({ key: 'Delete' }, { collapsed: true }, handleDelete);
    } else {
      this.addBinding(
        { key: 'Backspace' },
        { collapsed: true, prefix: /^.?$/ },
        handleBackspace,
      );
      this.addBinding(
        { key: 'Delete' },
        { collapsed: true, suffix: /^.?$/ },
        handleDelete,
      );
    }
    this.addBinding(
      { key: 'Backspace' },
      { collapsed: false },
      handleDeleteRange,
    );
    this.addBinding({ key: 'Delete' }, { collapsed: false }, handleDeleteRange);
    this.addBinding(
      {
        key: 'Backspace',
        altKey: null,
        ctrlKey: null,
        metaKey: null,
        shiftKey: null,
      },
      { collapsed: true, offset: 0 },
      handleBackspace,
    );
    this.listen();
  }

  addBinding(keyBinding, context = {}, handler = {}) {
    const binding = normalize(keyBinding);
    if (binding == null) {
      debug.warn('Attempted to add invalid keyboard binding', binding);
      return;
    }
    if (typeof context === 'function') {
      context = { handler: context };
    }
    if (typeof handler === 'function') {
      handler = { handler };
    }
    const keys = Array.isArray(binding.key) ? binding.key : [binding.key];
    keys.forEach(key => {
      const singleBinding = extend({}, binding, { key }, context, handler);
      this.bindings[singleBinding.key] = this.bindings[singleBinding.key] || [];
      this.bindings[singleBinding.key].push(singleBinding);
    });
  }

  listen() {
    this.quill.root.addEventListener('keydown', evt => {
      if (evt.defaultPrevented) return;
      const bindings = (this.bindings[evt.key] || []).concat(
        this.bindings[evt.which] || [],
      );
      const matches = bindings.filter(binding => Keyboard.match(evt, binding));
      if (matches.length === 0) return;
      const range = this.quill.getSelection();
      if (range == null || !this.quill.hasFocus()) return;
      const [line, offset] = this.quill.getLine(range.index);
      const [leafStart, offsetStart] = this.quill.getLeaf(range.index);
      const [leafEnd, offsetEnd] =
        range.length === 0
          ? [leafStart, offsetStart]
          : this.quill.getLeaf(range.index + range.length);
      const prefixText =
        leafStart instanceof TextBlot
          ? leafStart.value().slice(0, offsetStart)
          : '';
      const suffixText =
        leafEnd instanceof TextBlot ? leafEnd.value().slice(offsetEnd) : '';
      const curContext = {
        collapsed: range.length === 0,
        empty: range.length === 0 && line.length() <= 1,
        format: this.quill.getFormat(range),
        line,
        offset,
        prefix: prefixText,
        suffix: suffixText,
        event: evt,
      };
      const prevented = matches.some(binding => {
        if (
          binding.collapsed != null &&
          binding.collapsed !== curContext.collapsed
        ) {
          return false;
        }
        if (binding.empty != null && binding.empty !== curContext.empty) {
          return false;
        }
        if (binding.offset != null && binding.offset !== curContext.offset) {
          return false;
        }
        if (Array.isArray(binding.format)) {
          // any format is present
          if (binding.format.every(name => curContext.format[name] == null)) {
            return false;
          }
        } else if (typeof binding.format === 'object') {
          // all formats must match
          if (
            !Object.keys(binding.format).every(name => {
              if (binding.format[name] === true)
                return curContext.format[name] != null;
              if (binding.format[name] === false)
                return curContext.format[name] == null;
              return equal(binding.format[name], curContext.format[name]);
            })
          ) {
            return false;
          }
        }
        if (binding.prefix != null && !binding.prefix.test(curContext.prefix)) {
          return false;
        }
        if (binding.suffix != null && !binding.suffix.test(curContext.suffix)) {
          return false;
        }
        return binding.handler.call(this, range, curContext, binding) !== true;
      });
      if (prevented) {
        evt.preventDefault();
      }
    });
  }
}

Keyboard.DEFAULTS = {
  bindings: {
    bold: makeFormatHandler('bold'),
    italic: makeFormatHandler('italic'),
    underline: makeFormatHandler('underline'),
    indent: {
      // highlight tab or tab at beginning of list, indent or blockquote
      key: 'Tab',
      handler(range, context) {
        const { format, collapsed, offset } = context;
        if (collapsed && offset !== 0) return true;
        if (context.line.statics.blotName === 'embed') return false;
        if (format['code-block'] || format.table) {
          return true;
        }
        this.quill.format('indent', '+1', Quill.sources.USER);
      },
    },
    outdent: {
      key: 'Tab',
      shiftKey: true,
      // highlight tab or tab at beginning of list, indent or blockquote
      handler(range, context) {
        const { format, collapsed, offset } = context;
        if (collapsed && offset !== 0) return true;
        if (context.line.statics.blotName === 'embed') return false;
        if (format['code-block'] || format.table || format.embed) {
          return true;
        }
        this.quill.format('indent', '-1', Quill.sources.USER);
      },
    },
    'outdent backspace': {
      key: 'Backspace',
      collapsed: true,
      shiftKey: null,
      metaKey: null,
      ctrlKey: null,
      altKey: null,
      format: ['indent', 'list'],
      offset: 0,
      handler(range, context) {
        if (context.format.indent != null) {
          this.quill.format('indent', '-1', Quill.sources.USER);
        } else if (context.format.list != null) {
          this.quill.format('start', false, Quill.sources.USER);
          this.quill.format('list', false, Quill.sources.USER);
        }
      },
    },
    'indent code-block': makeCodeBlockHandler(true),
    'outdent code-block': makeCodeBlockHandler(false),
    'remove tab': {
      key: 'Tab',
      shiftKey: true,
      collapsed: true,
      prefix: /\t$/,
      handler(range) {
        this.quill.deleteText(range.index - 1, 1, Quill.sources.USER);
      },
    },
    tab: {
      key: 'Tab',
      handler(range, context) {
        if (context.format.table) return true;
        this.quill.history.cutoff();
        const delta = new Delta()
          .retain(range.index)
          .delete(range.length)
          .insert('\t');
        this.quill.updateContents(delta, Quill.sources.USER);
        this.quill.history.cutoff();
        this.quill.setSelection(range.index + 1, Quill.sources.SILENT);
        return false;
      },
    },
    'blockquote empty enter': {
      key: 'Enter',
      collapsed: true,
      format: ['blockquote'],
      empty: true,
      handler() {
        this.quill.format('blockquote', false, Quill.sources.USER);
      },
    },
    'indent empty enter': {
      key: 'Enter',
      collapsed: true,
      format: ['indent'],
      empty: true,
      handler(range, context) {
        this.quill.format('indent', false, Quill.sources.USER);
      },
    },
    'list empty enter': {
      key: 'Enter',
      collapsed: true,
      format: ['list'],
      empty: true,
      handler(range, context) {
        this.quill.format('list', false, Quill.sources.USER);
        this.quill.format('start', false, Quill.sources.USER);
        if (context.format.indent) {
          this.quill.format('indent', false, Quill.sources.USER);
        }
      },
    },
    'list enter': {
      key: 'Enter',
      collapsed: true,
      format: { list: 'ordered' },
      handler(range) {
        if (this.quill.scroll.composing) return;
        const [line, offset] = this.quill.getLine(range.index);
        const formats = extend({}, line.formats(), { list: 'ordered' });
        const delta = new Delta()
          .retain(range.index)
          .insert('\n', formats)
          .retain(line.length() - offset - 1)
          .retain(1, { list: 'ordered', start: false });
        this.quill.updateContents(delta, Quill.sources.USER);
        this.quill.setSelection(range.index + 1, Quill.sources.USER);
        this.quill.scrollIntoView();
      },
    },
    'checklist enter': {
      key: 'Enter',
      collapsed: true,
      format: { list: 'checked' },
      handler(range) {
        if (this.quill.scroll.composing) return;
        const [line, offset] = this.quill.getLine(range.index);
        const formats = extend({}, line.formats(), { list: 'checked' });
        const delta = new Delta()
          .retain(range.index)
          .insert('\n', formats)
          .retain(line.length() - offset - 1)
          .retain(1, { list: 'unchecked' });
        this.quill.updateContents(delta, Quill.sources.USER);
        this.quill.setSelection(range.index + 1, Quill.sources.SILENT);
        this.quill.scrollIntoView();
      },
    },
    'header enter': {
      key: 'Enter',
      collapsed: true,
      format: ['header'],
      suffix: /^$/,
      handler(range, context) {
        const [line, offset] = this.quill.getLine(range.index);
        const delta = new Delta()
          .retain(range.index)
          .insert('\n', context.format)
          .retain(line.length() - offset - 1)
          .retain(1, { header: null });
        this.quill.updateContents(delta, Quill.sources.USER);
        this.quill.setSelection(range.index + 1, Quill.sources.SILENT);
        this.quill.scrollIntoView();
      },
    },
    'table backspace': {
      key: 'Backspace',
      format: ['table'],
      collapsed: true,
      offset: 0,
      handler(range, context) {
        const { line } = context;
        if (!line || !line.prev) return false;
        return line.parent.length() > 1 || line.length() > 1;
      },
    },
    'table backspace not collapsed': {
      key: 'Backspace',
      empty: false,
      collapsed: false,
      handler(range) {
        const anchorFormat = this.quill.getFormat(range.index);
        const focusFormat = this.quill.getFormat(range.index + range.length);
        if (!anchorFormat.table && !focusFormat.table) return true; // 양쪽 라인 모두 테이블셀이 아니면 return true;
        if (anchorFormat.table && focusFormat.table) return true; // 양쪽 라인 모두 테이블셀이어도 return true;
        const lines = this.quill.getLines(range.index, range.length);
        if (range.index === 0) {
          this.quill.deleteText(range.index, range.length + 1, 'user');
          return false;
        }
        if (lines.length > 1) {
          const anchorLine = _.head(lines);
          const focusLine = _.last(lines);
          if (anchorLine.parent === focusLine.parent) return true;
          _.forEach(lines, line => {
            const length = line.length();
            if (length > 1) {
              line.deleteAt(0, length - 1);
            }
          });
        } else {
          const [line] = lines;
          const maxLength = line.length();
          const deleteLength = range.length < maxLength ? range.length : maxLength - 1;
          this.quill.deleteText(range.index, deleteLength);
          this.quill.setSelection(range.index, 0);
        }
        return false;
      },
    },
    'table delete': {
      key: 'Delete',
      format: ['table'],
      collapsed: true,
      suffix: /^$/,
      handler() {},
    },
    'table tab': {
      key: 'Tab',
      shiftKey: null,
      format: ['table'],
      handler(range, context) {
        const { event, line: cell } = context;
        const offset = cell.offset(this.quill.scroll);
        if (event.shiftKey) {
          this.quill.setSelection(offset - 1, Quill.sources.USER);
        } else {
          this.quill.setSelection(offset + cell.length(), Quill.sources.USER);
        }
      },
    },
    'list autofill': {
      key: ' ',
      collapsed: true,
      format: {
        list: false,
        'code-block': false,
        blockquote: false,
        header: false,
        table: false,
      },
      prefix: /^\s*?(\d+\.|-|\*|\[ ?\]|\[v\])$/,
      handler(range, context) {
        const length = context.prefix.length;
        const [line, offset] = this.quill.getLine(range.index);
        if (offset > length) return true;
        let value;
        // prefix 에서 start 번호를 뽑아냄
        switch (context.prefix.trim()) {
          case '[]':
          case '[ ]':
            value = 'unchecked';
          break;
          case '[v]':
            value = 'checked';
            break;
          case '-':
          case '*':
            value = 'bullet';
          break;
          default:
            value = 'ordered';
        }
        this.quill.insertText(range.index, ' ', Quill.sources.USER);
        this.quill.history.cutoff();
        const delta = new Delta()
          .retain(range.index - offset)
          .delete(length + 1)
          .retain(line.length() - 2 - offset);

        if (value === 'ordered') {
          delta.retain(1, {
            list: value,
            start: Number(context.prefix.slice(0, -1)),
          });
        } else {
          delta.retain(1, { list: value });
        }

        this.quill.updateContents(delta, Quill.sources.USER);
        this.quill.history.cutoff();
        this.quill.setSelection(range.index - length, Quill.sources.SILENT);
        return false;
      },
    },
    'code exit': {
      key: 'Enter',
      collapsed: true,
      format: ['code-block'],
      prefix: /^$/,
      suffix: /^\s*$/,
      handler(range) {
        const [line, offset] = this.quill.getLine(range.index);
        let numLines = 2;
        let cur = line;
        while (
          cur != null &&
          cur.length() <= 1 &&
          cur.formats()['code-block']
          ) {
          cur = cur.prev;
          numLines -= 1;
          // Requisite prev lines are empty
          if (numLines <= 0) {
            const delta = new Delta()
              .retain(range.index + line.length() - offset - 2)
              .retain(1, { 'code-block': null })
              .delete(1);
            this.quill.updateContents(delta, Quill.sources.USER);
            this.quill.setSelection(range.index - 1, Quill.sources.SILENT);
            return false;
          }
        }
        return true;
      },
    },
    'arrow left': {
      key: 'ArrowLeft',
      collapsed: true,
      offset: 0,
      handler(range, context) {
        // 이전 blot 이 TableWrapper 이면 fakeCursor 를 보여줌
        if (context.format.table) {
          const { line: currLine } = context;
          if (
            !currLine.parent.prev &&
            !currLine.row().prev &&
            !currLine.prev
          ) {
            const tableWrapper = currLine.tableWrapper();
            tableWrapper.showFakeCursor();
            return false;
          }
        } else {
          const [prevLine] = this.quill.getLine(range.index - 1);
          if (prevLine.statics.blotName === 'table') {
            const tableWrapper = prevLine.tableWrapper();
            tableWrapper.showFakeCursor(false);
            return false;
          }

          if (prevLine.statics.blotName === 'image-grid') {
            prevLine.showFakeCursor(-1);
            return false;
          }

          if (prevLine.statics.blotName === 'image') {
            prevLine.showFakeCursor(false);
            return false;
          }
        }
        return true;
      },
    },
    'arrow right': {
      key: 'ArrowRight',
      collapsed: true,
      handler(range, context) {
        if (context.format.table) {
          const { offset, line: currLine } = context;
          const lineLength = currLine.length();
          if (
            currLine.statics.blotName === 'table' &&
            !currLine.parent.next &&
            !currLine.row().next &&
            !currLine.next &&
            offset === lineLength - 1
          ) {
            const tableWrapper = currLine.tableWrapper();
            tableWrapper.showFakeCursor(false);
            return false;
          }
        } else {
          const [nextLine] = this.quill.getLine(range.index + 1);
          if (nextLine.statics.blotName === 'table') {
            const tableWrapper = nextLine.tableWrapper();
            tableWrapper.showFakeCursor();
            return false;
          }

          if (nextLine.statics.blotName === 'image-grid') {
            nextLine.showFakeCursor();
            return false;
          }

          if (nextLine.statics.blotName === 'image') {
            nextLine.showFakeCursor();
            return false;
          }
        }
        return true;
      },
    },
    'list arrow up': {
      key: 'ArrowUp',
      format: ['list'],
      handler(range, context) {
        const firstLine = this.quill.getLine(0);
        if (firstLine && firstLine[0]) {
          return firstLine[0] !== context.line;
        }
        return true;
      },
    },
    'arrow up': {
      key: 'ArrowUp',
      handler(range, context) {
        const { prev } = context.line;
        if (prev) {
          if (prev.statics.blotName === 'image-grid') {
            prev.showFakeCursor();
            return false;
          }

          if (prev.statics.blotName === 'image') {
            prev.showFakeCursor();
            return false;
          }
        }
        return true;
      },
    },
    'arrow down': {
      key: 'ArrowDown',
      handler(range, context) {
        const { next } = context.line;
        if (next) {
          if (next.statics.blotName === 'image-grid') {
            next.showFakeCursor();
            return false;
          }

          if (next.statics.blotName === 'image') {
            next.showFakeCursor();
            return false;
          }
        }
        return true;
      },
    },
    backspace: {
      key: 'Backspace',
      collapsed: true,
      handler(range, context) {
        if (!context.format.table) {
          const [prevLine] = this.quill.getLine(range.index - 1);
          if (prevLine.statics.blotName === 'table') {
            const tableWrapper = prevLine.tableWrapper();
            tableWrapper.showFakeCursor(false);
            if (context.line.length() === 1) {
              context.line.remove();
            }
            return false;
          }

          if (prevLine.statics.blotName === 'image-grid') {
            prevLine.showFakeCursor(-1);
            if (context.line.length() === 1) {
              context.line.remove();
            }
            return false;
          }

          if (prevLine.statics.blotName === 'image') {
            prevLine.showFakeCursor(false);
            if (context.line.length() === 1) {
              context.line.remove();
            }
            return false;
          }
        }
        return true;
      },
    },
    'embed left': makeEmbedArrowHandler('ArrowLeft', false),
    'embed left shift': makeEmbedArrowHandler('ArrowLeft', true),
    'embed right': makeEmbedArrowHandler('ArrowRight', false),
    'embed right shift': makeEmbedArrowHandler('ArrowRight', true),
    'table down': makeTableArrowHandler(false),
    'table up': makeTableArrowHandler(true),
  },
};

function handleBackspace(range, context) {
  if (range.index === 0 || this.quill.getLength() <= 1) return;
  const [line] = this.quill.getLine(range.index);
  let formats = {};
  if (context.offset === 0) {
    const [prev] = this.quill.getLine(range.index - 1);
    if (prev != null) {
      if (prev.length() > 1 || prev.statics.blotName === 'table') {
        const curFormats = line.formats();
        const prevFormats = this.quill.getFormat(range.index - 1, 1);
        formats = DeltaOp.attributes.diff(curFormats, prevFormats) || {};
      }
    }
  }
  // Check for astral symbols
  const length = /[\uD800-\uDBFF][\uDC00-\uDFFF]$/.test(context.prefix) ? 2 : 1;
  this.quill.deleteText(range.index - length, length, Quill.sources.USER);
  if (Object.keys(formats).length > 0) {
    this.quill.formatLine(
      range.index - length,
      length,
      formats,
      Quill.sources.USER,
    );
  }
  this.quill.focus();
}

function handleDelete(range, context) {
  // Check for astral symbols
  const length = /^[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(context.suffix) ? 2 : 1;
  if (range.index >= this.quill.getLength() - length) return;
  let formats = {};
  let nextLength = 0;
  const [line] = this.quill.getLine(range.index);
  if (context.offset >= line.length() - 1) {
    const [next] = this.quill.getLine(range.index + 1);
    if (next) {
      const curFormats = line.formats();
      const nextFormats = this.quill.getFormat(range.index, 1);
      formats = DeltaOp.attributes.diff(curFormats, nextFormats) || {};
      nextLength = next.length();
    }
  }
  this.quill.deleteText(range.index, length, Quill.sources.USER);
  if (Object.keys(formats).length > 0) {
    this.quill.formatLine(
      range.index + nextLength - 1,
      length,
      formats,
      Quill.sources.USER,
    );
  }
}

function handleDeleteRange(range) {
  const lines = this.quill.getLines(range);
  let formats = {};
  if (lines.length > 1) {
    const firstFormats = lines[0].formats();
    const lastFormats = lines[lines.length - 1].formats();
    formats = DeltaOp.attributes.diff(lastFormats, firstFormats) || {};
  }
  this.quill.deleteText(range, Quill.sources.USER);
  if (Object.keys(formats).length > 0) {
    this.quill.formatLine(range.index, 1, formats, Quill.sources.USER);
  }
  this.quill.setSelection(range.index, Quill.sources.SILENT);
  this.quill.focus();
}

// TODO use just updateContents()
function handleEnter(range, context) {
  if (range.length > 0) {
    this.quill.scroll.deleteAt(range.index, range.length); // So we do not trigger text-change
  }
  if (this.quill.scroll.composing) return;
  this.quill.insertText(range.index, '\n', {}, Quill.sources.USER);
  // Earlier scroll.deleteAt might have messed up our selection,
  // so insertText's built in selection preservation is not reliable
  this.quill.setSelection(range.index + 1, Quill.sources.SILENT);
  this.quill.focus();
}

function makeCodeBlockHandler(indent) {
  return {
    key: 'Tab',
    shiftKey: !indent,
    format: { 'code-block': true },
    handler(range) {
      const CodeBlock = this.quill.scroll.query('code-block');
      const lines =
        range.length === 0
          ? this.quill.getLines(range.index, 1)
          : this.quill.getLines(range);
      let { index, length } = range;
      lines.forEach((line, i) => {
        if (indent) {
          line.insertAt(0, CodeBlock.TAB);
          if (i === 0) {
            index += CodeBlock.TAB.length;
          } else {
            length += CodeBlock.TAB.length;
          }
        } else if (line.domNode.textContent.startsWith(CodeBlock.TAB)) {
          line.deleteAt(0, CodeBlock.TAB.length);
          if (i === 0) {
            index -= CodeBlock.TAB.length;
          } else {
            length -= CodeBlock.TAB.length;
          }
        }
      });
      this.quill.update(Quill.sources.USER);
      this.quill.setSelection(index, length, Quill.sources.SILENT);
    },
  };
}

function makeEmbedArrowHandler(key, shiftKey) {
  const where = key === 'ArrowLeft' ? 'prefix' : 'suffix';
  return {
    key,
    shiftKey,
    altKey: null,
    [where]: /^$/,
    handler(range) {
      let { index } = range;
      if (key === 'ArrowRight') {
        index += range.length + 1;
      }
      const [leaf] = this.quill.getLeaf(index);
      if (!(leaf instanceof EmbedBlot)) return true;
      if (leaf instanceof AdditorImage) {
        leaf.showFakeCursor(false);
        return false;
      }

      if (key === 'ArrowLeft') {
        if (shiftKey) {
          this.quill.setSelection(
            range.index - 1,
            range.length + 1,
            Quill.sources.USER,
          );
        } else {
          this.quill.setSelection(range.index - 1, Quill.sources.USER);
        }
      } else if (shiftKey) {
        this.quill.setSelection(
          range.index,
          range.length + 1,
          Quill.sources.USER,
        );
      } else {
        this.quill.setSelection(
          range.index + range.length + 1,
          Quill.sources.USER,
        );
      }
      return false;
    },
  };
}

function makeFormatHandler(format) {
  return {
    key: format[0],
    shortKey: true,
    handler(range, context) {
      this.quill.format(format, !context.format[format], Quill.sources.USER);
    },
  };
}

function makeTableArrowHandler(up) {
  return {
    key: up ? 'ArrowUp' : 'ArrowDown',
    collapsed: true,
    format: ['table'],
    handler(range, context) {
      // TODO move to table module
      const key = up ? 'prev' : 'next';
      const cell = context.line;
      const targetRow = cell.parent[key];
      if (targetRow != null) {
        if (targetRow.statics.blotName === 'table-row') {
          let targetCell = targetRow.children.head;
          let cur = cell;
          while (cur.prev != null) {
            cur = cur.prev;
            targetCell = targetCell.next;
          }
          const index =
            targetCell.offset(this.quill.scroll) +
            Math.min(context.offset, targetCell.length() - 1);
          this.quill.setSelection(index, 0, Quill.sources.USER);
        }
      } else {
        const targetLine = cell.table().parent[key];
        if (targetLine != null) {
          if (up) {
            this.quill.setSelection(
              targetLine.offset(this.quill.scroll) + targetLine.length() - 1,
              0,
              Quill.sources.USER,
            );
          } else {
            this.quill.setSelection(
              targetLine.offset(this.quill.scroll),
              0,
              Quill.sources.USER,
            );
          }
        }
      }
      return false;
    },
  };
}

function normalize(binding) {
  if (typeof binding === 'string' || typeof binding === 'number') {
    binding = { key: binding };
  } else if (typeof binding === 'object') {
    binding = clone(binding, false);
  } else {
    return null;
  }
  if (binding.shortKey) {
    binding[SHORTKEY] = binding.shortKey;
    delete binding.shortKey;
  }
  return binding;
}

function tableSide(table, row, cell, offset) {
  if (row.prev == null && row.next == null) {
    if (cell.prev == null && cell.next == null) {
      return offset === 0 ? -1 : 1;
    }
    return cell.prev == null ? -1 : 1;
  } else if (row.prev == null) {
    return -1;
  } else if (row.next == null) {
    return 1;
  }
  return null;
}

export { Keyboard as default, SHORTKEY, normalize };
