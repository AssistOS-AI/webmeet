import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_PORT = Number.parseInt(process.env.PORT || '7000', 10);
const MCP_PORT = Number.parseInt(process.env.WEBMEET_MCP_PORT || '7001', 10);
const API_PORT = Number.parseInt(process.env.WEBMEET_API_PORT || '8791', 10);
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_DIR = path.join(ROOT_DIR, 'IDE-plugins/webmeet-tool-button');
const PUBLIC_ASSET_ROOTS = [
    path.join(PLUGIN_DIR, 'components/webmeet-dashboard-modal'),
    path.join(PLUGIN_DIR, 'components/webmeet-participant-card'),
    path.join(PLUGIN_DIR, 'vendor')
];

const CONTENT_TYPES = new Map([
    ['.css', 'text/css; charset=utf-8'],
    ['.html', 'text/html; charset=utf-8'],
    ['.js', 'application/javascript; charset=utf-8'],
    ['.json', 'application/json; charset=utf-8'],
    ['.svg', 'image/svg+xml'],
    ['.png', 'image/png'],
    ['.woff2', 'font/woff2']
]);

function writeResponse(res, status, body, headers = {}) {
    const buffer = Buffer.from(String(body || ''));
    res.writeHead(status, {
        'Content-Length': buffer.length,
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        ...headers
    });
    res.end(buffer);
}

function htmlEscape(value) {
    return String(value || '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function readPloinkyAuthInfo(req) {
    const raw = String(req.headers?.['x-ploinky-auth-info'] || '').trim();
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw);
        const user = parsed?.user && typeof parsed.user === 'object' ? parsed.user : null;
        const roles = Array.isArray(user?.roles) ? user.roles.map((role) => String(role || '').trim()) : [];
        const sessionId = String(parsed?.sessionId || '').trim();
        const id = String(user?.id || '').trim();
        return id && sessionId ? { user: { ...user, roles }, sessionId } : null;
    } catch {
        return null;
    }
}

function requirePloinkyIdentity(req, res) {
    if (readPloinkyAuthInfo(req)) {
        return true;
    }
    writeResponse(res, 401, JSON.stringify({ error: 'Ploinky guest session required.' }), {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
    });
    return false;
}

