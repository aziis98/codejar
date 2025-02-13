type Options = {
  tab: string
}

export class CodeJar {
  private readonly editor: HTMLElement
  private readonly highlight: (e: HTMLElement) => void
  private readonly listeners: [string, any][] = []
  private options: Options
  private history: HistoryRecord[] = []
  private at = -1
  private focus = false
  private callback?: (code: string) => void

  constructor(editor: HTMLElement, highlight: (e: HTMLElement) => void, options: Partial<Options> = {}) {
    this.editor = editor
    this.highlight = highlight
    this.options = {
      tab: "\t",
      ...options
    }

    this.editor.setAttribute("contentEditable", "true")
    this.editor.setAttribute("spellcheck", "false")
    this.editor.style.outline = "none"
    this.editor.style.overflowWrap = "break-word"
    this.editor.style.overflowY = "auto"
    this.editor.style.resize = "vertical"
    this.editor.style.whiteSpace = "pre-wrap"

    this.highlight(this.editor)
    const debounceHighlight = debounce(() => {
      const pos = this.save()
      this.highlight(this.editor)
      this.restore(pos)
    }, 30)

    let recording = false
    const shouldRecord = (event: KeyboardEvent): boolean => {
      return !isUndo(event) && !isRedo(event)
        && event.key !== "Meta"
        && event.key !== "Control"
        && event.key !== "Alt"
        && !event.key.startsWith("Arrow")
    }
    const debounceRecordHistory = debounce((event: KeyboardEvent) => {
      if (shouldRecord(event)) {
        this.recordHistory()
        recording = false
      }
    }, 300)

    const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (event: HTMLElementEventMap[K]) => void) => {
      this.listeners.push([type, fn])
      this.editor.addEventListener(type, fn)
    }

    on("keydown", event => {
      this.handleNewLine(event)
      this.handleTabCharacters(event)
      this.handleJumpToBeginningOfLine(event)
      this.handleSelfClosingCharacters(event)
      this.handleUndoRedo(event)
      if (shouldRecord(event) && !recording) {
        this.recordHistory()
        recording = true
      }
    })

    on("keyup", event => {
      debounceHighlight()
      debounceRecordHistory(event)
      if (this.callback) this.callback(this.toString())
    })

    on("focus", _event => {
      this.focus = true
    })

    on("blur", _event => {
      this.focus = false
    })

