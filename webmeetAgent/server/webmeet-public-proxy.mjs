import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAxiFaceAssetsHttpHandler } from './axi-face-assets.mjs';
import { findWorkspaceRoot } from '../lib/workspacePaths.mjs';

const PUBLIC_PORT = Number.parseInt(process.env.PORT || '7000', 10);
const MCP_PORT = Number.parseInt(process.env.WEBMEET_MCP_PORT || '7001', 10);
const API_PORT = Number.parseInt(process.env.WEBMEET_API_PORT || '8791', 10);
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE_ROOT = findWorkspaceRoot();
const REPO_NAME = String(process.env.PLOINKY_REPO_NAME || 'AchillesIDE').trim() || 'AchillesIDE';
const PLUGIN_DIR = path.join(ROOT_DIR, 'IDE-plugins/webmeet-tool-button');
const EXPLORER_DIR = path.join(WORKSPACE_ROOT, '.ploinky', 'repos', REPO_NAME, 'explorer');
const EXPLORER_WEBSKEL_DIR = path.join(WORKSPACE_ROOT, '.ploinky', 'repos', REPO_NAME, 'explorer', 'WebSkel');
const EXPLORER_SHARED_STYLE_FILES = [
    path.join(EXPLORER_DIR, 'styles.css'),
    path.join(EXPLORER_DIR, 'plugins.css')
];
const PUBLIC_ASSET_ROOTS = [
    path.join(PLUGIN_DIR, 'components/webmeet-dashboard-modal'),
    path.join(PLUGIN_DIR, 'components/webmeet-participant-card'),
    path.join(PLUGIN_DIR, 'components/webmeet-participant-audio-modal'),
    path.join(PLUGIN_DIR, 'vendor'),
    EXPLORER_WEBSKEL_DIR,
    ...EXPLORER_SHARED_STYLE_FILES
];
const PUBLIC_SERVICE_PREFIX = '/public-services/webmeet/';
const INTERNAL_API_PREFIX = '/api/';
const HTTP_SERVICE_TOOL = '__http_service__';
const PUBLIC_MCP_METHODS = new Set([
    'initialize',
    'notifications/initialized',
    'notifications/cancelled',
    'tools/list',
    'resources/list',
    'ping'
]);

const CONTENT_TYPES = new Map([
    ['.css', 'text/css; charset=utf-8'],
    ['.html', 'text/html; charset=utf-8'],
    ['.js', 'application/javascript; charset=utf-8'],
    ['.mjs', 'application/javascript; charset=utf-8'],
    ['.json', 'application/json; charset=utf-8'],
    ['.svg', 'image/svg+xml'],
    ['.png', 'image/png'],
    ['.wasm', 'application/wasm'],
    ['.tflite', 'application/octet-stream'],
    ['.woff2', 'font/woff2']
]);

const handlePublicAxiFaceAssetRequest = createAxiFaceAssetsHttpHandler({
    fs: fs.promises,
    path,
    workspaceRoot: WORKSPACE_ROOT
});

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

let cachedJwtVerify = null;
let sharedReplayCache = null;

async function loadJwtVerify() {
    if (cachedJwtVerify) return cachedJwtVerify;
    const candidates = [
        process.env.PLOINKY_JWT_VERIFY_MODULE,
        '/Agent/lib/jwtVerify.mjs',
        path.resolve(process.cwd(), 'Agent/lib/jwtVerify.mjs'),
        path.resolve(process.cwd(), '../Agent/lib/jwtVerify.mjs')
    ].filter(Boolean);
    for (const candidate of candidates) {
        try {
            cachedJwtVerify = await import(candidate);
            return cachedJwtVerify;
        } catch (_) {
            // Try the next runtime-specific location.
        }
    }
    return null;
}

function readDerivedMasterKey() {
    const hex = String(process.env.PLOINKY_DERIVED_MASTER_KEY || '').trim();
    return hex ? Buffer.from(hex, 'hex') : null;
}

function expectedAudienceForSelf() {
    const principal = String(process.env.PLOINKY_AGENT_PRINCIPAL || '').trim();
    if (principal) return principal;
    const agentName = String(process.env.AGENT_NAME || process.env.WEBMEET_ROUTE_AGENT_NAME || 'webmeetAgent').trim();
    return agentName ? `agent:${agentName}` : '';
}

