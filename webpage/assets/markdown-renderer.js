document.addEventListener('DOMContentLoaded', () => {
    try {
        const mdNodes = document.querySelectorAll('script[type="text/plain"].raw-markdown');
        if (!mdNodes || mdNodes.length === 0) return;
        mdNodes.forEach(node => {
            const md = node.textContent || '';
            let html = md;
            if (typeof marked !== 'undefined') {
                try {
                    html = marked.parse(md);
                } catch (e) {
                    console.warn('marked parse failed, falling back to text', e);
                    html = '<pre>' + escapeHtml(md) + '</pre>';
                }
            }
            const clean = (typeof DOMPurify !== 'undefined') ? DOMPurify.sanitize(html) : html;
            const container = document.createElement('div');
            container.innerHTML = clean;
            node.parentNode.replaceChild(container, node);
            // render KaTeX in the replaced container
            if (typeof renderMathInElement !== 'undefined') {
                try {
                    renderMathInElement(container, {
                        delimiters: [
                            {left: '$$', right: '$$', display: true},
                            {left: '$', right: '$', display: false},
                            {left: '\\(', right: '\\)', display: false},
                            {left: '\\[', right: '\\]', display: true}
                        ],
                        throwOnError: false
                    });
                } catch (e) {
                    console.warn('KaTeX render failed', e);
                }
            }
        });
    } catch (e) {
        console.error('markdown-renderer error', e);
    }

    function escapeHtml(str) {
        return String(str || '').replace(/[&<>]/g, function(m) {
            if (m === '&') return '&amp;';
            if (m === '<') return '&lt;';
            if (m === '>') return '&gt;';
            return m;
        });
    }
});