function sendGuestPage(req, res) {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const meetingId = String(url.searchParams.get('room') || '').trim();
    const guestToken = String(url.searchParams.get('token') || '').trim();
    const initialError = !meetingId || !guestToken ? 'Invite link is invalid or incomplete.' : '';

    writeResponse(res, 200, `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Join WebMeet</title>
    <link rel="stylesheet" href="./assets/components/webmeet-dashboard-modal/webmeet-dashboard-modal.css">
    <link rel="stylesheet" href="./assets/components/webmeet-participant-card/webmeet-participant-card.css">
    <style>
        :root {
            color-scheme: light;
            --file-exp-panel: #f7f8fa;
            --bg: #f7f8fa;
            --surface: #ffffff;
            --text: #17202a;
            --text-soft: #627080;
            --white: #ffffff;
            --light-gray: #176b87;
            --accent: #176b87;
            --accent-hover: #0e5268;
            --border: #e5e7eb;
            --border-strong: #d8dee7;
            --menu-backgroud: #eef2f6;
            --option-hover: #eef2f6;
            --inactive-element: #eef2f6;
            --gray-button-background: #ffffff;
            --gray-button-border: #627080;
            --gray-button-text: #17202a;
            --danger: #b42318;
        }
        * { box-sizing: border-box; }
        body {
            margin: 0;
            min-height: 100vh;
            font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            background: var(--file-exp-panel);
            color: var(--text);
        }
        .webmeet-public-join {
            min-height: 100vh;
            display: grid;
            place-items: center;
            padding: 24px;
        }
        .webmeet-public-panel {
            width: min(420px, 100%);
            background: var(--surface);
            border: 1px solid var(--border-strong);
            border-radius: 8px;
            padding: 24px;
            box-shadow: 0 16px 42px rgba(22, 32, 42, 0.12);
        }
        .webmeet-public-panel h1 {
            margin: 0 0 8px;
            font-size: 1.35rem;
            line-height: 1.2;
            letter-spacing: 0;
        }
        .webmeet-public-panel p {
            margin: 0 0 20px;
            color: var(--text-soft);
            line-height: 1.45;
        }
        .webmeet-public-panel label {
            display: block;
            margin: 0 0 8px;
            font-size: 0.86rem;
            font-weight: 650;
        }
        .form-input {
            width: 100%;
            min-height: 42px;
            border: 1px solid var(--border-strong);
            border-radius: 7px;
            padding: 0 12px;
            font: inherit;
            color: var(--text);
            background: var(--surface);
        }
        textarea.form-input { padding: 10px 12px; }
        .form-input:focus {
            outline: 2px solid rgba(23, 107, 135, 0.22);
            border-color: var(--accent);
        }
        .general-button {
            min-height: 40px;
            border: 1px solid var(--accent);
            border-radius: 7px;
            padding: 0 14px;
            font: inherit;
            font-weight: 650;
            background: var(--accent);
            color: #fff;
            cursor: pointer;
        }
        .general-button:hover { background: var(--accent-hover); }
        .general-button.subtle-button {
            color: var(--text);
            background: var(--surface);
            border-color: var(--border-strong);
        }
        .webmeet-public-actions {
            display: flex;
            justify-content: flex-end;
            margin-top: 16px;
        }
        .webmeet-public-message {
            min-height: 20px;
            margin-top: 12px;
            color: var(--danger);
            font-size: 0.9rem;
        }
        .webmeet-public-dashboard .webmeet-dashboard-modal {
            inset: 0;
            width: 100vw;
            height: 100vh;
            max-width: 100vw;
            max-height: 100vh;
            min-width: 0;
            min-height: 0;
            border-radius: 0;
            resize: none;
        }
        .webmeet-public-dashboard .webmeet-modal-window-actions,
        .webmeet-public-dashboard #webmeetCreateRoomButton {
            display: none !important;
        }
    </style>
</head>
<body>
    <main class="webmeet-public-join" id="webmeetGuestJoin">
        <section class="webmeet-public-panel">
            <h1>Join WebMeet</h1>
            <p>Enter your name to join this room.</p>
            <form id="webmeetGuestForm">
                <label for="webmeetGuestName">Name</label>
                <input id="webmeetGuestName" class="form-input" name="displayName" autocomplete="name" required>
                <div class="webmeet-public-actions">
                    <button type="submit" class="general-button" id="webmeetGuestJoinButton">Join room</button>
                </div>
                <div class="webmeet-public-message" id="webmeetGuestMessage">${htmlEscape(initialError)}</div>
            </form>
        </section>
    </main>
    <main class="webmeet-public-dashboard webmeet-hidden" id="webmeetDashboardRoot"></main>
    <script type="module">
        const meetingId = ${JSON.stringify(meetingId)};
        const guestToken = ${JSON.stringify(guestToken)};
        const publicApiBaseUrl = window.location.pathname.startsWith('/api/')
            ? window.location.origin + '/api'
            : window.location.origin + '/public-services/webmeet';
        window.__WEBMEET_PUBLIC_API_URL = publicApiBaseUrl;

        const form = document.getElementById('webmeetGuestForm');
        const input = document.getElementById('webmeetGuestName');
        const button = document.getElementById('webmeetGuestJoinButton');
        const message = document.getElementById('webmeetGuestMessage');
        const joinView = document.getElementById('webmeetGuestJoin');
        const dashboardRoot = document.getElementById('webmeetDashboardRoot');

        function setMessage(value) {
            message.textContent = String(value || '');
        }

        function createParticipantId(displayName) {
            const slug = String(displayName || 'guest').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'guest';
            const suffix = crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
            return 'guest-' + slug + '-' + suffix;
        }

        async function joinGuest(displayName) {
            const participantId = createParticipantId(displayName);
            const response = await fetch(publicApiBaseUrl + '/meetings/' + encodeURIComponent(meetingId) + '/join-guest', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                body: JSON.stringify({ guestToken, displayName, participantId })
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(payload.error || 'Could not join room.');
            }
            return {
                ...payload,
                guest: true,
                guestToken,
                publicApiBaseUrl
            };
        }

        async function openDashboard(session) {
            const htmlResponse = await fetch('./assets/components/webmeet-dashboard-modal/webmeet-dashboard-modal.html', {
                headers: { 'Accept': 'text/html' }
            });
            if (!htmlResponse.ok) {
                throw new Error('Dashboard UI could not be loaded.');
            }
            dashboardRoot.innerHTML = await htmlResponse.text();
            const sessionKey = 'webmeet.guestSession.' + Date.now() + '-' + Math.random().toString(36).slice(2);
            sessionStorage.setItem(sessionKey, JSON.stringify(session));
            window.location.hash = 'webmeet-dashboard-page?guestSession=' + encodeURIComponent(sessionKey);

            const module = await import('./assets/components/webmeet-dashboard-modal/webmeet-dashboard-modal.js');
            const actions = new Map();
            const instance = new module.WebMeetDashboardModal(dashboardRoot, () => {}, {
                registerAction(name, callback) {
                    actions.set(name, callback);
                },
                onGuestExit() {
                    sessionStorage.removeItem(sessionKey);
                    dashboardRoot.innerHTML = '';
                    dashboardRoot.classList.add('webmeet-hidden');
                    joinView.classList.add('webmeet-hidden');
                    try {
                        window.history.replaceState(null, '', window.location.pathname);
                    } catch (_) {
                        window.location.hash = '';
                    }
                    window.close();
                    window.setTimeout(() => {
                        if (!window.closed) {
                            window.location.replace('about:blank');
                        }
                    }, 50);
                }
            });
            dashboardRoot.addEventListener('click', (event) => {
                const actionTarget = event.target?.closest?.('[data-local-action]');
                if (!actionTarget) return;
                const action = actions.get(String(actionTarget.dataset.localAction || ''));
                if (!action) return;
                event.preventDefault();
                void action(actionTarget);
            });
            joinView.classList.add('webmeet-hidden');
            dashboardRoot.classList.remove('webmeet-hidden');
            await instance.afterRender();
        }

        form.addEventListener('submit', async (event) => {
            event.preventDefault();
            const displayName = String(input.value || '').trim();
            if (!meetingId || !guestToken) {
                setMessage('Invite link is invalid or incomplete.');
                return;
            }
            if (!displayName) {
                setMessage('Enter your name to join.');
                input.focus();
                return;
            }
            button.disabled = true;
            setMessage('Joining room...');
            try {
                await openDashboard(await joinGuest(displayName));
            } catch (error) {
                button.disabled = false;
                setMessage(error instanceof Error ? error.message : String(error));
            }
        });

        if (!meetingId || !guestToken) {
            button.disabled = true;
        }
        setTimeout(() => input.focus(), 0);
    </script>
</body>
</html>`, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; media-src 'self' blob:; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'"
    });
}

