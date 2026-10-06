"""Bounded Mermaid gate for tutor deltas, with no dependency on HTTP framing."""

import re

MAX_SOURCE = 8000
MAX_DIAGRAMS = 4
MAX_OPENING = 256
_NOTICE = '\n图示暂未显示，已保留源码。请参考周围讲解，或让 AI 用短标签重新画图。\n\n'
_LIST = re.compile(r'^([-+*]|\d{1,9}[.)])( +)')
_EMPTY_LIST = re.compile(r'^([-+*]|\d{1,9}[.)]) *\n?$')


def _prefix(line):
    """Read quote/list prefixes; keep their scope across ordinary prose lines."""
    rest, containers = line.expandtabs(4), []
    while True:
        stripped = rest.lstrip(' ')
        indent = len(rest) - len(stripped)
        if indent > 3:
            return stripped, containers, indent
        if stripped.startswith('>'):
            containers.append(('quote', 0))
            rest = stripped[1:]
            if rest.startswith(' '):
                rest = rest[1:]
            continue
        empty_item = _EMPTY_LIST.fullmatch(stripped)
        if empty_item:
            # CommonMark gives an empty item one padding column, including when
            # its marker has no following space or several trailing spaces.
            containers.append(('list', indent + len(empty_item[1]) + 1))
            return '', containers, 0
        item = _LIST.match(stripped)
        if item:
            padding = len(item[2]) if len(item[2]) <= 4 else 1
            containers.append(('list', indent + len(item[1]) + padding))
            rest = stripped[len(item[1]) + padding:]
            continue
        return stripped, containers, indent


def _opening(line):
    """Read a fence plus its quote/list containers, without parsing its body."""
    rest, containers, indent = _prefix(line)
    fence = re.match(r'^(`{3,}|~{3,})([^\r\n]*)\n?$', rest)
    return (fence[1], containers, indent) if fence else None


class TutorRendering:
    """Create a fresh gate for each answer; validation is explicitly injected."""

    def __init__(self, validate):
        self.validate = validate

    def stream(self):
        return MermaidStream(self.validate)


