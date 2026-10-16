function appendSeparator(navigation) {
    const separator = document.createElement('span');
    separator.setAttribute('aria-hidden', 'true');
    separator.textContent = '/';
    navigation.append(separator);
}

function appendLink(navigation, href, label) {
    const link = document.createElement('a');
    link.href = href;
    link.textContent = label;
    navigation.append(link);
}

function appendCurrentPage(navigation, label) {
    const current = document.createElement('span');
    current.setAttribute('aria-current', 'page');
    current.textContent = label;
    navigation.append(current);
}

export function initializeDocumentationBreadcrumb(agentName, {
    overviewHref = '../../docs/index.html',
    overviewLabel = 'Explorer overview',
    includeAgentLevel = true
} = {}) {
    const header = document.querySelector('.site-header');
    if (!agentName || !header || header.querySelector('nav.breadcrumbs[aria-label="Breadcrumb"]')) return;

    const heading = document.querySelector('main h1');
    if (!heading) return;

    const currentFile = window.location.pathname.split('/').pop() || 'index.html';
    const navigation = document.createElement('nav');
    navigation.className = 'breadcrumbs';
    navigation.setAttribute('aria-label', 'Breadcrumb');

    if (!includeAgentLevel) {
        if (currentFile === 'index.html') {
            appendCurrentPage(navigation, overviewLabel);
        } else {
            appendLink(navigation, overviewHref, overviewLabel);
            appendSeparator(navigation);
            appendCurrentPage(navigation, heading.textContent.trim());
        }
    } else {
        appendLink(navigation, overviewHref, overviewLabel);
        appendSeparator(navigation);
        if (currentFile === 'index.html') {
            appendCurrentPage(navigation, agentName);
        } else {
            appendLink(navigation, 'index.html', agentName);
            appendSeparator(navigation);
            appendCurrentPage(navigation, heading.textContent.trim());
        }
    }

    document.querySelectorAll('.breadcrumbs').forEach((breadcrumb) => breadcrumb.remove());
    const brand = header.querySelector('.site-header__brand');
    if (brand) {
        brand.replaceWith(navigation);
        return;
    }
    header.prepend(navigation);
}
