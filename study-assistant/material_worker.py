"""Untrusted document parser. Run only through material_parser's sandbox in production.

Uploaded paths are never extracted to disk or executed. Fixed system converters
receive generated temporary paths; archive members remain bounded byte buffers.
"""
import base64
import io
import json
from pathlib import PurePosixPath, Path
import re
import resource
import stat
import struct
import subprocess
import sys
import tempfile
import warnings
import zipfile
import unicodedata
import zlib

MAX_BYTES = 10 * 1024 * 1024
MAX_EXPANDED = 50 * 1024 * 1024
MAX_TEXT = 200_000
MAX_FILES = 100
DOCS = {'txt', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
        'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff'}
IMAGES = DOCS - {'txt', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'}


class Invalid(ValueError):
    pass


def zip_name(entry):
    """Prefer declared Unicode, then recover common unmarked UTF-8/Chinese ZIPs."""
    # Python 3.14 may already apply Unicode Path extras to filename, whereas
    # older deployment runtimes leave it as CP437. orig_filename keeps raw text.
    name = entry.orig_filename
    if '\x00' in name:
        raise Invalid('ZIP 文件名包含无效字符')
    if not entry.flag_bits & 0x800:
        raw = name.encode('cp437')
        extra = entry.extra
        while len(extra) >= 4:
            kind, length = struct.unpack_from('<HH', extra)
            field, extra = extra[4:4 + length], extra[4 + length:]
            if kind == 0x7075 and len(field) >= 5 and field[0] == 1:
                if struct.unpack_from('<I', field, 1)[0] == zlib.crc32(raw):
                    try:
                        return unicodedata.normalize('NFC', field[5:].decode('utf-8'))
                    except UnicodeError:
                        pass
        for encoding in ('utf-8', 'gb18030'):
            try:
                name = raw.decode(encoding)
                break
            except UnicodeError:
                continue
    return unicodedata.normalize('NFC', name)


def incidental_file(name):
    """Only recognized office lock/recovery files and desktop metadata are skipped."""
    leaf = PurePosixPath(name).name.casefold()
    return (leaf in ('.ds_store', 'thumbs.db', 'desktop.ini') or leaf.startswith('._')
            or (leaf.startswith('~$') and PurePosixPath(leaf).suffix in
                ('.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'))
            or re.fullmatch(r'~wrl[0-9a-f]+\.tmp', leaf) is not None)


def safe_name(name):
    if not isinstance(name, str) or not name or len(name) > 400:
        raise Invalid('文件名称无效')
    if any(ord(c) < 32 for c in name) or '\\' in name or ':' in name:
        raise Invalid('文件包含不安全路径：' + name[:100])
    path = PurePosixPath(name)
    if path.is_absolute() or any(p in ('', '.', '..') for p in name.rstrip('/').split('/')):
        raise Invalid('拒绝压缩包路径穿越：' + name[:100])
    return path.suffix.lower().lstrip('.')


def check_entries(entries, packed_size, office=False):
    """Validate every member before any decompression, including directories."""
    if len(entries) > (1000 if office else 200):
        raise Invalid('压缩包成员过多')
    names, size, count, skipped = set(), 0, 0, []
    for name, length, directory, special, encrypted in entries:
        ext = safe_name(name)
        if name.casefold().rstrip('/') in names or special or encrypted:
            raise Invalid('拒绝重复路径、链接、特殊文件或加密文件：' + name)
        names.add(name.casefold().rstrip('/'))
        if directory:
            continue
        size += length
        if length < 0 or length > MAX_BYTES or size > MAX_EXPANDED:
            raise Invalid('压缩包展开体积超限（单文件 10 MB，合计 50 MB）')
        if not office and incidental_file(name):
            skipped.append(name)
            continue
        count += 1
        if not office and ext not in DOCS:
            raise Invalid('压缩包含不支持的文件（不允许程序、脚本或嵌套压缩包）：' + name)
        if office and any(s in name.lower() for s in ('vbaproject', 'macros/', 'embeddings/', 'activex/')):
            raise Invalid('不接受包含宏、嵌入对象或 ActiveX 的 Office 文件')
    if size > max(packed_size, 1) * 200:
        raise Invalid('压缩比过高，请解压后分批上传')
    if not office and count > MAX_FILES:
        raise Invalid('压缩包最多包含 100 个资料文件')
    return skipped


def zip_members(data, office=False, skipped=None):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries = archive.infolist()
        names = [zip_name(e) for e in entries]
        ignored = check_entries([(name, e.file_size, e.is_dir(),
                        stat.S_IFMT(e.external_attr >> 16) not in (0, stat.S_IFREG, stat.S_IFDIR),
                        bool(e.flag_bits & 1)) for e, name in zip(entries, names)], len(data), office)
        if skipped is not None:
            skipped.extend(ignored)
        result = {}
        for entry, name in zip(entries, names):
            if not entry.is_dir() and name not in ignored:
                with archive.open(entry) as stream:
                    content = stream.read(MAX_BYTES + 1)
                if len(content) != entry.file_size or len(content) > MAX_BYTES:
                    raise Invalid('压缩包实际体积与目录不一致')
                result[name] = content
        return result


def seven_members(data, skipped=None):
    import py7zr
    from py7zr.io import Py7zIO, WriterFactory

    class Buffer(Py7zIO):
        def __init__(self, factory):
            self.value = io.BytesIO()
            self.factory = factory
        def write(self, chunk):
            if self.value.tell() + len(chunk) > MAX_BYTES:
                raise Invalid('7Z 展开文件超限')
            growth = max(0, self.value.tell() + len(chunk) - self.size())
            self.factory.total += growth
            if self.factory.total > MAX_EXPANDED:
                raise Invalid('7Z 实际展开总量超过 50 MB')
            return self.value.write(chunk)
        def read(self, size=None):
            return self.value.read(-1 if size is None else size)
        def seek(self, offset, whence=0):
            if offset < 0 or offset > MAX_BYTES:
                raise Invalid('7Z 偏移量无效')
            return self.value.seek(offset, whence)
        def flush(self):
            pass
        def size(self):
            return len(self.value.getbuffer())

    class Factory(WriterFactory):
        def __init__(self, allowed):
            self.files = {}
            self.total = 0
            self.allowed = allowed
        def create(self, filename):
            if filename not in self.allowed or filename in self.files:
                raise Invalid('7Z 成员路径无效')
            buf = Buffer(self)
            self.files[filename] = buf
            return buf

    with py7zr.SevenZipFile(io.BytesIO(data), mode='r') as archive:
        if archive.needs_password():
            raise Invalid('不支持加密压缩包')
        entries = list(archive.files)
        ignored = check_entries([(e.filename, e.uncompressed, e.is_directory,
                        not (e.is_file or e.is_directory),
                        False) for e in entries], len(data))
        if skipped is not None:
            skipped.extend(ignored)
        allowed = {e.filename: e.uncompressed for e in entries if not e.is_directory and e.filename not in ignored}
        factory = Factory(allowed)
        if allowed:
            archive.extract(targets=list(allowed), factory=factory)
        result = {name: buf.value.getvalue() for name, buf in factory.files.items()}
        if set(result) != set(allowed) or any(len(result[n]) != allowed[n] for n in result):
            raise Invalid('7Z 实际成员与目录不一致')
        return result


def command(args):
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=30, check=True)
    if len(result.stdout) > MAX_TEXT * 8:
        raise Invalid('提取文本超限')
    return result.stdout.decode('utf-8', errors='strict')