function resolveAssetPath(pathname) {
    const prefix = '/api/assets/';
    if (!pathname.startsWith(prefix)) return null;
    const relativePath = decodeURIComponent(pathname.slice(prefix.length));
    if (!relativePath || relativePath.includes('\0')) return null;

    const candidates = [];
    if (relativePath.startsWith('components/webmeet-dashboard-modal/')) {
        candidates.push(path.join(
            PLUGIN_DIR,
            relativePath.replace(/^components\/webmeet-dashboard-modal\//, 'components/webmeet-dashboard-modal/')
        ));
    } else if (relativePath.startsWith('components/webmeet-participant-card/')) {
        candidates.push(path.join(
            PLUGIN_DIR,
            relativePath.replace(/^components\/webmeet-participant-card\//, 'components/webmeet-participant-card/')
        ));
    } else if (relativePath.startsWith('vendor/')) {
        candidates.push(path.join(PLUGIN_DIR, relativePath));
    } else {
        candidates.push(path.join(PLUGIN_DIR, 'vendor', relativePath));
    }

    for (const candidate of candidates) {
        const resolved = path.resolve(candidate);
        if (!PUBLIC_ASSET_ROOTS.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`))) {
            continue;
        }
        if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
            return resolved;
        }
    }
    return null;
}

function sendAsset(pathname, res) {
    const assetPath = resolveAssetPath(pathname);
    if (!assetPath) {
        writeResponse(res, 404, JSON.stringify({ error: 'Asset not found.' }), {
            'Content-Type': 'application/json'
        });
        return;
    }
    const body = fs.readFileSync(assetPath);
    const extension = path.extname(assetPath).toLowerCase();
    res.writeHead(200, {
        'Content-Type': CONTENT_TYPES.get(extension) || 'application/octet-stream',
        'Content-Length': body.length,
        'Cache-Control': extension === '.html' ? 'no-store' : 'public, max-age=3600',
        'X-Content-Type-Options': 'nosniff'
    });
    res.end(body);
}

function proxy(req, res, targetPort, targetPath) {
    const headers = {
        ...req.headers,
        host: `127.0.0.1:${targetPort}`
    };
    const upstream = http.request({
        hostname: '127.0.0.1',
        port: targetPort,
        path: targetPath,
        method: req.method,
        headers
    }, (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode || 200, upstreamRes.headers);
        upstreamRes.pipe(res, { end: true });
    });
    upstream.on('error', (error) => {
        if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
        }
        res.end(JSON.stringify({ error: 'upstream error', detail: String(error?.message || error) }));
    });
    req.on('aborted', () => upstream.destroy());
    req.pipe(upstream, { end: true });
}

function isAllowedPublicApi(req, pathname) {
    const method = String(req.method || 'GET').toUpperCase();
    return method === 'POST' && (
        /^\/api\/meetings\/[^/]+\/join-guest$/.test(pathname)
        || /^\/api\/meetings\/[^/]+\/guest-state$/.test(pathname)
        || /^\/api\/meetings\/[^/]+\/guest-leave$/.test(pathname)
        || /^\/api\/meetings\/[^/]+\/guest-presence$/.test(pathname)
        || /^\/api\/meetings\/[^/]+\/guest-chat$/.test(pathname)
        || /^\/api\/meetings\/[^/]+\/guest-transcript$/.test(pathname)
    );
}

const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = url.pathname || '/';

    if (pathname === '/health' || pathname === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, service: 'webmeet-public-proxy' }));
        return;
    }

    if (req.method === 'GET' && pathname === '/api/guest') {
        if (!requirePloinkyIdentity(req, res)) return;
        sendGuestPage(req, res);
        return;
    }

    if (req.method === 'GET' && pathname.startsWith('/api/assets/')) {
        sendAsset(pathname, res);
        return;
    }

    if (pathname === '/mcp' || pathname.startsWith('/mcp/')) {
        proxy(req, res, MCP_PORT, `${pathname}${url.search || ''}`);
        return;
    }

    if (isAllowedPublicApi(req, pathname)) {
        if (!requirePloinkyIdentity(req, res)) return;
        proxy(req, res, API_PORT, `${pathname}${url.search || ''}`);
        return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found.' }));
});

server.listen(PUBLIC_PORT, '0.0.0.0', () => {
    process.stdout.write(`webmeet-public-proxy listening on 0.0.0.0:${PUBLIC_PORT}\n`);
});