class MermaidStream:
    """Pass prose immediately; hold just one bounded fenced diagram until checked.

    A line prefix waits only while it could open/close a fence. Other characters
    flow immediately. Ordinary code fences retain their own marker and length,
    so Mermaid examples inside them never trigger a renderer.
    """

    def __init__(self, validate):
        self.validate = validate
        self.mode = 'prose'
        self.line = ''
        self.marker = ''
        self.length = 0
        self.body = []
        self.size = 0
        self.diagrams = 0
        self.finished = False
        self.after_cr = False
        self.containers = []
        self.prose_containers = []

    def _container_line(self, line, *, partial=False, containers=None):
        """Return the code body line, or signal that its container has ended."""
        rest = line.expandtabs(4)
        containers = self.containers if containers is None else containers
        matched = []
        for kind, width in containers:
            if kind == 'quote':
                quote = re.match(r'^ {0,3}> ?', rest)
                if not quote:
                    if partial and not rest.strip(' ') and len(rest) <= 3:
                        return True, '', True, matched
                    return False, rest, False, matched
                rest = rest[quote.end():]
            else:
                spaces = len(rest) - len(rest.lstrip(' '))
                if spaces < width:
                    if not rest.strip():
                        return True, '', partial, containers
                    return False, rest, False, matched
                rest = rest[width:]
            matched.append((kind, width))
        return True, rest, False, matched

    def _closing(self, line):
        inside, line, _, _ = self._container_line(line)
        if not inside:
            return False
        return bool(re.fullmatch(r' {0,3}' + re.escape(self.marker) + '{' + str(self.length) + r',}[ \t]*\r?\n?', line))

    def _possible(self, line):
        if self.mode in ('code', 'degraded'):
            inside, body, ambiguous, matched = self._container_line(line, partial=True)
            if ambiguous:
                return True
            if inside:
                return bool(re.fullmatch(r' {0,3}' + re.escape(self.marker) + r'*[ \t]*\r?', body))
            # Fenced code ends when its list or quote ends, even without a closer.
            self.mode = 'prose'
            self.prose_containers = matched
            self.containers = []
        # Wait only for ambiguous Markdown prefixes. A list's actual prose flows.
        _, rest, ambiguous, matched = self._container_line(line, partial=True, containers=self.prose_containers)
        if ambiguous:
            return True
        rest, containers, indent = _prefix(rest)
        self.prose_containers = matched + containers
        if indent > 3:
            return False
        if rest in ('-', '+', '*') or re.fullmatch(r'\d{1,9}[.)]?', rest):
            return True
        if not rest:
            return True
        match = re.match(r'^(`+|~+)(.*)$', rest)
        return bool(match and (len(match[1]) >= 3 or not match[2]))

    def _downgrade(self):
        output = [self.marker * self.length + 'text\n', ''.join(self.body)]
        self.body = []
        self.size = 0
        self.mode = 'degraded'
        return output

    def _checked(self):
        source = ''.join(self.body)
        self.body = []
        self.size = 0
        try:
            report = self.validate(source)
        except Exception:
            # Failure text is deliberately generic; do not emit renderer/source details.
            report = {'status': 'unavailable'}
        if isinstance(report, dict) and report.get('status') == 'passed':
            normalized = report.get('source', source)
            if isinstance(normalized, str) and len(normalized) <= MAX_SOURCE:
                fence = self.marker * self.length
                return fence + 'mermaid\n' + normalized.rstrip('\r\n') + '\n' + fence + '\n'
        return self.marker * self.length + 'text\n' + source + self.marker * self.length + '\n' + _NOTICE

    def _complete_line(self, line):
        if self.mode == 'graph':
            if self._closing(line):
                self.mode = 'prose'
                return [self._checked()]
            self.body.append(line)
            self.size += len(line)
            return []
        if self.mode in ('code', 'degraded'):
            inside, _, _, matched = self._container_line(line)
            if not inside:
                self.mode = 'prose'
                self.prose_containers = matched
                self.containers = []
                return self._complete_line(line)
            closed = self._closing(line)
            output = [line]
            if closed:
                if self.mode == 'degraded':
                    output.append(_NOTICE)
                self.mode = 'prose'
                self.prose_containers = self.containers
                self.containers = []
            return output
        # Apply the same cap to complete lines and prefixes split across deltas.
        if len(line.rstrip('\n')) > MAX_OPENING and self._possible(line.rstrip('\n')):
            return ['\\' + line]
        _, body, _, matched = self._container_line(line, containers=self.prose_containers)
        self.prose_containers = matched
        opening = _opening(body)
        if not opening:
            _, containers, _ = _prefix(body)
            self.prose_containers = matched + containers
            return [line]
        fence, containers, indent = opening
        containers = matched + containers
        if indent > 3:
            # Four remaining spaces mean literal indented code, including inside
            # a list. Do not enter fence state or rewrite its example language.
            self.prose_containers = containers
            return [line]
        info_start = re.search(r'`{3,}|~{3,}', line).end()
        info = line[info_start:].rstrip('\n')
        if fence[0] == '`' and '`' in info:
            return [line]
        language = (info.strip().split() or [''])[0]
        if containers:
            self.mode = 'code'
            self.containers = containers
            self.marker, self.length = fence[0], len(fence)
            if language == 'mermaid':
                offset = info_start + len(info) - len(info.lstrip())
                return [line[:offset] + 'text' + line[offset + len('mermaid'):]]
            return [line]
        self.marker, self.length = fence[0], len(fence)
        self.containers = []
        if language != 'mermaid':
            self.mode = 'code'
            return [line]
        self.diagrams += 1
        self.mode = 'graph'
        if self.diagrams > MAX_DIAGRAMS:
            return self._downgrade()
        return []

    def feed(self, piece):
        if self.finished:
            raise ValueError('stream already finished')
        output = []
        # CommonMark also accepts bare CR. Canonicalize new reply line endings
        # before detection; a CRLF split across deltas still produces one LF.
        if not piece:
            return output
        original = piece
        if self.after_cr and piece.startswith('\n'):
            piece = piece[1:]
        self.after_cr = original.endswith('\r')
        piece = piece.replace('\r\n', '\n').replace('\r', '\n')
        for part in piece.splitlines(keepends=True):
            # Unicode splitlines boundaries are not CommonMark line endings.
            newline = part.endswith('\n')
            if self.line is None:
                output.append(part)
                if newline:
                    self.line = ''
                continue
            self.line += part
            possible_close = (self.mode == 'graph' and len(self.line) <= MAX_OPENING
                              and bool(re.fullmatch(r' {0,3}' + re.escape(self.marker)
                                                    + r'*[ \t]*\r?', self.line)))
            if (self.mode == 'graph' and self.size + len(self.line) > MAX_SOURCE
                    and not possible_close and not (newline and self._closing(self.line))):
                output.extend(self._downgrade())
                output.append(self.line)
                self.line = '' if newline else None
                continue
            if newline:
                output.extend(self._complete_line(self.line))
                self.line = ''
            elif self.mode != 'graph' and not self._possible(self.line):
                output.append(self.line)
                self.line = None
            elif self.mode == 'prose' and len(self.line) > MAX_OPENING:
                # An unbounded opening line must not become an unchecked diagram.
                output.append('\\' + self.line)
                self.line = None
        return [text for text in output if text]

    def finish(self, *, interrupted=False):
        if self.finished:
            return []
        self.finished = True
        output = []
        if self.line:
            if self.mode == 'graph' and self._closing(self.line) and not interrupted:
                self.mode = 'prose'
                output.append(self._checked())
            elif self.mode == 'graph':
                if not self._closing(self.line):
                    self.body.append(self.line)
            else:
                output.extend(self._complete_line(self.line))
        if self.mode == 'graph':
            output.extend(self._downgrade())
            output.extend(['\n' + self.marker * self.length + '\n', _NOTICE])
        elif self.mode == 'degraded':
            output.extend(['\n' + self.marker * self.length + '\n', _NOTICE])
        return [text for text in output if text]