def ocr(data):
    from PIL import Image
    Image.MAX_IMAGE_PIXELS = 16_000_000
    with warnings.catch_warnings():
        warnings.simplefilter('error', Image.DecompressionBombWarning)
        with Image.open(io.BytesIO(data)) as picture:
            if getattr(picture, 'n_frames', 1) != 1:
                raise Invalid('请将多帧图片拆分为单张图片')
            if picture.width * picture.height > 16_000_000:
                raise Invalid('图片不能超过 1600 万像素')
            picture.load()
            with tempfile.TemporaryDirectory() as directory:
                source = Path(directory) / 'image.png'
                picture.convert('RGB').save(source)
                return command(['/usr/bin/tesseract', str(source), 'stdout', '-l', 'chi_sim+eng'])


def pdf_text(data):
    from pypdf import PdfReader
    reader = PdfReader(io.BytesIO(data))
    if reader.is_encrypted:
        raise Invalid('不支持加密 PDF')
    if len(reader.pages) > 200:
        raise Invalid('单个 PDF 最多 200 页，请拆分上传')
    pages, scanned = [], 0
    with tempfile.TemporaryDirectory() as directory:
        source = Path(directory) / 'input.pdf'
        source.write_bytes(data)
        for index, page in enumerate(reader.pages):
            text = page.extract_text() or ''
            if not text.strip():
                scanned += 1
                if scanned > 40:
                    raise Invalid('单个 PDF 最多识别 40 页扫描页，请拆分上传')
                prefix = str(Path(directory) / 'page')
                command(['/usr/bin/pdftoppm', '-f', str(index + 1), '-l', str(index + 1),
                         '-scale-to', '2200', '-singlefile', '-png', str(source), prefix])
                text = ocr(Path(prefix + '.png').read_bytes())
            if not text.strip():
                raise Invalid('PDF 第 %d 页未识别出文字，请提供清晰资料' % (index + 1))
            pages.append('第 %d 页\n%s' % (index + 1, text))
            if sum(map(len, pages)) > MAX_TEXT:
                raise Invalid('PDF 文本超限')
    return '\n\n'.join(pages)


