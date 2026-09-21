"""Private screenshot worker; reads only allowlisted local rendering assets."""
import base64
import json
import mimetypes
from pathlib import Path
import sys
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright


def capture(source, config):
    site = Path(config['site']).resolve()
    shared = (site / 'learn/assets').resolve()
    katex = (site / 'diagram-design/learning-path/katex').resolve()
    images, errors, complete = [], [], True
    with sync_playwright() as runtime:
        browser = runtime.chromium.launch(headless=True)
        try:
            for width in (960, 390):
                page = browser.new_page(viewport={'width': width, 'height': 1000}, device_scale_factor=1)
                page.on('pageerror', lambda error: errors.append('渲染脚本错误'))
                def route(request):
                    url = urlsplit(request.request.url)
                    base = shared if url.path.startswith('/learn/assets/') else katex if url.path.startswith('/katex/') else None
                    relative = url.path.split('/assets/', 1)[-1] if base == shared else url.path.split('/katex/', 1)[-1]
                    file = (base / relative).resolve() if base else None
                    if url.netloc != 'render.local' or not base or not file.is_relative_to(base) or not file.is_file():
                        request.abort()
                        return
                    request.fulfill(body=file.read_bytes(), content_type=mimetypes.guess_type(str(file))[0] or 'application/octet-stream')
                page.route('**/*', route)
                page.set_content('''<!doctype html><meta charset="utf-8"><base href="http://render.local/"><link rel="stylesheet" href="http://render.local/learn/assets/markdown.css">
<link rel="stylesheet" href="http://render.local/katex/katex.min.css"><style>body{margin:20px;font:16px sans-serif} .katex-display{overflow-x:auto}</style>
<script src="http://render.local/learn/assets/vendor-markdown-it.js"></script><script src="http://render.local/katex/katex.min.js"></script>
<script src="http://render.local/learn/assets/markdown.js"></script><main></main>''', wait_until='load')
                page.evaluate('''async source => {const root=document.querySelector('main');root.innerHTML=LearnMarkdown.render(source);await LearnMarkdown.enhance(root);await document.fonts.ready;}''', source)
                errors.extend(page.evaluate('''() => Array.from(document.querySelectorAll('.md-math-fallback,[data-diagram="failed"],.md-fallback')).map(el=>el.textContent.slice(0,180))'''))
                height = page.evaluate('document.documentElement.scrollHeight')
                if height > 10000:
                    complete = False
                    break
                for top in range(0, height, 1000):
                    image = page.screenshot(type='jpeg', quality=80, clip={'x':0,'y':top,'width':width,'height':min(1000,height-top)}, full_page=True)
                    images.append('data:image/jpeg;base64,' + base64.b64encode(image).decode())
                page.close()
        finally:
            browser.close()
    if sum(map(len, images)) > 8 * 1024 * 1024:
        images, complete = [], False
    return {'images': images, 'errors': list(dict.fromkeys(errors)), 'complete': complete}


if __name__ == '__main__':
    config = json.loads(Path(sys.argv[1]).read_text())
    source = json.load(sys.stdin)['source']
    if len(source) > 80000:
        raise ValueError('render input too long')
    print(json.dumps(capture(source, config)))