function readPloinkyAuthInfo(req) {
    const raw = String(req.headers?.['x-ploinky-auth-info'] || '').trim();
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

function authInfoFromInvocation(grant, { invocationToken = '' } = {}) {
    if (!grant || typeof grant !== 'object') return null;
    const out = {};
    const callerPrincipal = grant.caller || grant.sub || '';
    if (callerPrincipal && /^agent:/i.test(callerPrincipal)) {
        out.agent = {
            principalId: callerPrincipal,
            name: String(callerPrincipal).replace(/^agent:/i, '')
        };
    }
    const userClaims = grant.usr || grant.user;
    if (userClaims && typeof userClaims === 'object') {
        out.user = {
            id: String(userClaims.id || userClaims.sub || ''),
            username: String(userClaims.username || userClaims.preferred_username || ''),
            email: String(userClaims.email || ''),
            roles: Array.isArray(userClaims.roles) ? [...userClaims.roles] : []
        };
    }
    out.invocation = {
        issuer: String(grant.iss || ''),
        subject: String(grant.sub || ''),
        scope: Array.isArray(grant.scope) ? [...grant.scope] : [],
        tool: String(grant.tool || ''),
        workspaceId: String(grant.workspace_id || '')
    };
    out.invocationToken = String(invocationToken || '');
    return out;
}

function applyVerifiedAuthInfoToRequest(req, verifiedPayload) {
    if (!req || !verifiedPayload || typeof verifiedPayload !== 'object') return;
    const current = readPloinkyAuthInfo(req) || {};
    const invocationToken = String(current?.invocationToken || '').trim();
    const normalized = authInfoFromInvocation(verifiedPayload, { invocationToken }) || {};
    const merged = {
        ...current,
        ...normalized,
        user: normalized.user || current.user || undefined,
        agent: normalized.agent || current.agent || undefined,
        invocation: normalized.invocation || current.invocation || undefined
    };
    req.headers['x-ploinky-auth-info'] = JSON.stringify(merged);
}

function buildExternalServicePath(pathname) {
    if (pathname === '/api') return PUBLIC_SERVICE_PREFIX.replace(/\/+$/g, '');
    if (!pathname.startsWith(INTERNAL_API_PREFIX)) return pathname;
    return `${PUBLIC_SERVICE_PREFIX}${pathname.slice(INTERNAL_API_PREFIX.length)}`;
}

function buildHttpServiceBody(req, url) {
    return {
        tool: HTTP_SERVICE_TOOL,
        arguments: {
            method: req.method || 'GET',
            path: buildExternalServicePath(url.pathname || ''),
            search: url.search || ''
        }
    };
}

function hasGuestRole(payload) {
    const roles = Array.isArray(payload?.usr?.roles) ? payload.usr.roles : [];
    return roles.some((role) => String(role || '').trim().toLowerCase() === 'guest');
}

function readAuthorizationBearer(req) {
    const raw = req.headers?.authorization || req.headers?.Authorization;
    const header = Array.isArray(raw) ? raw[0] : raw;
    if (typeof header !== 'string' || !header.toLowerCase().startsWith('bearer ')) {
        return '';
    }
    return header.slice(7).trim();
}

async function verifyRouterInvocationToken(invocationToken, { expectedTool, bodyObject }) {
    const jwt = await loadJwtVerify();
    if (!jwt?.verifyInvocationToken) {
        return { ok: false, reason: 'jwt verifier unavailable' };
    }
    const secret = readDerivedMasterKey();
    if (!secret) {
        return { ok: false, reason: 'PLOINKY_DERIVED_MASTER_KEY not configured' };
    }
    const audience = expectedAudienceForSelf();
    if (!audience) {
        return { ok: false, reason: 'agent audience unavailable' };
    }
    if (!sharedReplayCache && typeof jwt.createMemoryReplayCache === 'function') {
        sharedReplayCache = jwt.createMemoryReplayCache({ maxSize: 4096 });
    }
    try {
        const { payload } = jwt.verifyInvocationToken(invocationToken, {
            secret,
            expectedAudience: audience,
            expectedTool,
            bodyObject,
            ...(sharedReplayCache ? { replayCache: sharedReplayCache } : {})
        });
        return { ok: true, payload };
    } catch (error) {
        return { ok: false, reason: error?.message || String(error) };
    }
}

async function verifyRouterGuestInvocation(req, url) {
    return verifyRouterInvocation(req, url, { requireGuest: true });
}

async function requirePloinkyGuestIdentity(req, res, url) {
    const verified = await verifyRouterGuestInvocation(req, url);
    if (verified.ok) return true;
    writeResponse(res, 401, JSON.stringify({ error: 'Ploinky guest session required.' }), {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
    });
    return false;
}

async function verifyRouterInvocation(req, url, { requireGuest = false } = {}) {
    const authInfo = readPloinkyAuthInfo(req);
    const invocationToken = String(authInfo?.invocationToken || '').trim();
    if (!invocationToken) {
        return { ok: false, reason: 'missing router invocation token' };
    }
    const verified = await verifyRouterInvocationToken(invocationToken, {
        expectedTool: HTTP_SERVICE_TOOL,
        bodyObject: buildHttpServiceBody(req, url)
    });
    if (!verified.ok) {
        return verified;
    }
    const { payload } = verified;
    if (requireGuest && !hasGuestRole(payload)) {
        return { ok: false, reason: 'guest role required' };
    }
    return { ok: true, payload };
}

async function requirePloinkyAuthenticatedIdentity(req, res, url) {
    const verified = await verifyRouterInvocation(req, url, { requireGuest: false });
    if (verified.ok) {
        applyVerifiedAuthInfoToRequest(req, verified.payload);
        return true;
    }
    writeResponse(res, 401, JSON.stringify({ error: 'Ploinky authentication required.' }), {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
    });
    return false;
}

function parseJsonRpcPayload(bodyBuffer) {
    try {
        return JSON.parse(bodyBuffer.toString('utf8') || '{}');
    } catch {
        return null;
    }
}

function asJsonRpcMessages(payload) {
    if (Array.isArray(payload)) return payload;
    if (payload && typeof payload === 'object') return [payload];
    return [];
}

function buildMcpInvocationSpec(message) {
    const method = typeof message?.method === 'string' ? message.method : '';
    if (method === 'tools/call') {
        const params = message.params && typeof message.params === 'object' ? message.params : {};
        const name = typeof params.name === 'string'
            ? params.name
            : typeof params.tool === 'string'
                ? params.tool
                : '';
        if (!name) return { ok: false, reason: 'missing tool name' };
        const argPayload = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
            ? { ...params.arguments }
            : {};
        return {
            ok: true,
            expectedTool: name,
            bodyObject: { tool: name, arguments: argPayload }
        };
    }
    if (method === 'resources/read') {
        const params = message.params && typeof message.params === 'object' ? message.params : {};
        const uri = typeof params.uri === 'string' ? params.uri : '';
        if (!uri) return { ok: false, reason: 'missing resource uri' };
        return {
            ok: true,
            expectedTool: 'resources/read',
            bodyObject: { tool: 'resources/read', arguments: { uri } }
        };
    }
    return { ok: false, reason: `method requires router invocation: ${method || 'unknown'}` };
}

function writeMcpRejection(res, message, reason) {
    const id = message && Object.prototype.hasOwnProperty.call(message, 'id') ? message.id : null;
    writeResponse(res, 200, JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: {
            code: -32600,
            message: `Invocation rejected: ${reason}`
        }
    }), {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
    });
}