def office_text(data, ext):
    from defusedxml import ElementTree as ET
    members = zip_members(data, office=True)
    content_types = members.get('[Content_Types].xml', b'')
    if b'macroenabled' in content_types.lower() or b'vbaproject' in content_types.lower():
        raise Invalid('不接受包含宏的 Office 文件')
    ET.fromstring(content_types)
    if ext == 'docx':
        selected = [n for n in members if n == 'word/document.xml' or re.fullmatch(r'word/(header|footer)\d+\.xml', n)]
    elif ext == 'pptx':
        selected = sorted((n for n in members if re.fullmatch(r'ppt/slides/slide\d+\.xml', n)),
                          key=lambda n: int(re.search(r'(\d+)\.xml', n).group(1)))
    else:
        if 'xl/workbook.xml' not in members:
            raise Invalid('文件内容不是 Excel 工作簿')
        import openpyxl
        workbook = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True, keep_links=False)
        chunks, length, has_values = [], 0, False
        try:
            for sheet in workbook:
                chunks.append(sheet.title)
                for row in sheet.iter_rows(values_only=True):
                    text = '\t'.join('' if v is None else str(v) for v in row)
                    length += len(text)
                    if length > MAX_TEXT:
                        raise Invalid('Excel 文本超限')
                    if text.strip():
                        has_values = True
                        chunks.append(text)
        finally:
            workbook.close()
        if not has_values:
            raise Invalid('工作簿没有已保存的单元格值；公式请先在 Office 中计算并保存')
        return '\n'.join(chunks)
    if not selected or (ext == 'docx' and 'word/document.xml' not in members):
        raise Invalid('Office 扩展名与实际内容不符')
    parts = []
    for name in selected:
        root = ET.fromstring(members[name])
        paragraphs = [''.join(t.text or '' for t in p.iter() if t.tag.endswith('}t'))
                      for p in root.iter() if p.tag.endswith('}p')]
        parts.append('\n'.join(paragraphs))
    return '\n\n'.join(parts)


