window.renderMarkdownWithMath = function(markdown) {
    const source = String(markdown || '');
    if (typeof marked === 'undefined') {
        return '<pre>' + escapeHtml(source) + '</pre>';
    }

    marked.setOptions({
        breaks: true,
        gfm: true,
        headerIds: false,
        mangle: false
    });

    const formulas = [];
    const placeholderPrefix = 'CBCMATHPLACEHOLDER';
    let prefix = placeholderPrefix;
    while (source.includes(prefix)) prefix += 'X';

    let protectedMarkdown = source.replace(
        /\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)/g,
        formula => {
            const placeholder = `${prefix}${formulas.length}TOKEN`;
            formulas.push(formula);
            return placeholder;
        }
    );
    protectedMarkdown = protectedMarkdown.replace(/\$([^\n$]*?)\$/g, formula => {
        const placeholder = `${prefix}${formulas.length}TOKEN`;
        formulas.push(formula);
        return placeholder;
    });

    let html = marked.parse(protectedMarkdown);
    if (typeof DOMPurify !== 'undefined') html = DOMPurify.sanitize(html);

    formulas.forEach((formula, index) => {
        const placeholder = `${prefix}${index}TOKEN`;
        html = html.replaceAll(placeholder, () => escapeMathFormula(formula));
    });
    return html;
};

document.addEventListener('DOMContentLoaded', () => {
    try {
        const mdNodes = document.querySelectorAll('script[type="text/plain"].raw-markdown');
        mdNodes.forEach(node => {
            const container = document.createElement('div');
            container.innerHTML = window.renderMarkdownWithMath(node.textContent || '');
            node.parentNode.replaceChild(container, node);

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
});

function escapeHtml(str) {
    return String(str || '').replace(/[&<>]/g, character => {
        if (character === '&') return '&amp;';
        if (character === '<') return '&lt;';
        return '&gt;';
    });
}

function escapeMathFormula(formula) {
    return formula.replace(/[<>]/g, character => character === '<' ? '&lt;' : '&gt;');
}