async function requireMcpInvocation(req, res, message) {
    const method = typeof message?.method === 'string' ? message.method : '';
    if (PUBLIC_MCP_METHODS.has(method)) {
        return true;
    }
    const token = readAuthorizationBearer(req);
    if (!token) {
        writeMcpRejection(res, message, 'missing router invocation token');
        return false;
    }
    const spec = buildMcpInvocationSpec(message);
    if (!spec.ok) {
        writeMcpRejection(res, message, spec.reason);
        return false;
    }
    const verified = await verifyRouterInvocationToken(token, {
        expectedTool: spec.expectedTool,
        bodyObject: spec.bodyObject
    });
    if (!verified.ok) {
        writeMcpRejection(res, message, verified.reason);
        return false;
    }
    return true;
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
    </style>
    <link rel="stylesheet" href="./assets/explorer/styles.css">
    <link rel="stylesheet" href="./assets/explorer/plugins.css">
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
    <main class="webmeet-hidden" id="webmeetDashboardRoot"></main>
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
        const guestDisplayNameStorageKey = 'webmeet.guestDisplayName';

        function setMessage(value) {
            message.textContent = String(value || '');
        }

        function readStoredGuestDisplayName() {
            try {
                return String(window.localStorage.getItem(guestDisplayNameStorageKey) || '').trim();
            } catch (_) {
                return '';
            }
        }

        function persistGuestDisplayName(displayName) {
            try {
                window.localStorage.setItem(guestDisplayNameStorageKey, String(displayName || '').trim());
            } catch (_) {
                // Ignore browser storage failures.
            }
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
            const sessionKey = 'webmeet.guestSession.' + Date.now() + '-' + Math.random().toString(36).slice(2);
            sessionStorage.setItem(sessionKey, JSON.stringify(session));
            window.location.hash = 'webmeet-dashboard-page?guestSession=' + encodeURIComponent(sessionKey);
            const webSkelModule = await import('./assets/explorer/WebSkel/webskel.mjs');
            const [dashboardTemplate, dashboardCss, participantCardTemplate, participantCardCss, participantAudioTemplate, participantAudioCss, dashboardModule, participantCardModule, participantAudioModule] = await Promise.all([
                fetch('./assets/components/webmeet-dashboard-modal/webmeet-dashboard-modal.html', { headers: { 'Accept': 'text/html' } }).then(async (response) => {
                    if (!response.ok) throw new Error('Dashboard UI could not be loaded.');
                    return response.text();
                }),
                fetch('./assets/components/webmeet-dashboard-modal/webmeet-dashboard-modal.css', { headers: { 'Accept': 'text/css' } }).then(async (response) => {
                    if (!response.ok) throw new Error('Dashboard styles could not be loaded.');
                    return response.text();
                }),
                fetch('./assets/components/webmeet-participant-card/webmeet-participant-card.html', { headers: { 'Accept': 'text/html' } }).then(async (response) => {
                    if (!response.ok) throw new Error('Participant card UI could not be loaded.');
                    return response.text();
                }),
                fetch('./assets/components/webmeet-participant-card/webmeet-participant-card.css', { headers: { 'Accept': 'text/css' } }).then(async (response) => {
                    if (!response.ok) throw new Error('Participant card styles could not be loaded.');
                    return response.text();
                }),
                fetch('./assets/components/webmeet-participant-audio-modal/webmeet-participant-audio-modal.html', { headers: { 'Accept': 'text/html' } }).then(async (response) => {
                    if (!response.ok) throw new Error('Participant audio modal UI could not be loaded.');
                    return response.text();
                }),
                fetch('./assets/components/webmeet-participant-audio-modal/webmeet-participant-audio-modal.css', { headers: { 'Accept': 'text/css' } }).then(async (response) => {
                    if (!response.ok) throw new Error('Participant audio modal styles could not be loaded.');
                    return response.text();
                }),
                import('./assets/components/webmeet-dashboard-modal/webmeet-dashboard-modal.js'),
                import('./assets/components/webmeet-participant-card/webmeet-participant-card.js'),
                import('./assets/components/webmeet-participant-audio-modal/webmeet-participant-audio-modal.js')
            ]);
            const webSkelClass = webSkelModule.default || webSkelModule.WebSkel;
            const webSkel = await webSkelClass.initialise('./assets/vendor/webmeet-guest-webskel.json');
            const registerWebSkelComponentConfig = (componentConfig) => {
                webSkel.configs = webSkel.configs || {};
                webSkel.configs.components = Array.isArray(webSkel.configs.components)
                    ? webSkel.configs.components
                    : [];
                const existingIndex = webSkel.configs.components.findIndex((component) => component?.name === componentConfig.name);
                if (existingIndex >= 0) {
                    webSkel.configs.components[existingIndex] = {
                        ...webSkel.configs.components[existingIndex],
                        ...componentConfig
                    };
                    return;
                }
                webSkel.configs.components.push(componentConfig);
            };
            registerWebSkelComponentConfig({
                name: 'webmeet-participant-card',
                type: 'components',
                presenterClassName: 'WebMeetParticipantCard'
            });
            registerWebSkelComponentConfig({
                name: 'webmeet-dashboard-modal',
                type: 'components',
                presenterClassName: 'WebMeetDashboardModal'
            });
            registerWebSkelComponentConfig({
                name: 'webmeet-participant-audio-modal',
                type: 'modal',
                presenterClassName: 'WebmeetParticipantAudioModal'
            });
            await webSkel.defineComponent({
                name: 'webmeet-participant-card',
                type: 'components',
                presenterClassName: 'WebMeetParticipantCard',
                loadedTemplate: participantCardTemplate,
                loadedCSSs: [participantCardCss],
                presenterModule: participantCardModule
            });
            await webSkel.defineComponent({
                name: 'webmeet-dashboard-modal',
                type: 'components',
                presenterClassName: 'WebMeetDashboardModal',
                loadedTemplate: dashboardTemplate,
                loadedCSSs: [dashboardCss],
                presenterModule: dashboardModule
            });
            await webSkel.defineComponent({
                name: 'webmeet-participant-audio-modal',
                type: 'components',
                presenterClassName: 'WebmeetParticipantAudioModal',
                loadedTemplate: participantAudioTemplate,
                loadedCSSs: [participantAudioCss],
                presenterModule: participantAudioModule
            });
            window.UI = webSkel;
            window.assistOS = window.assistOS || {};
            window.assistOS.webSkel = webSkel;
            window.assistOS.UI = window.assistOS.UI || {};
            window.assistOS.UI.showModal = webSkelModule.showModal;
            window.assistOS.UI.closeModal = webSkelModule.closeModal;
            dashboardRoot.innerHTML = '';
            webSkel.createElement('webmeet-dashboard-modal', dashboardRoot, {
                onGuestExit() {
                    sessionStorage.removeItem(sessionKey);
                    dashboardRoot.innerHTML = '';
                    dashboardRoot.classList.add('webmeet-hidden');
                    joinView.classList.remove('webmeet-hidden');
                    input.value = readStoredGuestDisplayName();
                    try {
                        window.history.replaceState(null, '', window.location.pathname);
                    } catch (_) {
                        window.location.hash = '';
                    }
                }
            }, {
                'data-presenter': 'webmeet-dashboard-modal',
                'data-host-surface': 'standalone-page'
            }, false);
            joinView.classList.add('webmeet-hidden');
            dashboardRoot.classList.remove('webmeet-hidden');
            const dashboardElement = dashboardRoot.querySelector('webmeet-dashboard-modal');
            if (dashboardElement?.renderCompletePromise) {
                await dashboardElement.renderCompletePromise;
            }
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
            persistGuestDisplayName(displayName);
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
        input.value = readStoredGuestDisplayName();
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
    } else if (relativePath.startsWith('components/webmeet-participant-audio-modal/')) {
        candidates.push(path.join(
            PLUGIN_DIR,
            relativePath.replace(/^components\/webmeet-participant-audio-modal\//, 'components/webmeet-participant-audio-modal/')
        ));
    } else if (relativePath.startsWith('explorer/WebSkel/')) {
        candidates.push(path.join(
            EXPLORER_WEBSKEL_DIR,
            relativePath.replace(/^explorer\/WebSkel\//, '')
        ));
    } else if (relativePath === 'explorer/styles.css' || relativePath === 'explorer/plugins.css') {
        candidates.push(path.join(
            EXPLORER_DIR,
            relativePath.replace(/^explorer\//, '')
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
        'Cache-Control': 'no-store',
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

function proxyBuffered(req, res, targetPort, targetPath, bodyBuffer) {
    const headers = {
        ...req.headers,
        host: `127.0.0.1:${targetPort}`,
        'content-length': String(bodyBuffer.length)
    };
    delete headers['transfer-encoding'];
    delete headers['Transfer-Encoding'];

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
    upstream.end(bodyBuffer);
}

async function proxyMcp(req, res, targetPath) {
    const method = String(req.method || 'GET').toUpperCase();
    if (method !== 'POST') {
        proxy(req, res, MCP_PORT, targetPath);
        return;
    }

    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
        try {
            const bodyBuffer = Buffer.concat(chunks);
            const payload = parseJsonRpcPayload(bodyBuffer);
            if (payload) {
                const messages = asJsonRpcMessages(payload);
                for (const message of messages) {
                    if (!(await requireMcpInvocation(req, res, message))) {
                        return;
                    }
                }
            }
            proxyBuffered(req, res, MCP_PORT, targetPath, bodyBuffer);
        } catch (error) {
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
            }
            res.end(JSON.stringify({ error: 'mcp proxy failure', detail: String(error?.message || error) }));
        }
    });
    req.on('error', (error) => {
        if (!res.headersSent) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
        }
        res.end(JSON.stringify({ error: 'request error', detail: String(error?.message || error) }));
    });
}

function isAllowedPublicApi(req, pathname) {
    const method = String(req.method || 'GET').toUpperCase();
    if (method === 'GET' && /^\/api\/meetings\/[^/]+\/transcript\/download$/.test(pathname)) {
        const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
        return url.searchParams.has('guestToken') && url.searchParams.has('participantId');
    }
    return method === 'POST' && (
        /^\/api\/meetings\/[^/]+\/join-guest$/.test(pathname)
        || /^\/api\/meetings\/[^/]+\/guest-state$/.test(pathname)
        || /^\/api\/meetings\/[^/]+\/guest-leave$/.test(pathname)
        || /^\/api\/meetings\/[^/]+\/guest-presence$/.test(pathname)
        || /^\/api\/meetings\/[^/]+\/guest-chat$/.test(pathname)
        || /^\/api\/meetings\/[^/]+\/guest-avatar$/.test(pathname)
    );
}

function isAllowedAuthenticatedApi(req, pathname) {
    // Allow all /api/* routes for authenticated users (via x-ploinky-auth-info header)
    if (!pathname.startsWith('/api/')) return false;
    // Exclude guest-only routes that require special handling
    const guestOnlyPattern = /^\/api\/meetings\/[^/]+\/(join-guest|guest-state|guest-leave|guest-presence|guest-chat|guest-avatar)$/;
    if (guestOnlyPattern.test(pathname)) return false;
    return true;
}

function normalizePublicServicePathname(pathname) {
    let normalized = String(pathname || '').trim() || '/';
    if (normalized.startsWith(PUBLIC_SERVICE_PREFIX)) {
        normalized = `/${normalized.slice(PUBLIC_SERVICE_PREFIX.length)}`.replace(/^\/+/, '/');
    }
    if (normalized === '/guest') return '/api/guest';
    if (normalized.startsWith('/assets/')) return `/api/${normalized.slice(1)}`;
    if (normalized.startsWith('/axi-face/')) return `/api/${normalized.slice(1)}`;
    if (normalized.startsWith('/meetings/')) return `/api/${normalized.slice(1)}`;
    return normalized;
}

const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
        if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
        }
        res.end(JSON.stringify({ error: 'proxy failure', detail: String(error?.message || error) }));
    });
});