def legacy_text(data, ext):
    import olefile
    with olefile.OleFileIO(io.BytesIO(data)) as ole:
        paths = ['/'.join(p).lower() for p in ole.listdir()]
        if any(any(x in p for x in ('vba', 'macros', 'objectpool')) for p in paths):
            raise Invalid('不接受包含宏或嵌入对象的 Office 文件')
        expected = {'doc': ['worddocument'], 'xls': ['workbook', 'book'], 'ppt': ['powerpoint document']}[ext]
        if not any(p in paths for p in expected):
            raise Invalid('Office 扩展名与实际内容不符')
    if ext == 'xls':
        import xlrd
        book = xlrd.open_workbook(file_contents=data, on_demand=True)
        try:
            lines, length = [], 0
            for sheet in book.sheets():
                lines.append(sheet.name)
                for i in range(sheet.nrows):
                    line = '\t'.join(str(v) for v in sheet.row_values(i))
                    length += len(line)
                    if length > MAX_TEXT:
                        raise Invalid('Excel 文本超限')
                    lines.append(line)
            return '\n'.join(lines)
        finally:
            book.release_resources()
    with tempfile.TemporaryDirectory() as directory:
        source = Path(directory) / ('input.' + ext)
        source.write_bytes(data)
        args = ['/usr/bin/antiword', '-m', 'UTF-8.txt'] if ext == 'doc' else ['/usr/bin/catppt', '-d', 'utf-8']
        return command(args + [str(source)])


def parse_document(name, data):
    ext = safe_name(name)
    if ext not in DOCS:
        raise Invalid('不支持的资料格式：' + name)
    if not data or len(data) > MAX_BYTES:
        raise Invalid('文件为空或超过 10 MB：' + name)
    if data.startswith((b'MZ', b'\x7fELF', b'#!', b'\xcf\xfa\xed\xfe', b'\xfe\xed\xfa', b'\xca\xfe\xba\xbe')):
        raise Invalid('拒绝可执行文件或脚本：' + name)
    if ext == 'txt':
        text = None
        encodings = ['utf-16'] if data.startswith((b'\xff\xfe', b'\xfe\xff')) else ['utf-8-sig', 'gb18030']
        for encoding in encodings:
            try:
                text = data.decode(encoding)
                break
            except UnicodeError:
                continue
        if text is None or any(ord(c) < 32 and c not in '\n\r\t' for c in text):
            raise Invalid('TXT 不是可识别的纯文本：' + name)
    elif ext == 'pdf':
        if not data.startswith(b'%PDF-'):
            raise Invalid('PDF 扩展名与内容不符')
        text = pdf_text(data)
    elif ext in ('docx', 'xlsx', 'pptx'):
        text = office_text(data, ext)
    elif ext in ('doc', 'xls', 'ppt'):
        text = legacy_text(data, ext)
    else:
        text = ocr(data)
    text = text.strip()
    if not text:
        raise Invalid('未识别出文字，请提供清晰的文字资料：' + name)
    if len(text) > MAX_TEXT:
        raise Invalid('资料文本超过 20 万字，请拆分上传：' + name)
    return {'name': name, 'text': text, 'characters': len(text)}


def parse(name, data, skipped=None):
    ext = safe_name(name)
    if len(data) > MAX_BYTES:
        raise Invalid('单个文件不能超过 10 MB')
    if ext in ('zip', '7z'):
        members = zip_members(data, skipped=skipped) if ext == 'zip' else seven_members(data, skipped=skipped)
        if not members:
            raise Invalid('压缩包没有可读取的资料')
        result = []
        for child, content in members.items():
            result.append(parse_document(child, content))
            if sum(len(x['text']) for x in result) > MAX_TEXT:
                raise Invalid('压缩包文本合计超过 20 万字，请拆分上传')
        for item in result:
            item['name'] = name + '/' + item['name']
        return result
    return [parse_document(name, data)]


def main():
    resource.setrlimit(resource.RLIMIT_AS, (768 * 1024 * 1024,) * 2)
    resource.setrlimit(resource.RLIMIT_CPU, (80, 80))
    resource.setrlimit(resource.RLIMIT_FSIZE, (60 * 1024 * 1024,) * 2)
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
    try:
        request = json.loads(sys.stdin.buffer.read(14 * 1024 * 1024))
        data = base64.b64decode(request['data'], validate=True)
        skipped = []
        result = {'materials': parse(request['name'], data, skipped), 'skipped': skipped}
    except Invalid as error:
        result = {'error': str(error)}
    except Exception:
        result = {'error': '文件损坏、类型不符或解析失败，请检查文件后重试'}
    sys.stdout.write(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