    on("paste", event => {
      this.recordHistory()
      this.handlePaste(event)
      this.recordHistory()
      if (this.callback) this.callback(this.toString())
    })
  }

  destroy() {
    for (let [type, fn] of this.listeners) {
      this.editor.removeEventListener(type, fn)
    }
  }

  /**
   * Visits all elements inside this.editor
   * @param visitor visitor function
   */
  private visit(visitor: (el: Node) => 'stop' | undefined) {
    const queue: Node[] = []

    if (this.editor.firstChild) queue.push(this.editor.firstChild)

    let el = queue.pop()

    while (el) {
      if (visitor(el) === 'stop')
        break

      if (el.nextSibling) queue.push(el.nextSibling)
      if (el.firstChild) queue.push(el.firstChild)

      el = queue.pop()
    }
  }

  private save(): Position {
    const s = window.getSelection()!
    const pos: Position = { start: 0, end: 0, direction: undefined }

    this.visit(el => {
      if (el === s.anchorNode && el === s.focusNode) {
        pos.start += s.anchorOffset
        pos.end += s.focusOffset
        pos.direction = s.anchorOffset < s.focusOffset ? '->' : '<-'
        return 'stop'
      }
      if (el === s.anchorNode) {
        pos.start += s.anchorOffset
        if (!pos.direction) {
          pos.direction = '->'
        }
        else {
          return 'stop'
        }
      }
      else if (el === s.focusNode) {
        pos.end += s.focusOffset
        if (!pos.direction) {
          pos.direction = '<-'
        }
        else {
          return 'stop'
        }
      }

      if (el.nodeType === Node.TEXT_NODE) {
        if (pos.direction != '->') pos.start += el.nodeValue!.length
        if (pos.direction != '<-') pos.end += el.nodeValue!.length
      }
    })

    return pos
  }

  private restore(pos: Position) {

    let current = 0
    let startNode: Node, endNode: Node
    let startOffset = 0, endOffset = 0

    if (!pos.direction) pos.direction = '->'
    if (pos.start < 0) pos.start = 0
    if (pos.end < 0) pos.end = 0

    // Flip start and end if direction is reversed.
    if (pos.direction == '<-') {
      const { start, end } = pos
      pos.start = end
      pos.end = start
    }

    this.visit(el => {

      if (el.nodeType !== Node.TEXT_NODE) return

      const len = (el.nodeValue || "").length

      if (current + len >= pos.start) {
        if (!startNode) {
          startNode = el
          startOffset = pos.start - current
        }
        if (current + len >= pos.end) {
          endNode = el
          endOffset = pos.end - current

          return 'stop'
        }
      }

      current += len
    })

    // Flip back the selection
    if (pos.direction == '<-') {
      [startNode, startOffset, endNode, endOffset] = [endNode!, endOffset, startNode!, startOffset]
    }

    getSelection()!.setBaseAndExtent(startNode!, startOffset, endNode!, endOffset)
  }

  private beforeCursor() {
    const s = window.getSelection()!
    const r0 = s.getRangeAt(0)
    const r = document.createRange()
    r.selectNodeContents(this.editor)
    r.setEnd(r0.startContainer, r0.startOffset)
    return r.toString()
  }

  private afterCursor() {
    const s = window.getSelection()!
    const r0 = s.getRangeAt(0)
    const r = document.createRange()
    r.selectNodeContents(this.editor)
    r.setStart(r0.endContainer, r0.endOffset)
    return r.toString()
  }

  private handleNewLine(event: KeyboardEvent) {
    if (event.key === "Enter") {
      event.preventDefault()
      const before = this.beforeCursor()
      const after = this.afterCursor()
      let [padding] = findPadding(before)
      let doublePadding = padding
      if (before[before.length - 1] === "{") doublePadding += this.options.tab
      let text = "\n" + doublePadding
      // Add an extra newline, otherwise Enter will not work at the end.
      if (after.length === 0) text += "\n"
      document.execCommand("insertHTML", false, text)
      if (after[0] === "}") {
        const pos = this.save()
        document.execCommand("insertHTML", false, "\n" + padding)
        this.restore(pos)
      }
    }
  }

  private handleSelfClosingCharacters(event: KeyboardEvent) {
    const open = `([{'"`
    const close = `)]}'"`
    const codeAfter = this.afterCursor()
    const pos = this.save()
    if (close.includes(event.key) && codeAfter.substr(0, 1) === event.key) {
      event.preventDefault()
      pos.start = ++pos.end
      this.restore(pos)
    } else if (open.includes(event.key)) {
      event.preventDefault()
      const text = event.key + close[open.indexOf(event.key)]
      document.execCommand("insertText", false, text)
      pos.start = ++pos.end
      this.restore(pos)
    }
  }

  private handleTabCharacters(event: KeyboardEvent) {
    if (event.key === "Tab") {
      event.preventDefault()
      if (event.shiftKey) {
        const before = this.beforeCursor()
        let [padding, start,] = findPadding(before)
        if (padding.length > 0) {
          const pos = this.save()
          // Remove full length tab or just remaining padding
          const len = Math.min(this.options.tab.length, padding.length)
          this.restore({start, end: start + len})
          document.execCommand("delete")
          pos.start -= len
          pos.end -= len
          this.restore(pos)
        }
      } else {
        document.execCommand("insertText", false, this.options.tab)
      }
    }
  }

  private handleJumpToBeginningOfLine(event: KeyboardEvent) {
    if (event.key === "ArrowLeft" && event.metaKey) {
      event.preventDefault()
      const before = this.beforeCursor()
      let [padding, start, end] = findPadding(before)
      if (before.endsWith(padding)) {
        if (event.shiftKey) {
          const pos = this.save()
          this.restore({start, end: pos.end}) // Select from line start.
        } else {
          this.restore({start, end: start}) // Jump to line start.
        }
      } else {
        if (event.shiftKey) {
          const pos = this.save()
          this.restore({start: end, end: pos.end}) // Select from beginning of text.
        } else {
          this.restore({start: end, end}) // Jump to beginning of text.
        }
      }
    }
  }

  private handleUndoRedo(event: KeyboardEvent) {
    if (isUndo(event)) {
      event.preventDefault()
      this.at--
      const record = this.history[this.at]
      if (record) {
        this.editor.innerHTML = record.html
        this.restore(record.pos)
      }
      if (this.at < 0) this.at = 0
    }
    if (isRedo(event)) {
      event.preventDefault()
      this.at++
      const record = this.history[this.at]
      if (record) {
        this.editor.innerHTML = record.html
        this.restore(record.pos)
      }
      if (this.at >= this.history.length) this.at--
    }
  }

  private recordHistory() {
    if (!this.focus) return

    const html = this.editor.innerHTML
    const pos = this.save()

    const lastRecord = this.history[this.at]
    if (lastRecord) {
      if (lastRecord.html === html
        && lastRecord.pos.start === pos.start
        && lastRecord.pos.end === pos.end) return
    }

    this.at++
    this.history[this.at] = {html, pos}
    this.history.splice(this.at + 1)

    const maxHistory = 300
    if (this.at > maxHistory) {
      this.at = maxHistory
      this.history.splice(0, 1)
    }
  }

  private handlePaste(event: ClipboardEvent) {
    event.preventDefault()
    const text = ((event as any).originalEvent || event).clipboardData.getData("text/plain")
    const pos = this.save()
    document.execCommand("insertText", false, text)
    let html = this.editor.innerHTML
    html = html
      .replace(/<div>/g, "\n")
      .replace(/<br>/g, "")
      .replace(/<\/div>/g, "")
    this.editor.innerHTML = html
    this.highlight(this.editor)
    this.restore({start: pos.end + text.length, end: pos.end + text.length})
  }

  updateOptions(options: Partial<Options>) {
    this.options = {...this.options, ...options}
  }

  updateCode(code: string) {
    this.editor.textContent = code
    this.highlight(this.editor)
  }

  onUpdate(callback: (code: string) => void) {
    this.callback = callback
  }

  toString() {
    return this.editor.textContent || ""
  }
}

function isCtrl(event: KeyboardEvent) {
  return event.metaKey || event.ctrlKey
}

function isUndo(event: KeyboardEvent) {
  return isCtrl(event) && !event.shiftKey && event.code === "KeyZ"
}

function isRedo(event: KeyboardEvent) {
  return isCtrl(event) && event.shiftKey && event.code === "KeyZ"
}

type HistoryRecord = {
  html: string
  pos: Position
}

type Position = {
  start: number
  end: number
  direction?: '->' | '<-' | undefined
}

function debounce(cb: any, wait: number) {
  let timeout = 0
  return (...args: any) => {
    clearTimeout(timeout)
    timeout = window.setTimeout(() => cb(...args), wait)
  }
}

function findPadding(text: string): [string, number, number] {
  // Find beginning of previous line.
  let i = text.length - 1
  while (i >= 0 && text[i] !== "\n") i--
  i++
  // Find padding of the line.
  let j = i
  while (j < text.length && /[ \t]/.test(text[j])) j++
  return [text.substring(i, j) || "", i, j]
}