async function handleRequest(req, res) {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = url.pathname || '/';
    const routedPathname = normalizePublicServicePathname(pathname);

    if (pathname === '/health' || pathname === '/healthz' || routedPathname === '/health' || routedPathname === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, service: 'webmeet-public-proxy' }));
        return;
    }

    if (req.method === 'GET' && routedPathname === '/api/guest') {
        if (!(await requirePloinkyGuestIdentity(req, res, url))) return;
        sendGuestPage(req, res);
        return;
    }

    if (req.method === 'GET' && routedPathname.startsWith('/api/assets/')) {
        sendAsset(routedPathname, res);
        return;
    }

    if (req.method === 'GET' && routedPathname.startsWith('/api/axi-face/')) {
        if (!(await requirePloinkyGuestIdentity(req, res, url))) return;
        const axiFaceUrl = new URL(url.toString());
        axiFaceUrl.pathname = routedPathname.replace(/^\/api/, '') || '/';
        if (await handlePublicAxiFaceAssetRequest(req, res, axiFaceUrl)) {
            return;
        }
    }

    if (routedPathname === '/mcp' || routedPathname.startsWith('/mcp/')) {
        await proxyMcp(req, res, `${routedPathname}${url.search || ''}`);
        return;
    }

    if (isAllowedPublicApi(req, routedPathname)) {
        if (!(await requirePloinkyGuestIdentity(req, res, url))) return;
        proxy(req, res, API_PORT, `${routedPathname}${url.search || ''}`);
        return;
    }

    if (isAllowedAuthenticatedApi(req, routedPathname)) {
        if (!(await requirePloinkyAuthenticatedIdentity(req, res, url))) return;
        proxy(req, res, API_PORT, `${routedPathname}${url.search || ''}`);
        return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found.' }));
}

server.listen(PUBLIC_PORT, '0.0.0.0', () => {
    process.stdout.write(`webmeet-public-proxy listening on 0.0.0.0:${PUBLIC_PORT}\n`);
});
